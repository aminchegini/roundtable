import * as fs from 'node:fs';
import type { Codex, ModelReasoningEffort, Thread, ThreadEvent, ThreadOptions } from '@openai/codex-sdk';
import type { AgentSession, TurnResult } from '../room/Room';
import type { AgentConfig, Tokens } from '../shared/protocol';
import { addTokens, buildFullPrompt, errorMessage, exists, home, isResumeError, primedInput } from './shared';
import type { Provider, SessionContext } from './types';

type CodexModule = typeof import('@openai/codex-sdk');
let modulePromise: Promise<CodexModule> | undefined;
const loadCodex = () => (modulePromise ??= import('@openai/codex-sdk'));

const EFFORTS: Record<AgentConfig['effort'], ModelReasoningEffort> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };

/** One Codex thread per (room, agent). Instructions go in the first message; the thread id is kept for resume. */
export class CodexAgentSession implements AgentSession {
  private thread: Thread | undefined;
  private threadId: string | undefined;
  private primed = false;
  private abort: AbortController | undefined;
  private tokens: Tokens = { input: 0, output: 0 };
  private disposed = false;
  private recreate = false;

  constructor(
    private config: AgentConfig,
    private roster: AgentConfig[],
    private readonly ctx: SessionContext,
  ) {
    this.threadId = ctx.resumeId;
    // A resumed thread already has its instructions in history.
    this.primed = !!ctx.resumeId;
  }

  async runTurn(digest: string): Promise<TurnResult> {
    const result = await this.runOnce(digest);
    if (result.error && this.threadId && isResumeError(result.error)) {
      // The stored thread id has no session on disk (a crashed earlier turn, or
      // Codex pruned it). Forget it and start over once, re-sending the instructions.
      this.ctx.onEvent({ type: 'activity', text: 'previous Codex thread not found; starting a fresh one' });
      this.threadId = undefined;
      this.thread = undefined;
      this.primed = false;
      return this.runOnce(digest);
    }
    return result;
  }

  private async runOnce(digest: string): Promise<TurnResult> {
    if (this.disposed) throw new Error('session disposed');
    const cwd = await this.ctx.resolveCwd(this.config);
    const thread = await this.ensureThread(cwd);
    const input = this.primed ? digest : primedInput(await buildFullPrompt(this.config, this.roster, cwd, this.ctx), digest);
    this.primed = true;

    this.abort = new AbortController();
    let text = '';
    let error: string | undefined;
    // `error` events also fire while Codex retries ("Reconnecting… 3/5"); only a
    // failed or missing turn.completed makes the turn an error.
    let lastError: string | undefined;
    let completed = false;
    try {
      const { events } = await thread.runStreamed(input, { signal: this.abort.signal });
      for await (const event of events) {
        if (event.type === 'turn.completed') completed = true;
        if (event.type === 'turn.failed') error = event.error.message;
        text = this.handle(event, text, cwd, (e) => (lastError = e));
      }
      if (!completed && !error) error = lastError ?? 'Codex ended the turn without completing it';
    } catch (err) {
      error = this.abort.signal.aborted ? 'interrupted' : errorMessage(err);
    } finally {
      this.abort = undefined;
    }
    if (thread.id && thread.id !== this.threadId) {
      this.threadId = thread.id;
      this.ctx.onEvent({ type: 'started', sessionId: thread.id, model: this.config.model, apiKeySource: 'codex login' });
    }
    return { text, passed: false, costUsd: 0, tokens: this.tokens, billing: this.ctx.env.CODEX_API_KEY ? 'api' : 'subscription', error };
  }

  private handle(event: ThreadEvent, text: string, cwd: string | undefined, fail: (e: string) => void): string {
    switch (event.type) {
      case 'item.updated':
      case 'item.completed': {
        const item = event.item;
        if (item.type === 'agent_message') {
          this.ctx.onEvent({ type: 'partial', text: item.text });
          return item.text;
        }
        if (event.type === 'item.completed') {
          if (item.type === 'command_execution') this.ctx.onEvent({ type: 'activity', text: `Shell: ${item.command.slice(0, 200)}` });
          if (item.type === 'file_change') {
            for (const change of item.changes) {
              this.ctx.onEvent({ type: 'activity', text: `${change.kind}: ${change.path}` });
              if (cwd) this.ctx.guardrails?.noteEdit(this.config.id, cwd, change.path);
            }
          }
          if (item.type === 'mcp_tool_call') this.ctx.onEvent({ type: 'activity', text: `${item.server}/${item.tool}` });
          if (item.type === 'web_search') this.ctx.onEvent({ type: 'activity', text: `Web search: ${item.query}` });
          if (item.type === 'error') fail(item.message);
        }
        return text;
      }
      case 'turn.completed':
        this.tokens = addTokens(this.tokens, event.usage.input_tokens, event.usage.output_tokens + event.usage.reasoning_output_tokens);
        return text;
      case 'turn.failed':
        return text;
      case 'error':
        fail(event.message);
        this.ctx.onEvent({ type: 'activity', text: event.message.slice(0, 160) });
        return text;
      default:
        return text;
    }
  }

  private async ensureThread(cwd: string | undefined): Promise<Thread> {
    if (this.thread && !this.recreate) return this.thread;
    this.recreate = false;
    const { Codex: CodexCtor } = await loadCodex();
    const codex: Codex = new CodexCtor({ env: cleanEnv(this.ctx.env) });
    const options = this.threadOptions(cwd);
    this.thread = this.threadId ? codex.resumeThread(this.threadId, options) : codex.startThread(options);
    return this.thread;
  }

  private threadOptions(cwd: string | undefined): ThreadOptions {
    const c = this.config;
    return {
      model: c.model,
      modelReasoningEffort: EFFORTS[c.effort],
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      sandboxMode: c.workspaceMode === 'read-only' ? 'read-only' : 'workspace-write',
      // codex exec is non-interactive; approvals cannot be routed to the room.
      approvalPolicy: 'never',
    };
  }

  async interrupt(): Promise<void> {
    this.abort?.abort();
  }

  async applyConfig(next: AgentConfig, roster: AgentConfig[]): Promise<void> {
    const prev = this.config;
    this.config = next;
    this.roster = roster;
    if (prev.model !== next.model || prev.effort !== next.effort || prev.workspaceMode !== next.workspaceMode) this.recreate = true;
    if (prev.role !== next.role || prev.name !== next.name || roster.length !== this.roster.length) this.primed = false;
  }

  restart(): void {
    this.recreate = true;
    this.primed = false;
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
  }
}

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

function configuredModel(): string | undefined {
  try {
    const toml = fs.readFileSync(home('.codex', 'config.toml'), 'utf8');
    return /^model\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  } catch {
    return undefined;
  }
}

export const codexProvider: Provider = {
  id: 'codex',
  title: 'Codex',
  vendor: 'OpenAI',
  enforcement: 'gates',
  costUsd: false,
  loginCommand: 'codex login',
  defaultModel: configuredModel() ?? 'gpt-6-astra',
  staticModels: [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
  ],
  async detect(env) {
    const auth = exists(home('.codex', 'auth.json'));
    const apiKey = !!env.CODEX_API_KEY;
    const model = configuredModel();
    return {
      installed: true,
      authenticated: auth || apiKey,
      detail: apiKey ? 'API key from environment' : auth ? `ChatGPT login (~/.codex)${model ? `, default model ${model}` : ''}` : 'not signed in',
      setupHint: 'Install the Codex CLI (npm i -g @openai/codex) and run `codex login`, or set CODEX_API_KEY.',
      models: model && !['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.5'].includes(model) ? [{ id: model, label: model }] : undefined,
    };
  },
  createSession(agent, roster, ctx) {
    return new CodexAgentSession(agent, roster, ctx);
  },
};
