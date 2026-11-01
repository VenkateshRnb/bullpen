# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/). While below 1.0, minor versions may change behavior.

## [0.1.0] - Unreleased

First public version, extracted from a private project.

### Added

- Task files with checks, dependencies, kinds, optional agent pins and per-task review settings.
- Headless runs of Claude Code and Codex, each in its own git worktree, merged into `bullpen/integration` without touching the user's branch.
- Usage-limit detection with reset-time parsing, and resting of the limited agent while another takes over.
- Sign-in detection for agents, before and during a run.
- Acceptance checks run by Bullpen itself, and cross-agent review with a verdict line that an echoed prompt cannot forge.
- Crash recovery, a single-instance lock and atomic state writes.
- `init`, `doctor`, `run`, `status`, `retry` and `unblock` commands, and a human-readable `.bullpen/STATUS.md`.
- Discovery of agent CLIs on `PATH` and inside the Claude and Codex desktop apps on Windows.
- An experimental Gemini CLI adapter (unverified), and support for any CLI through configuration.

### Known limitations

- A real usage-limit message has not been observed from any tool.
- Verified on Windows only; macOS and Linux are untested by hand.
