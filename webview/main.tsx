import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentView, RoomMeta, RoomStatus } from '../src/shared/protocol';
import { Drawer, Guardrails, Help, ProviderBadge, available, providerOf } from './panels';
import { PermissionCard, SpecCard, Transcript } from './room';
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
          <Guardrails view={state.guardrails} providers={state.providers} />
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
        <Drawer key={editingAgent.config.id} agent={editingAgent} providers={state.providers} canRemove={state.allAgents.length > 1} onClose={() => setEditing(undefined)} />
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
        {view === 'room' && status && (
          <>
            <span className="meter" title="Debate rounds since your last message">
              {Math.min(status.round + (status.running ? 1 : 0), status.maxRounds)}/{status.maxRounds}
            </span>
            <span className="meter" title={`Estimated spend${hasTokensOnly ? '; token-only providers are not in the USD figure' : ''}`}>
              ${status.costUsd.toFixed(2)}
              {status.budgetUsd > 0 ? `/${status.budgetUsd.toFixed(0)}` : ''}
              {hasTokensOnly && status.tokens.input + status.tokens.output > 0 ? ` · ${fmtTokens(status.tokens.input + status.tokens.output)} tok` : ''}
            </span>
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
              <button className="danger small" onClick={() => post({ type: 'stop' })}>
                Stop
              </button>
            )}
            <button className="ghost small" title="Guardrails" onClick={() => props.onView('guardrails')}>
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
            <button key={a.config.id} className={`chip ${a.status}`} title={`${a.config.name} · ${a.config.model} — click for settings`} onClick={() => props.onEditAgent(a.config.id)}>
              <span className="dot" style={{ background: a.config.color }} />
              {a.config.name}
              <ProviderBadge provider={providerOf(state.providers, a.config.provider)} />
            </button>
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
    <button key={r.id} className={`ghost ${r.id === state.rooms.activeRoomId ? 'active' : ''}`} onClick={() => { post({ type: 'switchRoom', id: r.id }); onClose(); }}>
      {r.pinned ? '📌 ' : ''}
      {r.name}
      <span className="hint"> · {r.kind === 'dm' ? 'DM' : `${r.agentIds.length}`}</span>
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

// -------------------------------------------------------------------- roster

function Roster(props: { agents: AgentView[]; state: State; selected: string | undefined; onSelect(id: string | undefined): void }) {
  const { state } = props;
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
                  {a.status === 'speaking' ? 'speaking…' : a.status === 'error' ? 'error' : provider?.costUsd ? `$${a.costUsd.toFixed(2)}` : `${fmtTokens((a.tokens?.input ?? 0) + (a.tokens?.output ?? 0))} tok`} · {a.config.effort}
                </span>
              </span>
            </button>
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
            running
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
