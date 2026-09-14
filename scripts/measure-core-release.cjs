#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_HELPER = path.join(__dirname, "core-release.cjs");
const OPERATIONS = ["readdir", "stat", "lstat", "realpath", "readFile"];
const SCOPES = ["total", "state", "release", "nodeModules", "other"];

function emptyCounts() {
  return { readdir: 0, stat: 0, lstat: 0, realpath: 0, readFile: 0, readBytes: 0 };
}

function newCounters() {
  return Object.fromEntries(SCOPES.map(scope => [scope, emptyCounts()]));
}

function pathValue(value) {
  try {
    return path.resolve(typeof value === "string" || Buffer.isBuffer(value) ? value.toString() : value);
  } catch {
    return "";
  }
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function hasNodeModulesSegment(target) {
  return target.split(/[\\/]+/).some(segment => segment.toLowerCase() === "node_modules");
}

function scopesFor(target, stateDir) {
  const value = pathValue(target);
  if (!value) return ["total", "other"];
  const stateRoot = path.resolve(stateDir);
  const releaseRoot = path.join(stateRoot, "releases");
  const inState = within(stateRoot, value);
  const inRelease = within(releaseRoot, value);
  return [
    "total",
    ...(inState ? ["state"] : []),
    ...(inRelease ? ["release"] : []),
    ...(hasNodeModulesSegment(value) ? ["nodeModules"] : []),
    ...(inState ? [] : ["other"]),
  ];
}

function readBytes(value, options) {
  if (Buffer.isBuffer(value)) return value.length;
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof value !== "string") return 0;
  const encoding = typeof options === "string" ? options : options?.encoding;
  return Buffer.byteLength(value, encoding || "utf8");
}

function record(counters, operation, target, stateDir, bytes = 0) {
  for (const scope of scopesFor(target, stateDir)) {
    counters[scope][operation]++;
    if (operation === "readFile") counters[scope].readBytes += bytes;
  }
}

function instrument(stateDir, counters) {
  const methods = {
    readdir: "readdirSync",
    stat: "statSync",
    lstat: "lstatSync",
    realpath: "realpathSync",
    readFile: "readFileSync",
  };
  const originals = {};
  for (const [operation, method] of Object.entries(methods)) {
    originals[method] = fs[method];
    fs[method] = function measuredFsMethod(...args) {
      record(counters, operation, args[0], stateDir);
      const result = originals[method].apply(this, args);
      if (operation === "readFile") {
        const bytes = readBytes(result, args[1]);
        if (bytes) {
          for (const scope of scopesFor(args[0], stateDir)) counters[scope].readBytes += bytes;
        }
      }
      return result;
    };
  }
  return () => {
    for (const method of Object.keys(originals)) fs[method] = originals[method];
  };
}

function loadHelper(helper = DEFAULT_HELPER) {
  if (typeof helper !== "string") return helper;
  return require(path.resolve(helper));
}

function safeError(error, stateDir) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(path.resolve(stateDir), "<stateDir>");
}

function measureReadCurrent(options = {}) {
  const requestedStateDir = options.stateDir || process.env.C2C_STATE_DIR;
  if (!requestedStateDir || typeof requestedStateDir !== "string") throw new Error("stateDir 必须是有效路径");
  const stateDir = path.resolve(requestedStateDir);
  const mode = options.mode || "full";
  if (mode !== "fast" && mode !== "full") throw new Error("mode 必须是 fast 或 full");
  const helper = loadHelper(options.helper || DEFAULT_HELPER);
  const counters = newCounters();
  const restore = instrument(stateDir, counters);
  const started = process.hrtime.bigint();
  let error;
  try {
    if (!helper.readCurrent(stateDir, mode)) throw new Error("current pointer 缺失，无法测量已安装 release");
  } catch (cause) {
    error = cause;
  } finally {
    restore();
  }
  const wallTimeMs = Number(process.hrtime.bigint() - started) / 1e6;
  const result = { status: error ? "error" : "ok", mode, wallTimeMs, io: counters };
  if (error) result.error = safeError(error, stateDir);
  return result;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(samples) {
  const result = { wallTimeMs: median(samples.map(sample => sample.wallTimeMs)), io: {} };
  for (const scope of SCOPES) {
    result.io[scope] = {};
    for (const operation of [...OPERATIONS, "readBytes"]) {
      result.io[scope][operation] = median(samples.map(sample => sample.io[scope][operation]));
    }
  }
  return result;
}

function environment() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuCount: os.cpus().length,
    totalMemoryMiB: Math.round(os.totalmem() / 1024 / 1024),
  };
}

function selfTest() {
  const stateDir = __dirname;
  const helper = {
    readCurrent(receivedStateDir, mode) {
      assert.strictEqual(receivedStateDir, stateDir);
      assert.strictEqual(mode, "full");
      fs.readdirSync(__dirname);
      fs.statSync(__filename);
      fs.lstatSync(__filename);
      fs.realpathSync(__filename);
      fs.readFileSync(__filename);
      return { version: 2 };
    },
  };
  const result = measureReadCurrent({ helper, stateDir, mode: "full" });
  assert.strictEqual(result.status, "ok");
  for (const operation of OPERATIONS) assert.ok(result.io.total[operation] >= 1, operation);
  assert.ok(result.io.total.readBytes > 0);
  const originalRead = fs.readFileSync;
  const failed = measureReadCurrent({ stateDir, helper: { readCurrent() { throw new Error("injected failure"); } } });
  assert.strictEqual(failed.status, "error");
  assert.strictEqual(fs.readFileSync, originalRead);
  assert.strictEqual(measureReadCurrent({ stateDir, helper: { readCurrent() { return null; } } }).status, "error");
  return { ok: true, selfTest: "passed" };
}

function help() {
  return [
    "用法: node scripts/measure-core-release.cjs --state-dir <目录> [选项]",
    "  --helper <文件>       指定导出 readCurrent 的 CommonJS helper",
    "  --mode <fast|full>    传给 readCurrent 的测量模式，默认 full",
    "  --runs <次数>         在同一进程重复只读测量，默认 1",
    "  --self-test           运行不写文件的计数器自检",
    "  --help                显示帮助",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { mode: "full", runs: 1 };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const [inlineName, inlineValue] = argument.split("=", 2);
    const name = inlineName === "--stateDir" ? "--state-dir" : inlineName;
    if (name === "--help" || name === "-h") return { help: true };
    if (name === "--self-test") { options.selfTest = true; continue; }
    if (!["--helper", "--state-dir", "--mode", "--runs"].includes(name)) throw new Error(`未知参数: ${argument}`);
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`参数缺少值: ${name}`);
    if (name === "--helper") options.helper = value;
    if (name === "--state-dir") options.stateDir = value;
    if (name === "--mode") options.mode = value;
    if (name === "--runs") options.runs = Number(value);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 1000) throw new Error("runs 必须是 1 到 1000 的整数");
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(`${help()}\n`); return; }
  if (options.selfTest) { process.stdout.write(`${JSON.stringify(selfTest())}\n`); return; }
  if (!options.stateDir && !process.env.C2C_STATE_DIR) throw new Error("必须指定 --state-dir 或 C2C_STATE_DIR");
  const helper = loadHelper(options.helper || DEFAULT_HELPER);
  const samples = Array.from({ length: options.runs }, () => measureReadCurrent({
    helper, stateDir: options.stateDir || process.env.C2C_STATE_DIR, mode: options.mode,
  }));
  const report = {
    schemaVersion: 1,
    helper: path.basename(options.helper || DEFAULT_HELPER),
    mode: options.mode,
    runs: options.runs,
    environment: environment(),
    samples,
    median: summarize(samples),
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (samples.some(sample => sample.status === "error")) process.exitCode = 1;
}

module.exports = { measureReadCurrent, summarize, newCounters };

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`测量失败: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
