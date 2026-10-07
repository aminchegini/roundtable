import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MODES, MODE_HINTS, MODE_LABELS, type AgentView, type InteractionMode, type RoomMeta, type RoomStatus } from '../src/shared/protocol';
import { Drawer, Guardrails, Help, ProviderBadge, available, providerOf } from './panels';
import { PermissionCard, SpecCard, Transcript } from './room';
import { RoomSettings } from './settings';
import { initial, post, reduce, type State, type View } from './state';
import './styles.css';

function App() {
  const [state, dispatch] = useReducer(reduce, initial);
  const [editing, setEditing] = useState<string | undefined>();
  const [narrow, setNarrow] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => dispatch(e.data);
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? 1000) < 720));
    observer.observe(el);
    return () => observer.disconnect();
  }, [state.loaded]);

  const roomState = state.roomState;
  const agents = roomState?.agents ?? [];
  const byId = new Map(state.allAgents.map((a) => [a.config.id, a]));
  for (const a of agents) byId.set(a.config.id, a);
  const names = agents.map((a) => a.config.name);
  const editingAgent = editing ? byId.get(editing) : undefined;
  const room = state.rooms.rooms.find((r) => r.id === state.rooms.activeRoomId);
  const setView = (view: View) => dispatch({ type: 'setView', view });

  if (!state.loaded) {
    return (
      <div ref={rootRef} className="empty">
        Loading…
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`app ${narrow ? 'narrow' : ''}`}>
      {!narrow && state.view === 'room' && <Roster agents={agents} state={state} selected={editing} onSelect={setEditing} />}
      <main className="main">
        <Header state={state} room={room} agents={agents} view={state.view} onView={setView} onEditAgent={setEditing} narrow={narrow} />
        {state.view === 'guardrails' ? (
          <Guardrails view={roomState?.guardrails ?? state.guardrails} providers={state.providers} onSave={room?.guardrails ? (file) => post({ type: 'updateRoom', id: room.id, patch: { guardrails: file } }) : undefined} />
        ) : state.view === 'room-settings' && room ? (
          <RoomSettings key={room.id + JSON.stringify(room.limits) + String(room.maxRounds) + String(!!room.guardrails)} state={state} room={room} />
        ) : state.view === 'help' ? (
          <Help providers={state.providers} />
        ) : (
          <>
            <Transcript state={state} byId={byId} names={names} onWelcomeAction={setView} />
            {roomState?.spec?.status === 'pending' && <SpecCard spec={roomState.spec} names={names} />}
            {roomState?.permissions.map((p) => (
              <PermissionCard key={p.requestId} request={p} agent={byId.get(p.agentId)} />
            ))}
            {roomState && <Composer state={state} room={room} onView={setView} />}
          </>
        )}
      </main>
      {editingAgent && (
        <Drawer
          key={editingAgent.config.id}
          agent={editingAgent}
          providers={state.providers}
          canRemove={state.allAgents.length > 1}
          roomGuardrails={roomState?.guardrails ?? state.guardrails}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------------- header

function Header(props: {
  state: State;
  room: RoomMeta | undefined;
  agents: AgentView[];
  view: View;
  onView(v: View): void;
  onEditAgent(id: string | undefined): void;
  narrow: boolean;
}) {
  const { state, room, agents, view } = props;
  const status: RoomStatus | undefined = state.roomState?.room;
  const [menu, setMenu] = useState<'none' | 'rooms' | 'participants' | 'more'>('none');
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(room?.name ?? '');
  const guardrailCount = state.guardrails.entries.filter((e) => e.enabled).length;
  const needsSetup = state.guardrails.setup.length > 0;
  const hasTokensOnly = agents.some((a) => !providerOf(state.providers, a.config.provider)?.costUsd);

  const rename = () => {
    if (room && name.trim() && name.trim() !== room.name) post({ type: 'renameRoom', id: room.id, name: name.trim() });
    setRenaming(false);
  };

  return (
    <header className="header">
      <div className="header-row">
        <button className="ghost room-switch" title="Switch room" onClick={() => setMenu(menu === 'rooms' ? 'none' : 'rooms')}>
          {room?.kind === 'dm' ? '◉' : '▣'} <span className="caret">▾</span>
        </button>
        {renaming && room ? (
          <input
            autoFocus
            className="room-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') rename();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <span
            className="title room-name"
            title="Click to rename"
            onClick={() => {
              if (!room) return;
              setName(room.name);
              setRenaming(true);
            }}
          >
            {room?.name ?? 'Roundtable'}
            {room?.kind === 'dm' && <span className="tag">DM</span>}
            {room?.pinned && <span className="tag">pinned</span>}
          </span>
        )}
        {view === 'room' && room && (
          <select
            className="mode-select"
            title={room.mode ? `Room mode: ${MODE_LABELS[room.mode]} — overrides every agent here. ${MODE_HINTS[room.mode]}` : "Room mode: agents' own. Pick a mode to force it on every agent in this room."}
            value={room.mode ?? ''}
            onChange={(e) => post({ type: 'updateRoom', id: room.id, patch: { mode: (e.target.value || null) as InteractionMode | null } })}
          >
            <option value="">agents' own</option>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>
        )}
        {view === 'room' && status && (
          <>
            <span className="meter" title="Debate rounds since your last message">
              {Math.min(status.round + (status.running ? 1 : 0), status.maxRounds)}/{status.maxRounds}
            </span>
            <BillingMeter status={status} tokensOnly={hasTokensOnly} />
            {status.paused && <span className="badge paused">paused</span>}
            {status.locks?.spec && <span className="badge">{status.locks.spec}</span>}
            {status.locks?.review && <span className="badge">{status.locks.review}</span>}
          </>
        )}
        <span className="spacer" />
        {view !== 'room' ? (
          <button className="secondary small" onClick={() => props.onView('room')}>
            ← Room
          </button>
        ) : (
          <>
            {status?.running && (
              <>
                <button
                  className="secondary small"
                  title={status.paused ? 'Resume: agents continue from where they stopped' : 'Pause: the current agent finishes, then the debate waits for you'}
                  onClick={() => post({ type: status.paused ? 'resume' : 'pause' })}
                >
                  {status.paused ? '▶ Resume' : '⏸ Pause'}
                </button>
                <button className="danger small" title="Stop: interrupt the speaking agent and end this debate" onClick={() => post({ type: 'stop' })}>
                  Stop
                </button>
              </>
            )}
            <button className="ghost small" title="Room settings: rounds, limits, guardrails" onClick={() => props.onView('room-settings')}>
              ⚙
            </button>
            <button className="ghost small" title="Guardrails for this room" onClick={() => props.onView('guardrails')}>
              ⛨ {guardrailCount}
              {needsSetup ? ' ⚠' : ''}
            </button>
            <button className="ghost small" title="Help" onClick={() => props.onView('help')}>
              ?
            </button>
            <button className="ghost small" title="More" onClick={() => setMenu(menu === 'more' ? 'none' : 'more')}>
              ⋯
            </button>
          </>
        )}
      </div>

      {view === 'room' && room && (
        <div className="header-row participants">
          {agents.map((a) => (
            <span key={a.config.id} className={`chip ${a.status} ${a.benched ? 'benched' : ''}`}>
              <button
                className="chip-main"
                title={`${a.config.name} · ${a.config.model} · ${MODE_LABELS[a.mode]} mode${a.benched ? ` — sitting out: ${benchText(a.benched)}` : ''} — click for settings`}
                onClick={() => props.onEditAgent(a.config.id)}
              >
                <span className="dot" style={{ background: a.config.color }} />
                {a.config.name}
                <ProviderBadge provider={providerOf(state.providers, a.config.provider)} />
                {a.mode !== 'build' && <span className="mode-tag">{a.mode}</span>}
                {a.benched && <span className="bench">⏸</span>}
              </button>
              {a.status === 'speaking' && (
                <button className="chip-skip" title={`Stop ${a.config.name}'s turn and skip it this round`} onClick={() => post({ type: 'skipAgent', id: a.config.id })}>
                  ⏭
                </button>
              )}
            </span>
          ))}
          {room.kind === 'group' && (
            <button className="chip add" title="Add or remove participants" onClick={() => setMenu(menu === 'participants' ? 'none' : 'participants')}>
              +
            </button>
          )}
        </div>
      )}

      {menu === 'rooms' && <RoomMenu state={state} onClose={() => setMenu('none')} />}
      {menu === 'participants' && room && <ParticipantsMenu state={state} room={room} onClose={() => setMenu('none')} />}
      {menu === 'more' && room && (
        <div className="popover">
          <button className="ghost" onClick={() => { post({ type: 'pinRoom', id: room.id, pinned: !room.pinned }); setMenu('none'); }}>
            {room.pinned ? 'Unpin room' : 'Pin room'}
          </button>
          <button className="ghost" onClick={() => { setName(room.name); setRenaming(true); setMenu('none'); }}>
            Rename room
          </button>
          <button className="ghost" onClick={() => { props.onView('room-settings'); setMenu('none'); }}>
            Room settings…
          </button>
          {state.location === 'sidebar' && (
            <button className="ghost" onClick={() => { post({ type: 'openInEditor' }); setMenu('none'); }}>
              Open in editor
            </button>
          )}
          <button className="ghost" onClick={() => { post({ type: 'reset' }); setMenu('none'); }}>
            Reset room (clear transcript)
          </button>
          <button className="ghost danger-text" onClick={() => { post({ type: 'deleteRoom', id: room.id }); setMenu('none'); }}>
            Delete room
          </button>
        </div>
      )}
    </header>
  );
}

/**
 * Subscription agents: say so and show the fullest quota window. API agents:
 * an approximate dollar figure against the budget. Never a bare price.
 */
function BillingMeter({ status, tokensOnly }: { status: RoomStatus; tokensOnly: boolean }) {
  const tokens = status.tokens.input + status.tokens.output;
  const tok = tokens > 0 ? `${fmtTokens(tokens)} tok` : '';
  const api = `API ≈ $${status.apiCostUsd.toFixed(2)}${status.budgetUsd > 0 ? ` / ${status.budgetUsd.toFixed(0)}` : ''}`;
  if (status.billing === 'subscription') {
    const q = status.quota;
    return (
      <span className="meter" title={q ? `${q.agentName}'s ${q.window} window is ${q.usedPercent}% used${q.resetsAt ? `, resets ${new Date(q.resetsAt).toLocaleString()}` : ''}. Vendor-reported, approximate.` : 'All agents run on subscriptions; no per-call charge. Usage counts against each plan.'}>
        Subscription{q ? ` · ${Math.max(0, 100 - q.usedPercent)}% left (${q.window})` : tok ? ` · ${tok}` : ''}
      </span>
    );
  }
  if (status.billing === 'api') {
    return (
      <span className="meter" title="Agents run on API keys. Dollar figure is the vendor's estimate, approximate; the cap applies to it.">
        {api} <span className="hint">(approx)</span>
      </span>
    );
  }
  if (status.billing === 'mixed') {
    const q = status.quota;
    return (
      <span className="meter" title="Some agents on subscriptions, some on API keys. Dollar figure covers API agents only and is approximate.">
        {api} <span className="hint">(approx)</span> · subscription{q ? ` ${Math.max(0, 100 - q.usedPercent)}% left (${q.window})` : ''}
      </span>
    );
  }
  return (
    <span className="meter" title="Billing is known after the first turn.">
      {tok || (tokensOnly ? '—' : 'billing: pending')}
    </span>
  );
}

function benchText(reason: NonNullable<AgentView['benched']>): string {
  return {
    'api-not-allowed': 'API usage is off (room or agent setting)',
    'api-budget': 'its API budget is used up',
    quota: 'its plan window is past the stop threshold',
    tokens: 'its token cap is reached',
    'provider-unavailable': 'its vendor is not installed or signed out',
  }[reason];
}

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
}

function RoomMenu({ state, onClose }: { state: State; onClose(): void }) {
  const [creating, setCreating] = useState<'none' | 'room' | 'dm'>('none');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>(state.allAgents.map((a) => a.config.id));
  const rooms = state.rooms.rooms;
  const groups = rooms.filter((r) => r.kind === 'group');
  const dms = rooms.filter((r) => r.kind === 'dm');
  const item = (r: RoomMeta) => (
    <button key={r.id} className={`ghost room-item ${r.id === state.rooms.activeRoomId ? 'active' : ''}`} onClick={() => { post({ type: 'switchRoom', id: r.id }); onClose(); }}>
      <span className="room-item-title">
        {r.pinned ? '📌 ' : ''}
        {r.name}
        <span className="hint"> · {r.kind === 'dm' ? 'DM' : `${r.agentIds.length}`}{r.mode ? ` · ${r.mode}` : ''}</span>
      </span>
      {r.lastMessage && (
        <span className="room-item-preview">
          {r.lastMessage.from ? `${r.lastMessage.from}: ` : ''}
          {r.lastMessage.text.replace(/\s+/g, ' ')}
        </span>
      )}
    </button>
  );
  return (
    <div className="popover rooms-menu">
      {creating === 'none' && (
        <>
          {groups.length > 0 && <div className="popover-title">Rooms</div>}
          {groups.map(item)}
          {dms.length > 0 && <div className="popover-title">Direct messages</div>}
          {dms.map(item)}
          <div className="row">
            <button className="secondary small" onClick={() => setCreating('room')}>
              + Room
            </button>
            <button className="secondary small" onClick={() => setCreating('dm')}>
              + DM
            </button>
          </div>
        </>
      )}
      {creating === 'room' && (
        <div className="create-form">
          <input autoFocus placeholder="Room name" value={name} onChange={(e) => setName(e.target.value)} />
          {state.allAgents.map((a) => (
            <label key={a.config.id} className="inline">
              <input type="checkbox" checked={picked.includes(a.config.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, a.config.id] : picked.filter((id) => id !== a.config.id))} />
              {a.config.name} <span className="hint">· {a.config.model}</span>
            </label>
          ))}
          <div className="row">
            <button disabled={picked.length === 0} onClick={() => { post({ type: 'createRoom', kind: 'group', name: name || undefined, agentIds: picked }); onClose(); }}>
              Create
            </button>
            <button className="secondary" onClick={() => setCreating('none')}>
              Back
            </button>
          </div>
        </div>
      )}
      {creating === 'dm' && (
        <div className="create-form">
          <div className="popover-title">Message which agent?</div>
          {state.allAgents.map((a) => (
            <button key={a.config.id} className="ghost" onClick={() => { post({ type: 'createRoom', kind: 'dm', agentIds: [a.config.id] }); onClose(); }}>
              <span className="dot" style={{ background: a.config.color }} /> {a.config.name} <span className="hint">· {a.config.model}</span>
            </button>
          ))}
          <button className="secondary small" onClick={() => setCreating('none')}>
            Back
          </button>
        </div>
      )}
    </div>
  );
}

function ParticipantsMenu({ state, room, onClose }: { state: State; room: RoomMeta; onClose(): void }) {
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...room.agentIds, id] : room.agentIds.filter((a) => a !== id);
    post({ type: 'setParticipants', id: room.id, agentIds: next });
  };
  return (
    <div className="popover">
      <div className="popover-title">Participants</div>
      {state.allAgents.map((a) => (
        <label key={a.config.id} className="inline">
          <input type="checkbox" checked={room.agentIds.includes(a.config.id)} onChange={(e) => toggle(a.config.id, e.target.checked)} />
          <span className="dot" style={{ background: a.config.color }} />
          {a.config.name} <span className="hint">· {providerOf(state.providers, a.config.provider)?.title} {a.config.model}</span>
        </label>
      ))}
      <div className="row">
        <button className="secondary small" onClick={() => post({ type: 'addAgent' })}>
          + New agent
        </button>
        <button className="secondary small" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

/** One agent's billing line: plan + fullest quota window, or approximate API dollars. */
function agentBilling(a: AgentView): string {
  const tok = (a.tokens?.input ?? 0) + (a.tokens?.output ?? 0);
  if (a.billing === 'subscription') {
    const q = [...(a.quota ?? [])].sort((x, y) => y.usedPercent - x.usedPercent)[0];
    return q ? `plan · ${Math.max(0, 100 - q.usedPercent)}% left (${q.window})` : tok > 0 ? `plan · ${fmtTokens(tok)} tok` : 'plan';
  }
  if (a.billing === 'api') return `API ≈ $${a.costUsd.toFixed(2)}`;
  return tok > 0 ? `${fmtTokens(tok)} tok` : '—';
}

// -------------------------------------------------------------------- roster

function Roster(props: { agents: AgentView[]; state: State; selected: string | undefined; onSelect(id: string | undefined): void }) {
  const { state } = props;
  const room = state.rooms.rooms.find((r) => r.id === state.rooms.activeRoomId);
  return (
    <aside className="roster">
      <div className="roster-title">In this room</div>
      {props.agents.map((a) => {
        const provider = providerOf(state.providers, a.config.provider);
        const models = provider?.models ?? [];
        const known = models.some((m) => m.id === a.config.model);
        return (
          <div key={a.config.id} className={`agent ${props.selected === a.config.id ? 'selected' : ''} ${available(provider) ? '' : 'unavailable'}`}>
            <button className="agent-main" onClick={() => props.onSelect(props.selected === a.config.id ? undefined : a.config.id)}>
              <span className={`dot ${a.status}`} style={{ background: a.config.color }} />
              <span className="agent-body">
                <span className="agent-name">
                  {a.config.name}
                  {a.config.reviewer && <span className="tag">reviewer</span>}
                  <ProviderBadge provider={provider} />
                </span>
                <span className="agent-meta">
                  {a.status === 'speaking' ? 'speaking…' : a.status === 'error' ? 'error' : a.benched ? `⏸ ${benchText(a.benched)}` : agentBilling(a)} · {a.config.effort}
                </span>
              </span>
            </button>
            <div className="agent-controls">
              <select
                className="agent-mode"
                title={`Mode for ${a.config.name}: ${MODE_HINTS[a.config.mode ?? 'build']}${room?.mode ? ` (room mode ${room.mode} currently overrides it)` : ''}`}
                value={a.config.mode ?? 'build'}
                disabled={!!room?.mode}
                onChange={(e) => post({ type: 'saveAgent', config: { ...a.config, mode: e.target.value as InteractionMode } })}
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABELS[m]}
                  </option>
                ))}
              </select>
              {a.status === 'speaking' && (
                <button className="ghost small" title="Stop this agent's turn and skip it this round" onClick={() => post({ type: 'skipAgent', id: a.config.id })}>
                  ⏭ skip
                </button>
              )}
            </div>
            <select
              className="agent-model"
              title="Model"
              value={known ? a.config.model : '__custom'}
              onChange={(e) => {
                if (e.target.value === '__custom') props.onSelect(a.config.id);
                else post({ type: 'saveAgent', config: { ...a.config, model: e.target.value } });
              }}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {!known && <option value="__custom">{a.config.model}</option>}
              {known && <option value="__custom">Other…</option>}
            </select>
          </div>
        );
      })}
      {props.agents.length === 0 && <div className="hint">No participants. Use + in the header.</div>}
    </aside>
  );
}

// ------------------------------------------------------------------ composer

function Composer({ state, room, onView }: { state: State; room: RoomMeta | undefined; onView(v: View): void }) {
  const [text, setText] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const running = state.roomState?.room.running ?? false;
  const agents = state.roomState?.agents ?? [];
  const names = agents.map((a) => a.config.name);

  const mentionMatch = /(^|\s)@([\w-]*)$/.exec(text);
  const suggestions = mentionMatch ? ['all', ...names].filter((n) => n.toLowerCase().startsWith((mentionMatch[2] ?? '').toLowerCase())) : [];

  const complete = (name: string) => {
    if (!mentionMatch) return;
    setText(text.slice(0, text.length - (mentionMatch[2]?.length ?? 0)) + `${name} `);
    setMentionIndex(0);
    ref.current?.focus();
  };

  const runCommand = (line: string): boolean => {
    const [cmd = '', ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    const findAgent = (n: string) => state.allAgents.find((a) => a.config.name.toLowerCase() === n.toLowerCase().replace(/^@/, ''));
    switch (cmd.toLowerCase()) {
      case 'stop':
        post({ type: 'stop' });
        return true;
      case 'pause':
        post({ type: 'pause' });
        return true;
      case 'resume':
        post({ type: 'resume' });
        return true;
      case 'skip': {
        const agent = findAgent(arg);
        if (agent) post({ type: 'skipAgent', id: agent.config.id });
        return !!agent;
      }
      case 'mode': {
        // /mode ask → room; /mode Rex plan → agent; /mode off → agents' own
        const [first = '', second] = rest;
        const asMode = (v: string) => (MODES as string[]).includes(v) ? (v as InteractionMode) : undefined;
        if (!room) return false;
        if (first === 'off' || first === 'own') {
          post({ type: 'updateRoom', id: room.id, patch: { mode: null } });
          return true;
        }
        const roomMode = asMode(first);
        if (roomMode && !second) {
          post({ type: 'updateRoom', id: room.id, patch: { mode: roomMode } });
          return true;
        }
        const agent = findAgent(first);
        const agentMode = second ? asMode(second) : undefined;
        if (agent && agentMode) post({ type: 'saveAgent', config: { ...agent.config, mode: agentMode } });
        return !!(agent && agentMode);
      }
      case 'reset':
        post({ type: 'reset' });
        return true;
      case 'guardrails':
        onView('guardrails');
        return true;
      case 'help':
        onView('help');
        return true;
      case 'dm': {
        const agent = findAgent(arg);
        if (agent) post({ type: 'createRoom', kind: 'dm', agentIds: [agent.config.id] });
        return !!agent;
      }
      case 'room': {
        const target = state.rooms.rooms.find((r) => r.name.toLowerCase() === arg.toLowerCase());
        if (target) post({ type: 'switchRoom', id: target.id });
        else post({ type: 'createRoom', kind: 'group', name: arg || undefined, agentIds: room?.agentIds ?? [] });
        return true;
      }
      case 'model': {
        const [who = '', ...model] = rest;
        const agent = findAgent(who);
        if (agent && model.length > 0) post({ type: 'saveAgent', config: { ...agent.config, model: model.join(' ') } });
        return !!agent;
      }
      default:
        return false;
    }
  };

  const send = () => {
    const value = text.trim();
    if (!value) return;
    if (value.startsWith('/') && runCommand(value)) {
      setText('');
      return;
    }
    post({ type: 'send', text: value });
    setText('');
  };

  return (
    <div className="composer">
      {suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map((n, i) => (
            <button key={n} className={`ghost ${i === mentionIndex ? 'active' : ''}`} onMouseDown={(e) => { e.preventDefault(); complete(n); }}>
              @{n}
            </button>
          ))}
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={ref}
          value={text}
          rows={narrowRows(text)}
          placeholder={
            state.roomState?.room.paused
              ? 'Paused — agents resume when you press ▶ · your message waits for them'
              : running
              ? 'Interject — agents see this on their next turn · Esc stops'
              : room?.kind === 'dm'
                ? `Message ${names[0] ?? 'the agent'}`
                : names.length > 0
                  ? `Message the room · @Name to pick who answers first · / for commands`
                  : 'Add participants first'
          }
          onChange={(e) => {
            setText(e.target.value);
            setMentionIndex(0);
          }}
          onKeyDown={(e) => {
            if (suggestions.length > 0 && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
              e.preventDefault();
              complete(suggestions[mentionIndex] ?? suggestions[0]!);
              return;
            }
            if (suggestions.length > 0 && e.key === 'ArrowDown') {
              e.preventDefault();
              setMentionIndex((mentionIndex + 1) % suggestions.length);
              return;
            }
            if (suggestions.length > 0 && e.key === 'ArrowUp') {
              e.preventDefault();
              setMentionIndex((mentionIndex - 1 + suggestions.length) % suggestions.length);
              return;
            }
            if (e.key === 'Escape' && running) {
              post({ type: 'stop' });
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button onClick={send} disabled={!text.trim()} title="Send (Enter)">
          Send
        </button>
      </div>
    </div>
  );
}

function narrowRows(text: string): number {
  return Math.min(8, Math.max(2, text.split('\n').length));
}

createRoot(document.getElementById('root')!).render(<App />);
