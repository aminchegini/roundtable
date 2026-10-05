# Providers

Roundtable runs agents through each vendor's own agent runtime, on your machine, with the login you already have. No keys are copied anywhere.

| Provider | Runtime | Sign-in | Guardrail enforcement | Cost figure |
| --- | --- | --- | --- | --- |
| **Claude** (Anthropic) | Claude Agent SDK (bundled CLI) | Claude Code login, or an API key via **Roundtable: Set API Key** | **Full** — in-process PreToolUse/PostToolUse/Stop hooks, approval prompts in the room | USD estimate |
| **Codex** (OpenAI) | `@openai/codex-sdk` (bundled `codex exec`) | `codex login` (ChatGPT), or `CODEX_API_KEY` | Gates after each turn | tokens |
| **Gemini** (Google) | Gemini CLI, headless `gemini -p … -o stream-json` | `gemini` once (Google), or `GEMINI_API_KEY` | Gates after each turn | tokens |
| **Copilot** (GitHub) | `@github/copilot-sdk` (bundled runtime) | `copilot login`, `gh auth`, or `COPILOT_GITHUB_TOKEN` | **Full** — in-process PreToolUse hook, approval prompts in the room | tokens |
| **Cursor agent** | `agent -p … --output-format stream-json` | `agent login`, or `CURSOR_API_KEY` | Gates after each turn | — (experimental) |

"Gates after each turn" means: the agent's edits are tracked from its own events, and when it finishes a turn Roundtable runs the enabled Stop gates (typecheck, lint, tests, secrets, boundaries, ADR, definition of done). A failing gate becomes a follow-up message to the same session, at most twice, then the agent is let through and a system message names the unmet gate. PreToolUse blocks (shell safety, protected paths, review/spec locks) are **not** enforced for these vendors in this version; the prompt still tells the agent the rules.

## Detection

**Roundtable: Refresh Providers** (or **Re-check providers** in Help) re-runs detection:

- Claude: `~/.claude/.credentials.json` or `ANTHROPIC_API_KEY`.
- Codex: `~/.codex/auth.json` or `CODEX_API_KEY`. The default model comes from `~/.codex/config.toml`.
- Gemini: `gemini` on PATH, `~/.gemini/oauth_creds.json` or `GEMINI_API_KEY`.
- Copilot: starts the bundled runtime and asks it (`getAuthStatus`, `listModels`). Takes a few seconds the first time.
- Cursor: `agent` or `cursor-agent` on PATH, then `agent --list-models` (the account's models are the sign-in test).

Agents whose provider is unavailable are shown greyed in the tree, roster and Welcome card, with the setup hint. They still exist; fix the login and re-check.

## Models

Each picker lists the vendor's known models and accepts any id typed by hand (**Other…**):

- Claude: `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5-20251001`
- Codex: `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`, `gpt-5.5`, plus whatever `~/.codex/config.toml` names
- Gemini: `auto`, `gemini-3-pro-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`
- Copilot: `auto` plus the account's `listModels()` result
- Cursor: the account's `agent --list-models` result

Change a model from the roster dropdown, the agent drawer, the tree context menu (**Change Model…**, grouped by vendor with availability), or `/model Name model-id`.

## How settings map per vendor

| Agent setting | Claude | Codex | Gemini | Copilot | Cursor |
| --- | --- | --- | --- | --- | --- |
| `effort` | `effort` option, live | `modelReasoningEffort` (thread recreated) | — | `reasoningEffort` (session recreated) | — |
| `permissionMode: default` | prompts in the room | `approvalPolicy: never`, workspace-write sandbox | `--approval-mode default` | prompts in the room | no `--force` |
| `acceptEdits` | auto-accept edits | same as above | `auto_edit` | approves read/write, prompts for shell | `--force` |
| `auto` | classifier | same | `yolo` | approve all | `--force` |
| `plan` / `dontAsk` | SDK semantics | same | `plan` / `default` | rejects prompts | — |
| `workspaceMode: read-only` | Edit/Write/Bash denied | `sandboxMode: read-only` | `--approval-mode plan` | edit/shell tools excluded | `--mode ask` |
| `workspaceMode: worktree` | own git worktree | own git worktree | own git worktree | own git worktree | own git worktree |

Vendors without approval callbacks (Codex, Gemini, Cursor) never ask you anything mid-turn; the mode selects their sandbox policy instead.

## Room protocol without tools

Claude agents have Roundtable's in-process tools (`pass_turn`, `approve_plan`, `submit_spec`). Other vendors use text:

- a reply that is exactly `PASS` passes the turn;
- a line `APPROVE: <summary>` from the reviewer approves the plan (reviewer-veto guardrail);
- a line `SPEC:` followed by a fenced markdown block submits a spec (spec-first guardrail).

Roundtable strips these from the posted message.

## Adding a provider

Implement `Provider` from `src/providers/types.ts`: `detect()`, `staticModels`, `defaultModel`, `enforcement`, `costUsd`, and `createSession()` returning an `AgentSession` (`runTurn`, `interrupt`, `applyConfig`, `restart`, `dispose`). Register it in `src/providers/registry.ts`. Use `buildFullPrompt` and `primedInput` from `src/providers/shared.ts` for the first message of a session, `spawnJsonl` for CLI vendors, and call `ctx.guardrails.noteEdit()` for every file the agent changes so the gates know about it. Keep event parsing in an exported pure function so it can be unit-tested with recorded events (see `applyGeminiEvent`).
