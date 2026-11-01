# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's private reporting instead: go to the repository's **Security** tab and choose **Report a vulnerability**. If that is not available, contact the maintainer through the details on their GitHub profile.

Include what you found, how to reproduce it, and the version (`bullpen --version`). You should get a reply within a week. Fixes for confirmed problems are released as soon as practical, and you will be credited unless you prefer not to be.

## Supported versions

Only the latest release receives security fixes while the project is below 1.0.

## What is in scope

Bullpen starts other tools and writes to your git repository, so the issues that matter most are:

- running or writing something it should not (path traversal, command injection through task files, config or agent output)
- touching a branch other than `bullpen/*`
- leaking environment variables or credentials into logs, commits or the status file
- weaknesses that let one task's agent affect another's worktree

## What is not a vulnerability

- An agent doing something harmful within the permissions you gave it. Agents run with your logins and the tool lists in your configuration, so choose those carefully (see the Safety section of the README and [docs/configuration.md](docs/configuration.md)).
- Prompt injection from the contents of a repository you chose to run Bullpen on. Do not run it on repositories you do not trust, and review the integration branch before merging it.
- A reviewing agent approving work that has a bug. Review is a second opinion, not an audit.

Bullpen has no runtime dependencies, no telemetry and makes no network calls of its own.
