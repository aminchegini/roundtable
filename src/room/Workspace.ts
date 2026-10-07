import { GuardrailRegistry, emptyGuardrailsView } from '../guardrails/registry';
import { ProcessRunner } from '../guardrails/runner';
import { ProviderRegistry, getProvider } from '../providers/registry';
import type { AgentConfig, AgentView, GuardrailsFile, GuardrailsView, ProviderId, RoomMeta, RoomsView } from '../shared/protocol';
import { blankAgent, defaultAgents, loadAgents, saveAgents } from './config';
import { RoomController, type ControllerEvent } from './RoomController';
import type { RoomSnapshot } from './Room';
import { RoomStore, type RoomStoreData } from './RoomStore';
import { ensureWorktree } from './worktrees';

/** Minimal key-value store (VS Code Memento in production, a Map in tests). */
export interface KeyValue {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): Promise<void>;
}

export interface WorkspaceDeps {
  root: string | undefined;
  /** Per-workspace state: rooms, transcripts, session ids. */
  state: KeyValue;
  /** Cross-workspace state: agents when no folder is open. */
  globalState: KeyValue;
  /** Directory for worktrees. */
  storageDir: string;
  env(): Promise<Record<string, string | undefined>>;
  claudePath: string | undefined;
  caps(): { maxRounds: number; budgetUsd: number };
  log(text: string): void;
  warn(text: string): void;
}

const ROOMS_KEY = 'roundtable.rooms';
const AGENTS_KEY = 'roundtable.agents';
const LEGACY_SNAPSHOT_KEY = 'roundtable.snapshot';
const LEGACY_SESSIONS_KEY = 'roundtable.sessions';
const snapshotKey = (roomId: string) => `roundtable.room.${roomId}.snapshot`;
const sessionsKey = (roomId: string) => `roundtable.room.${roomId}.sessions`;

export type WorkspaceEvent =
  | { type: 'rooms' }
  | { type: 'agents' }
  | { type: 'providers' }
  | { type: 'guardrails' }
  | { type: 'activity'; roomId: string }
  | { type: 'navigate'; view: 'room' | 'guardrails' | 'help' }
  /** A vendor rejected a turn for lack of a login. */
  | { type: 'login-needed'; provider: ProviderId; agentName: string; reason: string; roomId: string };

/** Everything the extension knows about one VS Code workspace: agents, rooms, guardrails, providers. */
export class Workspace {
  agents: AgentConfig[] = [];
  readonly rooms: RoomStore;
  readonly providers: ProviderRegistry;
  registry: GuardrailRegistry | undefined;
  private controllers = new Map<string, RoomController>();
  private controllerEvents = new Map<string, Set<(event: ControllerEvent) => void>>();
  private listeners = new Set<(event: WorkspaceEvent) => void>();
  private env: Record<string, string | undefined> = {};
  private lastLoginPrompt = new Map<ProviderId, number>();

  private constructor(private readonly deps: WorkspaceDeps) {
    this.rooms = new RoomStore(deps.state.get<RoomStoreData>(ROOMS_KEY), (data) => void deps.state.set(ROOMS_KEY, data));
    this.rooms.onChange(() => this.notify({ type: 'rooms' }));
    this.providers = new ProviderRegistry(() => this.env);
    this.providers.onChange(() => this.notify({ type: 'providers' }));
  }

  static async open(deps: WorkspaceDeps): Promise<Workspace> {
    const ws = new Workspace(deps);
    ws.env = await deps.env();
    ws.agents = await ws.loadAgents();
    if (deps.root) {
      ws.registry = new GuardrailRegistry(deps.root, new ProcessRunner());
      await ws.registry.load(ws.agents);
    }
    await ws.migrateLegacyRoom();
    if (ws.rooms.list().length === 0) {
      ws.rooms.create({ name: 'General', kind: 'group', agentIds: ws.agents.map((a) => a.id) });
    }
    void ws.providers.refresh();
    return ws;
  }

  /** v2 kept one unnamed room in workspace state; move it into a "General" room. */
  private async migrateLegacyRoom(): Promise<void> {
    const snapshot = this.deps.state.get<RoomSnapshot>(LEGACY_SNAPSHOT_KEY);
    if (!snapshot) return;
    const room = this.rooms.create({ name: 'General', kind: 'group', agentIds: this.agents.map((a) => a.id) });
    await this.deps.state.set(snapshotKey(room.id), snapshot);
    await this.deps.state.set(sessionsKey(room.id), this.deps.state.get(LEGACY_SESSIONS_KEY));
    await this.deps.state.set(LEGACY_SNAPSHOT_KEY, undefined);
    await this.deps.state.set(LEGACY_SESSIONS_KEY, undefined);
  }

  onChange(listener: (event: WorkspaceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(event: WorkspaceEvent): void {
    for (const l of this.listeners) l(event);
  }

  get root(): string | undefined {
    return this.deps.root;
  }

  /** Ask every open chat view to show a section. */
  navigate(view: 'room' | 'guardrails' | 'help'): void {
    this.notify({ type: 'navigate', view });
  }

  // ---- agents ----

  private async loadAgents(): Promise<AgentConfig[]> {
    const stored = this.deps.root ? await loadAgents(this.deps.root) : this.deps.globalState.get<AgentConfig[]>(AGENTS_KEY);
    return stored && stored.length > 0 ? stored : defaultAgents();
  }

  private async saveAgentsToDisk(): Promise<void> {
    if (this.deps.root) await saveAgents(this.deps.root, this.agents);
    else await this.deps.globalState.set(AGENTS_KEY, this.agents);
    await this.registry?.refresh(this.agents);
    this.notify({ type: 'agents' });
    this.notify({ type: 'guardrails' });
  }

  agentViews(): AgentView[] {
    return this.agents.map((config) => ({ config, status: 'idle', costUsd: 0, tokens: { input: 0, output: 0 }, billing: 'unknown' }));
  }

  async addAgent(provider: ProviderId = 'claude', model?: string): Promise<AgentConfig> {
    const agent = blankAgent(this.agents, provider, model ?? getProvider(provider).defaultModel);
    this.agents = [...this.agents, agent];
    await this.saveAgentsToDisk();
    return agent;
  }

  async saveAgent(config: AgentConfig): Promise<void> {
    this.agents = this.agents.map((a) => (a.id === config.id ? config : a));
    await this.saveAgentsToDisk();
    for (const controller of this.controllers.values()) {
      if (controller.participants().some((a) => a.id === config.id)) await controller.saveAgent(config);
    }
  }

  async removeAgent(id: string): Promise<void> {
    if (this.agents.length <= 1) throw new Error('Keep at least one agent.');
    this.agents = this.agents.filter((a) => a.id !== id);
    const deletedRooms = this.rooms.removeAgentEverywhere(id);
    for (const roomId of deletedRooms) await this.disposeRoom(roomId);
    for (const controller of this.controllers.values()) await controller.syncParticipants();
    await this.saveAgentsToDisk();
  }

  async pinAgent(id: string, pinned: boolean): Promise<void> {
    const agent = this.agents.find((a) => a.id === id);
    if (agent) await this.saveAgent({ ...agent, pinned });
  }

  // ---- rooms ----

  roomsView(): RoomsView {
    return { rooms: this.rooms.list(), activeRoomId: this.rooms.activeRoomId };
  }

  createRoom(input: { name?: string; kind: 'group' | 'dm'; agentIds: string[] }): RoomMeta {
    if (input.kind === 'dm') {
      const existing = this.rooms.dmFor(input.agentIds[0] ?? '');
      if (existing) {
        this.rooms.setActive(existing.id);
        return existing;
      }
    }
    const agentName = this.agents.find((a) => a.id === input.agentIds[0])?.name;
    return this.rooms.create({
      name: input.name ?? (input.kind === 'dm' ? (agentName ?? 'Direct message') : `Room ${this.rooms.list().filter((r) => r.kind === 'group').length + 1}`),
      kind: input.kind,
      agentIds: input.agentIds,
    });
  }

  /** Find or create the DM with an agent and make it active. */
  dmWith(agentId: string): RoomMeta {
    return this.createRoom({ kind: 'dm', agentIds: [agentId] });
  }

  async setParticipants(roomId: string, agentIds: string[]): Promise<void> {
    this.rooms.setParticipants(roomId, agentIds);
    await this.controllers.get(roomId)?.syncParticipants();
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.disposeRoom(roomId);
    this.rooms.remove(roomId);
  }

  private async disposeRoom(roomId: string): Promise<void> {
    const controller = this.controllers.get(roomId);
    if (controller) {
      await controller.stop();
      controller.dispose();
      this.controllers.delete(roomId);
    }
    await this.deps.state.set(snapshotKey(roomId), undefined);
    await this.deps.state.set(sessionsKey(roomId), undefined);
  }

  /** Live controller for a room, started on first use. */
  controller(roomId: string): RoomController | undefined {
    const meta = this.rooms.get(roomId);
    if (!meta) return undefined;
    let controller = this.controllers.get(roomId);
    if (controller) return controller;
    const { deps } = this;
    controller = new RoomController({
      meta: () => this.rooms.get(roomId) ?? meta,
      agents: () => this.agents,
      registry: this.registry,
      providers: this.providers,
      caps: () => deps.caps(),
      storage: {
        getSnapshot: () => deps.state.get<RoomSnapshot>(snapshotKey(roomId)),
        setSnapshot: (s) => deps.state.set(snapshotKey(roomId), s),
        getSessions: () => deps.state.get<Record<string, string>>(sessionsKey(roomId)) ?? {},
        setSessions: (s) => deps.state.set(sessionsKey(roomId), s),
      },
      env: this.env,
      claudePath: deps.claudePath,
      resolveCwd: (agent) => this.resolveCwd(agent),
      log: deps.log,
      emit: (event) => {
        for (const l of this.controllerEvents.get(roomId) ?? []) l(event);
      },
      changed: () => {
        this.rooms.touch(roomId);
        this.notify({ type: 'activity', roomId });
      },
      loginNeeded: (agent, reason) => {
        // One prompt per vendor per minute, however many agents fail.
        const last = this.lastLoginPrompt.get(agent.provider) ?? 0;
        if (Date.now() - last < 60_000) return;
        this.lastLoginPrompt.set(agent.provider, Date.now());
        this.notify({ type: 'login-needed', provider: agent.provider, agentName: agent.name, reason, roomId });
        void this.providers.refresh();
      },
    });
    this.controllers.set(roomId, controller);
    return controller;
  }

  onControllerEvent(roomId: string, listener: (event: ControllerEvent) => void): () => void {
    let set = this.controllerEvents.get(roomId);
    if (!set) this.controllerEvents.set(roomId, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Reset a room: fresh transcript and sessions, same participants. */
  async resetRoom(roomId: string): Promise<void> {
    const controller = this.controllers.get(roomId);
    if (controller) {
      await controller.reset();
      controller.dispose();
      this.controllers.delete(roomId);
    } else {
      await this.deps.state.set(snapshotKey(roomId), undefined);
      await this.deps.state.set(sessionsKey(roomId), undefined);
    }
  }

  private async resolveCwd(agent: AgentConfig): Promise<string | undefined> {
    const root = this.deps.root;
    if (!root || agent.workspaceMode !== 'worktree') return root;
    try {
      return await ensureWorktree(root, this.deps.storageDir, agent.id);
    } catch (err) {
      this.deps.warn(`Could not create a worktree for ${agent.name}; using the shared workspace. ${err instanceof Error ? err.message : String(err)}`);
      return root;
    }
  }

  // ---- guardrails ----

  guardrailsView(): GuardrailsView {
    return this.registry ? this.registry.view(this.agents) : emptyGuardrailsView();
  }

  async setGuardrails(file: GuardrailsFile): Promise<void> {
    if (!this.registry) return;
    await this.registry.setFile(file, this.agents);
    for (const c of this.controllers.values()) c.restartAll();
    this.notify({ type: 'guardrails' });
  }

  /** Apply pending setup; returns lines for the room's system messages. */
  async runGuardrailSetup(): Promise<string[]> {
    const registry = this.registry;
    if (!registry || registry.busy || registry.setupPlan.actions.length === 0) return [];
    this.notify({ type: 'guardrails' });
    const before = this.agents;
    const result = await registry.runSetup(before);
    if (result.agents !== before) {
      for (const agent of result.agents) {
        const prev = before.find((a) => a.id === agent.id);
        if (prev && prev !== agent) await this.saveAgent(agent);
      }
    }
    await registry.refresh(this.agents);
    for (const c of this.controllers.values()) c.restartAll();
    this.notify({ type: 'guardrails' });
    const lines = [
      result.written.length > 0 ? `wrote ${result.written.join(', ')}` : '',
      result.installed.length > 0 ? `installed ${result.installed.join(', ')}` : '',
      result.agents !== before ? 'updated agent settings' : '',
    ].filter(Boolean);
    return [`Guardrail setup: ${lines.length > 0 ? lines.join('; ') : 'nothing to do'}.`, ...result.errors.map((e) => `Guardrail setup problem: ${e}`)];
  }

  /** After a sign-in: re-detect providers, restart sessions, re-send the last message in a room. */
  async retryAfterLogin(roomId: string | undefined): Promise<boolean> {
    this.lastLoginPrompt.clear();
    await this.providers.refresh();
    for (const c of this.controllers.values()) c.restartAll();
    const target = roomId ?? this.rooms.activeRoomId;
    const controller = target ? this.controllers.get(target) : undefined;
    return controller?.retryLast() ?? false;
  }

  /** Roomless summary for trees and the status bar. */
  activity(roomId: string): { running: boolean; speaker?: string; pending: number } {
    const c = this.controllers.get(roomId);
    return { running: c?.running ?? false, speaker: c?.speaker?.name, pending: c?.pendingPermissions ?? 0 };
  }

  dispose(): void {
    for (const c of this.controllers.values()) c.dispose();
    this.controllers.clear();
  }
}
