# Development

```bash
npm install
npm run build          # extension host + webview bundles → dist/
npm run watch
npm run typecheck      # host and webview tsconfigs
npm test               # vitest, no API calls
npm run preview        # webview in a browser with fake data: http://localhost:5179/?loc=editor|sidebar
npm run e2e            # live two-agent Claude debate (cents)
npm run e2e:guardrails # live guardrail hooks on a scratch TS project (cents)
npm run e2e:providers  # one DM turn per signed-in provider (cents each)
npm run package        # build the .vsix (vendor SDK JS bundled, no vendor binaries)
npm run check:package  # file list vs package-manifest.txt, denylist, 25 MB cap
npm run check:vsix     # import the vendor bundles from the extracted .vsix
npm run release -- X.Y.Z  # bump, changelog, commit, tag (see docs/release.md)
```

Optional git hook that scans fixtures for secrets before a commit: `git config core.hooksPath scripts/githooks`.

Press **F5** in VS Code to launch the Extension Development Host.

## Layout

```
src/
  extension.ts          activation, commands, editor panel
  vscode/               ChatHost (webview bridge), RoomsTree, StatusBar
  room/
    Workspace.ts        agents + rooms + guardrail registry + controllers for one VS Code workspace
    RoomStore.ts        room metadata (create/rename/pin/delete/participants/active)
    RoomController.ts   one live room: scheduler, runtime, sessions, permissions, persistence
    Room.ts             turn scheduler and caps (no VS Code / vendor imports; unit-tested)
    textCommands.ts     PASS / APPROVE / SPEC text protocol
    SdkAgentSession.ts  Claude Agent SDK session (streaming input, room tools, hooks)
    config.ts           agents.json schema and defaults
    worktrees.ts        git worktree per agent
  providers/
    types.ts registry.ts shared.ts
    claude.ts codex.ts gemini.ts copilot.ts cursor.ts
  guardrails/
    types.ts detect.ts store.ts presets.ts runner.ts setup.ts
    runtime.ts          per-room state; builds hooks, prompts, tools; host-side stop gates
    registry.ts         per-workspace: profile, guardrails.json, effective set, setup plan
    catalog/            gates.ts knowledge.ts process.ts
  shared/
    protocol.ts         types shared with the webview; host↔webview messages
    guardrailsFile.ts   pure edits to guardrails.json
webview/
  main.tsx state.ts room.tsx panels.tsx markdown.tsx styles.css
scripts/                e2e scripts, preview harness, static server
docs/
test/
```

## Build output

`esbuild.mjs` produces:

- `dist/extension.js` — the extension host (CommonJS; only `vscode` is external).
- `dist/webview/main.js|css` — the React UI.
- `dist/vendor/{claude,codex,copilot}.mjs` — the vendor SDKs as ESM bundles (ESM so their `import.meta.url` keeps working). Their platform binary packages are externals that are never loaded, because every adapter passes an explicit executable path (`pathToClaudeCodeExecutable`, `codexPathOverride`, `RuntimeConnection.forStdio`). `src/providers/vendorLoader.ts` imports them at runtime; `src/providers/cli.ts` finds the CLIs.
- The Copilot SDK's optional native FFI dependency (`koffi`) is replaced by a stub (`scripts/stubs/koffi.mjs`): it is only used for an in-process runtime host, and Roundtable always drives the `copilot` CLI over stdio.

The whole package is about 1 MB. `scripts/check-package.mjs` keeps it that way.

## Data flow

1. `extension.ts` opens a `Workspace` with mementos, env (Claude API key fallback), caps and logging.
2. `ChatHost` renders the webview and forwards `WebviewToHost` messages: room-scoped ones to the active `RoomController`, workspace-scoped ones (rooms, agents, guardrails, providers) to `Workspace`.
3. `RoomController` owns a `Room` (scheduler) and a `GuardrailRuntime`; `Room.createSession` goes through the provider registry. Providers without a Stop hook are wrapped in `GatedSession`, which runs the stop gates after each turn.
4. Room events become `HostToWebview` messages; the webview reducer in `webview/state.ts` applies them.

## Adding a provider

See [providers.md](providers.md#adding-a-provider).

## Adding a guardrail

See [guardrails.md](guardrails.md#adding-a-guardrail).

## Tests

- `test/Room.test.ts` — scheduler with fake sessions.
- `test/guardrails.test.ts` — store layering, detection, every gate's hooks, Stop loop guard, process state machines, setup planning.
- `test/rooms.test.ts` — text protocol, RoomStore, Workspace (migration, DMs, participant sync, host-side gates), provider event reducers, registry.

Fake providers: tests swap the Cursor entry in `PROVIDERS` for a scripted one (`patchProvider`).

## Releasing

`npx @vscode/vsce package` builds a `.vsix`. `media/icon.png` is the Marketplace icon, `media/icon.svg` the activity bar icon.
