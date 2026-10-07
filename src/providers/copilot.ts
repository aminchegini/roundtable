import type { CopilotClient, CopilotSession, PermissionRequest, PermissionRequestResult, SessionConfig } from '@github/copilot-sdk';
import type { AgentSession, TurnResult } from '../room/Room';
import type { AgentConfig, ModelOption, Tokens } from '../shared/protocol';
import { WRITE_TOOL, addTokens, buildFullPrompt, editedPathsFrom, errorMessage } from './shared';
import type { Provider, SessionContext } from './types';

type CopilotModule = typeof import('@github/copilot-sdk');
let modulePromise: Promise<CopilotModule> | undefined;
const loadModule = () => (modulePromise ??= import('@github/copilot-sdk'));

/** One runtime process for the whole extension; sessions are cheap. */
let clientPromise: Promise<CopilotClient> | undefined;
async function client(): Promise<CopilotClient> {
  clientPromise ??= loadModule().then(async ({ CopilotClient: Ctor }) => {
    const c = new Ctor({});
    await c.start();
    return c;
  });
  return clientPromise;
}

const EFFORTS: Record<AgentConfig['effort'], string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };

/** Copilot SDK session: in-process permission and PreToolUse hooks, so guardrails are fully enforced. */
export class CopilotAgentSession implements AgentSession {
  private session: CopilotSession | undefined;
  private sessionId: string | undefined;
  private primed: boolean;
  private tokens: Tokens = { input: 0, output: 0 };
  private disposed = false;
  private recreate = false;
  private cwd: string | undefined;

  constructor(
    private config: AgentConfig,
    private roster: AgentConfig[],
    private readonly ctx: SessionContext,
  ) {
    this.sessionId = ctx.resumeId;
    this.primed = !!ctx.resumeId;
  }

  async runTurn(digest: string): Promise<TurnResult> {
    if (this.disposed) throw new Error('session disposed');
    let session: CopilotSession;
    try {
      session = await this.ensureSession();
    } catch (err) {
      return { text: '', passed: false, costUsd: 0, error: `Copilot: ${errorMessage(err)}` };
    }
    const input = this.primed ? digest : `${await buildFullPrompt(this.config, this.roster, this.cwd, this.ctx)}\n\n---\n\n${digest}`;
    this.primed = true;

    return new Promise<TurnResult>((resolve) => {
      let text = '';
      let streamed = '';
      let error: string | undefined;
      const offs: Array<() => void> = [];
      const done = () => {
        offs.forEach((off) => off());
        resolve({ text: text || streamed, passed: false, costUsd: 0, tokens: this.tokens, error });
      };
      offs.push(
        session.on('assistant.message_delta', (e) => {
          streamed += e.data.deltaContent;
          this.ctx.onEvent({ type: 'partial', text: streamed });
        }),
        session.on('assistant.message', (e) => {
          text = e.data.content;
        }),
        session.on('tool.execution_start', (e) => {
          const d = e.data as { toolName?: string; arguments?: unknown };
          const name = d.toolName ?? 'tool';
          this.ctx.onEvent({ type: 'activity', text: `${name}: ${JSON.stringify(d.arguments ?? {}).slice(0, 160)}` });
        }),
        session.on('assistant.usage', (e) => {
          this.tokens = addTokens(this.tokens, e.data.inputTokens, e.data.outputTokens);
        }),
        session.on('session.error', (e) => {
          error = String((e.data as { message?: string }).message ?? 'session error');
        }),
        session.on('session.idle', done),
      );
      session.send({ prompt: input }).catch((err) => {
        error = errorMessage(err);
        done();
      });
    });
  }

  private async ensureSession(): Promise<CopilotSession> {
    if (this.session && !this.recreate) return this.session;
    this.recreate = false;
    this.cwd = await this.ctx.resolveCwd(this.config);
    const c = await client();
    const config = this.sessionConfig();
    this.session = this.sessionId ? await c.resumeSession(this.sessionId, config) : await c.createSession(config);
    if (this.session.sessionId !== this.sessionId) {
      this.sessionId = this.session.sessionId;
      this.ctx.onEvent({ type: 'started', sessionId: this.sessionId, model: this.config.model, apiKeySource: 'github login' });
    }
    return this.session;
  }

  private sessionConfig(): SessionConfig {
    const cwd = this.cwd;
    const agent = this.config;
    const readOnly = agent.workspaceMode === 'read-only';
    return {
      model: agent.model === 'auto' ? undefined : agent.model,
      reasoningEffort: EFFORTS[agent.effort] as SessionConfig['reasoningEffort'],
      workingDirectory: cwd,
      streaming: true,
      excludedTools: readOnly ? ['edit', 'create', 'write', 'bash', 'shell'] : undefined,
      onPermissionRequest: (request) => this.permission(request),
      hooks: {
        onPreToolUse: async (input) => {
          if (cwd && this.ctx.guardrails) {
            const reason = await this.ctx.guardrails.preToolUse(agent, this.roster, cwd, input.toolName, input.toolArgs);
            if (reason) return { permissionDecision: 'deny', permissionDecisionReason: reason };
          }
          return undefined;
        },
        onPostToolUse: async (input) => {
          if (cwd && WRITE_TOOL.test(input.toolName)) for (const p of editedPathsFrom(input.toolArgs)) this.ctx.guardrails?.noteEdit(agent.id, cwd, p);
          return undefined;
        },
      },
    };
  }

  private async permission(request: PermissionRequest): Promise<PermissionRequestResult> {
    const mode = this.config.permissionMode;
    const kind = (request as { kind?: string }).kind ?? 'tool';
    if (mode === 'auto' || (mode === 'acceptEdits' && (kind === 'write' || kind === 'read'))) return { kind: 'approve-once' };
    if (mode === 'dontAsk' || mode === 'plan') return { kind: 'reject', feedback: 'Not allowed in this mode.' };
    const decision = await this.ctx.requestPermission(kind, request as unknown as Record<string, unknown>, false, new AbortController().signal);
    return decision === 'deny' ? { kind: 'reject', feedback: 'The user denied this action.' } : { kind: 'approve-once', approvedInteractively: true };
  }

  async interrupt(): Promise<void> {
    await this.session?.abort().catch(() => undefined);
  }

  async applyConfig(next: AgentConfig, roster: AgentConfig[]): Promise<void> {
    const prev = this.config;
    this.config = next;
    this.roster = roster;
    if (this.session && prev.model !== next.model) await this.session.setModel(next.model).catch(() => (this.recreate = true));
    if (prev.workspaceMode !== next.workspaceMode || prev.effort !== next.effort) this.recreate = true;
    if (prev.role !== next.role || prev.name !== next.name) this.primed = false;
  }

  restart(): void {
    this.recreate = true;
    this.primed = false;
  }

  dispose(): void {
    this.disposed = true;
    void this.session?.abort().catch(() => undefined);
  }
}

export const copilotProvider: Provider = {
  id: 'copilot',
  title: 'Copilot',
  vendor: 'GitHub',
  enforcement: 'full',
  costUsd: false,
  loginCommand: 'copilot login || gh auth login',
  defaultModel: 'auto',
  staticModels: [{ id: 'auto', label: 'auto' }],
  async detect(env) {
    const token = env.COPILOT_GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN;
    try {
      const c = await Promise.race([client(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('runtime start timed out')), 20_000))]);
      const status = await c.getAuthStatus();
      let models: ModelOption[] | undefined;
      if (status.isAuthenticated) {
        models = (await c.listModels().catch(() => [])).map((m) => ({ id: m.id, label: m.name || m.id }));
      }
      return {
        installed: true,
        authenticated: status.isAuthenticated,
        detail: status.isAuthenticated ? `GitHub login${status.login ? ` as ${status.login}` : ''} (${status.authType ?? 'user'})` : (status.statusMessage ?? 'not signed in'),
        setupHint: 'Install GitHub Copilot CLI (npm i -g @github/copilot) and run `copilot login`, or set COPILOT_GITHUB_TOKEN. Requires a Copilot subscription.',
        models,
      };
    } catch (err) {
      return {
        installed: true,
        authenticated: token ? 'unknown' : false,
        detail: `Copilot runtime unavailable: ${errorMessage(err)}`,
        setupHint: 'Run `copilot login` or set COPILOT_GITHUB_TOKEN. Requires a Copilot subscription.',
      };
    }
  },
  createSession(agent, roster, ctx) {
    return new CopilotAgentSession(agent, roster, ctx);
  },
};
