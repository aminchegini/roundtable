# Guardrails

Guardrails are project-level rules that apply to every agent in the room. They are selected per project (presets or one by one) and stored in `.roundtable/guardrails.json`, which is meant to be committed so the whole team runs the same factory.

Three layers:

| Layer | Mechanism | Can an agent work around it? |
| --- | --- | --- |
| Gate | Claude Agent SDK hooks (`PreToolUse`, `PostToolUse`, `Stop`) on every tool call | No |
| Knowledge | Files in the project (AGENTS.md, architecture map, ADRs) fed into every agent's prompt | Yes, which is why gates exist |
| Process | Room tools plus runtime state (approval, spec) that gates read | No |

## Catalog

### Gates

- **bash-safety** — denies force pushes, recursive deletes outside the project, curl-into-shell, sudo, `git reset --hard`, disk-level commands. Package installs are denied unless `allowInstalls` is on. Optional `allowlistOnly` mode.
- **protected-paths** — denies Edit/Write to files matching the globs (and shell commands that redirect into them). Agents with `canEditProtected` are exempt.
- **secrets-scan** — after each write, scans the written text for key/token/private-key shapes and tells the agent; at `Stop`, re-scans every file the agent touched and blocks until clean. Runs `gitleaks protect --staged` before `git commit` when gitleaks is installed.
- **typecheck-gate** — runs `tsc --noEmit` after `.ts` edits (throttled) and at `Stop` when `.ts` files changed.
- **lint-gate** — eslint on changed files, after edits and at `Stop`.
- **tests-gate** — runs the detected test command at `Stop` (`whenEdited` by default).
- **boundaries** — dependency-cruiser on changed files, using `.dependency-cruiser.cjs` generated from `docs/architecture.yml`.

### Knowledge

- **agents-md** — creates `AGENTS.md` from detection if neither it nor `CLAUDE.md` exists; its content is appended to every agent prompt.
- **architecture-map** — creates `docs/architecture.yml` (one module per source folder, all imports allowed; prune by hand). Listed in every prompt and used to generate the boundaries config.
- **adr** — creates `docs/adr/` with a first ADR and template. With `enforce`, a turn that changes files matching `archGlobs` without touching `docs/adr/**` is blocked.
- **definition-of-done** — a checklist in every prompt; with `require`, the final reply must contain a `DoD:` line when files changed.

### Process

- **reviewer-veto** — one agent is flagged `reviewer` (read-only). Other agents' edits are denied until the reviewer calls `approve_plan`. Approval resets with every user message. Setup picks the reviewer (first agent whose name or role mentions review/skeptic/critic/QA).
- **spec-first** — edits are denied until an agent calls `submit_spec` and the user approves it in the room. Approval or "request changes" is posted as a user message so agents see it.
- **worktree-per-implementer** — switches every non-reviewer to `worktree` mode and tells agents to commit on `roundtable/<agent>/<slug>` branches. The project's `node_modules` is symlinked into each worktree so tooling works.

While locked by a process guardrail, agents may still run read-only shell commands (`git status`, `ls`, `grep`, test and typecheck commands); everything else is denied with the reason.

## Presets

| | solo | team | factory |
| --- | --- | --- | --- |
| bash-safety, protected-paths, secrets-scan | ✓ | ✓ | ✓ |
| typecheck-gate, lint-gate, tests-gate | | ✓ | ✓ |
| agents-md, adr (soft), definition-of-done | | ✓ | ✓ |
| architecture-map, boundaries, adr (enforced), DoD (required) | | | ✓ |
| reviewer-veto, spec-first, worktree-per-implementer | | | ✓ |

The file records the preset plus your changes relative to it:

```json
{ "preset": "team", "enabled": { "boundaries": true, "tests-gate": { "when": "always" } }, "disabled": ["lint-gate"] }
```

Effective config for a guardrail = its defaults (from project detection) ← preset overrides ← your overrides.

## Setup

Enabling a guardrail that needs files or tools shows a setup list (files to write, packages to install, agent settings to change). **Apply setup** writes the files (never overwriting an existing one), installs packages with the detected package manager, and restarts agent sessions. Setup actions are deduplicated across guardrails, so the architecture map is written once even if both `architecture-map` and `boundaries` ask for it.

## Stop-hook behaviour

Gates that check at `Stop` return `{ decision: 'block', reason }`, which makes the agent keep working on the reason. To avoid loops, an agent is blocked at most twice per turn; after that it is allowed to finish and a system message names the unmet gate.

## Adding a guardrail

Add a `GuardrailDef` to `src/guardrails/catalog/` and list it in `catalog/index.ts`:

```ts
export const myGuardrail: GuardrailDef<MyConfig> = {
  id: 'my-guardrail', title: '…', summary: '…', layer: 'gate',
  fields: [{ key: 'strict', label: 'Strict', type: 'boolean' }],   // drives the config form
  appliesTo: (profile) => profile.node,
  defaults: (profile) => ({ strict: false }),
  status: (profile, config, agents) => 'ready',                     // or 'needs-setup' | 'missing-tool'
  setup: async (profile, config, agents) => [],                     // write / install / agents actions
  hooks: (ctx) => ({ PreToolUse: [{ matcher: 'Bash', hooks: [async (input) => deny('…')] }] }),
  stopCheck: async (ctx, lastMessage) => undefined,                 // return a reason to keep the agent working
  prompt: (ctx) => 'One paragraph the agent should know.',
  tools: (ctx) => [],                                               // room tools (zod schema + handler)
};
```

`ctx` gives you the agent, roster, project root, the agent's cwd, the detected profile, the per-room state (`ctx.room`), the per-turn state (`ctx.turn.editedFiles`), a serial command `runner`, `report()` to post a system message, and `stateChanged()` to refresh the UI. Hooks must be fast or run through `ctx.runner`; the Stop matcher has a 10-minute timeout.

Unit-test a guardrail by building hooks from a `GuardrailRuntime` with a fake runner and firing synthetic hook inputs — see `test/guardrails.test.ts`.

To add a preset, append to `src/guardrails/presets.ts`.
