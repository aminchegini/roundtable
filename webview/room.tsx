import { useEffect, useRef, useState } from 'react';
import { USER_ID, type AgentView, type PermissionRequest, type RoomMessage, type SpecView } from '../src/shared/protocol';
import { Markdown } from './markdown';
import { post, type State } from './state';

export function Transcript({ state, byId, names, onWelcomeAction }: { state: State; byId: Map<string, AgentView>; names: string[]; onWelcomeAction(action: 'guardrails' | 'help'): void }) {
  const end = useRef<HTMLDivElement>(null);
  const roomState = state.roomState;
  const speaking = roomState?.agents.filter((a) => a.status === 'speaking') ?? [];
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [roomState?.messages.length, state.live, speaking.length]);

  if (!roomState) return <div className="empty">No room yet. Create one from the sidebar or the room switcher.</div>;

  return (
    <div className="transcript">
      {roomState.messages.length === 0 && <Welcome state={state} onAction={onWelcomeAction} />}
      {roomState.messages.map((m) => (
        <Message key={m.id} message={m} agent={byId.get(m.from)} names={names} />
      ))}
      {speaking.map((a) => {
        const live = state.live[a.config.id];
        return (
          <div key={a.config.id} className="msg live">
            <div className="msg-from" style={{ color: a.config.color }}>
              {a.config.name}
            </div>
            {live?.text ? <Markdown text={live.text} names={names} /> : <div className="typing">thinking…</div>}
            {live?.activity && <div className="activity">{live.activity}</div>}
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

function Message({ message, agent, names }: { message: RoomMessage; agent: AgentView | undefined; names: string[] }) {
  const [copied, setCopied] = useState(false);
  if (message.from === 'system') return <div className="msg system">{message.text}</div>;
  const isUser = message.from === USER_ID;
  const copy = () => {
    void navigator.clipboard.writeText(message.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className={`msg ${isUser ? 'user' : ''}`}>
      <div className="msg-head">
        <span className="msg-from" style={{ color: isUser ? undefined : agent?.config.color }}>
          {isUser ? 'You' : (agent?.config.name ?? 'Former agent')}
        </span>
        <span className="msg-time">{new Date(message.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        <button className="ghost small msg-copy" title="Copy message" onClick={copy}>
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <Markdown text={message.text} names={names} />
    </div>
  );
}

export function PermissionCard({ request, agent }: { request: PermissionRequest; agent: AgentView | undefined }) {
  const respond = (decision: 'allow' | 'always' | 'deny') => post({ type: 'permissionResponse', requestId: request.requestId, decision });
  return (
    <div className="card warn">
      <div>
        <strong style={{ color: agent?.config.color }}>{agent?.config.name ?? 'Agent'}</strong> wants to use <strong>{request.toolName}</strong>
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

export function SpecCard({ spec, names }: { spec: SpecView; names: string[] }) {
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
        <button className="secondary small" onClick={() => setOpen(!open)}>
          {open ? 'Collapse' : 'Expand'}
        </button>
      </div>
      {open && (
        <div className="spec-body">
          <Markdown text={spec.markdown} names={names} />
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

/** Empty-room content: who is here, which providers work, how to start. */
function Welcome({ state, onAction }: { state: State; onAction(action: 'guardrails' | 'help'): void }) {
  const room = state.rooms.rooms.find((r) => r.id === state.rooms.activeRoomId);
  const agents = state.roomState?.agents ?? [];
  const unavailable = agents.filter((a) => {
    const p = state.providers.find((p) => p.id === a.config.provider);
    return p && (!p.installed || p.authenticated === false);
  });
  const guardrailCount = state.guardrails.entries.filter((e) => e.enabled).length;
  return (
    <div className="welcome">
      <h2>{room?.kind === 'dm' ? `Direct message with ${agents[0]?.config.name ?? 'an agent'}` : (room?.name ?? 'Roundtable')}</h2>
      <p className="hint">
        {room?.kind === 'dm'
          ? 'Only this agent answers here. Its memory is separate from any room it is also in.'
          : 'Everyone here answers you and each other. Use @Name to pick who goes first, @all to queue everyone. Agents pass when they have nothing to add; the debate stops when all pass or the round cap hits.'}
      </p>
      {agents.length > 0 && (
        <div className="welcome-agents">
          {agents.map((a) => {
            const p = state.providers.find((p) => p.id === a.config.provider);
            const bad = p && (!p.installed || p.authenticated === false);
            return (
              <div key={a.config.id} className={`welcome-agent ${bad ? 'bad' : ''}`}>
                <span className="dot" style={{ background: a.config.color }} />
                <span>
                  <strong>{a.config.name}</strong> <span className="hint">{p?.title ?? a.config.provider} · {a.config.model}</span>
                  <br />
                  <span className="hint">{a.config.role.split('\n')[0] || 'no role yet'}</span>
                  {bad && (
                    <div className="warn-text">
                      ⚠ {p?.detail}. {p?.setupHint}{' '}
                      {p?.installed && (
                        <button className="small" onClick={() => post({ type: 'login', provider: p.id })}>
                          Sign in
                        </button>
                      )}
                    </div>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {agents.length === 0 && <p className="warn-text">This room has no agents. Add some with the participants button in the header.</p>}
      {unavailable.length === 0 && agents.length > 0 && <p className="hint">All providers in this room are signed in. Type below to start.</p>}
      <div className="row">
        <button className="secondary small" onClick={() => onAction('guardrails')}>
          Guardrails · {guardrailCount} active
        </button>
        <button className="secondary small" onClick={() => onAction('help')}>
          Help & shortcuts
        </button>
      </div>
    </div>
  );
}
