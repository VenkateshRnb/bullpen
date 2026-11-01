# Adding an agent

Any command-line tool that can take a prompt and work without a person at the keyboard can join the bullpen. You add it in `.bullpen/config.json`; no code changes are needed.

```json
{
  "agents": {
    "myagent": {
      "enabled": true,
      "command": "myagent",
      "promptVia": "stdin",
      "args": ["run", "--non-interactive", "--allow", "edit,shell:git,shell:npm"],
      "reviewArgs": ["run", "--non-interactive", "--read-only"],
      "cooldownMinutes": 60,
      "authCheck": { "args": ["whoami"], "okPattern": "signed in" }
    }
  },
  "routing": {
    "default": ["claude", "codex", "myagent"]
  }
}
```

## Checklist

1. **Headless mode.** Find the flag that runs one prompt and exits (`-p`, `exec`, `run`, ...).
2. **Prompt delivery.** Prefer `stdin`. If the tool only takes the prompt as an argument, use `arg`. If long multi-line arguments break on your platform, use `file`: Bullpen writes the prompt to `.bullpen-prompt.md` in the worktree and you tell the agent to read it with `{promptFile}`.
3. **Unattended permissions.** Allow edits and the few commands the checks need (usually `git`, your package manager, your test runner). Do not use a blanket "approve everything" flag outside a disposable sandbox.
4. **Read-only reviews.** Set `reviewArgs` to the tool's read-only or plan mode so a reviewer cannot change files.
5. **Sign-in probe.** If the tool has a "who am I" or "status" command, set `authCheck` so a signed-out agent is noticed before it wastes an attempt.
6. **Try it.** Run `bullpen doctor`, then a one-line task such as the one in `examples/`.

## What a usable agent must do

- Exit with code 0 when it finished, non-zero when it failed.
- Print its usage-limit message to stdout or stderr when it runs out, ideally with the reset time. Bullpen recognises many wordings; if yours is not recognised, [open an issue](https://github.com/VenkateshRnb/bullpen/issues/new?template=limit_message.yml) with the exact text and it will be added to `src/limits.ts` with a test.
- Leave the work in the working directory. Bullpen commits it for the agent.

## Testing without spending any usage

The test suite uses a pretend agent, `test/fixtures/fake-agent.mjs`, driven by environment variables. It is the quickest way to try a change to Bullpen itself without calling a real agent.
