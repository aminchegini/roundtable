import { useState, type ReactNode } from 'react';
import {
  DEFAULT_LIMITS,
  MODES,
  MODE_HINTS,
  MODE_LABELS,
  type InteractionMode,
  type GuardrailOverrides,
  type GuardrailsFile,
  type GuardrailsView,
  type Limits,
  type ProviderView,
  type RoomMeta,
} from '../src/shared/protocol';
import { Guardrails } from './panels';
import { post, type State } from './state';

/** A labelled control with its explanation underneath. Every setting uses this so nothing is unexplained. */
export function Field({ label, hint, children, inline }: { label: ReactNode; hint: ReactNode; children: ReactNode; inline?: boolean }) {
  return (
    <label className={`field ${inline ? 'inline' : ''}`}>
      {inline ? (
        <>
          {children} <span className="field-label">{label}</span>
        </>
      ) : (
        <>
          <span className="field-label">{label}</span>
          {children}
        </>
      )}
      <span className="hint">{hint}</span>
    </label>
  );
}

export const LIMIT_HINTS = {
  allowApi: {
    room: 'Off by default. Agents that run on an API key (ANTHROPIC_API_KEY, CODEX_API_KEY, GEMINI_API_KEY, CURSOR_API_KEY) are metered per token and sit out of this room unless you tick this and tick the same box in the agent’s own settings. Subscription agents are not affected.',
    agent: 'Off by default. This agent may only spend metered API money when both this box and the room’s box are ticked. Irrelevant for agents on a subscription login.',
  },
  apiBudgetUsd: {
    room: 'Approximate USD across all API-billed agents in this room (the vendor’s estimate, not a bill). The debate stops when reached. 0 = no limit.',
    agent: 'Approximate USD this agent may spend across its rooms before it sits out. 0 = no limit.',
  },
  quotaStopPercent: {
    room: 'For subscription agents whose vendor reports rate-limit windows (Claude: 5-hour and 7-day). When any agent’s fullest window is this % used, the debate pauses until it resets. 0 = ignore.',
    agent: 'When this agent’s fullest plan window is this % used, it sits out until the window resets. 0 = ignore.',
  },
  maxTokens: {
    room: 'Total tokens (input + output) across all agents and turns in this room, as reported by the vendors. The debate stops when reached. 0 = no limit.',
    agent: 'Total tokens this agent may use across its rooms. 0 = no limit.',
  },
};

export function LimitsForm({ value, scope, onChange }: { value: Limits; scope: 'room' | 'agent'; onChange(next: Limits): void }) {
  const set = <K extends keyof Limits>(key: K, v: Limits[K]) => onChange({ ...value, [key]: v });
  const num = (key: 'apiBudgetUsd' | 'quotaStopPercent' | 'maxTokens', max?: number) => (
    <input
      type="number"
      min={0}
      max={max}
      step={key === 'apiBudgetUsd' ? 0.5 : 1}
      value={value[key]}
      onChange={(e) => set(key, Math.max(0, Number(e.target.value) || 0))}
    />
  );
  return (
    <div className="limits">
      <Field inline label="Allow API-billed agents" hint={LIMIT_HINTS.allowApi[scope]}>
        <input type="checkbox" checked={value.allowApi} onChange={(e) => set('allowApi', e.target.checked)} />
      </Field>
      {value.allowApi && (
        <Field label="API budget (≈ USD, 0 = unlimited)" hint={LIMIT_HINTS.apiBudgetUsd[scope]}>
          {num('apiBudgetUsd')}
        </Field>
      )}
      <Field label="Stop at plan usage (%, 0 = ignore)" hint={LIMIT_HINTS.quotaStopPercent[scope]}>
        {num('quotaStopPercent', 100)}
      </Field>
      <Field label="Token cap (0 = unlimited)" hint={LIMIT_HINTS.maxTokens[scope]}>
        {num('maxTokens')}
      </Field>
    </div>
  );
}

/** Room settings: name, rounds, limits, guardrails (inherit or custom). */
export function RoomSettings({ state, room }: { state: State; room: RoomMeta }) {
  const rs = state.roomState;
  const [limits, setLimits] = useState<Limits>(room.limits ?? DEFAULT_LIMITS);
  const [rounds, setRounds] = useState<string>(room.maxRounds === undefined ? '' : String(room.maxRounds));
  const [saved, setSaved] = useState(false);
  const inherits = !room.guardrails;

  const save = () => {
    const parsed = rounds.trim() === '' ? null : Math.max(1, Math.floor(Number(rounds) || 1));
    post({ type: 'updateRoom', id: room.id, patch: { limits, maxRounds: parsed } });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const setCustom = (custom: boolean) => {
    // Start a custom file from what the room currently sees so nothing changes until you edit it.
    post({ type: 'updateRoom', id: room.id, patch: { guardrails: custom ? (rs?.guardrails.file ?? state.guardrails.file) : null } });
  };

  return (
    <div className="panel">
      <section>
        <h3>Room</h3>
        <div className="hint">
          {room.kind === 'dm' ? 'A direct message with one agent.' : `${room.agentIds.length} participants.`} Settings here apply to this room only; workspace defaults apply where a field is empty.
        </div>
        <Field label="Rounds per message (empty = workspace default)" hint="How many times the whole table may go round after each message you send before agents stop and wait for you. Low numbers keep debates short and cheap.">
          <input type="number" min={1} value={rounds} placeholder={String(rs?.maxRounds ?? '')} onChange={(e) => setRounds(e.target.value)} />
        </Field>
        <Field
          label="Room mode"
          hint={`Forces one mode on every agent in this room, whatever their own setting. ${room.mode ? MODE_HINTS[room.mode] : 'Currently each agent uses its own mode.'} Applies on each agent's next turn.`}
        >
          <select value={room.mode ?? ''} onChange={(e) => post({ type: 'updateRoom', id: room.id, patch: { mode: (e.target.value || null) as InteractionMode | null } })}>
            <option value="">agents' own modes</option>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]} — {MODE_HINTS[m].split('.')[0]}
              </option>
            ))}
          </select>
        </Field>
      </section>

      <section>
        <h3>Limits</h3>
        <div className="hint">Spending and usage guards for this room. Each agent has its own limits too; the stricter one wins.</div>
        <LimitsForm value={limits} scope="room" onChange={setLimits} />
        <div className="row">
          <button onClick={save}>{saved ? 'Saved' : 'Save room settings'}</button>
        </div>
      </section>

      <section>
        <h3>Guardrails</h3>
        <div className="hint">
          Rules every agent in this room must follow. Inherit the workspace file (<code>.roundtable/guardrails.json</code>, shared with your team) or keep a custom set for this room only. Individual agents can
          still force rules on or off in their own settings.
        </div>
        <div className="row">
          <label className="inline">
            <input type="radio" name="gr-scope" checked={inherits} onChange={() => setCustom(false)} /> Inherit workspace guardrails
          </label>
          <label className="inline">
            <input type="radio" name="gr-scope" checked={!inherits} onChange={() => setCustom(true)} /> Custom for this room
          </label>
        </div>
        {rs && (
          <GuardrailsScoped
            view={rs.guardrails}
            providers={state.providers}
            readOnlyNote={inherits ? 'Editing here changes the workspace file for every room. Switch to "Custom for this room" to change only this room.' : undefined}
            onChange={inherits ? (file) => post({ type: 'setGuardrails', file }) : (file) => post({ type: 'updateRoom', id: room.id, patch: { guardrails: file } })}
          />
        )}
      </section>
    </div>
  );
}

/** The Guardrails panel with its save target redirected (workspace file or room file). */
function GuardrailsScoped({ view, providers, onChange, readOnlyNote }: { view: GuardrailsView; providers: ProviderView[]; onChange(file: GuardrailsFile): void; readOnlyNote?: string }) {
  return (
    <div className="scoped-guardrails">
      {readOnlyNote && <div className="hint note">{readOnlyNote}</div>}
      <Guardrails view={view} providers={providers} onSave={onChange} embedded />
    </div>
  );
}

/** Per-agent guardrail forcing: inherit from the room, force on, or force off. */
export function AgentGuardrails({ view, value, onChange }: { view: GuardrailsView; value: GuardrailOverrides | undefined; onChange(next: GuardrailOverrides | undefined): void }) {
  const current: GuardrailOverrides = value ?? { enabled: {}, disabled: [] };
  const stateOf = (id: string): 'inherit' | 'on' | 'off' => (current.disabled.includes(id) ? 'off' : current.enabled[id] !== undefined ? 'on' : 'inherit');
  const set = (id: string, mode: 'inherit' | 'on' | 'off') => {
    const enabled = { ...current.enabled };
    let disabled = current.disabled.filter((d) => d !== id);
    delete enabled[id];
    if (mode === 'on') enabled[id] = true;
    if (mode === 'off') disabled = [...disabled, id];
    const next = { enabled, disabled };
    onChange(Object.keys(next.enabled).length === 0 && next.disabled.length === 0 ? undefined : next);
  };
  const entries = view.entries.filter((e) => e.applies);
  if (entries.length === 0) return <span className="hint">Open a folder to use guardrails.</span>;
  return (
    <div className="agent-guardrails">
      {entries.map((e) => (
        <div key={e.id} className="agent-guardrail-row" title={e.summary}>
          <span className="agent-guardrail-title">
            {e.title} <span className="hint">({e.enabled ? 'on in room' : 'off in room'})</span>
          </span>
          <select value={stateOf(e.id)} onChange={(ev) => set(e.id, ev.target.value as 'inherit' | 'on' | 'off')}>
            <option value="inherit">inherit</option>
            <option value="on">force on</option>
            <option value="off">force off</option>
          </select>
        </div>
      ))}
      <span className="hint">
        <b>inherit</b> follows the room. <b>force on</b> applies the rule to this agent even when the room has it off (with default settings). <b>force off</b> exempts this agent — for instance a trusted
        release agent allowed to touch protected paths. Changes apply on the agent’s next turn.
      </span>
    </div>
  );
}
