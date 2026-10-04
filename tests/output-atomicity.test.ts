import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { isolateStateDir, cleanup } from "./helpers.js";
import { saveExecutionOutput, listExecutionOutputs, readExecutionOutput, readExecutionOutputIndexStrict } from "../src/execution/output.js";
import { appendExecutionRecord, appendExecutionRecordLocked, readExecutionRecordsStrict, withExecutionRecordsLockAsync } from "../src/execution/records.js";

let dir: string;
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); if (dir) cleanup(dir); delete process.env.C2C_STATE_DIR; });

function shortLockStore(kind: string, workspaceId: string) {
  const record = { taskId: "lock-regression", iteration: 0, changedFiles: [], tests: null, exitStatus: "ok", timestamp: "2026-10-03T00:00:00.000Z" };
  return {
    busy: kind === "output" ? "OUTPUT_STORE_BUSY" : "EXECUTION_RECORDS_BUSY",
    lock: kind === "output" ? path.join(dir, "execution-outputs", workspaceId, "index.json.lock") : path.join(dir, "executions", `${workspaceId}.jsonl.lock`),
    write: () => kind === "output" ? saveExecutionOutput(workspaceId, { command: "one", raw: "one" })
      : kind === "sync" ? appendExecutionRecord(workspaceId, record)
      : withExecutionRecordsLockAsync(workspaceId, async () => appendExecutionRecordLocked(workspaceId, record)),
    count: () => {
      if (kind !== "output") return readExecutionRecordsStrict(workspaceId).length;
      // Inspect this owned fixture directly: public list/read themselves acquire a lock.
      const index = path.join(dir, "execution-outputs", workspaceId, "index.json");
      return fs.existsSync(index) ? JSON.parse(fs.readFileSync(index, "utf8")).items.length : 0;
    },
  };
}

async function verifyAcquisitionPolicy() {
  // Extend this existing regression instead of changing the frozen 3054-case inventory.
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const platforms = process.platform === "win32" ? ["win32", "linux"] : [process.platform];
  try {
    for (const os of platforms) for (const kind of ["output", "sync", "async"]) {
      Object.defineProperty(process, "platform", { ...platform, value: os });
      for (const code of ["EEXIST", "EPERM", "EACCES", "ENOENT", "EIO"]) for (const persistent of [false, true]) {
        const store = shortLockStore(kind, `${os}-${kind}-${code}-${persistent}`);
        const fault = Object.assign(new Error("acquisition fault"), { code });
        const open = fs.openSync;
        let attempts = 0;
        vi.useFakeTimers(); vi.setSystemTime(0);
        const wait = vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, ms) => {
          expect(ms).toBe(10); vi.advanceTimersByTime(ms!); return "timed-out";
        });
        vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
          if (file === store.lock && flags === "wx") {
            attempts++;
            if (persistent || attempts === 1) throw fault;
          }
          return open(file, flags, mode);
        });
        // Observe rejection immediately; fake timers exercise async 10ms waits without real sleeps.
        const outcome = Promise.resolve().then(store.write).then(() => null, error => error);
        await vi.runAllTimersAsync();
        const error = await outcome;
        const retryable = code === "EEXIST" || (os === "win32" && ["EPERM", "EACCES"].includes(code));
        if (!retryable) {
          expect(error).toBe(fault); expect(attempts).toBe(1); expect(Date.now()).toBe(0);
          expect(store.count()).toBe(0);
        } else if (persistent) {
          expect(error).toMatchObject({ code: store.busy }); expect(attempts).toBe(51);
          expect(Date.now()).toBe(500); expect(store.count()).toBe(0);
        } else {
          expect(error).toBeNull(); expect(attempts).toBe(2); expect(Date.now()).toBe(10);
          expect(store.count()).toBe(1);
        }
        if (kind === "async") expect(wait).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expect(fs.existsSync(store.lock)).toBe(false);
        vi.restoreAllMocks(); vi.useRealTimers();
      }
    }
  } finally {
    Object.defineProperty(process, "platform", platform);
    vi.restoreAllMocks(); vi.useRealTimers();
  }
}

async function verifyPostWriteErrors() {
  for (const kind of ["output", "sync", "async"]) for (const stage of kind === "output" ? ["unlink"] : ["unlink", "fsync"]) {
    const workspaceId = `post-${kind}-${stage}`, store = shortLockStore(kind, workspaceId);
    const fault = Object.assign(new Error("possible committed mutation"), { code: "EPERM" });
    const unlink = fs.unlinkSync, open = fs.openSync, sync = fs.fsyncSync;
    const indexRename = fs.renameSync;
    let recordFd: number | undefined, committed = false, calls = 0;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      const fd = open(file, flags, mode);
      if (flags === "a" && String(file).endsWith(`${workspaceId}.jsonl`)) recordFd = fd;
      return fd;
    });
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      indexRename(from, to);
      if (kind === "output" && String(to).endsWith("index.json")) committed = true;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      sync(fd);
      if (fd === recordFd) { committed = true; if (stage === "fsync") throw fault; }
    });
    vi.spyOn(fs, "unlinkSync").mockImplementation(file => {
      if (file === store.lock && stage === "unlink") throw fault;
      return unlink(file);
    });
    // A BUSY-only retrying caller must not duplicate a post-append/release failure.
    let failure: unknown;
    try {
      for (;;) {
        calls++;
        try { await store.write(); break; }
        catch (error) { if ((error as { code?: string }).code === store.busy && calls < 2) continue; throw error; }
      }
    } catch (error) { failure = error; }
    finally { vi.restoreAllMocks(); }
    expect(failure).toBe(fault); expect(calls).toBe(1); expect(committed).toBe(true);
    expect(store.count()).toBe(1);
    if (kind === "output") {
      expect(fs.readFileSync(path.join(dir, "execution-outputs", workspaceId, "bodies/1.txt"), "utf8")).toBe("one");
      expect(fs.readdirSync(path.join(dir, "execution-outputs", workspaceId, "bodies"))).toEqual(["1.txt"]);
    }
    expect(fs.existsSync(store.lock)).toBe(stage === "unlink");
    // No per-lock repair/reclaim: afterEach removes only the owned test fixture directory.
  }
}

it("strict index snapshot exposes allocation horizon without creating absent state or writing existing state", () => {
  dir = isolateStateDir();
  expect(readExecutionOutputIndexStrict("absent")).toEqual({ nextId: 1, items: [] });
  expect(fs.existsSync(path.join(dir, "execution-outputs"))).toBe(false);
  const meta = saveExecutionOutput("ws", { command: "one", raw: "one" });
  const file = path.join(dir, "execution-outputs/ws/index.json");
  const before = fs.readFileSync(file), stat = fs.statSync(file);
  const write = vi.spyOn(fs, "writeFileSync");
  expect(readExecutionOutputIndexStrict("ws")).toEqual({ nextId: meta.id + 1, items: [meta] });
  expect(write).not.toHaveBeenCalled();
  expect(fs.readFileSync(file)).toEqual(before);
  expect(fs.statSync(file).mtimeMs).toBe(stat.mtimeMs);
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
});

it.each(["replace", "corrupt", "next_id", "retention_future", "retention_conflict", "temp", "locked", "symlink"])("strict index rejects %s without repair", mode => {
  dir = isolateStateDir();
  saveExecutionOutput("ws", { command: "one", raw: "one" });
  const file = path.join(dir, "execution-outputs/ws/index.json");
  const read = fs.readFileSync;
  if (mode === "replace") vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    const content = (read as (...args: unknown[]) => unknown)(p, ...args);
    if (p === file) {
      // A valid atomic replacement during the read still invalidates this snapshot.
      fs.writeFileSync(`${file}.replacement`, content as string);
      fs.renameSync(`${file}.replacement`, file);
    }
    return content;
  }) as typeof fs.readFileSync);
  if (mode === "corrupt") fs.writeFileSync(file, "{");
  if (mode === "next_id") {
    const index = JSON.parse(read(file, "utf8")); index.nextId = index.items[0].id;
    fs.writeFileSync(file, JSON.stringify(index));
  }
  if (mode === "retention_future" || mode === "retention_conflict") {
    const index = JSON.parse(read(file, "utf8"));
    index.retentionThrough = mode === "retention_future" ? index.nextId : index.items[0].id;
    fs.writeFileSync(file, JSON.stringify(index));
  }
  if (mode === "temp") fs.writeFileSync(`${file}.interrupted.tmp`, "{}");
  if (mode === "locked") fs.writeFileSync(`${file}.lock`, "{}");
  if (mode === "symlink") {
    const original = path.dirname(file), moved = original + "-real";
    fs.renameSync(original, moved);
    fs.symlinkSync(moved, original, process.platform === "win32" ? "junction" : "dir");
  }
  expect(() => readExecutionOutputIndexStrict("ws")).toThrow();
});
it("短锁 acquisition 分类与真实跨进程 writer 不重号、不丢 index，retention 中 metadata/body 对应", async () => {
  dir = isolateStateDir();
  await verifyAcquisitionPolicy();
  saveExecutionOutput("ws", { command: "seed", raw: "seed", taskId: "seed" });
  const source = pathToFileURL(path.resolve("src/execution/output.ts")).href;
  const script = `import fs from 'node:fs'; import {saveExecutionOutput} from ${JSON.stringify(source)};
    const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
    const original = fs.readFileSync;
    fs.readFileSync = function(p,...args) { const value=original.call(this,p,...args); if(String(p).endsWith('index.json')) pause(15); return value; };
    const ids=[], deadline=Date.now()+15000; for(let i=0;i<15;i++) { const taskId=process.env.WRITER+'-'+i;
      for(;;) { try { ids.push(saveExecutionOutput('ws',{command:taskId,raw:taskId,taskId}).id); break; }
        catch(e) { if(e.code!=='OUTPUT_STORE_BUSY' || Date.now()>deadline) throw e; pause(20); } }
    } console.log(JSON.stringify(ids));`;
  const children = Array.from({ length: 4 }, (_, i) => spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], {
    env: { ...process.env, WRITER: `writer${i}` }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }));
  const completed = await Promise.allSettled(children.map(child => new Promise<number[]>((resolve, reject) => {
    let out="", err=""; child.stdout!.on("data", d=>out+=d); child.stderr!.on("data",d=>err+=d);
    child.once("error",reject); child.once("exit", code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  })));
  const results=completed.map(result=>{ if(result.status==="rejected")throw result.reason; return result.value; });
  const ids=results.flat(); expect(new Set(ids).size).toBe(60);
  const index=JSON.parse(fs.readFileSync(path.join(dir,"execution-outputs/ws/index.json"),"utf8"));
  expect(index.nextId).toBe(62); expect(index.items).toHaveLength(40);
  expect(index.items.map((m: any)=>m.id)).toEqual(Array.from({length:40},(_,i)=>i+22));
  for(const meta of listExecutionOutputs("ws",40)) {
    expect(readExecutionOutput("ws",meta.id)).toMatchObject({ok:true,text:meta.taskId});
  }
}, 30000);
it("损坏 index 不重置 ID 或覆盖正文", () => {
  dir=isolateStateDir(); saveExecutionOutput("ws",{command:"one",raw:"original"});
  const index=path.join(dir,"execution-outputs/ws/index.json"); fs.writeFileSync(index,"broken");
  expect(()=>saveExecutionOutput("ws",{command:"two",raw:"replacement"})).toThrow();
  expect(fs.readFileSync(index,"utf8")).toBe("broken");
  expect(fs.readFileSync(path.join(dir,"execution-outputs/ws/bodies/1.txt"),"utf8")).toBe("original");
});
it("index 提交失败不能提前删除旧 retention 正文；post-write/release 错误不可重试", async () => {
  dir=isolateStateDir(); for(let i=0;i<40;i++)saveExecutionOutput("ws",{command:"test",raw:`body${i}`});
  const index=path.join(dir,"execution-outputs/ws/index.json"), previous=fs.readFileSync(index,"utf8");
  const rename=fs.renameSync;
  vi.spyOn(fs,"renameSync").mockImplementation((from,to)=>{if(String(to)===index)throw new Error("commit failed"); return rename(from,to);});
  expect(()=>saveExecutionOutput("ws",{command:"new",raw:"new body"})).toThrow("commit failed");
  expect(fs.readFileSync(index,"utf8")).toBe(previous);
  expect(fs.readFileSync(path.join(dir,"execution-outputs/ws/bodies/1.txt"),"utf8")).toBe("body0");
  vi.restoreAllMocks();
  await verifyPostWriteErrors();
});
it("崩溃留下 orphan body 不得复用 ID；丢失 index 不能从 1 重新开始", () => {
  dir=isolateStateDir(); saveExecutionOutput("ws",{command:"one",raw:"one"});
  const orphan=path.join(dir,"execution-outputs/ws/bodies/2.txt"); fs.writeFileSync(orphan,"orphan");
  const saved=saveExecutionOutput("ws",{command:"three",raw:"three"});
  expect(saved.id).toBe(3); expect(fs.readFileSync(orphan,"utf8")).toBe("orphan");
  const index=path.join(dir,"execution-outputs/ws/index.json"); fs.unlinkSync(index);
  expect(()=>saveExecutionOutput("ws",{command:"four",raw:"four"})).toThrow("拒绝重置 ID");
  expect(fs.existsSync(index)).toBe(false);
  saveExecutionOutput("empty",{command:"empty",raw:""});
  fs.unlinkSync(path.join(dir,"execution-outputs/empty/index.json"));
  expect(()=>saveExecutionOutput("empty",{command:"again",raw:""})).toThrow("拒绝重置 ID");
});
it("index 读取失败停止操作，清理失败仅留下不再引用的 orphan", () => {
  dir=isolateStateDir(); for(let i=0;i<40;i++)saveExecutionOutput("ws",{command:"test",raw:`body${i}`});
  const index=path.join(dir,"execution-outputs/ws/index.json"), originalRead=fs.readFileSync;
  const read=vi.spyOn(fs,"readFileSync").mockImplementation(((file: any,...args: any[])=>{
    if(String(file)===index)throw Object.assign(new Error("denied"),{code:"EACCES"});
    return (originalRead as any)(file,...args);
  }) as any);
  expect(()=>saveExecutionOutput("ws",{command:"new",raw:"new"})).toThrow("无法读取"); read.mockRestore();
  const rm=fs.rmSync, old=path.join(dir,"execution-outputs/ws/bodies/1.txt");
  vi.spyOn(fs,"rmSync").mockImplementation((file,opts)=>{if(String(file)===old)throw new Error("cleanup failed");return rm(file,opts);});
  const saved=saveExecutionOutput("ws",{command:"new",raw:"new"});
  expect(saved.id).toBe(41); expect(fs.existsSync(old)).toBe(true);
  expect(listExecutionOutputs("ws",40).some(m=>m.id===1)).toBe(false);
  expect(readExecutionOutput("ws",41)).toMatchObject({ok:true,text:"new"});
});
