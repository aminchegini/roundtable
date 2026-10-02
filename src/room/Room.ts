import {
  USER_ID,
  type AgentConfig,
  type AgentStatus,
  type AgentView,
  type RoomMessage,
  type RoomStatus,
  type StopReason,
} from '../shared/protocol';

export interface TurnResult {
  /** Final reply text for the room. Ignored when `passed`. */
  text: string;
  /** Agent called pass_turn: nothing to add. */
  passed: boolean;
  /** Cumulative estimated cost of this agent's session. */
  costUsd: number;
  error?: string;
}

export interface AgentSession {
  runTurn(prompt: string): Promise<TurnResult>;
  interrupt(): Promise<void>;
  /** Apply a config change, live where possible, otherwise by restarting on next turn. */
  applyConfig(next: AgentConfig, roster: AgentConfig[]): Promise<void>;
  dispose(): void;
}

export interface RoomCaps {
  maxRounds: number;
  /** 0 disables the cap. */
  budgetUsd: number;
}

export type RoomEvent =
  | { type: 'message'; message: RoomMessage }
  | { type: 'agents' }
  | { type: 'room' };

export interface RoomDeps {
  createSession(config: AgentConfig, roster: AgentConfig[]): AgentSession;
  getCaps(): RoomCaps;
  emit(event: RoomEvent): void;
}

interface Member {
  config: AgentConfig;
  session: AgentSession;
  /** Index into `messages` of the first message this agent has not seen. */
  cursor: number;
  status: AgentStatus;
  costUsd: number;
}

export interface RoomSnapshot {
  messages: RoomMessage[];
  costs: Record<string, number>;
}

/**
 * Free-debate scheduler. One agent speaks at a time; agents addressed by
 * @Name go first, otherwise round-robin. The debate ends when every agent
 * passes in a row, the round cap or budget cap is hit, or the user stops it.
 */
export class Room {
  private members: Member[] = [];
  private messages: RoomMessage[] = [];
  private nextId = 1;
  private running = false;
  private stopRequested = false;
  private stopReason: StopReason | undefined;
  /** Agent turns taken since the last user message. */
  private turnsSinceUser = 0;
  private consecutivePasses = 0;
  private consecutiveErrors = 0;
  private priority: string[] = [];
  private lastSpeaker = -1;
  private active: Member | undefined;
  private loop: Promise<void> | undefined;

  constructor(private readonly deps: RoomDeps, configs: AgentConfig[], snapshot?: RoomSnapshot) {
    if (snapshot) {
      this.messages = snapshot.messages.slice();
      this.nextId = this.messages.reduce((max, m) => Math.max(max, m.id), 0) + 1;
    }
    for (const config of configs) {
      this.members.push(this.makeMember(config, configs, snapshot?.costs[config.id] ?? 0));
    }
  }

  private makeMember(config: AgentConfig, roster: AgentConfig[], costUsd = 0): Member {
    return {
      config,
      session: this.deps.createSession(config, roster),
      // A restored or newly added agent resumes its own session history (or
      // starts fresh), so it only needs messages posted from now on.
      cursor: this.messages.length,
      status: 'idle',
      costUsd,
    };
  }

  // ---- views ----

  get agentViews(): AgentView[] {
    return this.members.map((m) => ({ config: m.config, status: m.status, costUsd: m.costUsd }));
  }

  get transcript(): RoomMessage[] {
    return this.messages;
  }

  get status(): RoomStatus {
    const caps = this.deps.getCaps();
    return {
      running: this.running,
      round: this.round,
      maxRounds: caps.maxRounds,
      costUsd: this.totalCost,
      budgetUsd: caps.budgetUsd,
      stopReason: this.stopReason,
    };
  }

  get snapshot(): RoomSnapshot {
    return {
      messages: this.messages.slice(-300),
      costs: Object.fromEntries(this.members.map((m) => [m.config.id, m.costUsd])),
    };
  }

  private get round(): number {
    return this.members.length === 0 ? 0 : Math.floor(this.turnsSinceUser / this.members.length);
  }

  private get totalCost(): number {
    return this.members.reduce((sum, m) => sum + m.costUsd, 0);
  }

  private get roster(): AgentConfig[] {
    return this.members.map((m) => m.config);
  }

  // ---- user actions ----

  postUserMessage(text: string): void {
    const message = this.post(USER_ID, text);
    this.turnsSinceUser = 0;
    this.consecutivePasses = 0;
    this.consecutiveErrors = 0;
    // The user's mentions outrank anything agents queued up earlier.
    this.priority = [...this.mentions(message.text, USER_ID), ...this.priority];
    this.start();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopRequested = true;
    await this.active?.session.interrupt().catch(() => undefined);
    await this.loop;
  }

  /** Resolves when the current debate has ended. */
  async whenIdle(): Promise<void> {
    await this.loop;
  }

  async saveAgent(config: AgentConfig): Promise<void> {
    const member = this.members.find((m) => m.config.id === config.id);
    if (!member) return;
    const renamed = member.config.name !== config.name || member.config.role !== config.role;
    member.config = config;
    await member.session.applyConfig(config, this.roster);
    if (renamed) await this.refreshRoster(member);
    this.deps.emit({ type: 'agents' });
  }

  async addAgent(config: AgentConfig): Promise<void> {
    this.members.push(this.makeMember(config, [...this.roster, config]));
    await this.refreshRoster(this.members[this.members.length - 1]);
    this.post('system', `${config.name} joined the room.`);
    this.deps.emit({ type: 'agents' });
  }

  async removeAgent(id: string): Promise<void> {
    const index = this.members.findIndex((m) => m.config.id === id);
    const member = this.members[index];
    if (!member) return;
    if (this.active === member) await member.session.interrupt().catch(() => undefined);
    member.session.dispose();
    this.members.splice(index, 1);
    if (this.lastSpeaker >= index) this.lastSpeaker -= 1;
    this.priority = this.priority.filter((p) => p !== id);
    await this.refreshRoster();
    this.post('system', `${member.config.name} left the room.`);
    this.deps.emit({ type: 'agents' });
  }

  /** Other agents' prompts name the participants, so tell them when that changes. */
  private async refreshRoster(except?: Member): Promise<void> {
    const roster = this.roster;
    await Promise.all(
      this.members.filter((m) => m !== except).map((m) => m.session.applyConfig(m.config, roster)),
    );
  }

  dispose(): void {
    this.stopRequested = true;
    for (const m of this.members) m.session.dispose();
  }

  // ---- scheduler ----

  private start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.stopReason = undefined;
    this.deps.emit({ type: 'room' });
    this.loop = this.run().finally(() => {
      this.running = false;
      this.active = undefined;
      this.deps.emit({ type: 'room' });
    });
  }

  private async run(): Promise<void> {
    for (;;) {
      const reason = this.shouldStop();
      if (reason) {
        this.stopReason = reason;
        this.announceStop(reason);
        return;
      }
      const member = this.pickNext();
      if (!member) {
        this.stopReason = 'all-passed';
        return;
      }
      await this.takeTurn(member);
    }
  }

  private shouldStop(): StopReason | undefined {
    const caps = this.deps.getCaps();
    if (this.stopRequested) return 'stopped';
    if (this.members.length === 0) return 'all-passed';
    if (this.consecutiveErrors >= this.members.length) return 'all-failed';
    if (this.consecutivePasses >= this.members.length) return 'all-passed';
    if (caps.budgetUsd > 0 && this.totalCost >= caps.budgetUsd) return 'budget';
    if (this.round >= caps.maxRounds) return 'max-rounds';
    return undefined;
  }

  private announceStop(reason: StopReason): void {
    const caps = this.deps.getCaps();
    if (reason === 'max-rounds') {
      this.post('system', `Round cap reached (${caps.maxRounds}). Send a message to continue.`);
    } else if (reason === 'budget') {
      this.post('system', `Budget cap reached ($${caps.budgetUsd.toFixed(2)}). Raise roundtable.budgetUsd or reset the room.`);
    } else if (reason === 'all-failed') {
      this.post('system', 'Every agent failed on its last turn. Debate stopped.');
    }
  }

  private pickNext(): Member | undefined {
    while (this.priority.length > 0) {
      const id = this.priority.shift();
      const index = this.members.findIndex((m) => m.config.id === id);
      if (index >= 0) {
        this.lastSpeaker = index;
        return this.members[index];
      }
    }
    if (this.members.length === 0) return undefined;
    this.lastSpeaker = (this.lastSpeaker + 1) % this.members.length;
    return this.members[this.lastSpeaker];
  }

  private async takeTurn(member: Member): Promise<void> {
    const digest = this.digestFor(member);
    this.turnsSinceUser += 1;
    if (!digest) {
      // Nothing new since this agent last spoke.
      this.consecutivePasses += 1;
      return;
    }
    member.cursor = this.messages.length;
    member.status = 'speaking';
    this.active = member;
    this.deps.emit({ type: 'agents' });

    let result: TurnResult;
    try {
      result = await member.session.runTurn(digest);
    } catch (err) {
      result = { text: '', passed: false, costUsd: member.costUsd, error: errorText(err) };
    }
    this.active = undefined;
    // Sessions report a running total; a restarted session may start lower.
    member.costUsd = Math.max(member.costUsd, result.costUsd);

    if (this.stopRequested) {
      member.status = 'idle';
    } else if (result.error) {
      member.status = 'error';
      this.consecutiveErrors += 1;
      this.consecutivePasses += 1;
      this.post('system', `${member.config.name} failed: ${result.error}`);
    } else {
      member.status = 'idle';
      this.consecutiveErrors = 0;
      const text = result.text.trim();
      if (result.passed || !text) {
        this.consecutivePasses += 1;
      } else {
        this.consecutivePasses = 0;
        const message = this.post(member.config.id, text);
        this.priority.push(...this.mentions(message.text, member.config.id));
      }
    }
    this.deps.emit({ type: 'agents' });
    this.deps.emit({ type: 'room' });
  }

  /** Room messages this agent has not seen yet, excluding its own. */
  private digestFor(member: Member): string {
    const lines: string[] = [];
    for (const m of this.messages.slice(member.cursor)) {
      if (m.from === member.config.id || m.from === 'system') continue;
      lines.push(`[${this.nameOf(m.from)}]: ${m.text}`);
    }
    return lines.join('\n\n');
  }

  private nameOf(id: string): string {
    if (id === USER_ID) return 'User';
    return this.members.find((m) => m.config.id === id)?.config.name ?? id;
  }

  /** Ids of agents addressed with @Name (or everyone for @all), minus the author. */
  private mentions(text: string, author: string): string[] {
    const ids: string[] = [];
    const lower = text.toLowerCase();
    const everyone = /@all\b/.test(lower);
    for (const m of this.members) {
      if (m.config.id === author) continue;
      const name = m.config.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (everyone || new RegExp(`@${name}(?![\\w-])`).test(lower)) ids.push(m.config.id);
    }
    return ids.filter((id) => !this.priority.includes(id));
  }

  private post(from: string, text: string): RoomMessage {
    const message: RoomMessage = { id: this.nextId++, from, text, ts: Date.now() };
    this.messages.push(message);
    this.deps.emit({ type: 'message', message });
    return message;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
