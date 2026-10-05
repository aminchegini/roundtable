# FAQ

**Does anything run in the cloud?**
Only the vendors' model inference, through their own runtimes and your own logins. Rooms, transcripts, guardrails and tool execution are local.

**Can agents from different vendors talk to each other?**
Yes. The room is vendor-neutral: each agent gets the messages it has not seen as text and replies as text. A Claude architect, a Codex implementer and a Gemini reviewer in one room is the point.

**Why does my Codex/Gemini/Cursor agent never ask for permission?**
Those runtimes are non-interactive when driven headlessly. Roundtable maps the permission mode to their sandbox/approval policy instead (see [providers.md](providers.md)). Claude and Copilot do ask, in the room.

**Can I give one agent a different memory per project?**
Memory is per (room, agent) already, and rooms are per workspace. Open another folder and you get fresh rooms.

**Can two rooms run at the same time?**
Yes. Each room has its own sessions; switch rooms while one is debating and start another.

**Why is the USD figure lower than expected?**
Only Claude reports USD. Other vendors report tokens, shown separately as `12k tok`.

**Where is everything stored?**

| What | Where |
| --- | --- |
| Agents | `.roundtable/agents.json` in the project |
| Guardrails | `.roundtable/guardrails.json` in the project |
| Rooms, transcripts, session ids | VS Code workspace state |
| Worktrees | VS Code global storage for the extension |
| Vendor sessions | Each vendor's own store (`~/.claude`, `~/.codex/sessions`, `~/.gemini/tmp`, `~/.copilot`, `~/.cursor`) |

**Can I use my own system prompt instead of Claude Code's?**
Not yet; roles are appended to the vendor default. The role box is the place for strong instructions.

**Can I run it in Cursor instead of VS Code?**
Yes, Cursor loads VS Code extensions. Build it and install the folder, or use `code --extensionDevelopmentPath` with Cursor's CLI.

**Is this on the Marketplace?**
Not yet. Run from source (F5) or `npx @vscode/vsce package` to make a `.vsix` and install it.
