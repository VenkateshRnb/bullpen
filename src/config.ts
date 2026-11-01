import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, Config } from "./types.ts";

export const DEFAULTS: Config = {
  integrationBranch: "bullpen/integration",
  concurrency: 1,
  taskTimeoutMinutes: 45,
  checkTimeoutMinutes: 10,
  maxAttemptsPerTask: 6,
  maxReviewRounds: 2,
  review: true,
  allowSelfReview: false,
  pollSeconds: 60,
  routing: {
    security: ["claude", "codex", "gemini"],
    arch: ["claude", "codex", "gemini"],
    impl: ["codex", "claude", "gemini"],
    research: ["gemini", "claude", "codex"],
    docs: ["gemini", "claude", "codex"],
    ui: ["gemini", "claude", "codex"],
    default: ["claude", "codex", "gemini"],
  },
  conventionsFiles: ["AGENTS.md", "CLAUDE.md", ".bullpen/CONVENTIONS.md"],
  agents: {
    // Flags verified against claude 2.1.308 and codex-cli 0.165 on this machine.
    // --allowedTools is variadic, so it stays last.
    claude: {
      enabled: true,
      command: null,
      promptVia: "stdin",
      cooldownMinutes: 60,
      args: [
        "-p", "--output-format", "text", "--permission-mode", "acceptEdits",
        "--allowedTools", "Bash(git:*)", "Bash(npm:*)", "Bash(node:*)", "Bash(npx:*)",
        "Read", "Edit", "Write", "Glob", "Grep",
      ],
      reviewArgs: ["-p", "--output-format", "text", "--permission-mode", "plan"],
      authCheck: { args: ["auth", "status"], okPattern: '"loggedIn":\\s*true' },
    },
    codex: {
      enabled: true,
      command: null,
      promptVia: "stdin",
      cooldownMinutes: 60,
      args: ["exec", "--sandbox", "workspace-write", "-C", "{cwd}", "-"],
      reviewArgs: ["exec", "--sandbox", "read-only", "-C", "{cwd}", "-"],
      authCheck: { args: ["login", "status"], okPattern: "logged in" },
    },
    // EXPERIMENTAL: written from third-party documentation, never run against a real Gemini CLI.
    // The prompt goes through a file because Gemini's -p takes it on the command line, where long
    // multi-line prompts break on Windows. GEMINI_CLI_TRUST_WORKSPACE skips the headless trust prompt.
    // After `npm i -g @google/gemini-cli`, run `bullpen doctor` and adjust.
    gemini: {
      enabled: true,
      command: null,
      promptVia: "file",
      cooldownMinutes: 60,
      args: ["-p", "Read the file {promptFile} in the current directory and follow its instructions exactly.", "--approval-mode", "auto_edit"],
      reviewArgs: ["-p", "Read the file {promptFile} in the current directory and follow its instructions exactly.", "--approval-mode", "plan"],
      env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
    },
  },
};

export function loadConfig(repo: string, override: Partial<Config> = {}): Config {
  const f = join(repo, ".bullpen", "config.json");
  const user = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Partial<Config>) : {};
  const merged: Config = {
    ...DEFAULTS,
    ...user,
    ...override,
    routing: { ...DEFAULTS.routing, ...user.routing, ...override.routing },
    agents: {},
  };
  const names = new Set([
    ...Object.keys(DEFAULTS.agents),
    ...Object.keys(user.agents ?? {}),
    ...Object.keys(override.agents ?? {}),
  ]);
  for (const n of names) {
    merged.agents[n] = {
      ...DEFAULTS.agents[n],
      ...(user.agents?.[n] ?? {}),
      ...(override.agents?.[n] ?? {}),
    } as AgentConfig;
  }
  return merged;
}

/* ---------- finding the executables ---------- */

function which(cmd: string): string | null {
  const r = spawnSync(process.platform === "win32" ? "where.exe" : "which", [cmd], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) return null;
  const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return process.platform === "win32" ? (lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) ?? null) : (lines[0] ?? null);
}

function walk(base: string, parts: string[]): string[] {
  if (!existsSync(base)) return [];
  if (parts.length === 0) return [base];
  const [head, ...rest] = parts;
  if (head !== "*") return walk(join(base, head), rest);
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }
  return names.flatMap((n) => walk(join(base, n), rest));
}

function newest(paths: string[]): string | null {
  let best: string | null = null;
  let bestTime = -1;
  for (const p of paths) {
    try {
      const t = statSync(p).mtimeMs;
      if (t > bestTime) {
        best = p;
        bestTime = t;
      }
    } catch {
      /* skip unreadable */
    }
  }
  return best;
}

/**
 * Besides PATH, look where the tools hide. On the Windows machine this was built on, Claude Code and
 * Codex exist only inside their desktop apps, in version-stamped folders that change on every
 * update, so we look them up on every run. The macOS and Linux locations are best-effort guesses
 * (the native installer and the desktop app's data folder) and have not been tested.
 */
const DISCOVER: Record<string, () => string | null> = {
  claude: () => {
    const found: string[] = [];
    const la = process.env.LOCALAPPDATA;
    if (la) found.push(...walk(join(la, "Claude-Data"), ["*", "claude-code", "*", "*", "claude.exe"]));
    const appData = join(homedir(), "Library", "Application Support", "Claude", "claude-code");
    found.push(...walk(appData, ["*", "claude"]), ...walk(appData, ["*", "*", "claude"]));
    const exe = process.platform === "win32" ? ".exe" : "";
    for (const p of [join(homedir(), ".local", "bin", `claude${exe}`), join(homedir(), ".claude", "local", `claude${exe}`)]) {
      if (existsSync(p)) found.push(p);
    }
    return newest(found);
  },
  codex: () => {
    if (process.platform !== "win32") return null;
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "(Get-AppxPackage OpenAI.Codex | Select-Object -First 1).InstallLocation"],
      { encoding: "utf8", windowsHide: true, timeout: 20_000 },
    );
    const loc = r.stdout?.trim();
    if (!loc) return null;
    const p = join(loc, "app", "resources", "codex.exe");
    return existsSync(p) ? p : null;
  },
};

export function resolveCommand(name: string, agent: AgentConfig): string | null {
  if (agent.command) return agent.command;
  return which(name) ?? DISCOVER[name]?.() ?? null;
}
