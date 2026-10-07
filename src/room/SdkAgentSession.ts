import type {
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentConfig, BillingKind, QuotaInfo } from '../shared/protocol';
import type { AgentSession, TurnResult } from './Room';

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');

import type { SessionContext, SessionEvent, SessionGuardrails } from '../providers/types';

export type { SessionContext, SessionEvent, SessionGuardrails };

const QUOTA_WINDOWS: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: '7d Opus',
  seven_day_sonnet: '7d Sonnet',
  seven_day_overage_included: '7d incl. overage',
  overage: 'overage',
};

const ROOM_SERVER = 'room';
const PASS_TOOL = `mcp__${ROOM_SERVER}__pass_turn`;
const READ_ONLY_DENY = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'];

interface PendingTurn {
  resolve(result: TurnResult): void;
  passed: boolean;
}

/** Unbounded async queue feeding user turns into a streaming-input query(). */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | undefined;
  private closed = false;

  push(item: SDKUserMessage): void {
    if (this.waiter) {
      this.waiter({ value: item, done: false });
      this.waiter = undefined;
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.closed = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

export function buildRolePrompt(config: AgentConfig, roster: AgentConfig[], passHint = `call the ${PASS_TOOL} tool`): string {
  const others = roster
    .filter((a) => a.id !== config.id)
    .map((a) => `- ${a.name}${a.reviewer ? ' (reviewer)' : ''}: ${firstLine(a.role) || 'no stated role'}`)
    .join('\n');
  return [
    `You are ${config.name}, one participant in a group room called Roundtable, together with the user and other AI agents.`,
    others ? `Other agents in the room:\n${others}` : 'You are currently the only agent in the room.',
    'Room messages arrive as "[Name]: text". Your final reply each turn is posted to the room for everyone to read.',
    'Speak as yourself in the first person; never prefix your reply with your own name or write lines for other participants.',
    'Keep replies conversational and short (a few sentences) unless someone asks for detail. Address someone directly with @Name to give them the next turn.',
    'Engage with what others said: disagree when you disagree, build on good ideas, and do not restate points already made.',
    `If you have nothing new to add, ${passHint} instead of replying. Do not reply just to agree.`,
    'There is no interactive question tool here; ask questions in your reply.',
    config.role.trim() ? `Your role:\n${config.role.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 160) ?? '';
}

/** One long-lived Claude Agent SDK session for one room participant. */
export class SdkAgentSession implements AgentSession {
  private query: Query | undefined;
  private input: InputQueue | undefined;
  private abort: AbortController | undefined;
  private pending: PendingTurn | undefined;
  private sessionId: string | undefined;
  private lastCost = 0;
  private tokens = { input: 0, output: 0 };
  private billing: BillingKind = 'unknown';
  private quota = new Map<string, QuotaInfo>();
  private partial = '';
  private disposed = false;
  /** A config change that needs a restart arrived mid-turn. */
  private restartAfterTurn = false;
  /** What the running session was started with, to detect changes that need a restart. */
  private started: { cwd: string | undefined; prompt: string; disallowed: string } | undefined;

  constructor(
    private config: AgentConfig,
    private roster: AgentConfig[],
    private readonly ctx: SessionContext,
    private readonly sdk: Sdk,
  ) {
    this.sessionId = ctx.resumeId;
  }

  async runTurn(prompt: string): Promise<TurnResult> {
    if (this.disposed) throw new Error('session disposed');
    if (!this.query) await this.start();
    return new Promise<TurnResult>((resolve) => {
      this.pending = { resolve, passed: false };
      this.partial = '';
      this.input?.push({
        type: 'user',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
      });
    });
  }

  async interrupt(): Promise<void> {
    if (this.pending) await this.query?.interrupt();
  }

  async applyConfig(next: AgentConfig, roster: AgentConfig[]): Promise<void> {
    const prev = this.config;
    this.config = next;
    this.roster = roster;
    if (!this.query || !this.started) return;

    const cwd = this.started.cwd;
    const prompt = await this.fullPrompt(next, roster, cwd);
    const disallowed = this.disallowed(next, roster, cwd).join();
    const needsRestart =
      prompt !== this.started.prompt ||
      disallowed !== this.started.disallowed ||
      prev.workspaceMode !== next.workspaceMode ||
      prev.allowedTools.join() !== next.allowedTools.join();
    if (needsRestart) {
      this.restart();
      return;
    }
    if (prev.model !== next.model) await this.query.setModel(next.model);
    if (prev.permissionMode !== next.permissionMode) await this.query.setPermissionMode(next.permissionMode);
    if (prev.effort !== next.effort) await this.query.applyFlagSettings({ effortLevel: next.effort });
  }

  /** Restart lazily on the next turn (or right away when idle), resuming the same session id. */
  restart(): void {
    if (!this.query) return;
    if (this.pending) this.restartAfterTurn = true;
    else this.shutdown();
  }

  forget(): void {
    this.sessionId = undefined;
    this.shutdown();
  }

  dispose(): void {
    this.disposed = true;
    this.shutdown();
  }

  private shutdown(): void {
    this.input?.close();
    this.abort?.abort();
    this.query = undefined;
    this.input = undefined;
    this.abort = undefined;
    this.started = undefined;
    this.finishTurn({ error: 'session closed' });
  }

  private async fullPrompt(config: AgentConfig, roster: AgentConfig[], cwd: string | undefined): Promise<string> {
    const role = buildRolePrompt(config, roster);
    const extra = cwd && this.ctx.guardrails ? await this.ctx.guardrails.buildPrompt(config, roster, cwd) : '';
    return extra ? `${role}\n\n${extra}` : role;
  }

  private disallowed(config: AgentConfig, roster: AgentConfig[], cwd: string | undefined): string[] {
    const list = ['AskUserQuestion', ...config.disallowedTools];
    if (config.workspaceMode === 'read-only') list.push(...READ_ONLY_DENY);
    if (cwd && this.ctx.guardrails) list.push(...this.ctx.guardrails.buildDisallowed(config, roster, cwd));
    return [...new Set(list)];
  }

  private async start(): Promise<void> {
    const sdk = this.sdk;
    const config = this.config;
    const roster = this.roster;
    const cwd = await this.ctx.resolveCwd(config);
    const guardrails = cwd ? this.ctx.guardrails : undefined;

    const toolSpecs = guardrails && cwd ? guardrails.buildTools(config, roster, cwd) : [];
    const roomServer = sdk.createSdkMcpServer({
      name: ROOM_SERVER,
      version: '1.0.0',
      tools: [
        sdk.tool(
          'pass_turn',
          'Pass your turn: you have nothing new to add to the room right now.',
          {},
          async () => {
            if (this.pending) this.pending.passed = true;
            return { content: [{ type: 'text', text: 'Turn passed. End your turn now without further text.' }] };
          },
          // Keep the tool in the prompt so agents need no tool search to pass.
          { alwaysLoad: true },
        ),
        ...toolSpecs.map((spec) =>
          sdk.tool(
            spec.name,
            spec.description,
            spec.schema,
            async (args) => ({ content: [{ type: 'text', text: await spec.handler(args as Record<string, unknown>) }] }),
            { alwaysLoad: true },
          ),
        ),
      ],
    });

    const prompt = await this.fullPrompt(config, roster, cwd);
    const disallowed = this.disallowed(config, roster, cwd);
    this.started = { cwd, prompt, disallowed: disallowed.join() };

    const options: Options = {
      model: config.model,
      effort: config.effort,
      permissionMode: config.permissionMode,
      // snapshot: false so edits to the role, roster or guardrails apply when the session resumes.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: prompt, snapshot: false },
      allowedTools: [PASS_TOOL, ...toolSpecs.map((t) => `mcp__${ROOM_SERVER}__${t.name}`), ...config.allowedTools],
      disallowedTools: disallowed,
      mcpServers: { [ROOM_SERVER]: roomServer },
      hooks: guardrails && cwd ? guardrails.buildHooks(config, roster, cwd) : undefined,
      // Project settings only: load the workspace CLAUDE.md, but keep the
      // user's personal plugins and hooks out of room agents.
      settingSources: ['project'],
      includePartialMessages: true,
      cwd,
      env: this.ctx.env,
      pathToClaudeCodeExecutable: this.ctx.claudePath,
      resume: this.sessionId,
      abortController: (this.abort = new AbortController()),
      canUseTool: (toolName, input, opts) => this.canUseTool(toolName, input, opts.signal, opts.suggestions),
    };

    this.input = new InputQueue();
    this.query = sdk.query({ prompt: this.input, options });
    void this.pump(this.query);
  }

  private async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    suggestions: PermissionUpdate[] | undefined,
  ): Promise<PermissionResult> {
    if (toolName.startsWith(`mcp__${ROOM_SERVER}__`)) return { behavior: 'allow', updatedInput: input };
    const canAlways = !!suggestions && suggestions.length > 0;
    const decision = await this.ctx.requestPermission(toolName, input, canAlways, signal);
    if (decision === 'deny') {
      return { behavior: 'deny', message: 'The user denied this action. Do not retry it; say what you wanted to do instead.' };
    }
    return {
      behavior: 'allow',
      updatedInput: input,
      updatedPermissions: decision === 'always' ? suggestions : undefined,
    };
  }

  private async pump(query: Query): Promise<void> {
    try {
      for await (const message of query) {
        if (query !== this.query) return;
        this.handle(message);
      }
      if (query === this.query) this.crashed('session ended unexpectedly');
    } catch (err) {
      if (query === this.query) this.crashed(err instanceof Error ? err.message : String(err));
    }
  }

  private crashed(reason: string): void {
    this.query = undefined;
    this.input = undefined;
    this.started = undefined;
    this.finishTurn({ error: reason });
  }

  private handle(m: SDKMessage): void {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.sessionId = m.session_id;
          // 'none' means no API key: the claude.ai OAuth login (a subscription) is in use.
          this.billing = m.apiKeySource === 'none' ? 'subscription' : 'api';
          this.ctx.onEvent({ type: 'started', sessionId: m.session_id, model: m.model, apiKeySource: m.apiKeySource });
        }
        break;
      case 'rate_limit_event': {
        const info = m.rate_limit_info;
        if (typeof info.utilization !== 'number') break;
        const used = info.utilization <= 1 ? info.utilization * 100 : info.utilization;
        const resetsAt = info.resetsAt ? (info.resetsAt > 1e12 ? info.resetsAt : info.resetsAt * 1000) : undefined;
        const window = QUOTA_WINDOWS[info.rateLimitType ?? ''] ?? info.rateLimitType ?? 'window';
        this.quota.set(window, { window, usedPercent: Math.round(used), resetsAt });
        break;
      }
      case 'stream_event': {
        if (m.parent_tool_use_id !== null) break;
        const event = m.event;
        if (event.type === 'message_start') {
          // Show only the latest assistant message of the turn while streaming.
          this.partial = '';
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          this.partial += event.delta.text;
          this.ctx.onEvent({ type: 'partial', text: this.partial });
        }
        break;
      }
      case 'assistant':
        if (m.parent_tool_use_id !== null) break;
        for (const block of m.message.content) {
          if (block.type === 'tool_use' && block.name !== PASS_TOOL) {
            this.ctx.onEvent({ type: 'activity', text: describeToolUse(block.name, block.input) });
          }
        }
        break;
      case 'result':
        this.lastCost = m.total_cost_usd;
        // usage is per turn in streaming sessions; keep a running total for the room.
        this.tokens = {
          input: this.tokens.input + (m.usage?.input_tokens ?? 0) + (m.usage?.cache_read_input_tokens ?? 0) + (m.usage?.cache_creation_input_tokens ?? 0),
          output: this.tokens.output + (m.usage?.output_tokens ?? 0),
        };
        if (m.subtype === 'success' && !m.is_error) {
          this.finishTurn({ text: m.result });
        } else {
          this.finishTurn({ error: explainError(m.subtype === 'success' ? m.result || 'request failed' : m.subtype) });
        }
        break;
    }
  }

  private finishTurn(outcome: { text?: string; error?: string }): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.resolve({
      text: outcome.text ?? '',
      passed: pending.passed,
      costUsd: this.lastCost,
      tokens: this.tokens,
      billing: this.billing,
      quota: this.quota.size > 0 ? [...this.quota.values()] : undefined,
      error: outcome.error,
    });
    if (this.restartAfterTurn) {
      this.restartAfterTurn = false;
      this.shutdown();
    }
  }
}

/** Turn vendor error text into something the user can act on. */
export function explainError(text: string): string {
  if (/OAuth session expired|Failed to authenticate|not logged in|Invalid authentication/i.test(text)) {
    return `${text} — your Claude Code login has expired. Run \`claude\` in a terminal and type /login, then send another message.`;
  }
  if (/error_max_budget_usd/.test(text)) return 'Session budget exhausted (error_max_budget_usd).';
  return text;
}

/** One-line description of a tool call for the activity line and permission prompts. */
export function describeToolUse(name: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  const detail =
    pickString(obj, ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) ??
    JSON.stringify(obj);
  const short = detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
  return short && short !== '{}' ? `${name}: ${short}` : name;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}
