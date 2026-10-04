import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { selectPreset, setGuardrailConfig, toggleGuardrail } from '../src/shared/guardrailsFile';
import {
  EFFORTS,
  MODELS,
  PERMISSION_MODES,
  USER_ID,
  WORKSPACE_MODES,
  type AgentConfig,
  type AgentView,
  type FieldSpec,
  type GuardrailEntry,
  type GuardrailLayer,
  type GuardrailsView,
  type HostToWebview,
  type PermissionRequest,
  type RoomMessage,
  type RoomStatus,
  type SpecView,
  type WebviewToHost,
} from '../src/shared/protocol';
import './styles.css';

declare function acquireVsCodeApi(): { postMessage(message: WebviewToHost): void };
const vscode = acquireVsCodeApi();
const post = (message: WebviewToHost) => vscode.postMessage(message);

interface Live {
  text: string;
  activity: string;
}

interface State {
  loaded: boolean;
  agents: AgentView[];
  messages: RoomMessage[];
  room: RoomStatus;
  permissions: PermissionRequest[];
  guardrails: GuardrailsView;
  spec: SpecView | undefined;
  /** Streaming text and tool activity for agents mid-turn, by agent id. */
  live: Record<string, Live>;
}

const initial: State = {
  loaded: false,
  agents: [],
  messages: [],
  room: { running: false, round: 0, maxRounds: 0, costUsd: 0, budgetUsd: 0 },
  permissions: [],
  guardrails: { profile: '', hasWorkspace: false, presets: [], file: { enabled: {}, disabled: [] }, entries: [], setup: [], busy: false },
  spec: undefined,
  live: {},
};

function reduce(state: State, m: HostToWebview): State {
  switch (m.type) {
    case 'state':
      return {
        loaded: true,
        agents: m.agents,
        messages: m.messages,
        room: m.room,
        permissions: m.permissions,
        guardrails: m.guardrails,
        spec: m.spec,
        live: {},
      };
    case 'message': {
      const live = { ...state.live };
      delete live[m.message.from];
      return { ...state, messages: [...state.messages, m.message], live };
    }
    case 'partial':
      return { ...state, live: { ...state.live, [m.agentId]: { text: m.text, activity: '' } } };
    case 'activity':
      return { ...state, live: { ...state.live, [m.agentId]: { text: state.live[m.agentId]?.text ?? '', activity: m.text } } };
    case 'agents': {
      const speaking = new Set(m.agents.filter((a) => a.status === 'speaking').map((a) => a.config.id));
      const live = Object.fromEntries(Object.entries(state.live).filter(([id]) => speaking.has(id)));
      return { ...state, agents: m.agents, live };
    }
    case 'room':
      return { ...state, room: m.room };
    case 'permissions':
      return { ...state, permissions: m.permissions };
    case 'guardrails':
      return { ...state, guardrails: m.guardrails };
    case 'spec':
      return { ...state, spec: m.spec };
  }
}

function App() {
  const [state, dispatch] = useReducer(reduce, initial);
  const [editing, setEditing] = useState<string | undefined>();
  const [view, setView] = useState<'room' | 'guardrails'>('room');

  useEffect(() => {
    const onMessage = (e: MessageEvent<HostToWebview>) => dispatch(e.data);
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const byId = new Map(state.agents.map((a) => [a.config.id, a]));
  const editingAgent = editing ? byId.get(editing) : undefined;

  if (!state.loaded) return <div className="empty">Loading room…</div>;

  return (
    <div className="app">
      <Roster agents={state.agents} selected={editing} onSelect={setEditing} />
      <main className="main">
        <Header room={state.room} guardrails={state.guardrails} view={view} onView={setView} />
        {view === 'guardrails' ? (
          <Guardrails view={state.guardrails} />
        ) : (
          <>
            <Transcript state={state} byId={byId} />
            {state.spec?.status === 'pending' && <SpecCard spec={state.spec} />}
            {state.permissions.map((p) => (
              <PermissionCard key={p.requestId} request={p} agent={byId.get(p.agentId)} />
            ))}
            <Composer running={state.room.running} names={state.agents.map((a) => a.config.name)} />
          </>
        )}
      </main>
      {editingAgent && (
        <Drawer
          key={editingAgent.config.id}
          agent={editingAgent}
          canRemove={state.agents.length > 1}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

function Header(props: { room: RoomStatus; guardrails: GuardrailsView; view: 'room' | 'guardrails'; onView(v: 'room' | 'guardrails'): void }) {
  const { room, guardrails, view } = props;
  const budget = room.budgetUsd > 0 ? ` / $${room.budgetUsd.toFixed(2)}` : '';
  const active = guardrails.entries.filter((e) => e.enabled).length;
  const needsSetup = guardrails.setup.length > 0;
  return (
    <header className="header">
      <span className="title">Roundtable</span>
      <span className="meter" title="Debate rounds since your last message">
        Round {Math.min(room.round + (room.running ? 1 : 0), room.maxRounds)} / {room.maxRounds}
      </span>
      <span className="meter" title="Estimated spend for this room">
        ${room.costUsd.toFixed(2)}
        {budget}
      </span>
      {room.locks?.spec && <span className="badge">{room.locks.spec}</span>}
      {room.locks?.review && <span className="badge">{room.locks.review}</span>}
      <span className="spacer" />
      <button
        className={`secondary ${view === 'guardrails' ? 'active' : ''}`}
        title="Project guardrails"
        onClick={() => props.onView(view === 'guardrails' ? 'room' : 'guardrails')}
      >
        {view === 'guardrails' ? '← Room' : `Guardrails · ${active}${needsSetup ? ' ⚠' : ''}`}
      </button>
      {room.running && (
        <button className="danger" onClick={() => post({ type: 'stop' })}>
          Stop
        </button>
      )}
      <button
        className="secondary"
        title="Clear the transcript and start every agent on a fresh session"
        onClick={() => post({ type: 'reset' })}
      >
        Reset room
      </button>
    </header>
  );
}

function Roster(props: { agents: AgentView[]; selected: string | undefined; onSelect(id: string | undefined): void }) {
  return (
    <aside className="roster">
      <div className="roster-title">Agents</div>
      {props.agents.map((a) => (
        <button
          key={a.config.id}
          className={`agent ${props.selected === a.config.id ? 'selected' : ''}`}
          onClick={() => props.onSelect(props.selected === a.config.id ? undefined : a.config.id)}
        >
          <span className={`dot ${a.status}`} style={{ background: a.config.color }} />
          <span className="agent-body">
            <span className="agent-name">
              {a.config.name}
              {a.config.reviewer && <span className="tag">reviewer</span>}
            </span>
            <span className="agent-meta">
              {shortModel(a.config.model)} · {a.config.effort}
            </span>
            <span className="agent-meta">
              {a.status === 'speaking' ? 'speaking…' : a.status === 'error' ? 'error' : `$${a.costUsd.toFixed(2)}`}
            </span>
          </span>
        </button>
      ))}
      <button className="secondary add" onClick={() => post({ type: 'addAgent' })}>
        + Add agent
      </button>
    </aside>
  );
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function Transcript({ state, byId }: { state: State; byId: Map<string, AgentView> }) {
  const end = useRef<HTMLDivElement>(null);
  const speaking = state.agents.filter((a) => a.status === 'speaking');
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [state.messages.length, state.live, speaking.length]);

  return (
    <div className="transcript">
      {state.messages.length === 0 && (
        <div className="empty">
          Ask the room something. Agents reply to you and to each other; use @Name to pick who goes first.
        </div>
      )}
      {state.messages.map((m) => (
        <Message key={m.id} message={m} agent={byId.get(m.from)} />
      ))}
      {speaking.map((a) => {
        const live = state.live[a.config.id];
        return (
          <div key={a.config.id} className="msg live">
            <div className="msg-from" style={{ color: a.config.color }}>
              {a.config.name}
            </div>
            {live?.text ? <RichText text={live.text} /> : <div className="typing">thinking…</div>}
            {live?.activity && <div className="activity">{live.activity}</div>}
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

function Message({ message, agent }: { message: RoomMessage; agent: AgentView | undefined }) {
  if (message.from === 'system') return <div className="msg system">{message.text}</div>;
  const isUser = message.from === USER_ID;
  return (
    <div className={`msg ${isUser ? 'user' : ''}`}>
      <div className="msg-from" style={{ color: isUser ? undefined : agent?.config.color }}>
        {isUser ? 'You' : (agent?.config.name ?? 'Former agent')}
      </div>
      <RichText text={message.text} />
    </div>
  );
}

/** Minimal rendering: fenced code blocks, inline code, and @mentions. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/```(?:\w*)\n?([\s\S]*?)(?:```|$)/g);
  return (
    <div className="msg-text">
      {parts.map((part, i) =>
        i % 2 === 1 ? <pre key={i}>{part.replace(/\n$/, '')}</pre> : <span key={i}>{inline(i > 0 ? part.replace(/^\n+/, '') : part)}</span>,
      )}
    </div>
  );
}

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|@[\w-]+)/g).map((piece, i) => {
    if (piece.startsWith('`') && piece.length > 2) return <code key={i}>{piece.slice(1, -1)}</code>;
    if (piece.startsWith('@')) return <span key={i} className="mention">{piece}</span>;
    return piece;
  });
}

function PermissionCard({ request, agent }: { request: PermissionRequest; agent: AgentView | undefined }) {
  const respond = (decision: 'allow' | 'always' | 'deny') =>
    post({ type: 'permissionResponse', requestId: request.requestId, decision });
  return (
    <div className="card warn">
      <div>
        <strong style={{ color: agent?.config.color }}>{agent?.config.name ?? 'Agent'}</strong> wants to use{' '}
        <strong>{request.toolName}</strong>
      </div>
      <pre>{request.detail}</pre>
      <div className="row">
        <button onClick={() => respond('allow')}>Allow once</button>
        {request.canAlways && (
          <button className="secondary" onClick={() => respond('always')}>
            Always allow
          </button>
        )}
        <button className="secondary" onClick={() => respond('deny')}>
          Deny
        </button>
      </div>
    </div>
  );
}

function SpecCard({ spec }: { spec: SpecView }) {
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(true);
  const decide = (decision: 'approve' | 'changes') => {
    post({ type: 'specDecision', decision, note });
    setNote('');
  };
  return (
    <div className="card info">
      <div className="row between">
        <div>
          <strong>Spec from {spec.agentName}</strong> — approve before agents may edit
        </div>
        <button className="secondary" onClick={() => setOpen(!open)}>
          {open ? 'Collapse' : 'Expand'}
        </button>
      </div>
      {open && (
        <div className="spec-body">
          <RichText text={spec.markdown} />
        </div>
      )}
      <input value={note} placeholder="Optional note for the agents" onChange={(e) => setNote(e.target.value)} />
      <div className="row">
        <button onClick={() => decide('approve')}>Approve spec</button>
        <button className="secondary" onClick={() => decide('changes')}>
          Request changes
        </button>
      </div>
    </div>
  );
}

function Composer({ running, names }: { running: boolean; names: string[] }) {
  const [text, setText] = useState('');
  const send = () => {
    if (!text.trim()) return;
    post({ type: 'send', text });
    setText('');
  };
  return (
    <div className="composer">
      <textarea
        value={text}
        rows={3}
        placeholder={
          running
            ? 'Interject — agents will see this on their next turn'
            : `Message the room (${names.map((n) => `@${n}`).join(' ')} or @all)`
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button onClick={send} disabled={!text.trim()}>
        Send
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- guardrails

const LAYERS: Array<{ id: GuardrailLayer; title: string; blurb: string }> = [
  { id: 'gate', title: 'Gates', blurb: 'Enforced by hooks on every tool call. Agents cannot work around them.' },
  { id: 'knowledge', title: 'Knowledge', blurb: 'Project files every agent reads, created from detection when missing.' },
  { id: 'process', title: 'Process', blurb: 'How work flows through the room: review, specs, isolation.' },
];

function Guardrails({ view }: { view: GuardrailsView }) {
  const presetIds = view.presets.find((p) => p.id === view.file.preset)?.guardrailIds ?? [];
  const save = (file: GuardrailsView['file']) => post({ type: 'setGuardrails', file });
  if (!view.hasWorkspace) {
    return <div className="empty">Open a folder to configure guardrails. They live in .roundtable/guardrails.json inside the project.</div>;
  }
  return (
    <div className="guardrails">
      <div className="hint">Detected: {view.profile}</div>

      <section>
        <h3>Preset</h3>
        <div className="presets">
          {view.presets.map((p) => (
            <button
              key={p.id}
              className={`preset ${view.file.preset === p.id ? 'selected' : ''}`}
              onClick={() => save(selectPreset(view.file, p.id))}
            >
              <span className="preset-title">{p.title}</span>
              <span className="hint">{p.summary}</span>
            </button>
          ))}
          <button className={`preset ${!view.file.preset ? 'selected' : ''}`} onClick={() => save(selectPreset(view.file, undefined))}>
            <span className="preset-title">Custom</span>
            <span className="hint">Start from nothing and pick guardrails one by one.</span>
          </button>
        </div>
      </section>

      {view.setup.length > 0 && (
        <section className="card warn">
          <strong>Setup needed for the enabled guardrails</strong>
          <ul>
            {view.setup.map((s, i) => (
              <li key={i}>
                {s.description}
                {s.detail && <code> {s.detail}</code>}
              </li>
            ))}
          </ul>
          <div className="row">
            <button disabled={view.busy} onClick={() => post({ type: 'applySetup' })}>
              {view.busy ? 'Applying…' : 'Apply setup'}
            </button>
            <span className="hint">Writes the files listed above into the project and installs packages with the detected package manager.</span>
          </div>
        </section>
      )}

      {LAYERS.map((layer) => (
        <section key={layer.id}>
          <h3>{layer.title}</h3>
          <div className="hint">{layer.blurb}</div>
          {view.entries
            .filter((e) => e.layer === layer.id)
            .map((entry) => (
              <GuardrailRow
                key={entry.id}
                entry={entry}
                onToggle={(on) => save(toggleGuardrail(view.file, presetIds, entry.id, on))}
                onSave={(config) => save(setGuardrailConfig(view.file, entry.id, config))}
              />
            ))}
        </section>
      ))}
    </div>
  );
}

function GuardrailRow(props: { entry: GuardrailEntry; onToggle(on: boolean): void; onSave(config: Record<string, unknown>): void }) {
  const { entry } = props;
  const [open, setOpen] = useState(false);
  const status = !entry.applies
    ? { label: 'not for this stack', cls: 'muted' }
    : !entry.enabled
      ? undefined
      : entry.status === 'ready'
        ? { label: 'active', cls: 'ok' }
        : entry.status === 'needs-setup'
          ? { label: 'needs setup', cls: 'warn' }
          : { label: 'tool missing', cls: 'warn' };
  return (
    <div className={`guardrail ${entry.enabled ? 'enabled' : ''}`}>
      <label className="guardrail-head">
        <input type="checkbox" checked={entry.enabled} disabled={!entry.applies} onChange={(e) => props.onToggle(e.target.checked)} />
        <span className="guardrail-title">{entry.title}</span>
        {status && <span className={`status ${status.cls}`}>{status.label}</span>}
        <span className="spacer" />
        {entry.fields.length > 0 && entry.applies && (
          <button className="secondary small" onClick={(e) => { e.preventDefault(); setOpen(!open); }}>
            {open ? 'Hide' : 'Configure'}
          </button>
        )}
      </label>
      <div className="hint">{entry.summary}</div>
      {open && <ConfigForm key={JSON.stringify(entry.config)} fields={entry.fields} config={entry.config} onSave={props.onSave} />}
    </div>
  );
}

function ConfigForm(props: { fields: FieldSpec[]; config: Record<string, unknown>; onSave(config: Record<string, unknown>): void }) {
  const [draft, setDraft] = useState<Record<string, unknown>>(props.config);
  const set = (key: string, value: unknown) => setDraft((d) => ({ ...d, [key]: value }));
  return (
    <div className="config-form">
      {props.fields.map((f) => (
        <label key={f.key} className={f.type === 'boolean' ? 'inline' : ''}>
          {f.type === 'boolean' ? (
            <>
              <input type="checkbox" checked={!!draft[f.key]} onChange={(e) => set(f.key, e.target.checked)} /> {f.label}
            </>
          ) : (
            <>
              {f.label}
              {f.type === 'select' ? (
                <select value={String(draft[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)}>
                  {f.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : f.type === 'number' ? (
                <input type="number" value={Number(draft[f.key] ?? 0)} onChange={(e) => set(f.key, Number(e.target.value))} />
              ) : f.type === 'list' ? (
                <textarea
                  rows={3}
                  value={Array.isArray(draft[f.key]) ? (draft[f.key] as string[]).join('\n') : ''}
                  placeholder="One per line"
                  onChange={(e) => set(f.key, e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
                />
              ) : (
                <input value={String(draft[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} />
              )}
            </>
          )}
          {f.help && <span className="hint">{f.help}</span>}
        </label>
      ))}
      <div className="row">
        <button onClick={() => props.onSave(draft)}>Save</button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- drawer

function Drawer({ agent, canRemove, onClose }: { agent: AgentView; canRemove: boolean; onClose(): void }) {
  const [draft, setDraft] = useState<AgentConfig>(agent.config);
  const [allowed, setAllowed] = useState(agent.config.allowedTools.join(', '));
  const [disallowed, setDisallowed] = useState(agent.config.disallowedTools.join(', '));
  const set = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const list = (value: string) => value.split(',').map((s) => s.trim()).filter(Boolean);

  const save = () => {
    const name = draft.name.trim().replace(/\s+/g, '-');
    if (!name) return;
    post({
      type: 'saveAgent',
      config: { ...draft, name, model: draft.model.trim() || agent.config.model, allowedTools: list(allowed), disallowedTools: list(disallowed) },
    });
    onClose();
  };

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="title">Agent settings</span>
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
      <label>
        Name
        <input value={draft.name} onChange={(e) => set('name', e.target.value)} />
      </label>
      <label>
        Color
        <input type="color" value={draft.color} onChange={(e) => set('color', e.target.value)} />
      </label>
      <label>
        Model
        <input list="models" value={draft.model} onChange={(e) => set('model', e.target.value)} />
        <datalist id="models">
          {MODELS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {agent.liveModel && agent.liveModel !== draft.model && <span className="hint">running: {agent.liveModel}</span>}
      </label>
      <label>
        Effort
        <select value={draft.effort} onChange={(e) => set('effort', e.target.value as AgentConfig['effort'])}>
          {EFFORTS.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <label>
        Permission mode
        <select
          value={draft.permissionMode}
          onChange={(e) => set('permissionMode', e.target.value as AgentConfig['permissionMode'])}
        >
          {PERMISSION_MODES.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <label>
        Workspace
        <select
          value={draft.workspaceMode}
          onChange={(e) => set('workspaceMode', e.target.value as AgentConfig['workspaceMode'])}
        >
          {WORKSPACE_MODES.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <span className="hint">shared: edits the open folder · worktree: own git worktree · read-only: no edits or shell</span>
      </label>
      <label>
        Role
        <textarea rows={6} value={draft.role} onChange={(e) => set('role', e.target.value)} />
      </label>
      <label className="inline">
        <input type="checkbox" checked={!!draft.reviewer} onChange={(e) => set('reviewer', e.target.checked)} /> Reviewer
        <span className="hint">Read-only; with the reviewer-veto guardrail, others cannot edit until this agent approves.</span>
      </label>
      <label className="inline">
        <input type="checkbox" checked={!!draft.canEditProtected} onChange={(e) => set('canEditProtected', e.target.checked)} /> May edit protected paths
      </label>
      <label>
        Always-allowed tools
        <input value={allowed} placeholder="e.g. Read, Grep, Bash(npm test:*)" onChange={(e) => setAllowed(e.target.value)} />
      </label>
      <label>
        Disallowed tools
        <input value={disallowed} placeholder="e.g. WebFetch, Bash" onChange={(e) => setDisallowed(e.target.value)} />
      </label>
      <span className="hint">Model, effort and permission mode apply immediately. Other changes restart this agent's session on its next turn, keeping its history.</span>
      <div className="row">
        <button onClick={save} disabled={!draft.name.trim()}>
          Save
        </button>
        {canRemove && (
          <button
            className="danger"
            onClick={() => {
              post({ type: 'removeAgent', id: agent.config.id });
              onClose();
            }}
          >
            Remove agent
          </button>
        )}
      </div>
    </aside>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
