import { useState } from 'react';
import { selectPreset, setGuardrailConfig, toggleGuardrail } from '../src/shared/guardrailsFile';
import {
  DEFAULT_LIMITS,
  EFFORTS,
  MODES,
  MODE_HINTS,
  MODE_LABELS,
  PERMISSION_MODES,
  WORKSPACE_MODES,
  type AgentConfig,
  type AgentView,
  type FieldSpec,
  type GuardrailEntry,
  type GuardrailLayer,
  type GuardrailsFile,
  type GuardrailsView,
  type ProviderView,
} from '../src/shared/protocol';
import { AgentGuardrails, Field, LimitsForm } from './settings';
import { post } from './state';

// ---------------------------------------------------------------- providers

export function providerOf(providers: ProviderView[], id: string): ProviderView | undefined {
  return providers.find((p) => p.id === id);
}

export function available(p: ProviderView | undefined): boolean {
  return !!p && p.installed && p.authenticated !== false;
}

export function ProviderBadge({ provider }: { provider: ProviderView | undefined }) {
  if (!provider) return null;
  const ok = available(provider);
  return (
    <span className={`pbadge ${ok ? '' : 'bad'}`} title={`${provider.title} (${provider.vendor}) — ${provider.detail}`}>
      {provider.title.slice(0, 2)}
    </span>
  );
}

export function ProviderCards({ providers }: { providers: ProviderView[] }) {
  return (
    <div className="provider-cards">
      {providers.map((p) => {
        const ok = available(p);
        return (
          <div key={p.id} className={`provider-card ${ok ? 'ok' : 'bad'}`}>
            <div className="row between">
              <strong>
                {p.title} <span className="hint">· {p.vendor}</span>
              </strong>
              <span className={`status ${ok ? 'ok' : p.installed ? 'warn' : 'muted'}`}>{ok ? 'ready' : p.installed ? 'not signed in' : 'not installed'}</span>
            </div>
            <div className="hint">{p.detail}</div>
            {!ok && p.setupHint && <div className="hint setup">{p.setupHint}</div>}
            {!ok && p.installed && (
              <div className="row">
                <button className="small" onClick={() => post({ type: 'login', provider: p.id })}>
                  Sign in
                </button>
                <span className="hint">
                  opens a terminal running <code>{p.loginCommand}</code>
                </span>
              </div>
            )}
            <div className="hint">
              Guardrails: {p.enforcement === 'full' ? 'full (in-process hooks)' : 'gates after each turn'} · cost: {p.costUsd ? 'USD' : 'tokens'}
              {p.experimental ? ' · experimental' : ''}
            </div>
          </div>
        );
      })}
      <button className="secondary small" onClick={() => post({ type: 'refreshProviders' })}>
        Re-check providers
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- guardrails

const LAYERS: Array<{ id: GuardrailLayer; title: string; blurb: string }> = [
  { id: 'gate', title: 'Gates', blurb: 'Enforced by hooks on every tool call (Claude, Copilot) or checked after each turn (Codex, Gemini, Cursor).' },
  { id: 'knowledge', title: 'Knowledge', blurb: 'Project files every agent reads, created from detection when missing.' },
  { id: 'process', title: 'Process', blurb: 'How work flows through the room: review, specs, isolation.' },
];

export function Guardrails({
  view,
  providers,
  onSave,
  embedded,
}: {
  view: GuardrailsView;
  providers: ProviderView[];
  /** Where edits go: the workspace file by default, or a room's own file. */
  onSave?(file: GuardrailsFile): void;
  /** Rendered inside another panel: no outer scroll container or profile line. */
  embedded?: boolean;
}) {
  const presetIds = view.presets.find((p) => p.id === view.file.preset)?.guardrailIds ?? [];
  const save = onSave ?? ((file: GuardrailsFile) => post({ type: 'setGuardrails', file }));
  if (!view.hasWorkspace) {
    return <div className="empty">Open a folder to configure guardrails. They live in .roundtable/guardrails.json inside the project.</div>;
  }
  const partial = providers.filter((p) => p.enforcement === 'gates').map((p) => p.title);
  return (
    <div className={embedded ? 'panel-embedded' : 'panel'}>
      {!embedded && <div className="hint">Detected: {view.profile}</div>}
      {!embedded && partial.length > 0 && <div className="hint">PreToolUse blocks apply in-process for Claude and Copilot agents; {partial.join(', ')} agents get the same gates checked after each turn instead.</div>}

      <section>
        <h3>Preset</h3>
        <div className="presets">
          {view.presets.map((p) => (
            <button key={p.id} className={`preset ${view.file.preset === p.id ? 'selected' : ''}`} onClick={() => save(selectPreset(view.file, p.id))}>
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
          <button
            className="secondary small"
            onClick={(e) => {
              e.preventDefault();
              setOpen(!open);
            }}
          >
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

/** How a mode is enforced for a vendor, for the hint under the Mode field. */
function modeEnforcement(provider: AgentConfig['provider'], mode: AgentConfig['mode']): string {
  if (!mode || mode === 'build') return '';
  const table: Record<AgentConfig['provider'], Record<'plan' | 'ask', string>> = {
    claude: { plan: "Enforced with Claude's plan permission mode (read-only tools).", ask: 'Enforced by removing Edit, Write and Bash tools.' },
    codex: { plan: 'Enforced with the read-only sandbox (Codex has no plan mode).', ask: 'Enforced with the read-only sandbox.' },
    gemini: { plan: "Enforced with Gemini's plan approval mode.", ask: "Enforced with Gemini's plan approval mode (read-only)." },
    copilot: { plan: 'Enforced by excluding edit and shell tools (Copilot has no plan mode).', ask: 'Enforced by excluding edit and shell tools.' },
    cursor: { plan: "Enforced with Cursor's --mode plan.", ask: "Enforced with Cursor's --mode ask." },
  };
  return table[provider][mode];
}

// -------------------------------------------------------------------- drawer

export function Drawer({
  agent,
  providers,
  canRemove,
  roomGuardrails,
  onClose,
}: {
  agent: AgentView;
  providers: ProviderView[];
  canRemove: boolean;
  /** Guardrails as the active room sees them, for the per-agent override list. */
  roomGuardrails: GuardrailsView | undefined;
  onClose(): void;
}) {
  const [draft, setDraft] = useState<AgentConfig>(agent.config);
  const [allowed, setAllowed] = useState(agent.config.allowedTools.join(', '));
  const [disallowed, setDisallowed] = useState(agent.config.disallowedTools.join(', '));
  const [customModel, setCustomModel] = useState(false);
  const set = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const list = (value: string) => value.split(',').map((s) => s.trim()).filter(Boolean);
  const provider = providerOf(providers, draft.provider);
  const models = provider?.models ?? [];
  const knownModel = models.some((m) => m.id === draft.model);

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
        <button className="secondary small" onClick={onClose}>
          Close
        </button>
      </div>
      <Field label="Name" hint="How the agent appears in the room and how you @mention it. No spaces.">
        <input value={draft.name} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <Field label="Color" hint="Used for the agent's name and dot everywhere.">
        <input type="color" value={draft.color} onChange={(e) => set('color', e.target.value)} />
      </Field>
      <label>
        Provider
        <select
          value={draft.provider}
          onChange={(e) => {
            const next = providerOf(providers, e.target.value);
            setDraft((d) => ({ ...d, provider: e.target.value as AgentConfig['provider'], model: next?.models[0]?.id ?? d.model }));
            setCustomModel(false);
          }}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title} — {p.vendor}
              {available(p) ? '' : ` (${p.installed ? 'not signed in' : 'not installed'})`}
              {p.experimental ? ' · experimental' : ''}
            </option>
          ))}
        </select>
        {provider && !available(provider) && (
          <span className="warn-text">
            ⚠ {provider.detail}. {provider.setupHint}{' '}
            {provider.installed && (
              <button className="small" onClick={() => post({ type: 'login', provider: provider.id })}>
                Sign in
              </button>
            )}
          </span>
        )}
        <span className="hint">
          The vendor whose agent runtime answers for this agent, using your login for that vendor. {provider ? `${provider.title}: guardrails ${provider.enforcement === 'full' ? 'fully enforced in-process' : 'checked after each turn'}; usage shown as ${provider.costUsd ? 'approximate USD when on an API key' : 'tokens'}.` : ''}
        </span>
      </label>
      <label>
        Model
        {!customModel && (knownModel || models.length === 0) ? (
          <select
            value={draft.model}
            onChange={(e) => {
              if (e.target.value === '__custom') setCustomModel(true);
              else set('model', e.target.value);
            }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.id !== m.label ? ` (${m.id})` : ''}
              </option>
            ))}
            <option value="__custom">Other…</option>
          </select>
        ) : (
          <input value={draft.model} placeholder="model id" onChange={(e) => set('model', e.target.value)} />
        )}
        {agent.liveModel && agent.liveModel !== draft.model && <span className="hint">running: {agent.liveModel}</span>}
        <span className="hint">The vendor's model id. Pick from the list or type one the vendor accepts; changes apply live where the vendor allows.</span>
      </label>
      <Field
        label="Mode"
        hint={`${MODE_HINTS[draft.mode ?? 'build']} ${modeEnforcement(draft.provider, draft.mode ?? 'build')} A room mode, when set, overrides this.`}
      >
        <select value={draft.mode ?? 'build'} onChange={(e) => set('mode', e.target.value as AgentConfig['mode'])}>
          {MODES.map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Effort" hint="How hard the model thinks before answering (reasoning budget). Higher = slower, costlier, more careful. Not every vendor or model honours every level.">
        <select value={draft.effort} onChange={(e) => set('effort', e.target.value as AgentConfig['effort'])}>
          {EFFORTS.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </Field>
      <label>
        Permission mode
        <select value={draft.permissionMode} onChange={(e) => set('permissionMode', e.target.value as AgentConfig['permissionMode'])}>
          {PERMISSION_MODES.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <span className="hint">
          default: risky tools ask you first (Claude, Copilot). acceptEdits: file edits go through, shell still asks. auto: a classifier decides. plan: read-only planning. dontAsk: deny anything not pre-approved.
          {draft.provider !== 'claude' && draft.provider !== 'copilot' ? ' This vendor has no prompts; the mode maps to its sandbox / approval policy.' : ''}
        </span>
      </label>
      <label>
        Workspace
        <select value={draft.workspaceMode} onChange={(e) => set('workspaceMode', e.target.value as AgentConfig['workspaceMode'])}>
          {WORKSPACE_MODES.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <span className="hint">shared: edits the open folder · worktree: own git worktree · read-only: no edits or shell</span>
      </label>
      <Field label="Role" hint="Appended to the vendor's system prompt (or sent as the first message for vendors without one). Say what this agent cares about, how it disagrees, what it must not do. Short beats long.">
        <textarea rows={6} value={draft.role} onChange={(e) => set('role', e.target.value)} />
      </Field>
      <label className="inline">
        <input type="checkbox" checked={!!draft.reviewer} onChange={(e) => set('reviewer', e.target.checked)} /> Reviewer
        <span className="hint">Read-only; with the reviewer-veto guardrail, others cannot edit until this agent approves.</span>
      </label>
      <Field inline label="May edit protected paths" hint="Exempt from the protected-paths guardrail (lockfiles, env files, CI, migrations). For a trusted release or infra agent.">
        <input type="checkbox" checked={!!draft.canEditProtected} onChange={(e) => set('canEditProtected', e.target.checked)} />
      </Field>
      <Field inline label="Pinned" hint="Shows under Pinned in the sidebar tree.">
        <input type="checkbox" checked={!!draft.pinned} onChange={(e) => set('pinned', e.target.checked)} />
      </Field>

      <div className="drawer-section">
        <span className="title">Limits</span>
        <span className="hint">Spending and usage guards for this agent in every room. The room has its own; the stricter one wins. When a limit is hit the agent sits out and the room says so.</span>
        <LimitsForm value={draft.limits ?? DEFAULT_LIMITS} scope="agent" onChange={(limits) => set('limits', limits)} />
      </div>

      <div className="drawer-section">
        <span className="title">Guardrails for this agent</span>
        <AgentGuardrails view={roomGuardrails ?? { profile: '', hasWorkspace: false, presets: [], file: { enabled: {}, disabled: [] }, entries: [], setup: [], busy: false }} value={draft.guardrails} onChange={(g) => set('guardrails', g)} />
      </div>
      <Field label="Always-allowed tools" hint="Claude tool rules that never prompt, comma-separated: Read, Grep, Bash(npm test:*). Leave empty to be asked as usual.">
        <input value={allowed} placeholder="e.g. Read, Grep, Bash(npm test:*)" onChange={(e) => setAllowed(e.target.value)} />
      </Field>
      <Field label="Disallowed tools" hint="Tools this agent may never use, comma-separated: WebFetch, Bash. Read-only workspace mode already removes edit and shell tools.">
        <input value={disallowed} placeholder="e.g. WebFetch, Bash" onChange={(e) => setDisallowed(e.target.value)} />
      </Field>
      <span className="hint">Model, effort and permission mode apply live where the provider allows; other changes restart the agent's sessions on their next turn, keeping history.</span>
      <div className="row">
        <button onClick={save} disabled={!draft.name.trim()}>
          Save
        </button>
        <button className="secondary" onClick={() => post({ type: 'createRoom', kind: 'dm', agentIds: [agent.config.id] })}>
          Message
        </button>
        {canRemove && (
          <button
            className="danger"
            onClick={() => {
              post({ type: 'removeAgent', id: agent.config.id });
              onClose();
            }}
          >
            Delete agent
          </button>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------- help

const DOCS: Array<[string, string]> = [
  ['../DISCLAIMER.md', 'Disclaimer'],
  ['getting-started.md', 'Getting started'],
  ['concepts.md', 'Concepts: agents, rooms, DMs, turns'],
  ['providers.md', 'Providers: Claude, Codex, Gemini, Copilot, Cursor'],
  ['agents.md', 'Agents and their settings'],
  ['rooms.md', 'Rooms, DMs and the debate'],
  ['guardrails.md', 'Guardrails and presets'],
  ['troubleshooting.md', 'Troubleshooting'],
  ['faq.md', 'FAQ'],
];

export function Help({ providers }: { providers: ProviderView[] }) {
  return (
    <div className="panel">
      <section>
        <h3>Shortcuts</h3>
        <table className="shortcuts">
          <tbody>
            <tr>
              <td>
                <kbd>Enter</kbd>
              </td>
              <td>send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline</td>
            </tr>
            <tr>
              <td>
                <kbd>Esc</kbd>
              </td>
              <td>stop the debate</td>
            </tr>
            <tr>
              <td>
                <kbd>@</kbd>
              </td>
              <td>mention an agent (autocomplete) · <code>@all</code> queues everyone</td>
            </tr>
            <tr>
              <td>
                <kbd>/</kbd>
              </td>
              <td>
                commands: <code>/stop</code>, <code>/reset</code>, <code>/dm Name</code>, <code>/model Name model-id</code>, <code>/room Name</code>, <code>/guardrails</code>
              </td>
            </tr>
            <tr>
              <td>
                <kbd>⌘⇧R</kbd>
              </td>
              <td>open chat · <kbd>⌘⇧.</kbd> send editor selection to the room</td>
            </tr>
          </tbody>
        </table>
      </section>
      <section>
        <h3>How a room works</h3>
        <p className="hint">
          You post; agents take turns one at a time. Mentioned agents go first, then round-robin. An agent with nothing new says so (PASS) and the debate ends when everyone passes, the round cap or
          budget hits, or you press Stop. A DM is a room with one agent. Every room keeps its own memory per agent.
        </p>
      </section>
      <section>
        <h3>Providers</h3>
        <ProviderCards providers={providers} />
      </section>
      <section>
        <h3>Costs and quotas</h3>
        <p className="hint">
          Agents on a subscription show <b>plan</b> and, when the vendor reports it, how much of the current rate-limit window is left. Agents on an API key show an{' '}
          <b>approximate</b> dollar figure from the vendor's own estimate; the room budget cap applies to that figure only. None of this is a bill — check the vendor's dashboard for the real numbers.
        </p>
      </section>
      <section>
        <h3>Disclaimer</h3>
        <p className="hint">
          Roundtable is an independent project, not affiliated with Anthropic, OpenAI, Google, GitHub or Cursor. It drives each vendor's own tools under <b>your</b> accounts and their terms. <b>Every token, charge, quota and overage incurred, and anything an agent does, is your responsibility; the author is not liable.</b> Multi-agent debates can burn tokens fast; caps and figures are estimates, not guarantees. Provided as is, with <b>no warranty or guarantee of any kind</b>. {' '}
          <a href="#" onClick={(e) => { e.preventDefault(); post({ type: 'openDoc', doc: '../DISCLAIMER.md' }); }}>Read the full disclaimer</a>.
        </p>
      </section>
      <section>
        <h3>Documentation</h3>
        <ul className="doclist">
          {DOCS.map(([file, title]) => (
            <li key={file}>
              <a href="#" onClick={(e) => { e.preventDefault(); post({ type: 'openDoc', doc: file }); }}>
                {title}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
