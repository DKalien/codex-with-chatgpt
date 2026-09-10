import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { isolateStateDir, cleanup } from "./helpers.js";
import { saveExecutionOutput, listExecutionOutputs, readExecutionOutput } from "../src/execution/output.js";

let dir: string;
afterEach(() => { vi.restoreAllMocks(); if (dir) cleanup(dir); delete process.env.C2C_STATE_DIR; });
it("真实跨进程 writer 不重号、不丢 index，retention 中 metadata/body 对应", async () => {
  dir = isolateStateDir();
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
it("index 提交失败不能提前删除旧 retention 正文", () => {
  dir=isolateStateDir(); for(let i=0;i<40;i++)saveExecutionOutput("ws",{command:"test",raw:`body${i}`});
  const index=path.join(dir,"execution-outputs/ws/index.json"), previous=fs.readFileSync(index,"utf8");
  const rename=fs.renameSync;
  vi.spyOn(fs,"renameSync").mockImplementation((from,to)=>{if(String(to)===index)throw new Error("commit failed"); return rename(from,to);});
  expect(()=>saveExecutionOutput("ws",{command:"new",raw:"new body"})).toThrow("commit failed");
  expect(fs.readFileSync(index,"utf8")).toBe(previous);
  expect(fs.readFileSync(path.join(dir,"execution-outputs/ws/bodies/1.txt"),"utf8")).toBe("body0");
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
