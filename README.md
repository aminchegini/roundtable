<p align="center">
  <img src="https://raw.githubusercontent.com/aminchegini/roundtable/main/media/icon.png" width="96" alt="Roundtable">
</p>

<h1 align="center">Roundtable</h1>

<p align="center">
  <b>Several AI coding agents in one room inside VS Code — from the vendors you already pay for, on your machine, under rules you set.</b>
</p>

<p align="center">
  <a href="https://github.com/aminchegini/roundtable/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/aminchegini/roundtable/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-%5E1.100-007ACC?logo=visualstudiocode&logoColor=white">
  <img alt="Providers" src="https://img.shields.io/badge/agents-Claude%20%C2%B7%20Codex%20%C2%B7%20Gemini%20%C2%B7%20Copilot%20%C2%B7%20Cursor-6a9bcc">
</p>

<p align="center">
  <a href="docs/getting-started.md">Getting started</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="docs/providers.md">Providers</a> ·
  <a href="docs/guardrails.md">Guardrails</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

Put a Claude architect, a Codex implementer and a Gemini skeptic in a room. Ask a question. They answer you **and each other**, one at a time, until they run out of things to say. DM one of them when you want a private word. Pin the rooms you live in. Add guardrails so the whole cast obeys your project's architecture.

![A room: three agents from two vendors debating, with modes, pause and skip controls](https://raw.githubusercontent.com/aminchegini/roundtable/main/docs/screenshots/room.jpg)

<details>
<summary><b>More screenshots</b> — sidebar, room settings, guardrails, help</summary>
<br>

| Sidebar chat | Room settings |
| :-: | :-: |
| <img src="https://raw.githubusercontent.com/aminchegini/roundtable/main/docs/screenshots/sidebar.jpg" width="320" alt="Sidebar chat view"> | <img src="https://raw.githubusercontent.com/aminchegini/roundtable/main/docs/screenshots/room-settings.jpg" width="560" alt="Room settings: rounds, mode, limits, guardrails"> |

| Guardrails | Help & providers |
| :-: | :-: |
| <img src="https://raw.githubusercontent.com/aminchegini/roundtable/main/docs/screenshots/guardrails.jpg" width="440" alt="Guardrails presets and catalog"> | <img src="https://raw.githubusercontent.com/aminchegini/roundtable/main/docs/screenshots/help.jpg" width="440" alt="Help panel with provider status"> |

</details>

## Why

Every vendor ships an agent that works alone. Real engineering is a conversation: someone proposes, someone pokes holes, someone ships. Roundtable gives you that conversation with the subscriptions you already have — no new API bills, no cloud orchestration service, nothing leaves your machine except the model calls each vendor's own runtime already makes.

## Features

- **Rooms and direct messages.** Group debates or one-on-one chats, each with its own memory per agent. Create, rename, pin, delete from the sidebar, the room switcher or the command palette.
- **Five vendors, your logins.** Claude (Claude Code), OpenAI Codex (ChatGPT), Google Gemini (Gemini CLI), GitHub Copilot, Cursor agent. Roundtable shows which are installed and signed in, greys out the rest with setup hints, and lists each vendor's models.
- **Per-agent control.** Vendor, model (one-click switch), effort, permission mode, role, tool rules, shared folder / own git worktree / read-only. Applied live where the vendor allows.
- **A real debate, under control.** `@Name` picks who speaks, agents pass when they have nothing new, round / budget / quota / token caps stop runaway loops. **Pause** holds the table, **Stop** ends it, **⏭** skips one agent. Interject at any time.
- **Modes.** Each agent is in *Build*, *Plan* or *Ask*; a room mode overrides everyone. Ask = answer only — enforced with read-only tools on every vendor, not just a prompt.
- **Guardrails.** Presets *solo*, *team*, *factory*, or à la carte: shell safety, protected paths, secrets scan, typecheck / lint / test gates, module boundaries, `AGENTS.md`, architecture map, ADRs, definition of done, reviewer veto, spec-first approval, worktree per implementer. Enforced with hooks for Claude and Copilot; checked after every turn for the others.
- **VS Code native.** Activity Bar icon, Rooms & Agents tree with context menus, sidebar chat or editor tab, status bar, `⌘⇧R` to open, `⌘⇧.` to send the editor selection to the room.

## Install

> **Preview.** 0.4.x is a pre-release: it works, it is used daily, and things will still move. Please report what breaks.

- **VS Code:** search *Roundtable* in the Extensions view (pre-release channel), or `code --install-extension eminhikmet.roundtable --pre-release`.
- **Cursor, VSCodium, Windsurf:** search *Roundtable* on Open VSX, or install the `.vsix` from the [latest release](https://github.com/aminchegini/roundtable/releases).
- **From source:** `git clone https://github.com/aminchegini/roundtable && cd roundtable && npm install && npm run build`, then press **F5** in VS Code.

Then click the **Roundtable** icon in the Activity Bar.

### Requirements

Roundtable is ~1 MB and ships **no AI runtimes**. It drives the vendor command-line agents you already have, with the accounts you are already signed in to. Install at least one:

| Vendor | Install | Sign in |
| --- | --- | --- |
| Claude (Claude Code) | `npm install -g @anthropic-ai/claude-code` | `claude` once, or **Roundtable: Set API Key** |
| OpenAI Codex | `npm install -g @openai/codex` | `codex login` |
| Google Gemini | `npm install -g @google/gemini-cli` | `gemini` once |
| GitHub Copilot | `npm install -g @github/copilot` | `copilot login` or `gh auth login` |
| Cursor agent | `curl https://cursor.com/install -fsSL \| bash` | `agent login` |

The Help panel (`?`) shows each vendor's status with **Install** / **Sign in** buttons that open a terminal and re-check. Executables are found on `PATH`, in `~/.local/bin`, Homebrew and npm global dirs, and via your login shell; `roundtable.<vendor>Path` settings override that.

**Telemetry: none.** Roundtable sends nothing anywhere; the only network traffic is the vendors' own.

Full walkthrough: [docs/getting-started.md](docs/getting-started.md).

## How a room works

```
you ──▶ room ──▶ Ada (Claude)  "In-process cache behind an interface. @Rex poke holes."
                 Rex (Codex)   "Deploys wipe it; every release logs everyone out."
                 Kit (Gemini)  "Redis later. Interface now. PASS when done."
                 …until everyone passes, the round cap hits, or you press Stop.
```

Each agent only sees what it has not read yet. Mentioned agents go first, then round-robin. A DM is a room with one agent. Every (room, agent) pair is its own vendor session, resumed across restarts.

## Guardrails in one picture

| | solo | team | factory |
| --- | :-: | :-: | :-: |
| shell safety · protected paths · secrets scan | ✓ | ✓ | ✓ |
| typecheck · lint · tests gates | | ✓ | ✓ |
| `AGENTS.md` · ADRs · definition of done | | ✓ | ✓ |
| architecture map · module boundaries · enforced ADRs | | | ✓ |
| reviewer veto · spec-first approval · worktree per implementer | | | ✓ |

Saved in `.roundtable/guardrails.json`, so the whole team runs the same factory. Details: [docs/guardrails.md](docs/guardrails.md).

## Documentation

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | install, providers, first conversation |
| [Concepts](docs/concepts.md) | agents, rooms, DMs, turns, sessions, cost |
| [Providers](docs/providers.md) | per-vendor setup, models, setting mappings, enforcement levels |
| [Agents](docs/agents.md) · [Rooms](docs/rooms.md) | every setting and action |
| [Guardrails](docs/guardrails.md) | catalog, presets, setup, adding your own |
| [Troubleshooting](docs/troubleshooting.md) · [FAQ](docs/faq.md) | |
| [Development](docs/development.md) · [Release](docs/release.md) | layout, build, tests, publishing |
| [Changelog](CHANGELOG.md) · [Disclaimer](DISCLAIMER.md) | |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `roundtable.maxRounds` | 6 | Default debate rounds per message; rooms can override |
| `roundtable.chatLocation` | `sidebar` | Where **Open Chat** shows the room (`sidebar` or `editor`) |
| `roundtable.defaultProvider` | `claude` | Vendor preselected for new agents |
| `roundtable.claudePath` · `codexPath` · `geminiPath` · `copilotPath` · `cursorPath` | auto | Explicit executable paths when auto-detection misses |

Per-room and per-agent settings (limits, modes, guardrails) live in the UI — see [docs/rooms.md](docs/rooms.md) and [docs/agents.md](docs/agents.md).

## Status

**0.4.0 pre-release.** Claude, Codex and Copilot are exercised end-to-end; the Gemini and Cursor adapters are tested against their documented event formats and need an installed, signed-in CLI to try live. Cursor support is marked experimental. Release process: [docs/release.md](docs/release.md).

Roadmap: out-of-process hook files for Codex / Gemini / Cursor so PreToolUse blocks apply everywhere, Marketplace packaging, agents speaking in parallel, Python and Go guardrail catalogs, CI export of the same gates.

## Costs, quotas and liability — read this

Agents on a **subscription** (Claude Code login, ChatGPT login, Copilot, Cursor, Gemini OAuth) show *plan* and, where the vendor reports it, how much of the current rate-limit window is left. Agents on an **API key** show an *approximate* dollar figure from the vendor's own estimate; the room budget cap applies to that figure only. **Nothing Roundtable shows is a bill, and no cap is a guarantee.** Multi-agent debates can burn tokens fast.

Roundtable is independent and not affiliated with any vendor. It drives their tools under **your** accounts and **their** terms. **You are responsible for every token, request, charge, quota and overage incurred, and for anything an agent does in your repository. The author is not liable for any of it.** The software comes with **no warranty or guarantee of any kind**. Full text: [DISCLAIMER.md](DISCLAIMER.md).

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). New providers and guardrails are the most useful contributions and each has a short recipe.

## License

[MIT](LICENSE) © 2026 Emin Hikmet — see also the [Disclaimer](DISCLAIMER.md). No warranty; use at your own risk.
