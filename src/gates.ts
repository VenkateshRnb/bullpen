import { spawn } from "node:child_process";
import { killTree, tail } from "./util.ts";

export interface ShellResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, timeoutMs);
    const onData = (b: Buffer) => {
      out = tail(out + b.toString("utf8"), 100_000);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `could not run: ${e.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: out, timedOut });
    });
  });
}

/** Bullpen runs the acceptance checks itself. It never takes an agent's word for it. */
export async function runChecks(
  commands: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; report: string }> {
  const lines: string[] = [];
  for (const cmd of commands) {
    const r = await runShell(cmd, cwd, timeoutMs);
    if (r.code === 0) {
      lines.push(`PASS  ${cmd}`);
      continue;
    }
    lines.push(`FAIL  ${cmd}  (exit ${r.timedOut ? "timeout" : r.code})`);
    lines.push(tail(r.output.trim(), 1500));
    return { ok: false, report: lines.join("\n") };
  }
  return { ok: true, report: lines.join("\n") || "(no checks defined)" };
}
