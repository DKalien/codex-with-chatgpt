import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 独立本机 UI；不调用 Desktop current_confirm，不接受网页提供的授权结论。 */
export function confirmLocalRoute(input: { workspaceId: string; workspaceRoot: string; routeCanonical: string }): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise(resolve => {
    const child = spawn(process.env.C2C_DESKTOP_PYTHON?.trim() || "python",
      ["-I", "-B", "-X", "utf8", fileURLToPath(new URL("./local-route-confirm.py", import.meta.url))],
      { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    let finished = false;
    const finish = (confirmed: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (!confirmed && child.exitCode === null && !child.killed) child.kill();
      resolve(confirmed);
    };
    const timer = setTimeout(() => { child.kill(); finish(false); }, 110_000);
    child.on("error", () => finish(false));
    child.stdin.on("error", () => finish(false));
    child.stdout.on("data", chunk => {
      output += chunk.toString("utf8");
      if (output.length > 4096) { child.kill(); finish(false); }
    });
    child.on("close", code => finish(code === 0 && output.trim() === '{"confirmed":true}'));
    child.stdin.end(JSON.stringify(input));
  });
}
