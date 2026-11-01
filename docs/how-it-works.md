# How Bullpen works

## The shared state is git

Nothing depends on an agent remembering anything. For each task Bullpen keeps:

- a branch `bullpen/task/<id>` checked out in its own worktree under `.bullpen/worktrees/<id>`
- a `HANDOFF.md` in that worktree that every agent reads first and updates last (done, next steps, gotchas)

All finished work is merged into `bullpen/integration`, checked out in `.bullpen/worktrees/_integration`. Your own branch is never touched. Merge `bullpen/integration` yourself when you are happy.

## A task's life

```
pending ──► running ──► awaiting_review ──► done
   ▲            │              │
   └────────────┴──────────────┘      any state ──► needs_human
```

1. **Pick an agent.** The task's `agents:` list is a hard pin. Otherwise `routing[kind]` is the preferred order and any other enabled agent is a fallback. Agents that are resting, busy, excluded for this task, or not installed are skipped. Only one task runs per agent at a time.
2. **Run it headless** in the task's worktree. The prompt carries the task, the project conventions, the acceptance checks and the current `HANDOFF.md`.
3. **Save the work.** Whatever the outcome, Bullpen commits the worktree (`wip(<id>): <agent> attempt <n>`). Agents are told not to commit, because some sandboxes cannot.
4. **Decide what happened** (table below).
5. **Run the checks** yourself defined in the task's `check:` list. Failures are written into `HANDOFF.md` for the next attempt.
6. **Review.** A different agent (never the author, unless `allowSelfReview`) reads the diff and answers with a line `REVIEW: APPROVE` or `REVIEW: CHANGES`. Changes go back to the author, at most `maxReviewRounds` times.
7. **Merge** into `bullpen/integration`. The handoff is archived to `.bullpen/handoff-archive/<id>.md` and dropped from the branch first.

## Outcomes of an attempt

| Outcome | What triggered it | What Bullpen does |
|---|---|---|
| `work_done` | Exit 0 and every check passes | Review, then merge |
| `limit` | Output looks like a usage limit | Note in `HANDOFF.md`, rest the agent until the reset, try the next agent. Not counted as a failure |
| `auth_required` | Output says the CLI is signed out | Rest the agent, re-check its sign-in every few minutes. Not counted as a failure |
| `checks_failed` | Exit 0 but a check fails | Record the failure in `HANDOFF.md`, retry. Counts as a failure |
| `error` | Non-zero exit that is not a limit | Retry. After two errors by the same agent it is skipped for this task |
| `timeout` | Exceeded `taskTimeoutMinutes` | Note, retry with a smaller step. Counts as a failure |
| `spawn_failed` | The CLI could not start | Rest the agent for 30 minutes |
| `crashed` | Bullpen itself threw | Retry. Counts as a failure |

After `maxAttemptsPerTask` failures the task becomes `needs_human`.

## Resting an agent

- The reset time is read from the message where possible (`resets at 5:30pm`, `in 3 hours 12 minutes`, an epoch after a pipe, a `retryDelay`, an ISO timestamp). One minute is added as a margin.
- With no reset time, the cool-down is `cooldownMinutes` (default 60), doubling on repeated hits up to 5 hours.
- Running out of credits rests the agent for 6 hours. A signed-out agent is rested for up to 12 hours but is re-checked every 5 minutes, so signing in is noticed quickly.
- When every suitable agent is resting, `bullpen run` sleeps until the first one returns. `bullpen run --once` returns instead and says when to come back.

A run that exited 0 with a long answer is never treated as a limit hit, even if it mentions "rate limit" (it may be writing code about one).

## Crash safety

State is written atomically to `.bullpen/state.json`. A lock file stops two Bullpen processes from working on the same repository. Work is committed after every attempt, so killing Bullpen (or Ctrl+C) loses nothing; interrupted tasks start again from their last commit.

## Files

```
.bullpen/
  config.json          your overrides (tracked)
  CONVENTIONS.md       rules every agent must follow (tracked)
  tasks/*.md           the work (tracked)
  state.json           runtime state            (git-ignored via .git/info/exclude)
  STATUS.md            human-readable status    (git-ignored)
  logs/                one log per agent run    (git-ignored)
  worktrees/           one worktree per task    (git-ignored)
  handoff-archive/     finished handoff notes   (git-ignored)
```

`bullpen init` adds the git-ignored entries to `.git/info/exclude`, so your tracked `.gitignore` is not changed.
