import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupStrict } from "./strict-teardown.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = path.join(projectRoot, ".tooling", "test-tmp");
const diagnosticRoot = path.join(projectRoot, ".tooling", "supervisor-acl-diagnostics");

export type SupervisorAclCall = {
  targets: unknown; durationMs: number; scriptSha256: string; success: boolean;
  output?: string;
  error?: { code: unknown; status: unknown; signal: unknown; stdout: string; stderr: string };
};

/** 仅测试观察：参数、返回值、异常和调用方 deadline 均原样透传。 */
export function observeSupervisorAclCall(records: SupervisorAclCall[], call: typeof execFileSync): typeof execFileSync {
  return ((file, args, options) => {
    const environment = options?.env;
    if (!environment?.C2C_SUPERVISOR_ACL_TARGETS) return call(file, args, options);
    const startedAt = performance.now();
    const record: SupervisorAclCall = {
      targets: JSON.parse(environment.C2C_SUPERVISOR_ACL_TARGETS), durationMs: 0, success: false,
      scriptSha256: createHash("sha256").update(args?.at(-1) ?? "").digest("hex"),
    };
    try {
      const output = call(file, args, options);
      record.success = true;
      record.output = String(output).slice(0, 16384);
      return output;
    } catch (error) {
      const detail = error as NodeJS.ErrnoException & { status?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown };
      record.error = { code: detail?.code, status: detail?.status, signal: detail?.signal,
        stdout: String(detail?.stdout ?? "").slice(0, 16384), stderr: String(detail?.stderr ?? "").slice(0, 16384) };
      throw error;
    } finally {
      record.durationMs = performance.now() - startedAt;
      records.push(record);
    }
  }) as typeof execFileSync;
}

function assertFixtureRoot(root: string): void {
  const relative = path.relative(tempRoot, path.resolve(root));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("diagnostic fixture outside test-tmp");
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(root).toLowerCase() !== path.resolve(root).toLowerCase()) {
    throw new Error("diagnostic fixture root is not canonical");
  }
}

const PREPARE_STORE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$target = [string](@(ConvertFrom-Json -InputObject $env:C2C_SUPERVISOR_ACL_TARGETS)[0].path)
$directory = Get-Item -LiteralPath $target -Force
if (-not $directory.PSIsContainer -or ($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'fixture is not an ordinary directory' }
$acl = Get-Acl -LiteralPath $target
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
$identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
$acl.SetOwner($identity)
$inheritance = [System.Security.AccessControl.InheritanceFlags]([int][System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [int][System.Security.AccessControl.InheritanceFlags]::ObjectInherit)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity,
  [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
[Console]::Out.WriteLine('OK:' + $sid)
`;

/** 只初始化新 fixture 目录；后续真实 store 入口仍校验 ACL 和启动身份。 */
export function prepareSupervisorFixtureStore(stateDir: string): void {
  const root = path.resolve(stateDir);
  assertFixtureRoot(root);
  const directory = path.join(root, "bridge-supervisor");
  fs.mkdirSync(directory, { mode: 0o700 });
  assertFixtureRoot(directory);
  if (process.platform !== "win32") {
    fs.chmodSync(directory, 0o700);
    return;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const output = execFileSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PREPARE_STORE_ACL], {
    encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024, stdio: "pipe",
    env: { SystemRoot: systemRoot, WINDIR: process.env.WINDIR ?? systemRoot, PATH: process.env.PATH ?? "",
      TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "", USERPROFILE: process.env.USERPROFILE ?? "",
      C2C_SUPERVISOR_ACL_TARGETS: JSON.stringify([{ path: directory, mode: "set-directory" }]) },
  });
  if (!/^OK:S-\d(?:-\d+)+\s*$/.test(output)) throw new Error("invalid fixture ACL output");
}

const READ_ACLS = String.raw`
$ErrorActionPreference = 'Stop'
foreach ($target in @(ConvertFrom-Json -InputObject $env:C2C_TEST_ACL_PATHS)) {
  $acl = Get-Acl -LiteralPath $target
  [ordered]@{path=$target;ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
    protected=$acl.AreAccessRulesProtected;sddl=$acl.Sddl;
    rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      [ordered]@{sid=$_.IdentityReference.Value;rights=[int64]$_.FileSystemRights;type=$_.AccessControlType.ToString();
        inherited=$_.IsInherited;inheritance=$_.InheritanceFlags.ToString();propagation=$_.PropagationFlags.ToString()}
    })} | ConvertTo-Json -Compress -Depth 5
}
`;

/** 失败副本只在 ignored 目录；链接仅保存元数据，绝不跟随到其它项目。 */
export function preserveSupervisorFailure(name: string, roots: string[], calls: SupervisorAclCall[], errors: unknown): string {
  roots.forEach(assertFixtureRoot);
  const destination = path.join(diagnosticRoot, randomUUID());
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const entries: Array<{ path: string; copy: string; kind: string; mode: number; nlink: number; target?: string }> = [];
  const aclPaths: string[] = [];
  function copy(source: string, target: string): void {
    const stat = fs.lstatSync(source);
    const entry = { path: source, copy: target, mode: stat.mode, nlink: stat.nlink };
    if (stat.isSymbolicLink()) {
      entries.push({ ...entry, kind: "link", target: fs.readlinkSync(source) });
      return;
    }
    aclPaths.push(source);
    if (stat.isDirectory()) {
      fs.mkdirSync(target, { mode: stat.mode & 0o777 });
      entries.push({ ...entry, kind: "directory" });
      for (const child of fs.readdirSync(source)) copy(path.join(source, child), path.join(target, child));
    } else if (stat.isFile()) {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      entries.push({ ...entry, kind: "file" });
    } else throw new Error("unsupported fixture entry");
  }
  roots.forEach((root, index) => copy(root, path.join(destination, `${index}-${path.basename(root)}`)));
  fs.writeFileSync(path.join(destination, "fixture.json"), JSON.stringify({ name, roots, entries, calls, errors }, null, 2));
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    try {
      const output = execFileSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", READ_ACLS], {
        encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024, stdio: "pipe",
        env: { SystemRoot: systemRoot, WINDIR: process.env.WINDIR ?? systemRoot, PATH: process.env.PATH ?? "",
          TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "", USERPROFILE: process.env.USERPROFILE ?? "",
          C2C_TEST_ACL_PATHS: JSON.stringify(aclPaths) },
      });
      fs.writeFileSync(path.join(destination, "original-acls.jsonl"), output);
    } catch (error) {
      const detail = error as NodeJS.ErrnoException & { status?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown };
      fs.writeFileSync(path.join(destination, "acl-capture-error.json"), JSON.stringify({ code: detail.code, status: detail.status,
        signal: detail.signal, stdout: String(detail.stdout ?? "").slice(0, 16384), stderr: String(detail.stderr ?? "").slice(0, 16384) }, null, 2));
      // ACL 快照未完成时保留 exact 原目录；不重试，不让诊断丢失替代原失败。
      throw new Error(`supervisor ACL snapshot failed; original fixtures retained; evidence: ${destination}`);
    }
  }
  return destination;
}

export async function finishSupervisorFixtures(failed: boolean, name: string, roots: string[], calls: SupervisorAclCall[], errors: unknown): Promise<string | null> {
  const evidence = failed ? preserveSupervisorFailure(name, roots, calls, errors) : null;
  await cleanupStrict(...roots);
  return evidence;
}
