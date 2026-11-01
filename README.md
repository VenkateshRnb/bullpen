# Bullpen

Bullpen runs a queue of coding tasks across several AI coding agent CLIs and keeps going when one of them reaches its usage limit.

[![CI](https://github.com/VenkateshRnb/bullpen/actions/workflows/ci.yml/badge.svg)](https://github.com/VenkateshRnb/bullpen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Status: early (0.x). It has been used with Claude Code, Codex and Antigravity CLI on Windows. See [Limitations](#limitations).

## Overview

Coding agents on subscription plans stop for hours once they reach a usage limit. Bullpen splits work into small tasks written as Markdown files and runs each task with the first available agent, in its own git worktree. If the agent reaches its limit, Bullpen commits the work done so far, adds a note to `HANDOFF.md`, marks the agent as unavailable until its limit resets, and gives the task to the next agent, which continues from the committed work.

The state lives in git rather than in any tool's conversation, so any agent can continue another agent's task.

Bullpen also:

- runs the checks you define (tests, type check, lint) itself instead of relying on the agent's report
- asks a different agent to review each change before it is merged
- merges into a separate branch and never modifies the branch you have checked out
- recovers from crashes and interruptions
- detects agents that are not signed in and skips them

```
.bullpen/tasks/*.md
        |
        v
  pick the first available agent
        |
        v
  run it headless in a git worktree --- limit reached? --> commit, note in HANDOFF.md,
        |                                                  rest the agent, try the next one
        v
  run the task's checks
        |
        v
  a different agent reviews the diff
        |
        v
  merge into bullpen/integration
```

## Requirements

- Node.js 20 or later
- git
- One or more supported agent CLIs, signed in. Cross-agent review needs at least two.

## Installation

```bash
npm install -g github:VenkateshRnb/bullpen
```

Bullpen is distributed through GitHub and is not published on npm. The command above downloads the repository and builds it on your machine. Each [release](https://github.com/VenkateshRnb/bullpen/releases) also carries a prebuilt `.tgz`, which you can install with `npm install -g ./agent-bullpen-<version>.tgz`.

To run from a clone:

```bash
git clone https://github.com/VenkateshRnb/bullpen.git
cd bullpen
npm install
npm run build
node bin/bullpen.js --help
```

## Usage

Run these from a git repository that has at least one commit.

```bash
bullpen init      # create .bullpen/ with a config file and an example task
bullpen doctor    # list the agents that were found and whether they are signed in
bullpen run       # work through the tasks in .bullpen/tasks/
bullpen status    # show agents, tasks and recent events
```

| Command | Description |
|---|---|
| `init` | Create `.bullpen/` with a config file, a conventions file and an example task |
| `doctor` | Show which agents were found, their versions and whether they are signed in |
| `run [--once] [--concurrency N]` | Run until every task is merged or needs attention. `--once` returns instead of waiting for a rested agent |
| `status` | Print `.bullpen/STATUS.md` |
| `retry <task>` | Reset a task that needs attention |
| `unblock <agent>` | Clear an agent's rest timer |
| `--version` | Print the version |

Finished work is on the branch `bullpen/integration`. Review it and merge it into your own branch. Progress is also written to `.bullpen/STATUS.md`.

## Task files

Each task is a Markdown file in `.bullpen/tasks/`. Files are processed in name order, and names starting with `_` are ignored.

```markdown
---
kind: security
depends_on: [010-core-db]
review: true
check:
  - npm test
  - npm run typecheck
---
Describe the work in plain language and say what "done" looks like.
```

| Key | Default | Description |
|---|---|---|
| `kind` | `default` | Selects the preferred agent order from `routing` in the config |
| `depends_on` | none | Tasks that must be merged first |
| `check` | none | Shell commands that must exit with code 0. Bullpen runs them, not the agent |
| `agents` | none | Restrict the task to these agents |
| `review` | config value | Whether a different agent reviews the change before merging |

Keep tasks small, about an hour of work or less. A small task loses little when an agent is cut off. Working samples are in [`examples/`](examples).

## Preparing worktrees

Each task runs in a fresh git worktree, which has no installed dependencies. To prepare it, list commands under setup in .bullpen/config.json. Bullpen runs them once per worktree before the agent starts:

```json
{ "setup": ["npm ci"] }
```

A failing setup marks the task 
eeds_human without starting an agent. See [Configuration](docs/configuration.md#preparing-worktrees).

## Supported agents

| Agent | Status | Tested with |
|---|---|---|
| Claude Code | Supported | 2.1.308 on Windows |
| Codex CLI | Supported | 0.165.0 on Windows |
| Antigravity CLI (`agy`) | Supported | 1.4.12 on Windows |
| Other CLIs | Through configuration | See [Adding an agent](docs/adding-an-agent.md) |

Bullpen looks for each CLI on `PATH`. On Windows it also looks inside the Claude and Codex desktop apps, whose folders change with every update.

## Documentation

- [How it works](docs/how-it-works.md): task states, outcomes, resting rules, files and branches
- [Configuration](docs/configuration.md): every setting and its default
- [Adding an agent](docs/adding-an-agent.md)
- [Changelog](CHANGELOG.md)

## Limitations

- No real usage-limit message has been observed from any tool. Detection is tested against sample wordings only. If an agent reaches its limit, please [report the exact message](https://github.com/VenkateshRnb/bullpen/issues/new?template=limit_message.yml).
- Real agents have only been run on Windows. The test suite, which uses pretend agents, passes in CI on Linux, macOS and Windows, and the built CLI starts on Node 20, 22 and 24.
- Gemini CLI is not included by default. Google moved personal and Google AI Pro/Ultra accounts to Antigravity CLI, and Gemini CLI now serves API-key and Enterprise users. It can be added through configuration.
- Running several tasks at once (`concurrency` above 1) has only been tested with test doubles.
- Merge conflicts are not resolved automatically. The task is marked `needs_human`.
- Agent review is a second opinion and can miss defects.

## Security considerations

- Agents run with your user account's permissions and logins. Set their allowed-tools lists deliberately; see [Configuration](docs/configuration.md).
- Do not run Bullpen on a repository you do not trust. Repository content can contain instructions aimed at the agents.
- Review `bullpen/integration` before merging it.
- Bullpen collects no telemetry and makes no network requests of its own. Only the agents you configure contact their vendors.
- Check each vendor's terms regarding unattended use of subscription plans.
- Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Related projects

Other tools address nearby problems. [tapout](https://pypi.org/project/tapout/) and [Kaseban/baton](https://github.com/Kaseban/baton) hand a session over from one agent to another, and [batonhq](https://libraries.io/npm/batonhq) routes tasks between agents. Bullpen is an unattended scheduler: it waits out an agent's reset time, runs your checks and has a second agent review. These descriptions come from the projects' own documentation and have not been verified in depth.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Reports of real usage-limit messages are especially useful.

## License

[MIT](LICENSE) © Naga Bala Venkatesh Ramoju

Bullpen is an independent project and is not affiliated with Anthropic, OpenAI or Google. Claude, Codex, Gemini and Antigravity are trademarks of their owners and are named here only to describe compatibility.
