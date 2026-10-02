# Roundtable

VS Code extension: several local Claude agents in one room, talking to you and to each other. Each agent has its own model, effort, permission mode, role, tools and workspace mode, editable while the room is running.

Agents are ordinary Claude Code sessions run through the Claude Agent SDK on your machine. They use your existing Claude Code login; nothing runs in a cloud agent service.

## Run it

```bash
npm install
npm run build
```

Open this folder in VS Code and press F5 ("Run Extension"). In the new window, open a project folder and run **Roundtable: Open Room** from the command palette.

Works in Cursor too, since it loads VS Code extensions.

## How the room works

- You send a message. Agents answer one at a time; each sees what was said since it last spoke.
- `@Name` gives that agent the next turn. `@all` queues everyone. Agents can do the same to each other.
- An agent with nothing to add passes. The debate ends when every agent passes in a row.
- Hard stops: `roundtable.maxRounds` (default 6 rounds after your last message), `roundtable.budgetUsd` (default $2 estimated spend for the room), and the Stop button.
- You can interject mid-debate; that resets the round counter.

## Per-agent settings

Click an agent in the roster.

| Setting | Applies |
| --- | --- |
| Model, effort, permission mode | Immediately, on the live session |
| Name, role, tool lists, workspace mode | On the agent's next turn (session restarts and resumes its history) |

Workspace modes: `shared` works in the open folder, `worktree` gives the agent its own git worktree (stored in extension storage, needs a git repo), `read-only` removes Edit, Write, NotebookEdit and Bash.

Agents are saved to `.roundtable/agents.json` in the workspace. The transcript and session ids are kept in VS Code workspace state, so reopening the room continues where it left off. **Reset room** clears both.

Tool calls that need approval show up as a prompt in the room, tagged with the agent's name. `bypassPermissions` is not offered.

## Auth

Sessions use the local `claude` executable and its login (`roundtable.claudePath` overrides auto-detection). If you would rather bill an API key, run **Roundtable: Set API Key**, then reset the room.

## Development

```bash
npm test          # scheduler tests, no API calls
npm run typecheck
npm run preview   # webview in a browser with fake data: http://localhost:5179/
npm run e2e       # live two-agent debate through the SDK (costs a few cents)
```

Layout:

- `src/room/Room.ts` — turn scheduler and caps. No VS Code or SDK imports, so it is unit-tested with fake sessions.
- `src/room/SdkAgentSession.ts` — one long-lived SDK `query()` per agent, the `pass_turn` tool, permission bridge.
- `src/panel/RoomPanel.ts` — webview host, persistence, wiring.
- `webview/` — React UI.
- `src/shared/protocol.ts` — message types shared by host and webview.

## Not in v1

Other model providers, moderator and mention-only turn modes, agents speaking in parallel, full markdown rendering, Marketplace packaging.
