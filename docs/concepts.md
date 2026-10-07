# Concepts

## Agent

An **agent** is an identity: a name, a colour, a role prompt, a vendor (**provider**), a model, an effort level, a permission mode, tool allow/deny lists and a workspace mode. Agents are saved in `.roundtable/agents.json` inside the project, so a team can share them.

An agent is not a conversation. It can sit in several rooms and have a DM; each of those has its own memory.

## Room

A **room** is a group conversation between you and a set of agents. Each room keeps:

- its transcript,
- one **session** per participating agent (that agent's memory in this room),
- its own guardrail state (review approval, pending spec).

Rooms live in VS Code workspace state (personal, not committed). Pin, rename and delete them from the sidebar tree, the room switcher in the chat header, or the command palette.

## Direct message

A **DM** is a room with exactly one agent. Nothing else is special about it: same scheduler, same guardrails, same caps. It exists so you can talk to one agent without the whole room weighing in. Click an agent in the tree, or type `/dm Name`.

## Turn

When you post, agents take turns **one at a time**:

1. Agents you @mentioned go first, in order. `@all` queues everyone.
2. Otherwise round-robin, continuing from whoever spoke last.
3. Each agent receives only the messages it has not seen yet, as `[Name]: text` lines.
4. Its final reply is posted to the room. Agents can @mention each other to hand over the turn.
5. An agent with nothing to add **passes** (Claude agents call a tool; others reply `PASS`).

The debate ends when every agent passes in a row, when the round cap is hit (`roundtable.maxRounds`, default 6 rounds after your last message), when the room's USD budget is reached (`roundtable.budgetUsd`, Claude agents only), or when you press Stop. You can interject at any time; that resets the round counter.

## Session and memory

Every (room, agent) pair has one long-lived vendor session: a Claude Agent SDK session, a Codex thread, a Gemini CLI session id, a Copilot session, or a Cursor chat id. Sessions are resumed when you reopen VS Code, so the agent remembers the room. **Reset room** throws the sessions away.

Changing an agent's name, role or guardrails restarts its sessions on their next turn, resuming the same history with the new instructions. Changing model, effort or permission mode applies live where the vendor allows it.

## Provider

A **provider** is the adapter for one vendor. It knows how to detect whether the vendor is installed and signed in, which models exist, how to run a turn, and what it can enforce. See [providers.md](providers.md).

## Guardrail

A **guardrail** is a project-level rule every agent must follow: a gate enforced on tool calls, a knowledge file fed into every prompt, or a process rule such as reviewer approval. Chosen per project from presets or individually, saved in `.roundtable/guardrails.json`. See [guardrails.md](guardrails.md).

## Cost and quotas

Each session reports how it is billed once it starts:

- **Subscription** (Claude Code login, ChatGPT login, Copilot, Cursor login, Gemini OAuth): the header says *Subscription* and, when the vendor reports rate-limit windows (Claude does: 5-hour and 7-day), how much of the fullest window is left. No dollar figure is shown because there is no per-call charge.
- **API key**: the header shows *API ≈ $x.xx (approx)* — the vendor's own estimate, not a bill — and the room budget cap (`roundtable.budgetUsd`) applies to it.
- A room with both shows both. Token counts appear where nothing else is available.

All figures are approximate and vendor-reported; the vendor's dashboard is authoritative. See [DISCLAIMER.md](../DISCLAIMER.md).
