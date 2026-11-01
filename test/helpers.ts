import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE = join(here, "fixtures", "fake-agent.mjs");
const AUTH_PROBE = join(here, "fixtures", "auth-probe.mjs");

export interface Scenario {
  tasks: Record<string, string>;
  script?: Record<string, string[]>;
  review?: Record<string, string[]>;
  config?: Record<string, unknown>;
  agents?: string[];
  /** Agents whose sign-in probe reports "signed out". */
  signedOut?: string[];
}

/** Builds a throwaway git repo wired to two fake agents, "a" and "b". */
export function makeRepo(s: Scenario) {
  const repo = mkdtempSync(join(tmpdir(), "bullpen-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  g("init", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  writeFileSync(join(repo, "check.mjs"), "import fs from 'node:fs'; process.exit(fs.existsSync(process.argv[2]) ? 0 : 1);\n");
  writeFileSync(join(repo, "README.md"), "# test\n");
  mkdirSync(join(repo, ".bullpen", "tasks"), { recursive: true });

  const names = s.agents ?? ["a", "b"];
  const agents: Record<string, unknown> = {
    claude: { enabled: false },
    codex: { enabled: false },
    antigravity: { enabled: false },
  };
  for (const n of names) {
    agents[n] = {
      enabled: true,
      command: process.execPath,
      args: [FAKE, n],
      reviewArgs: [FAKE, n],
      promptVia: "stdin",
      cooldownMinutes: 60,
      authCheck: { args: [AUTH_PROBE, n], okPattern: "^signed in" },
    };
  }
  writeFileSync(
    join(repo, ".bullpen", "config.json"),
    JSON.stringify({ pollSeconds: 3600, routing: { default: names }, agents, ...s.config }, null, 2),
  );
  for (const [id, text] of Object.entries(s.tasks)) {
    writeFileSync(join(repo, ".bullpen", "tasks", `${id}.md`), text);
  }
  g("add", "-A");
  g("commit", "-m", "init");

  process.env.FAKE_STATE_DIR = mkdtempSync(join(tmpdir(), "bullpen-fake-"));
  process.env.FAKE_SCRIPT = JSON.stringify(s.script ?? {});
  process.env.FAKE_REVIEW = JSON.stringify(s.review ?? {});
  process.env.FAKE_SIGNED_OUT = (s.signedOut ?? []).join(",");
  return { repo, git: g };
}

/** A clock that only moves when the bullpen sleeps, so "wait 3 hours" takes no real time. */
export function fakeClock(startMs = Date.UTC(2026, 9, 31, 10, 0, 0)) {
  let t = startMs;
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms;
    },
    log: () => {},
    get time() {
      return t;
    },
  };
}

export const taskFile = (kind: string, check: string[], extra = "") =>
  `---\nkind: ${kind}\ncheck:\n${check.map((c) => `  - ${c}`).join("\n")}\n${extra}---\nDo the thing.\n`;
