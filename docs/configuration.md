# Configuration

Settings live in `.bullpen/config.json` and override the defaults. Every key is optional.

```json
{
  "concurrency": 1,
  "review": true,
  "taskTimeoutMinutes": 45
}
```

## Settings

| Key | Default | Meaning |
|---|---|---|
| `integrationBranch` | `bullpen/integration` | Where finished work is merged |
| `concurrency` | `1` | Tasks run at once. Each agent still runs one task at a time |
| `taskTimeoutMinutes` | `45` | An agent run longer than this is stopped |
| `checkTimeoutMinutes` | `10` | Limit for each `check:` command |
| `setup` | `[]` | Commands Bullpen runs itself, once per new worktree and before any agent starts, for example `["npm ci"]`. See [Preparing worktrees](#preparing-worktrees) |
| `setupTimeoutMinutes` | `10` | Limit for each setup command |
| `maxAttemptsPerTask` | `6` | Failed attempts before a task becomes `needs_human` |
| `maxReviewRounds` | `2` | Times a reviewer may send work back |
| `review` | `true` | Have a different agent review before merging (a task can override with `review:`) |
| `allowSelfReview` | `false` | Let the author review its own work |
| `pollSeconds` | `60` | Longest sleep while waiting for a resting agent |
| `conventionsFiles` | `AGENTS.md`, `CLAUDE.md`, `.bullpen/CONVENTIONS.md` | Files whose contents are put in every prompt |
| `routing` | see below | Preferred agent order per task `kind` |
| `agents` | see below | How to run each agent |

## Preparing worktrees

Each task runs in a fresh git worktree, which contains only what is committed. Installed dependencies such as 
ode_modules are not committed, so checks like 
pm test would fail there. List the commands that prepare a worktree under setup:

```json
{ "setup": ["npm ci"] }
```

Bullpen runs these commands itself, not an agent, so they work even where an agent's sandbox has no network access. They run once per worktree, in order, before the first agent starts. Resumed attempts and reviews reuse the prepared worktree. Changing the commands, or recreating the worktree, runs them again. If a command fails or times out, the task becomes `needs_human` and no agent is started, because that is an environment problem and not something an agent can fix. The output is kept in `.bullpen/logs/<task>-setup.log`; after fixing the cause, run `bullpen retry <task>`.

Treat `.bullpen/config.json` like a script: anyone who can change it can make Bullpen run commands on your machine.

## Routing

Routing is a preference, not a restriction. Any other enabled agent is used as a fallback.

```json
"routing": {
  "security": ["claude", "codex", "antigravity"],
  "arch":     ["claude", "codex", "antigravity"],
  "impl":     ["codex", "claude", "antigravity"],
  "research": ["antigravity", "claude", "codex"],
  "docs":     ["antigravity", "claude", "codex"],
  "ui":       ["antigravity", "claude", "codex"],
  "default":  ["claude", "codex", "antigravity"]
}
```

These orders are a starting guess, not a benchmark. Tune them to what works for you.

## Agents

Each entry under `agents` has these fields:

| Field | Meaning |
|---|---|
| `enabled` | `false` switches the agent off |
| `command` | Absolute path or bare command. `null` means find it on `PATH` or in a known app location on every run |
| `args` | Arguments for work runs. Placeholders: `{cwd}`, `{prompt}`, `{promptFile}` |
| `reviewArgs` | Arguments for read-only review runs. Falls back to `args` |
| `promptVia` | `stdin` (best), `arg` (substituted where `{prompt}` appears) or `file` (written to `.bullpen-prompt.md` in the worktree and referenced as `{promptFile}`) |
| `cooldownMinutes` | Rest time when a limit message has no reset time |
| `env` | Extra environment variables for this agent only |
| `authCheck` | `{ "args": [...], "okPattern": "regex" }`: run `command ...args`; the agent counts as signed in when the output matches |

### Built-in defaults

**Claude Code** runs `claude -p --output-format text --permission-mode acceptEdits --allowedTools "Bash(git:*)" "Bash(npm:*)" "Bash(node:*)" "Bash(npx:*)" Read Edit Write Glob Grep`, with the prompt on stdin. Reviews use `--permission-mode plan`.

**Codex** runs `codex exec --sandbox workspace-write -C <worktree> -`, with the prompt on stdin. Reviews use `--sandbox read-only`.

**Antigravity CLI** (`agy`) runs `agy -p "Read the file .bullpen-prompt.md ..." --mode accept-edits --settings <rules>` with the prompt in a file, where the rules allow `git`, `npm`, `node` and `npx` for that run only. Reviews use `--mode plan`. Run `agy` once yourself first to sign in; headless runs reuse that sign-in. A command outside the allow-list is denied without failing the run, so add rules for your own tools (for example `command(pnpm)`) by editing `args` in your config. Bullpen runs the task's checks itself, so a denied command shows up as a failed check rather than a silent success.

The tool lists above are what the agents may do unattended. If you want agents to run other commands (a build tool, a test runner), add them to `args` deliberately. Do not replace them with a blanket "skip all permissions" flag unless the whole run is inside a disposable sandbox or container.

## Environment

Bullpen passes your environment to the agents unchanged, plus anything in `env`. Keep secrets you do not want an agent to see out of the shell you start it from.
