import type { AgentSession, TurnResult } from '../room/Room';
import type { AgentConfig, InteractionMode, Tokens } from '../shared/protocol';
import { WRITE_TOOL, addTokens, buildFullPrompt, currentMode, editedPathsFrom, exists, findBin, home, primedInput, spawnJsonl } from './shared';
import type { Provider, SessionContext } from './types';

export interface TurnAcc {
  text: string;
  error?: string;
}

export interface TurnHooks {
  started(sessionId: string, model: string): void;
  partial(text: string): void;
  activity(text: string): void;
  edited(file: string): void;
}

/** Apply one Gemini stream-json event; returns tokens to add. */
export function applyGeminiEvent(acc: TurnAcc, event: Record<string, unknown>, hooks: TurnHooks): { input?: number; output?: number } {
  const type = event.type as string;
  if (type === 'init' && typeof event.session_id === 'string') {
    hooks.started(event.session_id, String(event.model ?? ''));
  } else if (type === 'message' && event.role === 'assistant' && typeof event.content === 'string') {
    acc.text = event.delta ? acc.text + event.content : event.content;
    hooks.partial(acc.text);
  } else if (type === 'tool_use') {
    const name = String(event.tool_name ?? 'tool');
    hooks.activity(`${name}: ${JSON.stringify(event.parameters ?? {}).slice(0, 160)}`);
    if (WRITE_TOOL.test(name)) for (const p of editedPathsFrom(event.parameters)) hooks.edited(p);
  } else if (type === 'error' && event.severity === 'error') {
    acc.error = String(event.message ?? 'error');
  } else if (type === 'result') {
    const stats = (event.stats ?? {}) as Record<string, number>;
    if (event.status && event.status !== 'success' && !acc.error) acc.error = String(event.status);
    return { input: stats.input_tokens, output: stats.output_tokens };
  }
  return {};
}

const APPROVAL: Record<AgentConfig['permissionMode'], string> = {
  default: 'default',
  acceptEdits: 'auto_edit',
  auto: 'yolo',
  dontAsk: 'default',
  plan: 'plan',
};

/** Ask and plan both map to Gemini's plan approval mode (read-only). */
export function geminiApprovalMode(workspaceMode: AgentConfig['workspaceMode'], permissionMode: AgentConfig['permissionMode'], mode: InteractionMode): string {
  return workspaceMode === 'read-only' || mode !== 'build' ? 'plan' : APPROVAL[permissionMode];
}

/** One `gemini -p` process per turn, chained with `--resume <session_id>`. */
export class GeminiAgentSession implements AgentSession {
  private sessionId: string | undefined;
  private primed: boolean;
  private abort: AbortController | undefined;
  private tokens: Tokens = { input: 0, output: 0 };
  private disposed = false;

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
    const bin = findBin('gemini');
    if (!bin) return { text: '', passed: false, costUsd: 0, error: 'Gemini CLI not installed (npm i -g @google/gemini-cli)' };
    const cwd = await this.ctx.resolveCwd(this.config);
    const input = this.primed ? digest : primedInput(await buildFullPrompt(this.config, this.roster, cwd, this.ctx), digest);
    this.primed = true;

    const mode = geminiApprovalMode(this.config.workspaceMode, this.config.permissionMode, currentMode(this.ctx, this.config));
    const args = ['-p', input, '-o', 'stream-json', '--approval-mode', mode, '-m', this.config.model];
    if (this.sessionId) args.push('-r', this.sessionId);

    this.abort = new AbortController();
    const acc: TurnAcc = { text: '' };
    const result = await spawnJsonl(bin, args, {
      cwd,
      env: this.ctx.env,
      signal: this.abort.signal,
      onLine: (event) => {
        const out = applyGeminiEvent(acc, event, {
          started: (id, model) => {
            if (id !== this.sessionId) {
              this.sessionId = id;
              this.ctx.onEvent({ type: 'started', sessionId: id, model, apiKeySource: 'gemini login' });
            }
          },
          partial: (t) => this.ctx.onEvent({ type: 'partial', text: t }),
          activity: (t) => this.ctx.onEvent({ type: 'activity', text: t }),
          edited: (file) => cwd && this.ctx.guardrails?.noteEdit(this.config.id, cwd, file),
        });
        this.tokens = addTokens(this.tokens, out.input, out.output);
      },
    });
    this.abort = undefined;
    if (result.aborted) acc.error = 'interrupted';
    else if (result.code !== 0 && !acc.error) acc.error = result.stderr.split('\n').slice(-3).join(' ') || `gemini exited with ${result.code}`;
    return { text: acc.text, passed: false, costUsd: 0, tokens: this.tokens, billing: this.ctx.env.GEMINI_API_KEY || this.ctx.env.GOOGLE_API_KEY ? 'api' : 'subscription', error: acc.error };
  }

  async interrupt(): Promise<void> {
    this.abort?.abort();
  }

  async applyConfig(next: AgentConfig, roster: AgentConfig[]): Promise<void> {
    if (next.role !== this.config.role || next.name !== this.config.name) this.primed = false;
    this.config = next;
    this.roster = roster;
  }

  restart(): void {
    this.primed = false;
  }

  forget(): void {
    this.sessionId = undefined;
    this.primed = false;
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
  }
}

export const geminiProvider: Provider = {
  id: 'gemini',
  title: 'Gemini',
  vendor: 'Google',
  enforcement: 'gates',
  costUsd: false,
  loginCommand: 'gemini',
  defaultModel: 'gemini-3-pro-preview',
  staticModels: [
    { id: 'auto', label: 'auto' },
    { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro' },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
  async detect(env) {
    const bin = findBin('gemini');
    const oauth = exists(home('.gemini', 'oauth_creds.json'));
    const apiKey = !!(env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY);
    return {
      installed: !!bin,
      authenticated: !bin ? false : oauth || apiKey ? true : 'unknown',
      detail: !bin ? 'Gemini CLI not installed' : apiKey ? 'API key from environment' : oauth ? 'Google login (~/.gemini)' : 'installed, login unknown',
      setupHint: 'Install Gemini CLI (npm i -g @google/gemini-cli) and run `gemini` once to sign in, or set GEMINI_API_KEY.',
    };
  },
  createSession(agent, roster, ctx) {
    return new GeminiAgentSession(agent, roster, ctx);
  },
};
