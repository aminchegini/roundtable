# Changelog

## 0.3.0 — rooms, direct messages, multi-vendor agents, VS Code surface

- Rooms and DMs: create, rename, pin, delete, edit participants; one session per (room, agent); rooms run independently.
- Providers: Claude, OpenAI Codex, Google Gemini, GitHub Copilot, Cursor agent. Detection shows installed / signed-in state with setup hints; model pickers per vendor; token figures for vendors without USD.
- Text room protocol (`PASS`, `APPROVE:`, `SPEC:`) for vendors without in-process tools; host-side stop gates for vendors without hooks.
- Activity bar icon, Rooms & Agents tree, sidebar chat view, editor chat tab, status bar item, commands, context menus, keybindings (`⌘⇧R`, `⌘⇧.`).
- Webview: responsive layout, room switcher, participant chips, inline model switch, @mention autocomplete, slash commands, markdown rendering, Welcome and Help panels.
- Docs: getting started, concepts, providers, agents, rooms, guardrails, troubleshooting, FAQ, development.

## 0.2.0 — guardrails

- Guardrail catalog in three layers (gates, knowledge, process), presets solo / team / factory, `.roundtable/guardrails.json`, setup with preview, Stop-hook loop guard, spec approval card, reviewer veto.

## 0.1.0 — the room

- Several Claude agents in one room with per-agent model and settings, free debate with @mentions, caps, permission prompts, live model switching, session resume, worktree mode.
