# Contributing to Roundtable

Thanks for taking the time. Roundtable is small enough to read in an afternoon, and most contributions fall into one of three buckets: a new **provider**, a new **guardrail**, or a fix in the room UI.

## Setup

```bash
git clone https://github.com/aminchegini/roundtable
cd roundtable
npm install
npm run build
npm test
```

Press **F5** in VS Code to launch the Extension Development Host. `npm run preview` opens the webview in a browser with fake data so you can iterate on UI without any agent running. `git config core.hooksPath scripts/githooks` enables the pre-commit secret scan for recorded fixtures.

## Before you open a pull request

- `npm run typecheck`, `npm test` and `npm run build` pass.
- If the set of shipped files changes, run `npm run check:package -- --update` and commit `package-manifest.txt` so the change is visible in review.
- New behaviour has a unit test. Scheduler, guardrail hooks, room store and provider event parsers are all tested without network access — see `test/` for the patterns.
- If you touched a provider, say in the PR which live checks you ran (`npm run e2e:providers codex`, for instance) or that you could not.
- Keep the change focused. Formatting-only changes to files you did not otherwise touch make review harder.

## Adding a provider

Implement the `Provider` interface in `src/providers/types.ts` and register it in `src/providers/registry.ts`. The important parts:

- `detect(env)` — installed? signed in? what models? Never prompt; just report with a `setupHint`.
- `createSession()` — return an `AgentSession`. Use `buildFullPrompt` / `primedInput` from `shared.ts` to send the role prompt as the first message when the vendor has no system-prompt hook, and `spawnJsonl` for CLIs that stream JSON lines.
- Call `ctx.guardrails.noteEdit()` for every file the agent changes so the stop gates see it.
- Keep event handling in an exported pure function and add a test with recorded events.

See [docs/providers.md](docs/providers.md).

## Adding a guardrail

Add a `GuardrailDef` to `src/guardrails/catalog/` and list it in `catalog/index.ts`. Presets live in `presets.ts`. Test it by building hooks from a `GuardrailRuntime` with a fake runner and firing synthetic hook inputs — `test/guardrails.test.ts` has examples.

See [docs/guardrails.md](docs/guardrails.md).

## Reporting bugs

Open an issue with: VS Code version, the provider and model involved, what you expected, what happened, and the relevant lines from the **Roundtable** output channel (View → Output → Roundtable). Redact anything you would not want public.

## Code style

TypeScript, strict mode, no default exports, small files with one job each. Comments explain *why*, not *what*. Match the surrounding code.

## License

By contributing you agree that your contributions are licensed under the MIT License that covers the project.
