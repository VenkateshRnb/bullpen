# Examples

Two tiny tasks and a config that adds a custom agent. They exist to check your setup with very little usage.

```bash
cd some-scratch-repo                 # any git repo with one commit
bullpen init
cp path/to/bullpen/examples/tasks/*.md .bullpen/tasks/
bullpen doctor
bullpen run
```

- `tasks/010-hello.md` asks an agent to create one file. The check is a one-line Node command.
- `tasks/020-add.md` asks for a small function with tests. The check runs `node --test`.
- `config.json` shows how to add another agent and set routing.

Afterwards look at `bullpen/integration` (`git log bullpen/integration`) and at `.bullpen/STATUS.md`. Delete the scratch repo when you are done.
