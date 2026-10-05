# Roundtable

**Several AI coding agents in one room inside VS Code — from the vendors you already pay for, on your machine, under rules you set.**

Put a Claude architect, a Codex implementer and a Gemini skeptic in a room. Ask a question. They answer you and each other, one at a time, until they run out of things to say. DM one of them when you want a private word. Pin the rooms you live in. Add guardrails so the whole cast obeys your project's architecture.

![Roundtable in the editor](docs/screenshot-editor.jpg)

## 60-second start

```bash
git clone <this repo> roundtable && cd roundtable
npm install && npm run build
```

Open the folder in VS Code, press **F5**, open a project in the new window, click the **Roundtable** icon in the Activity Bar.

Full walkthrough: [docs/getting-started.md](docs/getting-started.md).

## What you get

- **Rooms and DMs** — group debates or one-on-one chats, each with its own memory per agent. Create, rename, pin, delete from the sidebar, the room switcher or the command palette.
- **Five vendors, your logins** — Claude (Claude Code), OpenAI Codex (ChatGPT), Google Gemini (Gemini CLI), GitHub Copilot, Cursor agent. Roundtable shows which are installed and signed in, greys out the rest with setup hints, and lists each vendor's models. Nothing runs in a cloud agent service.
- **Per-agent control** — vendor, model (one-click switch), effort, permission mode, role, tool rules, shared folder / own git worktree / read-only. Live where the vendor allows.
- **A real debate** — @mentions pick who speaks, agents pass when they have nothing new, round and budget caps stop runaway loops, Esc stops now. Interject any time.
- **Guardrails** — presets *solo*, *team*, *factory* or à la carte: shell safety, protected paths, secrets scan, typecheck/lint/test gates, module boundaries, AGENTS.md, architecture map, ADRs, definition of done, reviewer veto, spec-first approval, worktree per implementer. Enforced with hooks for Claude and Copilot, checked after every turn for the others.
- **VS Code native** — Activity Bar icon, Rooms & Agents tree with context menus, sidebar chat or editor tab, status bar, `⌘⇧R` to open, `⌘⇧.` to send the editor selection to the room.

## Docs

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | install, providers, first conversation |
| [Concepts](docs/concepts.md) | agents, rooms, DMs, turns, sessions, cost |
| [Providers](docs/providers.md) | per-vendor setup, models, setting mappings, enforcement levels |
| [Agents](docs/agents.md) · [Rooms](docs/rooms.md) | every setting and action |
| [Guardrails](docs/guardrails.md) | catalog, presets, setup, adding your own |
| [Troubleshooting](docs/troubleshooting.md) · [FAQ](docs/faq.md) | |
| [Development](docs/development.md) | layout, data flow, tests, release |
| [Changelog](CHANGELOG.md) | |

## Status

0.3.0. Runs from source; not on the Marketplace yet. Claude, Codex and Copilot are exercised end-to-end on the author's machine; the Gemini and Cursor adapters are tested against their documented event formats and need an installed, signed-in CLI to try live. Cursor support is marked experimental.
