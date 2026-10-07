# Getting started

Roundtable puts several AI coding agents in one room inside VS Code. They answer you and each other, each with its own vendor, model and settings, and the whole thing runs on your machine with the subscriptions you already have.

## 1. Install and run

Until it is on the Marketplace, run it from source:

```bash
git clone https://github.com/aminchegini/roundtable
cd roundtable
npm install
npm run build
```

Open the folder in VS Code and press **F5** (Run Extension). A second window opens with Roundtable installed. Open a project folder there.

Works in Cursor too.

## 2. Open the room

Click the **Roundtable** icon in the Activity Bar (the round table with three seats). The sidebar shows:

- **Rooms & Agents** — rooms, direct messages and your agents. Right-click anything to rename, pin, delete, change model.
- **Chat** — the active room.

Prefer a big view? Press `⌘⇧R` or run **Roundtable: Open Chat in Editor**. Set `roundtable.chatLocation` to `editor` to make that the default.

## 3. Check your providers

Open **Help** (the `?` in the chat header). Each vendor card shows whether it is installed and signed in:

| Provider | What it needs |
| --- | --- |
| Claude | Claude Code installed and signed in once (`claude`), or **Roundtable: Set API Key** |
| Codex | `npm i -g @openai/codex`, then `codex login` (ChatGPT account) |
| Gemini | `npm i -g @google/gemini-cli`, then run `gemini` once to sign in |
| Copilot | `npm i -g @github/copilot`, then `copilot login` (Copilot subscription) |
| Cursor agent | `curl https://cursor.com/install -fsSL \| bash`, then `agent login` |

Agents whose vendor is not signed in are greyed out with the setup hint. Click **Re-check providers** after signing in.

## 4. Meet the default agents

A fresh workspace gets three Claude agents in a room called **General**:

- **Ada** — architect (Fable)
- **Rex** — skeptic (Sonnet)
- **Kit** — pragmatist (Haiku)

Click an agent chip or roster row to change its name, vendor, model, effort, role, permissions and workspace mode. The model dropdown in the roster switches models in one click.

## 5. Talk

Type in the composer and press Enter.

- `@Rex` gives Rex the next turn; `@all` queues everyone.
- Agents reply one at a time and pass when they have nothing to add. The debate stops when everyone passes, after `roundtable.maxRounds` rounds, or when the room's USD budget is reached.
- Press **Stop** (or Esc) to interrupt.
- `/dm Rex` opens a private chat with Rex; only Rex answers there, and that chat has its own memory.

## 6. Add guardrails

Open **Guardrails** (the shield in the header) and pick a preset — **solo**, **team** or **factory** — or toggle rules one by one. Rules that need project files or tools show a setup list; **Apply setup** writes them. See [guardrails.md](guardrails.md).

## Next

- [concepts.md](concepts.md) — agents, rooms, DMs, turns, memory
- [providers.md](providers.md) — vendor details, model lists, enforcement levels
- [rooms.md](rooms.md), [agents.md](agents.md)
- [troubleshooting.md](troubleshooting.md), [faq.md](faq.md)
