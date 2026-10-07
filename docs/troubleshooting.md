# Troubleshooting

The **Roundtable** output channel (View → Output → Roundtable) logs every session start with its vendor, model and auth source, plus errors.

## A provider shows "not signed in"

Run the vendor's login in a terminal, then **Roundtable: Refresh Providers**:

- Claude: `claude` (then `/login`), or **Roundtable: Set API Key** and reload.
- Codex: `codex login`. Roundtable reads `~/.codex/auth.json`.
- Gemini: `gemini` (interactive once). Roundtable looks for `~/.gemini/oauth_creds.json` or `GEMINI_API_KEY`.
- Copilot: `copilot login` or `gh auth login`. Needs a Copilot subscription.
- Cursor: `agent login`. If `agent --list-models` prints "No models available for this account", the login is missing or the plan has no CLI access.

## "previous session lost; starting a fresh one"

Not an error. The vendor could not resume the agent's saved session (it was pruned, never written because an earlier turn crashed, or the vendor restarted). Roundtable forgets the dead id, re-sends the agent's instructions and retries the turn once on a fresh session. The agent loses its memory of that room; the transcript stays. If the retry fails too, the real error is shown as usual.

## An agent fails every turn

The system message in the room says why. Common causes:

- Vendor not installed on PATH (Gemini, Cursor). VS Code started from the Dock may have a short PATH; Roundtable also checks `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`.
- Model id not valid for that vendor. Pick one from the dropdown.
- Worktree mode without a git repo: a warning appears and the agent falls back to the shared folder.

## Typecheck/lint/test gates fail in a worktree

The worktree shares the project's `node_modules` through a symlink created when the worktree is made. If the project was installed later, run `npm install` in the project root again or delete the worktree (extension global storage → `worktrees/`) so it is recreated.

## Agents keep talking

Lower `roundtable.maxRounds`, or set `roundtable.budgetUsd`. Press Stop or Esc. Agents that merely agree are told to pass; a strong role prompt ("do not restate") helps.

## Nothing happens after I send

Check the status bar: if it says an approval is waiting, scroll the chat for the permission card (Claude/Copilot ask before risky tools). If a Claude agent is in `plan` mode it cannot edit. If guardrails lock edits (reviewer veto, spec-first), the header shows a badge.

## The chat is blank

Reload the window (`Developer: Reload Window`). If it persists, check Help → Toggle Developer Tools for errors and the Roundtable output channel.

## Reset everything

- **Reset room** clears one room.
- Delete `.roundtable/agents.json` and `.roundtable/guardrails.json` in the project to get the defaults back.
- Rooms live in workspace state; delete them from the tree.
