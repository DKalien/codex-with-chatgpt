import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import { Workspace } from "../workspace/manager.js";

export const WINDOWS_SUPERVISOR_TASK_MODE = "windows-scheduled-task" as const;
const TASK_PREFIX = "CodexWithChatGPT-";
const TASK_DESCRIPTION = "Codex with ChatGPT supervisor managed task";

const userSidSchema = z.string().regex(/^S-1-5-(?:21-(?:\d+-){3}\d+|\d+(?:-\d+)+)$/i);
const taskDefinitionSchema = z.object({
  version: z.literal(1),
  taskName: z.string().regex(/^CodexWithChatGPT-[0-9a-f]{12}$/),
  taskPath: z.literal("\\"),
  workspaceId: z.string().regex(/^[0-9a-f]{12}$/),
  workspaceRoot: z.string().min(1),
  stateDir: z.string().min(1),
  stableLauncher: z.string().min(1),
  nodeExecutable: z.string().min(1),
  userSid: userSidSchema,
  action: z.object({
    id: z.literal(""),
    execute: z.string().min(1),
    arguments: z.array(z.string()).length(7),
    commandLine: z.string().min(1),
    workingDirectory: z.string().min(1),
  }).strict(),
  trigger: z.object({ type: z.literal("AtLogOn"), userId: userSidSchema, enabled: z.literal(true) }).strict(),
  principal: z.object({ userId: userSidSchema, logonType: z.literal("InteractiveToken"), runLevel: z.literal("Limited") }).strict(),
  settings: z.object({
    startWhenAvailable: z.literal(true),
    multipleInstances: z.literal("IgnoreNew"),
    executionTimeLimit: z.literal("PT0S"),
    restartCount: z.literal(3),
    restartInterval: z.literal("PT1M"),
  }).strict(),
  registrationInfo: z.object({ description: z.string().min(1) }).strict(),
}).strict().refine(value => value.taskName === `${TASK_PREFIX}${value.workspaceId}` &&
  value.trigger.userId === value.userSid && value.principal.userId === value.userSid);

export type WindowsSupervisorTaskDefinition = z.infer<typeof taskDefinitionSchema>;

/** Normalized projection of every action, trigger, principal, and setting owned by this task. */
export interface WindowsTaskProjection {
  taskName: string;
  taskPath: string;
  actions: Array<{ id: string; type: "Exec"; execute: string; arguments: string; workingDirectory: string }>;
  triggers: Array<{ type: "AtLogOn"; userId: string; enabled: boolean; delay: string; repetitionInterval: string; repetitionDuration: string; startBoundary: string; endBoundary: string }>;
  principal: { userId: string; logonType: string; runLevel: string };
  settings: {
    startWhenAvailable: boolean;
    multipleInstances: string;
    executionTimeLimit: string;
    restartCount: number;
    restartInterval: string;
  };
  registrationInfo: { description: string };
}

export type WindowsTaskErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "SCHEDULER_UNAVAILABLE"
  | "CURRENT_USER_SID_UNAVAILABLE"
  | "INVALID_TASK_DEFINITION"
  | "TASK_CONFLICT"
  | "PERMISSION_DENIED"
  | "TASK_OPERATION_FAILED"
  | "TASK_VERIFY_FAILED";

export class WindowsTaskError extends Error {
  constructor(public readonly code: WindowsTaskErrorCode) {
    super(code);
    this.name = "WindowsTaskError";
  }
}

export interface WindowsTaskCapability {
  available: boolean;
  errorCode?: "UNSUPPORTED_PLATFORM" | "SCHEDULER_UNAVAILABLE";
}

export interface WindowsTaskBackend {
  readonly platform: string;
  capability(): WindowsTaskCapability;
  currentUserSid(): string | null;
  read(taskName: string, expected: WindowsSupervisorTaskDefinition): { exists: boolean; definition?: unknown; exact?: boolean };
  register(definition: WindowsSupervisorTaskDefinition): void;
  /** Must re-read and compare inside the same backend operation before removing. */
  removeIfExact(definition: WindowsSupervisorTaskDefinition): boolean;
}

export interface WindowsSupervisorTaskInput {
  workspaceRoot: string;
  stateDir?: string;
}

export type WindowsSupervisorTaskInspection = {
  status: "absent" | "owned" | "conflict" | "unsupported";
  registrationMode: typeof WINDOWS_SUPERVISOR_TASK_MODE | null;
  taskName: string;
  workspaceId: string;
  definition: WindowsSupervisorTaskDefinition | null;
  errorCode: WindowsTaskErrorCode | null;
};

function quoteWindowsArgument(value: string): string {
  let result = '"';
  let slashes = 0;
  for (const char of value) {
    if (char === "\\") {
      slashes++;
    } else if (char === '"') {
      result += "\\".repeat(slashes * 2 + 1) + '"';
      slashes = 0;
    } else {
      result += "\\".repeat(slashes) + char;
      slashes = 0;
    }
  }
  return result + "\\".repeat(slashes * 2) + '"';
}

function canonicalFile(file: string, expected: string): string {
  let real: string;
  try { real = fs.realpathSync.native(file); }
  catch { throw new WindowsTaskError("INVALID_TASK_DEFINITION"); }
  const canonical = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (canonical(real) !== canonical(expected)) throw new WindowsTaskError("INVALID_TASK_DEFINITION");
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.nlink !== 1) throw new WindowsTaskError("INVALID_TASK_DEFINITION");
  return real;
}

function canonicalDirectory(dir: string): string {
  let real: string;
  try { real = fs.realpathSync.native(dir); }
  catch { throw new WindowsTaskError("INVALID_TASK_DEFINITION"); }
  if (!fs.statSync(real).isDirectory()) throw new WindowsTaskError("INVALID_TASK_DEFINITION");
  return real;
}

/** Build the only task definition this module will install. Paths are canonical and the action always uses the stable launcher. */
export function buildWindowsSupervisorTaskDefinition(input: WindowsSupervisorTaskInput & {
  userSid: string;
  nodeExecutable?: string;
}): WindowsSupervisorTaskDefinition {
  const sid = userSidSchema.safeParse(input.userSid);
  if (!sid.success) throw new WindowsTaskError("INVALID_TASK_DEFINITION");
  let workspace: Workspace;
  try { workspace = new Workspace(input.workspaceRoot); }
  catch { throw new WindowsTaskError("INVALID_TASK_DEFINITION"); }

  const stateDir = canonicalDirectory(path.resolve(input.stateDir ?? getStateDir()));
  const stableLauncher = canonicalFile(path.join(stateDir, "bin", "c2c.js"), path.join(stateDir, "bin", "c2c.js"));
  const nodePath = path.resolve(input.nodeExecutable ?? process.execPath);
  const nodeExecutable = canonicalFile(nodePath, nodePath);
  const args = [stableLauncher, "supervisor", "run", "-w", workspace.root, "--state-dir", stateDir];
  // Keep the actual argv explicit in the public definition; a PowerShell backend serializes it once for Task Scheduler.
  const commandLine = args.map(quoteWindowsArgument).join(" ");
  const value: WindowsSupervisorTaskDefinition = {
    version: 1,
    taskName: `${TASK_PREFIX}${workspace.id}`,
    taskPath: "\\",
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    stateDir,
    stableLauncher,
    nodeExecutable,
    userSid: sid.data,
    action: {
      id: "",
      execute: nodeExecutable,
      arguments: args,
      commandLine,
      workingDirectory: stateDir,
    },
    trigger: { type: "AtLogOn", userId: sid.data, enabled: true },
    principal: { userId: sid.data, logonType: "InteractiveToken", runLevel: "Limited" },
    settings: {
      startWhenAvailable: true,
      multipleInstances: "IgnoreNew",
      executionTimeLimit: "PT0S",
      restartCount: 3,
      restartInterval: "PT1M",
    },
    registrationInfo: { description: `${TASK_DESCRIPTION}; workspace=${workspace.id}` },
  };
  const parsed = taskDefinitionSchema.safeParse(value);
  if (!parsed.success) throw new WindowsTaskError("INVALID_TASK_DEFINITION");
  return parsed.data;
}

export function windowsTaskProjection(definition: WindowsSupervisorTaskDefinition): WindowsTaskProjection {
  return {
    taskName: definition.taskName,
    taskPath: definition.taskPath,
    actions: [{
      id: definition.action.id,
      type: "Exec",
      execute: definition.action.execute,
      arguments: definition.action.commandLine,
      workingDirectory: definition.action.workingDirectory,
    }],
    triggers: [{
      type: "AtLogOn",
      userId: definition.trigger.userId,
      enabled: definition.trigger.enabled,
      delay: "",
      repetitionInterval: "",
      repetitionDuration: "",
      startBoundary: "",
      endBoundary: "",
    }],
    principal: { ...definition.principal },
    settings: { ...definition.settings },
    registrationInfo: { ...definition.registrationInfo },
  };
}

function taskNameFor(input: WindowsSupervisorTaskInput): { taskName: string; workspaceId: string } {
  let workspace: Workspace;
  try { workspace = new Workspace(input.workspaceRoot); }
  catch { throw new WindowsTaskError("INVALID_TASK_DEFINITION"); }
  return { taskName: `${TASK_PREFIX}${workspace.id}`, workspaceId: workspace.id };
}

function unsupported(input: WindowsSupervisorTaskInput, errorCode: WindowsTaskErrorCode): WindowsSupervisorTaskInspection {
  const identity = taskNameFor(input);
  return { ...identity, status: "unsupported", registrationMode: null, definition: null, errorCode };
}

function inspectWithBackend(input: WindowsSupervisorTaskInput, backend: WindowsTaskBackend): WindowsSupervisorTaskInspection {
  const identity = taskNameFor(input);
  if (backend.platform !== "win32") return unsupported(input, "UNSUPPORTED_PLATFORM");
  const capability = backend.capability();
  if (!capability.available) return unsupported(input, capability.errorCode ?? "SCHEDULER_UNAVAILABLE");
  const userSid = backend.currentUserSid();
  if (!userSid || !userSidSchema.safeParse(userSid).success) return unsupported(input, "CURRENT_USER_SID_UNAVAILABLE");

  const definition = buildWindowsSupervisorTaskDefinition({ ...input, userSid });
  let current: { exists: boolean; definition?: unknown; exact?: boolean };
  try { current = backend.read(definition.taskName, definition); }
  catch (error) {
    const errorCode = error instanceof WindowsTaskError ? error.code : "TASK_OPERATION_FAILED";
    return { ...identity, status: "unsupported", registrationMode: null, definition, errorCode };
  }
  if (!current.exists) return { ...identity, status: "absent", registrationMode: WINDOWS_SUPERVISOR_TASK_MODE, definition, errorCode: null };

  const actual = z.object({
    taskName: z.string(),
    taskPath: z.literal("\\"),
    actions: z.array(z.object({ id: z.string(), type: z.literal("Exec"), execute: z.string(), arguments: z.string(), workingDirectory: z.string() }).strict()),
    triggers: z.array(z.object({ type: z.literal("AtLogOn"), userId: z.string(), enabled: z.boolean(), delay: z.string(), repetitionInterval: z.string(), repetitionDuration: z.string(), startBoundary: z.string(), endBoundary: z.string() }).strict()),
    principal: z.object({ userId: z.string(), logonType: z.string(), runLevel: z.string() }).strict(),
    settings: z.object({ startWhenAvailable: z.boolean(), multipleInstances: z.string(), executionTimeLimit: z.string(), restartCount: z.number().int(), restartInterval: z.string() }).strict(),
    registrationInfo: z.object({ description: z.string() }).strict(),
  }).strict().safeParse(current.definition);
  const exact = current.exact !== false && actual.success && isDeepStrictEqual(actual.data, windowsTaskProjection(definition));
  return {
    ...identity,
    status: exact ? "owned" : "conflict",
    registrationMode: WINDOWS_SUPERVISOR_TASK_MODE,
    definition,
    errorCode: null,
  };
}

export function inspectWindowsSupervisorTask(
  input: WindowsSupervisorTaskInput,
  backend: WindowsTaskBackend = windowsTaskBackend,
): WindowsSupervisorTaskInspection {
  try { return inspectWithBackend(input, backend); }
  catch (error) {
    if (error instanceof WindowsTaskError && error.code === "INVALID_TASK_DEFINITION") throw error;
    return unsupported(input, "TASK_OPERATION_FAILED");
  }
}

export function installWindowsSupervisorTask(
  input: WindowsSupervisorTaskInput,
  backend: WindowsTaskBackend = windowsTaskBackend,
): { status: "installed" | "already_installed"; definition: WindowsSupervisorTaskDefinition } {
  const inspection = inspectWindowsSupervisorTask(input, backend);
  if (inspection.status === "unsupported") throw new WindowsTaskError(inspection.errorCode ?? "SCHEDULER_UNAVAILABLE");
  if (inspection.status === "conflict") throw new WindowsTaskError("TASK_CONFLICT");
  if (!inspection.definition) throw new WindowsTaskError("TASK_VERIFY_FAILED");
  if (inspection.status === "owned") return { status: "already_installed", definition: inspection.definition };

  try { backend.register(inspection.definition); }
  catch (error) {
    if (error instanceof WindowsTaskError) throw error;
    throw new WindowsTaskError("TASK_OPERATION_FAILED");
  }
  const after = inspectWindowsSupervisorTask(input, backend);
  if (after.status !== "owned" || !after.definition) {
    throw new WindowsTaskError(after.status === "unsupported" ? after.errorCode ?? "TASK_OPERATION_FAILED" : "TASK_VERIFY_FAILED");
  }
  return { status: "installed", definition: after.definition };
}

export function uninstallWindowsSupervisorTask(
  input: WindowsSupervisorTaskInput,
  backend: WindowsTaskBackend = windowsTaskBackend,
): { status: "removed" | "absent"; taskName: string } {
  const inspection = inspectWindowsSupervisorTask(input, backend);
  if (inspection.status === "unsupported") throw new WindowsTaskError(inspection.errorCode ?? "SCHEDULER_UNAVAILABLE");
  if (inspection.status === "conflict") throw new WindowsTaskError("TASK_CONFLICT");
  if (inspection.status === "absent") return { status: "absent", taskName: inspection.taskName };
  if (!inspection.definition) throw new WindowsTaskError("TASK_VERIFY_FAILED");

  let removed: boolean;
  try { removed = backend.removeIfExact(inspection.definition); }
  catch (error) {
    if (error instanceof WindowsTaskError) throw error;
    throw new WindowsTaskError("TASK_OPERATION_FAILED");
  }
  if (!removed) throw new WindowsTaskError("TASK_CONFLICT");
  const after = inspectWindowsSupervisorTask(input, backend);
  if (after.status !== "absent") throw new WindowsTaskError(after.status === "unsupported" ? after.errorCode ?? "TASK_OPERATION_FAILED" : "TASK_VERIFY_FAILED");
  return { status: "removed", taskName: inspection.taskName };
}

const POWERSHELL_TASK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Out($value) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject $value -Depth 16 -Compress)) }
function SidValue($value) {
  if ($null -eq $value) { return '' }
  $text = [string]$value
  if ($text -match '^S-1-') { return $text }
  try { return (New-Object System.Security.Principal.NTAccount($text)).Translate([System.Security.Principal.SecurityIdentifier]).Value }
  catch { return $text }
}
function SpanValue($value) {
  if ($null -eq $value) { return '' }
  if ($value -is [TimeSpan]) { return [System.Xml.XmlConvert]::ToString($value) }
  return [string]$value
}
function CimValue($value) {
  if ($null -eq $value) { return $null }
  if ($value -is [Microsoft.Management.Infrastructure.CimInstance]) {
    $map = [ordered]@{}
    foreach ($property in @($value.CimInstanceProperties | Sort-Object Name)) {
      $nested = $property.Value
      if ($property.Name -eq 'UserId') { $nested = SidValue $nested }
      $map[[string]$property.Name] = CimValue $nested
    }
    return $map
  }
  if ($value -is [TimeSpan]) { return [System.Xml.XmlConvert]::ToString($value) }
  if ($value -is [System.Enum]) { return [string]$value }
  if ($value -is [System.Array]) { return ,@($value | ForEach-Object { CimValue $_ }) }
  return $value
}
function TaskShape($task, $name) {
  $actions = @($task.Actions | ForEach-Object { [ordered]@{ type = [string]$_.CimClass.CimClassName; fields = (CimValue $_) } })
  $triggers = @($task.Triggers | ForEach-Object { [ordered]@{ type = [string]$_.CimClass.CimClassName; fields = (CimValue $_) } })
  [ordered]@{
    taskName = [string]$name
    taskPath = '\'
    actions = $actions
    triggers = $triggers
    principal = (CimValue $task.Principal)
    settings = (CimValue $task.Settings)
    description = [string]$task.Description
  }
}
function GetRootTask($name) {
  try { return Get-ScheduledTask -TaskPath '\' -TaskName $name -ErrorAction Stop }
  catch {
    if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { return $null }
    throw
  }
}
function BuildExpected($d) {
  $action = New-ScheduledTaskAction -Execute $d.action.execute -Argument $d.action.commandLine -WorkingDirectory $d.action.workingDirectory
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $d.userSid
  $principal = New-ScheduledTaskPrincipal -UserId $d.userSid -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  return New-ScheduledTask -Action @($action) -Trigger @($trigger) -Principal $principal -Settings $settings -Description $d.registrationInfo.description
}
function Normalize($task, $name) {
  $actions = @($task.Actions | ForEach-Object { [ordered]@{
    id = [string]$_.Id
    type = $(if ($_.CimClass.CimClassName -eq 'MSFT_TaskExecAction') { 'Exec' } else { 'OTHER:' + [string]$_.CimClass.CimClassName })
    execute = [string]$_.Execute; arguments = [string]$_.Arguments; workingDirectory = [string]$_.WorkingDirectory
  } })
  $triggers = @($task.Triggers | ForEach-Object {
    $interval = ''; $duration = ''
    if ($null -ne $_.Repetition) { $interval = [string]$_.Repetition.Interval; $duration = [string]$_.Repetition.Duration }
    [ordered]@{
      type = $(if ($_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') { 'AtLogOn' } else { 'OTHER:' + [string]$_.CimClass.CimClassName })
      userId = (SidValue $_.UserId); enabled = [bool]$_.Enabled; delay = [string]$_.Delay
      repetitionInterval = $interval; repetitionDuration = $duration
      startBoundary = [string]$_.StartBoundary; endBoundary = [string]$_.EndBoundary
    }
  })
  $p = $task.Principal
  $s = $task.Settings
  $multipleInstances = [string]$s.MultipleInstances
  if ($multipleInstances -eq '2') { $multipleInstances = 'IgnoreNew' }
  if ($multipleInstances -eq '0') { $multipleInstances = 'Parallel' }
  if ($multipleInstances -eq '1') { $multipleInstances = 'Queue' }
  if ($multipleInstances -eq '3') { $multipleInstances = 'StopExisting' }
  $logonType = [string]$p.LogonType
  if ($logonType -eq 'Interactive' -or $logonType -eq '3') { $logonType = 'InteractiveToken' }
  $runLevel = [string]$p.RunLevel
  if ($runLevel -eq 'LeastPrivilege' -or $runLevel -eq '0') { $runLevel = 'Limited' }
  if ($runLevel -eq 'HighestAvailable' -or $runLevel -eq '1') { $runLevel = 'Highest' }
  [ordered]@{
    taskName = [string]$name
    taskPath = '\'
    actions = $actions
    triggers = $triggers
    principal = [ordered]@{ userId = (SidValue $p.UserId); logonType = $logonType; runLevel = $runLevel }
    settings = [ordered]@{
      startWhenAvailable = [bool]$s.StartWhenAvailable
      multipleInstances = $multipleInstances
      executionTimeLimit = (SpanValue $s.ExecutionTimeLimit)
      restartCount = [int]$s.RestartCount
      restartInterval = (SpanValue $s.RestartInterval)
    }
    registrationInfo = [ordered]@{ description = [string]$task.Description }
  }
}
try {
  $request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
  if ($request.operation -eq 'capability') {
    $module = Get-Module -ListAvailable -Name ScheduledTasks | Select-Object -First 1
    $requiredParameters = @{
      'Get-ScheduledTask' = @('TaskPath','TaskName')
      'New-ScheduledTask' = @('Action','Trigger','Principal','Settings','Description')
      'New-ScheduledTaskAction' = @('Execute','Argument','WorkingDirectory')
      'New-ScheduledTaskTrigger' = @('AtLogOn','User')
      'New-ScheduledTaskPrincipal' = @('UserId','LogonType','RunLevel')
      'New-ScheduledTaskSettingsSet' = @('StartWhenAvailable','MultipleInstances','ExecutionTimeLimit','RestartCount','RestartInterval')
      'Register-ScheduledTask' = @('TaskPath','TaskName','InputObject')
      'Unregister-ScheduledTask' = @('TaskPath','TaskName','Confirm')
    }
    $available = $null -ne $module
    foreach ($name in $requiredParameters.Keys) {
      $command = Get-Command $name -ErrorAction SilentlyContinue
      if (-not $command) { $available = $false; continue }
      foreach ($parameter in $requiredParameters[$name]) { if (-not $command.Parameters.ContainsKey($parameter)) { $available = $false } }
    }
    Out @{ ok = $true; available = $available }; exit 0
  }
  if ($request.operation -eq 'current-user-sid') {
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Out @{ ok = $true; sid = $sid }; exit 0
  }
  Import-Module ScheduledTasks -ErrorAction Stop
  $d = $request.definition
  $name = [string]$d.taskName
  if ($request.operation -eq 'inspect') {
    $task = GetRootTask $name
    if ($null -eq $task) { Out @{ ok = $true; exists = $false }; exit 0 }
    $expected = BuildExpected $d
    $actualShape = ConvertTo-Json -InputObject (TaskShape $task $name) -Depth 24 -Compress
    $expectedShape = ConvertTo-Json -InputObject (TaskShape $expected $name) -Depth 24 -Compress
    $exact = $actualShape -ceq $expectedShape
    if ($exact) { Out @{ ok = $true; exists = $true; exact = $true; definition = (Normalize $task $name) } }
    else { Out @{ ok = $true; exists = $true; exact = $false } }
    exit 0
  }
  if ($request.operation -eq 'register') {
    $existing = GetRootTask $name
    if ($null -ne $existing) { Out @{ ok = $false; code = 'TASK_CONFLICT' }; exit 0 }
    $scheduled = BuildExpected $d
    try { Register-ScheduledTask -TaskPath '\' -TaskName $name -InputObject $scheduled -ErrorAction Stop | Out-Null }
    catch {
      try { if ($null -ne (GetRootTask $name)) { Out @{ ok = $false; code = 'TASK_CONFLICT' }; exit 0 } }
      catch { }
      throw
    }
    Out @{ ok = $true }; exit 0
  }
  if ($request.operation -eq 'remove-if-exact') {
    $task = GetRootTask $name
    if ($null -eq $task) { Out @{ ok = $true; removed = $false; absent = $true }; exit 0 }
    $expected = BuildExpected $d
    $actualJson = ConvertTo-Json -InputObject (TaskShape $task $name) -Depth 24 -Compress
    $expectedJson = ConvertTo-Json -InputObject (TaskShape $expected $name) -Depth 24 -Compress
    if ($actualJson -cne $expectedJson) { Out @{ ok = $true; removed = $false; absent = $false }; exit 0 }
    Unregister-ScheduledTask -TaskPath '\' -TaskName $name -Confirm:$false -ErrorAction Stop | Out-Null
    Out @{ ok = $true; removed = $true; absent = $false }; exit 0
  }
  Out @{ ok = $false; code = 'TASK_OPERATION_FAILED' }; exit 0
} catch {
  $code = 'TASK_OPERATION_FAILED'
  try { if ($_.Exception.HResult -eq -2147024891) { $code = 'PERMISSION_DENIED' } } catch { }
  Out @{ ok = $false; code = $code }; exit 0
}
`;

type PowerShellResponse = { ok: boolean; available?: boolean; sid?: string; exists?: boolean; exact?: boolean; definition?: unknown; removed?: boolean; absent?: boolean; code?: WindowsTaskErrorCode };

function runPowerShellTaskOperation(operation: string, payload: Record<string, unknown> = {}): PowerShellResponse {
  if (process.platform !== "win32") throw new WindowsTaskError("UNSUPPORTED_PLATFORM");
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new WindowsTaskError("SCHEDULER_UNAVAILABLE");
  const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(POWERSHELL_TASK_SCRIPT, "utf16le").toString("base64");
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PSModulePath", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    input: JSON.stringify({ operation, ...payload }), encoding: "utf8", windowsHide: true,
    timeout: 12_000, maxBuffer: 128 * 1024, env,
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new WindowsTaskError("SCHEDULER_UNAVAILABLE");
    throw new WindowsTaskError("TASK_OPERATION_FAILED");
  }
  let response: PowerShellResponse;
  try { response = JSON.parse(result.stdout.trim()) as PowerShellResponse; }
  catch { throw new WindowsTaskError("TASK_OPERATION_FAILED"); }
  if (!response || typeof response.ok !== "boolean") throw new WindowsTaskError("TASK_OPERATION_FAILED");
  if (!response.ok) throw new WindowsTaskError(response.code ?? "TASK_OPERATION_FAILED");
  return response;
}

export const windowsTaskBackend: WindowsTaskBackend = {
  platform: process.platform,
  capability() {
    try {
      const result = runPowerShellTaskOperation("capability");
      return result.available ? { available: true } : { available: false, errorCode: "SCHEDULER_UNAVAILABLE" };
    } catch (error) {
      return { available: false, errorCode: error instanceof WindowsTaskError && error.code === "UNSUPPORTED_PLATFORM" ? "UNSUPPORTED_PLATFORM" : "SCHEDULER_UNAVAILABLE" };
    }
  },
  currentUserSid() {
    try {
      const sid = runPowerShellTaskOperation("current-user-sid").sid;
      return sid && userSidSchema.safeParse(sid).success ? sid : null;
    } catch { return null; }
  },
  read(taskName, expected) {
    const result = runPowerShellTaskOperation("inspect", { definition: expected });
    return result.exists ? { exists: true, definition: result.definition, exact: result.exact === true } : { exists: false };
  },
  register(definition) {
    runPowerShellTaskOperation("register", { definition });
  },
  removeIfExact(definition) {
    const result = runPowerShellTaskOperation("remove-if-exact", { definition });
    return result.removed === true || result.absent === true;
  },
};
