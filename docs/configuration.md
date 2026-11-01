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
| `maxAttemptsPerTask` | `6` | Failed attempts before a task becomes `needs_human` |
| `maxReviewRounds` | `2` | Times a reviewer may send work back |
| `review` | `true` | Have a different agent review before merging (a task can override with `review:`) |
| `allowSelfReview` | `false` | Let the author review its own work |
| `pollSeconds` | `60` | Longest sleep while waiting for a resting agent |
| `conventionsFiles` | `AGENTS.md`, `CLAUDE.md`, `.bullpen/CONVENTIONS.md` | Files whose contents are put in every prompt |
| `routing` | see below | Preferred agent order per task `kind` |
| `agents` | see below | How to run each agent |

## Routing

Routing is a preference, not a restriction. Any other enabled agent is used as a fallback.

```json
"routing": {
  "security": ["claude", "codex", "gemini"],
  "arch":     ["claude", "codex", "gemini"],
  "impl":     ["codex", "claude", "gemini"],
  "research": ["gemini", "claude", "codex"],
  "docs":     ["gemini", "claude", "codex"],
  "ui":       ["gemini", "claude", "codex"],
  "default":  ["claude", "codex", "gemini"]
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

**Gemini CLI** is experimental. It runs `gemini -p "Read the file .bullpen-prompt.md ... " --approval-mode auto_edit` (reviews use `plan`) with `GEMINI_CLI_TRUST_WORKSPACE=true`. None of this has been run against a real install.

The tool lists above are what the agents may do unattended. If you want agents to run other commands (a build tool, a test runner), add them to `args` deliberately. Do not replace them with a blanket "skip all permissions" flag unless the whole run is inside a disposable sandbox or container.

## Environment

Bullpen passes your environment to the agents unchanged, plus anything in `env`. Keep secrets you do not want an agent to see out of the shell you start it from.
