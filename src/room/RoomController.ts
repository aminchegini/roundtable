import type { GuardrailRegistry } from '../guardrails/registry';
import type { GuardrailRuntime } from '../guardrails/runtime';
import { getProvider, type ProviderRegistry } from '../providers/registry';
import { isAuthError, type SessionContext } from '../providers/types';
import { describeToolUse } from './SdkAgentSession';
import {
  DEFAULT_LIMITS,
  type AgentConfig,
  type AgentView,
  type GuardrailsView,
  type HostToWebview,
  type Limits,
  type PermissionDecision,
  type PermissionRequest,
  type RoomMeta,
  type RoomState,
  type RoomStatus,
  type SpecView,
} from '../shared/protocol';
import { emptyGuardrailsView } from '../guardrails/registry';
import { Room, type AgentSession, type RoomCaps, type RoomSnapshot, type TurnResult } from './Room';

/** Messages a controller emits; the chat host forwards them when the room is the active one. */
export type ControllerEvent = Extract<HostToWebview, { type: 'message' | 'partial' | 'activity' | 'agents' | 'room' | 'permissions' | 'spec' }>;

export interface ControllerStorage {
  getSnapshot(): RoomSnapshot | undefined;
  setSnapshot(snapshot: RoomSnapshot | undefined): Promise<void>;
  getSessions(): Record<string, string>;
  setSessions(sessions: Record<string, string> | undefined): Promise<void>;
}

export interface ControllerDeps {
  meta(): RoomMeta;
  /** Every agent in the workspace; participants are looked up by id. */
  agents(): AgentConfig[];
  registry: GuardrailRegistry | undefined;
  providers: ProviderRegistry;
  /** Workspace defaults; the room's own settings override them. */
  defaults(): { maxRounds: number };
  storage: ControllerStorage;
  env: Record<string, string | undefined>;
  claudePath: string | undefined;
  resolveCwd(agent: AgentConfig): Promise<string | undefined>;
  log(text: string): void;
  emit(event: ControllerEvent): void;
  /** Called when the room transcript or activity changed (for trees and status bar). */
  changed(): void;
  /** A turn failed because the vendor wants the user to sign in. */
  loginNeeded(agent: AgentConfig, reason: string): void;
}

interface PendingPermission {
  request: PermissionRequest;
  resolve(decision: PermissionDecision): void;
}

/**
 * Runs for providers without an in-process Stop hook: after each turn the
 * guardrail stop checks run here, and a failing gate becomes a follow-up turn.
 */
class GatedSession implements AgentSession {
  constructor(
    private readonly inner: AgentSession,
    private readonly agent: () => AgentConfig,
    private readonly roster: () => AgentConfig[],
    private readonly runtime: GuardrailRuntime,
    private readonly resolveCwd: () => Promise<string | undefined>,
  ) {}

  async runTurn(prompt: string): Promise<TurnResult> {
    let result = await this.inner.runTurn(prompt);
    const cwd = await this.resolveCwd();
    while (!result.error && cwd) {
      const reason = await this.runtime.stopGate(this.agent(), this.roster(), cwd, result.text);
      if (!reason) break;
      result = await this.inner.runTurn(`${reason}\n\nAddress this, then give your final reply to the room.`);
    }
    return result;
  }
  interrupt() {
    return this.inner.interrupt();
  }
  applyConfig(next: AgentConfig, roster: AgentConfig[]) {
    return this.inner.applyConfig(next, roster);
  }
  restart() {
    this.inner.restart?.();
  }
  dispose() {
    this.inner.dispose();
  }
}

/** One live room: scheduler, guardrail runtime, sessions, permissions, persistence. */
export class RoomController {
  readonly room: Room;
  private runtime: GuardrailRuntime | undefined;
  private liveModels = new Map<string, string>();
  private permissions = new Map<string, PendingPermission>();
  private nextPermissionId = 1;

  constructor(private readonly deps: ControllerDeps) {
    this.runtime = deps.registry?.createRuntime(
      {
        report: (text) => this.room.postSystem(text),
        stateChanged: () => {
          this.deps.emit({ type: 'room', room: this.status() });
          this.deps.emit({ type: 'spec', spec: this.specView() });
        },
      },
      () => this.deps.meta().guardrails,
    );
    this.room = new Room(
      {
        getCaps: () => this.caps(),
        billingHint: (config) => {
          // Env-key presence is a reliable API signal before the session reports anything.
          const env = this.deps.env;
          const key = { claude: env.ANTHROPIC_API_KEY, codex: env.CODEX_API_KEY, gemini: env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY, copilot: undefined, cursor: env.CURSOR_API_KEY }[config.provider];
          return key ? 'api' : 'unknown';
        },
        unavailable: (config) => {
          const status = this.deps.providers.statusOf(config.provider);
          return !!status && (!status.installed || status.authenticated === false);
        },
        emit: (event) => {
          switch (event.type) {
            case 'message':
              this.deps.emit({ type: 'message', message: event.message });
              void this.persist();
              this.deps.changed();
              break;
            case 'agents':
              this.deps.emit({ type: 'agents', agents: this.agentViews() });
              this.deps.changed();
              break;
            case 'room':
              this.deps.emit({ type: 'room', room: this.status() });
              void this.persist();
              this.deps.changed();
              break;
            case 'user-message':
              this.runtime?.onUserMessage();
              break;
            case 'turn-start': {
              this.runtime?.onTurnStart(event.agentId);
              // Known signed-out vendor: prompt before the turn burns a failure.
              const agent = this.participants().find((a) => a.id === event.agentId);
              const status = agent && this.deps.providers.statusOf(agent.provider);
              if (agent && status && (!status.installed || status.authenticated === false)) {
                this.deps.loginNeeded(agent, status.detail);
              }
              break;
            }
            case 'turn-done': {
              const agent = this.participants().find((a) => a.id === event.agentId);
              if (agent) this.runtime?.applyReply(agent, event.reply);
              break;
            }
            case 'turn-error': {
              const agent = this.participants().find((a) => a.id === event.agentId);
              if (agent && isAuthError(event.error)) this.deps.loginNeeded(agent, event.error);
              break;
            }
          }
        },
        createSession: (config, roster) => this.createSession(config, roster),
      },
      this.participants(),
      deps.storage.getSnapshot(),
    );
  }

  get id(): string {
    return this.deps.meta().id;
  }

  caps(): RoomCaps {
    const meta = this.deps.meta();
    return { maxRounds: meta.maxRounds ?? this.deps.defaults().maxRounds, limits: meta.limits ?? DEFAULT_LIMITS };
  }

  private limits(): Limits {
    return this.deps.meta().limits ?? DEFAULT_LIMITS;
  }

  guardrailsView(): GuardrailsView {
    return this.deps.registry ? this.deps.registry.view(this.deps.agents(), this.deps.meta().guardrails) : emptyGuardrailsView();
  }

  /** Room settings changed: re-resolve guardrails if needed and refresh. */
  settingsChanged(): void {
    if (this.runtime) this.deps.registry?.roomFileChanged(this.runtime);
    this.room.restartAll();
    this.deps.emit({ type: 'room', room: this.status() });
    this.deps.emit({ type: 'agents', agents: this.agentViews() });
  }

  participants(): AgentConfig[] {
    const all = this.deps.agents();
    return this.deps.meta().agentIds.map((id) => all.find((a) => a.id === id)).filter((a): a is AgentConfig => !!a);
  }

  private createSession(config: AgentConfig, roster: AgentConfig[]): AgentSession {
    const provider = getProvider(config.provider);
    const ctx: SessionContext = {
      resolveCwd: (c) => this.deps.resolveCwd(c),
      env: this.deps.env,
      resumeId: this.deps.storage.getSessions()[config.id],
      guardrails: this.runtime,
      claudePath: this.deps.claudePath,
      onEvent: (event) => {
        if (event.type === 'partial') this.deps.emit({ type: 'partial', agentId: config.id, text: event.text });
        else if (event.type === 'activity') this.deps.emit({ type: 'activity', agentId: config.id, text: event.text });
        else {
          this.liveModels.set(config.id, event.model);
          this.deps.log(`[${this.deps.meta().name}/${config.name}] session ${event.sessionId} model=${event.model} auth=${event.apiKeySource}`);
          void this.deps.storage.setSessions({ ...this.deps.storage.getSessions(), [config.id]: event.sessionId });
          this.deps.emit({ type: 'agents', agents: this.agentViews() });
        }
      },
      requestPermission: (toolName, input, canAlways, signal) => this.requestPermission(config.id, toolName, input, canAlways, signal),
    };
    const session = provider.createSession(config, roster, ctx);
    if (provider.enforcement === 'gates' && this.runtime) {
      const runtime = this.runtime;
      return new GatedSession(
        session,
        () => this.participants().find((a) => a.id === config.id) ?? config,
        () => this.participants(),
        runtime,
        () => this.deps.resolveCwd(config),
      );
    }
    return session;
  }

  // ---- views ----

  agentViews(): AgentView[] {
    return this.room.agentViews.map((a) => ({ ...a, liveModel: this.liveModels.get(a.config.id) }));
  }

  status(): RoomStatus {
    const status = this.room.status;
    const locks = this.runtime?.locks ?? {};
    return Object.keys(locks).length > 0 ? { ...status, locks } : status;
  }

  specView(): SpecView | undefined {
    const spec = this.runtime?.room.spec;
    if (!spec || spec.status === 'none') return undefined;
    const agent = this.deps.agents().find((a) => a.id === spec.agentId);
    return { status: spec.status, markdown: spec.markdown, agentName: agent?.name ?? 'Agent' };
  }

  state(): RoomState {
    return {
      agents: this.agentViews(),
      messages: this.room.transcript,
      room: this.status(),
      permissions: [...this.permissions.values()].map((p) => p.request),
      spec: this.specView(),
      limits: this.limits(),
      maxRounds: this.caps().maxRounds,
      guardrails: this.guardrailsView(),
      inheritsGuardrails: !this.deps.meta().guardrails,
    };
  }

  get running(): boolean {
    return this.room.status.running;
  }

  get speaker(): AgentConfig | undefined {
    return this.room.agentViews.find((a) => a.status === 'speaking')?.config;
  }

  // ---- actions ----

  send(text: string): void {
    if (text.trim()) this.room.postUserMessage(text.trim());
  }

  stop(): Promise<void> {
    return this.room.stop();
  }

  async saveAgent(config: AgentConfig): Promise<void> {
    await this.room.saveAgent(config);
  }

  /** Sync the room's members with the meta's agent ids. */
  async syncParticipants(): Promise<void> {
    const wanted = this.participants();
    const current = this.room.agentConfigs;
    for (const agent of current) if (!wanted.some((w) => w.id === agent.id)) await this.room.removeAgent(agent.id);
    for (const agent of wanted) if (!current.some((c) => c.id === agent.id)) await this.room.addAgent(agent);
    this.deps.emit({ type: 'agents', agents: this.agentViews() });
  }

  specDecision(decision: 'approve' | 'changes', note: string): void {
    if (!this.runtime) return;
    const { userMessage } = this.runtime.specDecision(decision, note);
    this.room.postUserMessage(userMessage);
    this.deps.emit({ type: 'spec', spec: this.specView() });
  }

  permissionResponse(requestId: string, decision: PermissionDecision): void {
    this.resolvePermission(requestId, decision);
  }

  restartAll(): void {
    this.room.restartAll();
  }

  /** Restart sessions and post the user's last message again (after a sign-in). */
  retryLast(): boolean {
    const text = this.room.lastUserMessage;
    if (!text) return false;
    this.room.restartAll();
    this.room.postUserMessage(text);
    return true;
  }

  /** Clear transcript and sessions; agents start fresh on their next turn. */
  async reset(): Promise<void> {
    await this.room.stop();
    for (const id of [...this.permissions.keys()]) this.resolvePermission(id, 'deny');
    this.liveModels.clear();
    await this.deps.storage.setSnapshot(undefined);
    await this.deps.storage.setSessions(undefined);
  }

  private async persist(): Promise<void> {
    await this.deps.storage.setSnapshot(this.room.snapshot);
  }

  // ---- permissions ----

  private requestPermission(agentId: string, toolName: string, input: Record<string, unknown>, canAlways: boolean, signal: AbortSignal): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      const requestId = String(this.nextPermissionId++);
      const request: PermissionRequest = { requestId, agentId, toolName, detail: describeToolUse(toolName, input), canAlways };
      this.permissions.set(requestId, { request, resolve });
      signal.addEventListener('abort', () => this.resolvePermission(requestId, 'deny'), { once: true });
      this.sendPermissions();
    });
  }

  private resolvePermission(requestId: string, decision: PermissionDecision): void {
    const pending = this.permissions.get(requestId);
    if (!pending) return;
    this.permissions.delete(requestId);
    pending.resolve(decision);
    this.sendPermissions();
  }

  private sendPermissions(): void {
    this.deps.emit({ type: 'permissions', permissions: [...this.permissions.values()].map((p) => p.request) });
    this.deps.changed();
  }

  get pendingPermissions(): number {
    return this.permissions.size;
  }

  dispose(): void {
    for (const id of [...this.permissions.keys()]) this.resolvePermission(id, 'deny');
    this.room.dispose();
    if (this.runtime) this.deps.registry?.releaseRuntime(this.runtime);
  }
}
