// Experimental Windows full gate; the serial pnpm test command remains authoritative.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { computeBuildId } from './write-build-id.mjs';
import release from './core-release.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phases = ['packaging', 'serial', 'parallel'];
// Current exhaustive inventory, including the supervisor foundation regressions.
// R5j remains deferred; this is a coverage guard, not candidate acceptance evidence.
export const expectedTests = 3403;
export const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function treeSnapshot(directory, prefix = '') {
  const entries = {};
  for (const item of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw new Error(`unexpected tree link: ${relative}`);
    if (item.isDirectory()) {
      entries[`${relative}/`] = 'directory';
      Object.assign(entries, treeSnapshot(directory, relative));
    } else if (item.isFile()) entries[relative] = hashFile(path.join(directory, relative));
    else throw new Error(`unexpected tree entry: ${relative}`);
  }
  return entries;
}

export function validateInventory(directory, manifest) {
  const discovered = Object.keys(treeSnapshot(path.join(directory, 'tests')))
    .filter(file => file.endsWith('.test.ts')).map(file => `tests/${file}`).sort();
  const files = manifest.files.map(entry => entry.file);
  if (new Set(files).size !== files.length || JSON.stringify([...files].sort()) !== JSON.stringify(discovered)) {
    throw new Error('classification missing/duplicate/unclassified test file');
  }
  for (const entry of manifest.files) {
    if (!phases.includes(entry.group) || !['none', 'read', 'write'].includes(entry.dist)) throw new Error('invalid classification');
    if (entry.dist === 'write' && entry.group !== 'packaging') throw new Error('shared-dist writer outside exclusive barrier');
    if (hashFile(path.join(directory, entry.file)) !== entry.sha256) throw new Error(`reaudit changed test: ${entry.file}`);
  }
  const support = Object.keys(treeSnapshot(path.join(directory, 'tests')))
    .filter(file => !file.endsWith('/') && !file.endsWith('.test.ts') && !file.includes('__pycache__/') && !file.endsWith('.pyc'))
    .map(file => `tests/${file}`);
  support.push(...Object.keys(treeSnapshot(path.join(directory, 'scripts')))
    .filter(file => !file.endsWith('/') && file !== 'test-full-candidate-manifest.json').map(file => `scripts/${file}`));
  support.push('vitest.config.ts', 'package.json');
  if (JSON.stringify(support.sort()) !== JSON.stringify(Object.keys(manifest.support).sort())) throw new Error('reaudit changed shared support inventory');
  for (const file of support) {
    if (hashFile(path.join(directory, file)) !== manifest.support[file]) throw new Error(`reaudit changed shared support: ${file}`);
  }
  const barrier = manifest.files.filter(entry => entry.group === 'packaging');
  if (!barrier.some(entry => entry.file === 'tests/desktop-helper-packaging.test.ts')) throw new Error('missing packaging barrier');
  for (const name of ['bridge-parent-death', 'daemon-parent-death', 'daemon-spawn', 'runtime', 'windows-process', 'web-control-cli']) {
    if (!manifest.files.some(entry => entry.file === `tests/${name}.test.ts` && entry.group === 'serial')) throw new Error(`missing serial fence: ${name}`);
  }
  return Object.fromEntries(phases.map(phase => [phase, manifest.files.filter(entry => entry.group === phase).map(entry => entry.file).sort()]));
}

export function validateReport(report, expected) {
  const actual = report.files.map(file => file.file);
  if (new Set(actual).size !== actual.length || JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) throw new Error('executed file set mismatch');
  if (report.reason !== 'passed' || report.errors || report.files.some(file => file.state !== 'passed' || file.tests.some(test => test.state !== 'passed'))) throw new Error('failed/skipped/pending tests');
  return report.files.reduce((sum, file) => sum + file.tests.length, 0);
}

export function validateCoverage(files, tests, expectedFiles) {
  if (files !== expectedFiles || tests !== expectedTests) throw new Error('aggregate coverage differs from frozen full suite');
}

function machineSnapshot() {
  // No command lines/environment/credentials; preserve exact Windows creation timestamps.
  const script = `$p=@(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -ne $PID} | Select-Object ProcessId,ParentProcessId,Name,@{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}}); $l=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Select-Object LocalAddress,LocalPort,OwningProcess); @{processes=$p;listeners=$l} | ConvertTo-Json -Depth 5 -Compress`;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }));
}

function validCreated(value) {
  // Fixed-width UTC strings retain 100ns precision that Date.parse would discard.
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}

export function identifyRunner(snapshot, pid = process.pid) {
  const matches = snapshot.processes.filter(p => p.ProcessId === pid);
  if (!Number.isSafeInteger(pid) || pid <= 0 || matches.length !== 1 || !validCreated(matches[0].Created)) {
    throw new Error('candidate runner exact identity missing/ambiguous');
  }
  return { ProcessId: pid, Created: matches[0].Created };
}

export function machineLeaks(before, after, runnerPid = process.pid) {
  const runner = identifyRunner(before, runnerPid);
  const identity = p => `${p.ProcessId}/${p.Created}`;
  const keys = new Set(before.processes.map(identity));
  const globalNew = after.processes.filter(p => !keys.has(identity(p)) && /^(node|python(?:w|3(?:\.\d+)?)?|git|cmd|powershell|pwsh|cloudflared)\.exe$/i.test(p.Name));
  function ancestry(child) {
    const visited = new Set();
    while (child) {
      if (!Number.isSafeInteger(child.ProcessId) || child.ProcessId <= 0 ||
          !validCreated(child.Created) || visited.has(identity(child))) return 'ambiguous';
      visited.add(identity(child));
      const current = after.processes.filter(p => p.ProcessId === child.ProcessId);
      const previous = before.processes.filter(p => p.ProcessId === child.ProcessId);
      if (current.length !== 1 || previous.length > 1 ||
          (previous.length && (!validCreated(previous[0].Created) || previous[0].Created > child.Created))) return 'ambiguous';
      if (previous.length && previous[0].Created === child.Created && previous[0].ParentProcessId !== child.ParentProcessId) return 'ambiguous';
      if (child.ProcessId === runner.ProcessId) return child.Created === runner.Created ? 'attributed' : 'ambiguous';
      if (keys.has(identity(child))) return 'unrelated';
      const parents = after.processes.filter(p => p.ProcessId === child.ParentProcessId);
      // A pre-run-only parent may have exited and had its PID reused during the run.
      // Without an after identity spanning the child's creation it cannot exclude a leak.
      if (parents.length !== 1 || !validCreated(parents[0].Created) || parents[0].Created > child.Created) return 'ambiguous';
      child = parents[0];
    }
    return 'ambiguous';
  }
  const classified = globalNew.map(p => ({ process: p, attribution: ancestry(p) }));
  const processes = classified.filter(p => p.attribution !== 'unrelated').map(p => p.process);
  const pids = new Set(processes.map(p => p.ProcessId));
  const listeners = after.listeners.filter(p => pids.has(p.OwningProcess));
  return { processes, listeners, globalNewProcessCount: globalNew.length,
    attributedProcessCount: classified.filter(p => p.attribution === 'attributed').length,
    ambiguousProcessCount: classified.filter(p => p.attribution === 'ambiguous').length,
    unrelatedProcessCount: classified.filter(p => p.attribution === 'unrelated').length };
}

async function runPhase(phase, files, output) {
  const workers = phase === 'parallel' ? 3 : 1;
  const config = path.join(output, `${phase}.config.mjs`);
  const report = path.join(output, `${phase}.json`);
  // Reuse the canonical config; only the exhaustive include partition/workers/reporters differ.
  fs.writeFileSync(config, `import base from ${JSON.stringify(pathToFileURL(path.join(root, 'vitest.config.ts')).href)};\nexport default {...base,test:{...base.test,include:${JSON.stringify(files)}}};\n`);
  const started = performance.now(), startedAt = Date.now();
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
      `--maxWorkers=${workers}`, '--testTimeout=90000', '--reporter=default', '--reporter=./scripts/test-full-candidate-reporter.mjs'],
    { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, C2C_CANDIDATE_REPORT: report } });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
  const result = { phase, workers, startedAt, endedAt: Date.now(), seconds: (performance.now() - started) / 1000, exitCode: code };
  if (!fs.existsSync(report)) return { ...result, files: 0, tests: 0, error: 'missing phase report' };
  const data = JSON.parse(fs.readFileSync(report, 'utf8'));
  result.files = data.files.length;
  result.tests = data.files.reduce((sum, file) => sum + file.tests.length, 0);
  try { validateReport(data, files); } catch (error) { result.error = error.message; }
  return result;
}

export async function main() {
  if (process.platform !== 'win32') throw new Error('candidate acceptance currently requires Windows; use the canonical serial gate elsewhere');
  process.chdir(root);
  const started = performance.now();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'scripts/test-full-candidate-manifest.json'), 'utf8'));
  const groups = validateInventory(root, manifest);
  const output = path.join(root, '.tooling/r5j-candidate', `${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(output, { recursive: true });
  const tempRoot = path.join(root, '.tooling/test-tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const beforeDirs = new Set(fs.readdirSync(tempRoot));
  const beforeMachine = machineSnapshot();
  const runnerIdentity = identifyRunner(beforeMachine);
  fs.writeFileSync(path.join(output, 'before.json'), JSON.stringify({ directories: [...beforeDirs], machine: beforeMachine, runnerIdentity }, null, 2));
  const result = { experimental: true, output, phases: [], errors: [] };
  async function execute(phase) {
    const measured = await runPhase(phase, groups[phase], output);
    result.phases.push(measured);
    if (measured.exitCode !== 0 || measured.error) throw new Error(`${phase}: exit=${measured.exitCode} ${measured.error ?? ''}`);
  }
  let dist;
  try {
    await execute('packaging');
    const distRoot = path.join(root, 'dist');
    const stored = fs.readFileSync(path.join(distRoot, 'build-id.txt'), 'utf8').trim();
    if (stored !== computeBuildId(distRoot) || stored !== release.buildId(distRoot)) throw new Error('barrier build identity mismatch');
    result.buildId = stored;
    dist = treeSnapshot(distRoot);
    fs.writeFileSync(path.join(output, 'dist-after-barrier.json'), JSON.stringify(dist, null, 2));
    for (const phase of ['serial', 'parallel']) await execute(phase);
    const files = result.phases.reduce((sum, phase) => sum + phase.files, 0);
    const tests = result.phases.reduce((sum, phase) => sum + phase.tests, 0);
    result.files = files; result.tests = tests;
    validateCoverage(files, tests, manifest.files.length);
    validateInventory(root, manifest);
  } catch (error) { result.errors.push(error.message); }
  result.files = result.phases.reduce((sum, phase) => sum + phase.files, 0);
  result.tests = result.phases.reduce((sum, phase) => sum + phase.tests, 0);
  // Observe bounded teardown; never delete residues or kill unknown PIDs to make a gate green.
  const deadline = Date.now() + 4000;
  do {
    result.newDirectories = fs.readdirSync(tempRoot).filter(name => !beforeDirs.has(name));
    if (!result.newDirectories.length) break;
    await delay(100);
  } while (Date.now() < deadline);
  const afterMachine = machineSnapshot();
  result.leaks = machineLeaks(beforeMachine, afterMachine);
  result.distUnchanged = !!dist && JSON.stringify(dist) === JSON.stringify(treeSnapshot(path.join(root, 'dist')));
  fs.writeFileSync(path.join(output, 'after.json'), JSON.stringify(afterMachine, null, 2));
  if (result.newDirectories.length) result.errors.push('new test-tmp residue');
  if (result.leaks.processes.length || result.leaks.listeners.length) result.errors.push('candidate-attributed/ambiguous test-capable process/listener survived');
  if (!result.distUnchanged) result.errors.push('checkout dist changed after barrier');
  result.seconds = (performance.now() - started) / 1000;
  result.exitCode = result.errors.length ? 1 : 0;
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
