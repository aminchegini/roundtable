import {
  DEFAULT_LIMITS,
  USER_ID,
  type AgentConfig,
  type AgentStatus,
  type AgentView,
  type BenchReason,
  type BillingKind,
  type InteractionMode,
  type Limits,
  type QuotaInfo,
  type RoomMessage,
  type RoomStatus,
  type StopReason,
  type Tokens,
} from '../shared/protocol';
import { parseReply, type ParsedReply } from './textCommands';

export interface TurnResult {
  /** Final reply text for the room. Ignored when `passed`. */
  text: string;
  /** Agent called pass_turn: nothing to add. */
  passed: boolean;
  /** Cumulative estimated cost of this agent's session (0 for providers without USD figures). */
  costUsd: number;
  /** Cumulative tokens of this agent's session, when the provider reports them. */
  tokens?: Tokens;
  /** How the vendor bills this session, once the session knows. */
  billing?: BillingKind;
  /** Rate-limit windows the vendor reported during the turn. */
  quota?: QuotaInfo[];
  error?: string;
}

export interface AgentSession {
  runTurn(prompt: string): Promise<TurnResult>;
  interrupt(): Promise<void>;
  /** Apply a config change, live where possible, otherwise by restarting on next turn. */
  applyConfig(next: AgentConfig, roster: AgentConfig[]): Promise<void>;
  /** Restart the underlying session (after its turn, if one is running), keeping history. */
  restart?(): void;
  /** Drop the vendor session entirely (stored id included); the next turn starts fresh with instructions. */
  forget?(): void;
  dispose(): void;
}

export interface RoomCaps {
  maxRounds: number;
  /** Room-level limits; see Limits. */
  limits: Limits;
}

export type RoomEvent =
  | { type: 'message'; message: RoomMessage }
  | { type: 'agents' }
  | { type: 'room' }
  | { type: 'user-message' }
  | { type: 'turn-start'; agentId: string }
  /** An agent finished a turn without error; `reply` carries parsed text commands. */
  | { type: 'turn-done'; agentId: string; reply: ParsedReply }
  | { type: 'turn-error'; agentId: string; error: string };

export interface RoomDeps {
  createSession(config: AgentConfig, roster: AgentConfig[]): AgentSession;
  getCaps(): RoomCaps;
  emit(event: RoomEvent): void;
  /** What we know about an agent's billing before its session reports it (from provider detection). */
  billingHint?(config: AgentConfig): BillingKind;
  /** True when the agent's vendor is known to be unavailable (not installed / signed out). */
  unavailable?(config: AgentConfig): boolean;
  /** Mode in force for an agent (room override applied); defaults to the agent's own or build. */
  modeOf?(config: AgentConfig): InteractionMode;
}

interface Member {
  config: AgentConfig;
  session: AgentSession;
  /** Index into `messages` of the first message this agent has not seen. */
  cursor: number;
  status: AgentStatus;
  costUsd: number;
  tokens: Tokens;
  billing: BillingKind;
  quota?: QuotaInfo[];
  /** Bench reason already announced for the current user request. */
  benchAnnounced?: BenchReason;
  /** The user asked to stop this agent's current turn and skip it this round. */
  skipRequested?: boolean;
}

export interface RoomSnapshot {
  messages: RoomMessage[];
  costs: Record<string, number>;
  tokens?: Record<string, Tokens>;
  billing?: Record<string, BillingKind>;
}

const NO_TOKENS: Tokens = { input: 0, output: 0 };

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
  private paused = false;
  private resumeGate: (() => void) | undefined;
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
      this.members.push(
        this.makeMember(config, configs, snapshot?.costs[config.id] ?? 0, snapshot?.tokens?.[config.id], snapshot?.billing?.[config.id]),
      );
    }
  }

  private makeMember(config: AgentConfig, roster: AgentConfig[], costUsd = 0, tokens: Tokens = NO_TOKENS, billing: BillingKind = 'unknown'): Member {
    return {
      config,
      session: this.deps.createSession(config, roster),
      // A restored or newly added agent resumes its own session history (or
      // starts fresh), so it only needs messages posted from now on.
      cursor: this.messages.length,
      status: 'idle',
      costUsd,
      tokens,
      billing: billing === 'unknown' ? (this.deps.billingHint?.(config) ?? 'unknown') : billing,
    };
  }

  // ---- limits ----

  /** Why this agent may not take a turn right now, if anything. */
  benchReason(member: Member): BenchReason | undefined {
    const room = this.deps.getCaps().limits;
    const own = member.config.limits ?? DEFAULT_LIMITS;
    if (this.deps.unavailable?.(member.config)) return 'provider-unavailable';
    const billing = member.billing === 'unknown' ? (this.deps.billingHint?.(member.config) ?? 'unknown') : member.billing;
    if (billing === 'api') {
      if (!room.allowApi || !own.allowApi) return 'api-not-allowed';
      if (own.apiBudgetUsd > 0 && member.costUsd >= own.apiBudgetUsd) return 'api-budget';
    }
    if (own.maxTokens > 0 && member.tokens.input + member.tokens.output >= own.maxTokens) return 'tokens';
    if (own.quotaStopPercent > 0 && (member.quota ?? []).some((q) => q.usedPercent >= own.quotaStopPercent)) return 'quota';
    return undefined;
  }

  private announceBench(member: Member, reason: BenchReason): void {
    if (member.benchAnnounced === reason) return;
    member.benchAnnounced = reason;
    const name = member.config.name;
    const text: Record<BenchReason, string> = {
      'api-not-allowed': `${name} runs on an API key and API usage is off here. Tick "Allow API-billed agents" in room settings and in ${name}'s settings to let it speak.`,
      'api-budget': `${name} reached its API budget (≈$${(member.config.limits?.apiBudgetUsd ?? 0).toFixed(2)}) and sits out. Raise it in ${name}'s settings.`,
      quota: `${name}'s plan usage passed ${member.config.limits?.quotaStopPercent ?? 0}% of a window and sits out until it resets.`,
      tokens: `${name} reached its token cap (${member.config.limits?.maxTokens ?? 0}) and sits out.`,
      'provider-unavailable': `${name}'s provider is not available (not installed or signed out); skipping.`,
    };
    this.post('system', text[reason] ?? `${name} is sitting out (${reason}).`);
  }

  // ---- views ----

  get agentViews(): AgentView[] {
    return this.members.map((m) => ({
      config: m.config,
      status: m.status,
      costUsd: m.costUsd,
      tokens: m.tokens,
      billing: m.billing,
      quota: m.quota,
      benched: this.benchReason(m),
      mode: this.deps.modeOf?.(m.config) ?? m.config.mode ?? 'build',
    }));
  }

  get transcript(): RoomMessage[] {
    return this.messages;
  }

  get status(): RoomStatus {
    const caps = this.deps.getCaps();
    return {
      running: this.running,
      paused: this.paused,
      round: this.round,
      maxRounds: caps.maxRounds,
      costUsd: this.totalCost,
      apiCostUsd: this.apiCost,
      tokens: this.members.reduce((t, m) => ({ input: t.input + m.tokens.input, output: t.output + m.tokens.output }), { ...NO_TOKENS }),
      billing: this.billing,
      quota: this.worstQuota,
      budgetUsd: caps.limits.allowApi ? caps.limits.apiBudgetUsd : 0,
      stopReason: this.stopReason,
    };
  }

  get snapshot(): RoomSnapshot {
    return {
      messages: this.messages.slice(-300),
      costs: Object.fromEntries(this.members.map((m) => [m.config.id, m.costUsd])),
      tokens: Object.fromEntries(this.members.map((m) => [m.config.id, m.tokens])),
      billing: Object.fromEntries(this.members.map((m) => [m.config.id, m.billing])),
    };
  }

  /** USD that will show up on a bill: agents on an API key, plus unknown ones to be safe. */
  private get apiCost(): number {
    return this.members.filter((m) => m.billing !== 'subscription').reduce((sum, m) => sum + m.costUsd, 0);
  }

  private get billing(): RoomStatus['billing'] {
    const kinds = new Set(this.members.map((m) => m.billing));
    if (kinds.size === 0) return 'unknown';
    if (kinds.has('subscription') && (kinds.has('api') || kinds.has('unknown'))) return 'mixed';
    if (kinds.has('subscription')) return 'subscription';
    if (kinds.has('api')) return 'api';
    return 'unknown';
  }

  private get worstQuota(): RoomStatus['quota'] {
    let worst: RoomStatus['quota'];
    for (const m of this.members) {
      for (const q of m.quota ?? []) {
        if (!worst || q.usedPercent > worst.usedPercent) worst = { ...q, agentName: m.config.name };
      }
    }
    return worst;
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
    this.deps.emit({ type: 'user-message' });
    for (const m of this.members) m.benchAnnounced = undefined;
    const message = this.post(USER_ID, text);
    this.turnsSinceUser = 0;
    this.consecutivePasses = 0;
    this.consecutiveErrors = 0;
    // The user's mentions outrank anything agents queued up earlier.
    this.priority = [...this.mentions(message.text, USER_ID), ...this.priority];
    this.start();
  }

  /** System messages are shown to the user but not sent to agents. */
  postSystem(text: string): void {
    this.post('system', text);
  }

  get agentConfigs(): AgentConfig[] {
    return this.roster;
  }

  /** Restart every session (e.g. guardrails changed); each resumes its own history. */
  restartAll(): void {
    for (const m of this.members) m.session.restart?.();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopRequested = true;
    this.resume();
    await this.active?.session.interrupt().catch(() => undefined);
    await this.loop;
  }

  /** Hold the debate after the current turn finishes; messages still queue. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.deps.emit({ type: 'room' });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.resumeGate?.();
    this.resumeGate = undefined;
    this.deps.emit({ type: 'room' });
  }

  /** Interrupt one agent's current turn (if speaking) and skip it for the rest of this round. */
  async skipAgent(id: string): Promise<void> {
    const member = this.members.find((m) => m.config.id === id);
    if (!member) return;
    this.priority = this.priority.filter((p) => p !== id);
    if (this.active === member) {
      member.skipRequested = true;
      await member.session.interrupt().catch(() => undefined);
    } else if (this.running) {
      member.skipRequested = true;
    }
  }

  /** Text of the last thing the user said, for retries. */
  get lastUserMessage(): string | undefined {
    return [...this.messages].reverse().find((m) => m.from === USER_ID)?.text;
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
      if (this.paused && !this.stopRequested) {
        await new Promise<void>((resolve) => (this.resumeGate = resolve));
      }
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
    if (this.members.every((m) => this.benchReason(m))) return 'all-benched';
    const limits = caps.limits;
    if (limits.allowApi && limits.apiBudgetUsd > 0 && this.apiCost >= limits.apiBudgetUsd) return 'budget';
    const tokens = this.status.tokens;
    if (limits.maxTokens > 0 && tokens.input + tokens.output >= limits.maxTokens) return 'tokens';
    if (limits.quotaStopPercent > 0 && (this.worstQuota?.usedPercent ?? 0) >= limits.quotaStopPercent) return 'quota';
    if (this.round >= caps.maxRounds) return 'max-rounds';
    return undefined;
  }

  private announceStop(reason: StopReason): void {
    const caps = this.deps.getCaps();
    if (reason === 'max-rounds') {
      this.post('system', `Round cap reached (${caps.maxRounds}). Send a message to continue.`);
    } else if (reason === 'budget') {
      this.post('system', `Room API budget reached (≈$${caps.limits.apiBudgetUsd.toFixed(2)}). Raise it in room settings or reset the room.`);
    } else if (reason === 'tokens') {
      this.post('system', `Room token cap reached (${caps.limits.maxTokens}). Raise it in room settings or reset the room.`);
    } else if (reason === 'quota') {
      this.post('system', `Plan usage passed ${caps.limits.quotaStopPercent}% of a window (${this.worstQuota?.agentName ?? 'an agent'}). The room waits until it resets; change the threshold in room settings.`);
    } else if (reason === 'all-benched') {
      this.post('system', 'Every agent is sitting out because of a limit or an unavailable provider. Check room and agent settings.');
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
    if (member.skipRequested) {
      member.skipRequested = false;
      this.consecutivePasses += 1;
      this.post('system', `${member.config.name} skipped this round.`);
      return;
    }
    const bench = this.benchReason(member);
    if (bench) {
      this.announceBench(member, bench);
      this.consecutivePasses += 1;
      this.deps.emit({ type: 'agents' });
      return;
    }
    if (!digest) {
      // Nothing new since this agent last spoke.
      this.consecutivePasses += 1;
      return;
    }
    member.cursor = this.messages.length;
    member.status = 'speaking';
    this.active = member;
    this.deps.emit({ type: 'turn-start', agentId: member.config.id });
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
    if (result.tokens) {
      member.tokens = {
        input: Math.max(member.tokens.input, result.tokens.input),
        output: Math.max(member.tokens.output, result.tokens.output),
      };
    }
    if (result.billing) member.billing = result.billing;
    if (result.quota) member.quota = result.quota;

    if (this.stopRequested) {
      member.status = 'idle';
    } else if (member.skipRequested) {
      member.skipRequested = false;
      member.status = 'idle';
      this.consecutivePasses += 1;
      this.post('system', `${member.config.name} skipped this round.`);
    } else if (result.error) {
      member.status = 'error';
      this.consecutiveErrors += 1;
      this.consecutivePasses += 1;
      this.post('system', `${member.config.name} failed: ${result.error}`);
      this.deps.emit({ type: 'turn-error', agentId: member.config.id, error: result.error });
    } else {
      member.status = 'idle';
      this.consecutiveErrors = 0;
      const reply = parseReply(result.text);
      this.deps.emit({ type: 'turn-done', agentId: member.config.id, reply });
      if (result.passed || reply.passed || !reply.text) {
        this.consecutivePasses += 1;
      } else {
        this.consecutivePasses = 0;
        const message = this.post(member.config.id, reply.text);
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
