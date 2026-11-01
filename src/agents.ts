import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentConfig } from "./types.ts";
import { killTree, tail } from "./util.ts";

export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  spawnFailed: boolean;
  output: string;
  durationMs: number;
}

export interface RunOptions {
  cwd: string;
  prompt: string;
  review: boolean;
  timeoutMs: number;
  logFile: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** Asks the CLI whether it is signed in. "unknown" when there is no probe or it cannot run. */
export function authStatus(command: string, agent: AgentConfig): "ok" | "not_signed_in" | "unknown" {
  if (!agent.authCheck) return "unknown";
  const r = spawnSync(command, agent.authCheck.args, { encoding: "utf8", timeout: 20_000, windowsHide: true });
  if (r.error) return "unknown";
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return new RegExp(agent.authCheck.okPattern, "i").test(out) ? "ok" : "not_signed_in";
}

const PROMPT_FILE = ".bullpen-prompt.md";

/**
 * Runs one agent CLI headlessly. The prompt goes through stdin (no command-line length or
 * quoting problems) unless the agent is configured with promptVia "arg" or "file".
 */
export function runAgent(command: string, agent: AgentConfig, opts: RunOptions): Promise<RunResult> {
  const template = opts.review && agent.reviewArgs ? agent.reviewArgs : agent.args;
  const args = template.map((a) =>
    a.replaceAll("{cwd}", opts.cwd).replaceAll("{prompt}", opts.prompt).replaceAll("{promptFile}", PROMPT_FILE),
  );
  const promptPath = join(opts.cwd, PROMPT_FILE);
  if (agent.promptVia === "file") writeFileSync(promptPath, opts.prompt);
  mkdirSync(dirname(opts.logFile), { recursive: true });
  const log = createWriteStream(opts.logFile);
  log.write(`$ ${command} ${template.join(" ")}\n(cwd ${opts.cwd})\n\n`);
  const started = Date.now();

  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    let done = false;
    const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...(opts.env ?? process.env), ...(agent.env ?? {}) },
      windowsHide: true,
      shell: needsShell,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const onAbort = () => {
      if (child.pid) killTree(child.pid);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, opts.timeoutMs);

    const finish = (r: Pick<RunResult, "exitCode" | "spawnFailed">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (agent.promptVia === "file") rmSync(promptPath, { force: true });
      log.end();
      resolve({ ...r, timedOut, output: out, durationMs: Date.now() - started });
    };

    const onData = (b: Buffer) => {
      const s = b.toString("utf8");
      log.write(s);
      out = tail(out + s, 200_000);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => {
      const msg = `spawn failed: ${e.message}`;
      log.write(msg);
      out += msg;
      finish({ exitCode: -1, spawnFailed: true });
    });
    child.on("close", (code) => finish({ exitCode: code, spawnFailed: false }));

    opts.signal?.addEventListener("abort", onAbort);
    child.stdin.on("error", () => {});
    if (agent.promptVia === "stdin") child.stdin.end(opts.prompt);
    else child.stdin.end();
  });
}
