# Rooms and direct messages

## Where rooms show up

- **Sidebar tree** (Roundtable → Rooms & Agents): sections Pinned, Rooms, Direct messages, Agents. Click a room to make it active; click an agent to open its DM. Hover for inline pin/DM buttons; right-click for rename, participants, reset, delete, change model.
- **Chat header**: the ▣/◉ button opens the room switcher (rooms, DMs, **+ Room**, **+ DM**). Click the room name to rename it. The participant chips open agent settings; **+** edits participants. **⋯** pins, renames, resets, deletes, or opens the room in an editor tab.
- **Command palette**: Roundtable: Switch Room…, New Room, New Direct Message, Rename Room, Pin/Unpin Room, Delete Room, Reset Room, Edit Participants.
- **Status bar**: the active room, who is speaking, how many approvals are waiting. Click to open the chat.

All open chat views (sidebar and editor tab) follow the same active room.

## Creating

- **New Room** asks for a name and participants.
- **New Direct Message** picks an agent. A DM per agent is reused; opening it again switches to it.
- From the composer: `/room Name` switches to that room or creates it with the current participants; `/dm Name` opens the DM.

## The debate

See [concepts.md](concepts.md#turn). In short: one speaker at a time, mentions first, pass when done, stop at all-pass, round cap, budget cap, or Stop.

Interjections are welcome mid-debate: the agent currently speaking is not interrupted, the others see your message on their next turn, and the round counter resets.

Esc in the composer stops the debate. Stop discards the active agent's unfinished reply.

## Participants

A room's participants are any subset of the workspace's agents. Adding an agent to a room starts a fresh session for it there; it only sees messages from that point on. Removing it drops its session in that room. Deleting an agent removes it from every room and deletes its DM.

## Reset

**Reset room** clears the transcript and throws away every session in that room; agents start from scratch with their current settings. Guardrail state (approval, spec) resets too.

## Persistence

Rooms, transcripts (last 300 messages) and session ids are kept in VS Code workspace state. Reopening the window restores them and resumes the vendor sessions.

## Room settings (⚙ in the header, or **Roundtable: Room Settings**)

Every field has its explanation next to it in the UI. In short:

| Setting | Meaning | Default |
| --- | --- | --- |
| Rounds per message | How many times the table goes round after each message before agents stop | workspace `roundtable.maxRounds` (6) |
| Allow API-billed agents | Agents on an API key (metered per token) may run in this room. **Off by default**; the agent's own settings must allow it too | off |
| API budget | Approximate USD across API-billed agents; the debate stops when reached; 0 = unlimited | 0 |
| Stop at plan usage % | When a subscription agent's fullest vendor-reported window (Claude 5h / 7d) reaches this %, the room pauses until it resets; 0 = ignore | 0 |
| Token cap | Total tokens across agents and turns; 0 = unlimited | 0 |
| Guardrails | Inherit the workspace file or keep a custom set for this room | inherit |

Agents have the same limits in their own settings; the stricter of room and agent wins. An agent that hits a limit **sits out** (⏸ on its chip, explanation in the transcript) rather than stopping the whole room; room-level limits stop the debate.

All figures are vendor estimates — see [DISCLAIMER.md](../DISCLAIMER.md).
