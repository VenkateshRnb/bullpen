# Contributing to Bullpen

Bullpen is deliberately small. Focused changes are the easiest to review.

## Reporting usage-limit messages

Detection reads the agent's output, and the exact wording of real limit messages has not been observed by the maintainer. If an agent reaches its limit, open a ["usage-limit message" issue](https://github.com/VenkateshRnb/bullpen/issues/new?template=limit_message.yml) with the exact text, the tool and its version. It becomes a test case in `test/limits.test.ts`.

Other welcome contributions: macOS and Linux fixes, adapters for other agent CLIs (see [docs/adding-an-agent.md](docs/adding-an-agent.md)), clearer docs, and bug reports with a reproduction.

## Setting up

You need Node 24 (the tests run the TypeScript directly) and git.

```bash
git clone https://github.com/VenkateshRnb/bullpen.git
cd bullpen
npm install
npm run typecheck     # strict TypeScript
npm run test:unit     # fast, a couple of seconds
npm test              # full suite, about 3 to 4 minutes (it builds real git repos)
npm run build         # compiles to dist/ (what ships in releases)
```

Run the tool from source with `npm run bullpen -- doctor`.

## Ground rules

- **No runtime dependencies.** Bullpen runs other people's tools with your credentials; keeping its own dependency tree empty is a safety feature. Dev dependencies are fine.
- **Erasable TypeScript only** (no enums, namespaces or parameter properties), because the tests run `.ts` files directly. `npm run typecheck` enforces this.
- **Every behavior change needs a test.** The end-to-end tests in `test/engine.test.ts` use a pretend agent (`test/fixtures/fake-agent.mjs`), so they cost nothing and are repeatable. Add a behavior to the fake agent if your scenario needs one.
- **Claims must be true.** If you add support for something, say in the README how it was verified. Unverified support goes in as "experimental".
- Keep pull requests focused: one change, explained, with the tests.

## Pull requests

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Branch from `main`, make the change, run `npm run typecheck && npm test`.
3. Fill in the pull request template. CI runs the suite on Linux, macOS and Windows.

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), not public issues.
