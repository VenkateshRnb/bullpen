import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { authStatus } from "./agents.ts";
import { loadConfig, resolveCommand } from "./config.ts";
import { runBullpen } from "./engine.ts";
import { loadState, saveState } from "./state.ts";

const HELP = `Bullpen: runs coding tasks across several AI coding agents and keeps going when one reaches its usage limit.

Run from inside a git repository (it needs at least one commit).

  init                 create .bullpen/ with a config, conventions and an example task
  doctor               show which agents are installed and their versions
  run [--once]         work through the tasks until all are done (Ctrl+C stops safely)
        --concurrency N    run N tasks at once (default 1)
  status               show agents, tasks and recent events
  retry <task>         give a stuck task a fresh start
  unblock <agent>      clear an agent's "resting" timer
  --version            print the version

Work lands on the branch bullpen/integration. Your own branch is never touched.
Progress is written to .bullpen/STATUS.md.
`;

function repoRoot(): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error("Not inside a git repository.");
    process.exit(2);
  }
  return r.stdout.trim();
}

function init(repo: string): void {
  const dir = join(repo, ".bullpen");
  mkdirSync(join(dir, "tasks"), { recursive: true });
  const cfgFile = join(dir, "config.json");
  if (!existsSync(cfgFile)) {
    writeFileSync(
      cfgFile,
      JSON.stringify({ concurrency: 1, review: true, taskTimeoutMinutes: 45 }, null, 2) + "\n",
    );
  }
  const conv = join(dir, "CONVENTIONS.md");
  if (!existsSync(conv)) {
    writeFileSync(
      conv,
      "# Conventions for agents\n\n- Keep changes small and tested.\n- Say in HANDOFF.md what is done and what is next.\n- Never commit secrets.\n",
    );
  }
  const example = join(dir, "tasks", "_example.md");
  if (!existsSync(example)) {
    writeFileSync(
      example,
      `---
kind: impl
depends_on: []
check:
  - node --version
---
Rename this file (drop the leading underscore, e.g. 010-first-task.md) and describe the work here.
Say what "done" looks like. The checks above are run by Bullpen, not by the agent.
`,
    );
  }
  // Keep runtime files out of git without touching the tracked .gitignore.
  const ex = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  const exFile = join(repo, ex);
  const have = existsSync(exFile) ? readFileSync(exFile, "utf8") : "";
  const want = [
    ".bullpen/state.json",
    ".bullpen/*.tmp",
    ".bullpen/bullpen.lock",
    ".bullpen/logs/",
    ".bullpen/worktrees/",
    ".bullpen/handoff-archive/",
    ".bullpen/STATUS.md",
    ".bullpen-prompt.md",
  ];
  const missing = want.filter((l) => !have.includes(l));
  if (missing.length) {
    mkdirSync(join(exFile, ".."), { recursive: true });
    appendFileSync(exFile, (have.endsWith("\n") || !have ? "" : "\n") + missing.join("\n") + "\n");
  }
  console.log("Created .bullpen/. Add task files to .bullpen/tasks/, then run: bullpen run");
}

function doctor(repo: string): void {
  const cfg = loadConfig(repo);
  for (const [name, a] of Object.entries(cfg.agents)) {
    if (!a.enabled) {
      console.log(`${name.padEnd(8)} disabled`);
      continue;
    }
    const cmd = resolveCommand(name, a);
    if (!cmd) {
      console.log(`${name.padEnd(8)} NOT FOUND (not on PATH or in a known app location)`);
      continue;
    }
    const v = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
    const ver = (v.stdout || v.stderr || "").trim().split(/\r?\n/)[0];
    const auth = authStatus(cmd, a);
    const signIn = auth === "ok" ? "signed in" : auth === "not_signed_in" ? "NOT SIGNED IN" : "sign-in unknown";
    const experimental = name === "gemini" ? "  (experimental: flags unverified)" : "";
    console.log(`${name.padEnd(8)} ${ver || "(no version output)"}  [${signIn}]${experimental}\n         ${cmd}`);
    if (auth === "not_signed_in") console.log(`         fix: run  "${cmd}" ${name === "codex" ? "login" : "auth login"}   in a terminal and finish the browser sign-in`);
  }
}

function status(repo: string): void {
  const f = join(repo, ".bullpen", "STATUS.md");
  console.log(existsSync(f) ? readFileSync(f, "utf8") : "No status yet. Run: bullpen run");
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return void console.log(HELP);
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    return void console.log(pkg.version);
  }
  const repo = repoRoot();
  switch (cmd) {
    case "init":
      return init(repo);
    case "doctor":
      return doctor(repo);
    case "status":
      return status(repo);
    case "run": {
      const ac = new AbortController();
      let hits = 0;
      process.on("SIGINT", () => {
        if (++hits > 1) process.exit(130);
        console.log("\nStopping after saving progress (press Ctrl+C again to force)...");
        ac.abort();
      });
      const ci = rest.indexOf("--concurrency");
      const concurrency = ci >= 0 ? parseInt(rest[ci + 1], 10) : undefined;
      const summary = await runBullpen(repo, { once: rest.includes("--once"), concurrency, signal: ac.signal });
      console.log(`\n${summary.message}`);
      console.log(`done: ${summary.done.length}   needs you: ${summary.needsHuman.length}`);
      if (summary.needsHuman.length) console.log(`needs you: ${summary.needsHuman.join(", ")} (see .bullpen/STATUS.md)`);
      process.exit(summary.reason === "stuck" || summary.needsHuman.length ? 1 : 0);
    }
    case "retry": {
      const id = rest[0];
      const s = loadState(repo);
      if (!id || !s.tasks[id]) return void console.error(`Unknown task "${id ?? ""}".`);
      Object.assign(s.tasks[id], { status: "pending", excluded: [], reviewRounds: 0, lastError: undefined });
      s.tasks[id].attempts = s.tasks[id].attempts.map((a) => (a.outcome === "crashed" || a.outcome === "error" || a.outcome === "checks_failed" || a.outcome === "timeout" ? { ...a, outcome: `${a.outcome} (cleared)` } : a));
      saveState(repo, s);
      return void console.log(`${id} is pending again.`);
    }
    case "unblock": {
      const s = loadState(repo);
      const a = s.agents[rest[0] ?? ""];
      if (!a) return void console.error(`No resting timer for "${rest[0] ?? ""}".`);
      a.blockedUntil = undefined;
      a.hits = 0;
      saveState(repo, s);
      return void console.log(`${rest[0]} can work again.`);
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(`bullpen: ${(e as Error).message}`);
  process.exit(1);
});
