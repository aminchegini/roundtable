# Agents

Open an agent's settings by clicking its chip in the chat header, its row in the roster (editor-width view), or via the tree. The drawer has:

| Setting | Meaning | Applies |
| --- | --- | --- |
| Name, colour | How the agent appears; `@Name` mentions use it | Next turn (sessions restart, history kept) |
| Provider | Vendor runtime (Claude, Codex, Gemini, Copilot, Cursor). Unavailable vendors are flagged with a setup hint | Next turn |
| Model | Vendor model id; dropdown of known models or **Other…** | Live where the vendor allows, else next turn |
| Effort | low · medium · high · xhigh · max; mapped to the vendor's reasoning effort | Live (Claude) / next turn |
| Permission mode | default (ask), acceptEdits, auto, plan, dontAsk; mapped per vendor, see [providers.md](providers.md) | Live (Claude, Copilot) / next turn |
| Workspace | shared (edits the open folder), worktree (own git worktree, `node_modules` symlinked), read-only (no edits, no shell) | Next turn |
| Role | Appended to the vendor's system prompt (or the first message, for vendors without one) | Next turn |
| Reviewer | Read-only; with the reviewer-veto guardrail, others cannot edit until it approves | Next turn |
| May edit protected paths | Exempt from the protected-paths guardrail | Next turn |
| Pinned | Shows in the Pinned section of the tree | Immediately |
| Always-allowed / disallowed tools | Claude tool rules (`Read`, `Bash(npm test:*)`, …) | Next turn |
| Limits | Allow API-billed usage (off by default; the room must allow it too), API budget, stop at plan usage %, token cap — 0 means unlimited. A limit benches this agent in every room | Next turn |
| Guardrails for this agent | Per rule: inherit the room, force on, or force off (e.g. exempt a trusted release agent from protected paths) | Next turn |

Agents are stored in `.roundtable/agents.json` in the project (or in VS Code global state when no folder is open), so a team can commit a shared cast.

## Quick actions

- **Roster dropdown** (editor view): change the model in one click.
- **Tree context menu**: Message, Change Model…, Rename, Pin, Delete.
- **Composer**: `/model Rex claude-opus-5-5`, `/dm Rex`.
- **Command palette**: Roundtable: New Agent (asks for the vendor first, then opens a DM with the new agent).

## Default cast

A new workspace gets Ada (architect, Claude Fable), Rex (skeptic, Claude Sonnet), Kit (pragmatist, Claude Haiku). Rename them, change vendors, or delete them — at least one agent must remain.

## Writing a good role

Short and specific beats long. State what the agent cares about, how it should disagree, and what it should not do. The room prompt already tells agents to be brief, address others with @Name and pass when they have nothing to add.
