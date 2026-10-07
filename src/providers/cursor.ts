import type { AgentSession, TurnResult } from '../room/Room';
import type { AgentConfig, InteractionMode, ModelOption } from '../shared/protocol';
import { WRITE_TOOL, buildFullPrompt, currentMode, editedPathsFrom, primedInput, spawnJsonl } from './shared';
import { findCli } from './cli';
import type { Provider, SessionContext } from './types';
import { execFile } from 'node:child_process';

export interface CursorAcc {
  text: string;
  streamed: string;
  error?: string;
}

export interface CursorHooks {
  started(sessionId: string, model: string): void;
  partial(text: string): void;
  activity(text: string): void;
  edited(file: string): void;
}

/** Apply one Cursor stream-json event. */
export function applyCursorEvent(acc: CursorAcc, event: Record<string, unknown>, hooks: CursorHooks): void {
  const type = event.type as string;
  if (type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
    hooks.started(event.session_id, String(event.model ?? ''));
  } else if (type === 'assistant') {
    const content = (event.message as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
    acc.streamed += content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    hooks.partial(acc.streamed);
  } else if (type === 'tool_call' && event.subtype === 'started') {
    const call = (event.tool_call ?? event) as Record<string, unknown>;
    const name = String(call.name ?? call.tool ?? 'tool');
    hooks.activity(name);
    if (WRITE_TOOL.test(name)) for (const p of editedPathsFrom(call.args ?? call.input)) hooks.edited(p);
  } else if (type === 'result') {
    acc.text = typeof event.result === 'string' ? event.result : acc.streamed;
    if (event.is_error) acc.error = acc.text || 'agent reported an error';
  }
}

/** Cursor has native ask and plan modes. */
export function cursorModeArgs(workspaceMode: AgentConfig['workspaceMode'], permissionMode: AgentConfig['permissionMode'], mode: InteractionMode): string[] {
  if (mode === 'ask') return ['--mode', 'ask'];
  if (mode === 'plan') return ['--mode', 'plan'];
  if (workspaceMode === 'read-only') return ['--mode', 'ask'];
  return permissionMode === 'acceptEdits' || permissionMode === 'auto' ? ['--force'] : [];
}

/** One `agent -p` process per turn, chained with `--resume <chatId>`. Experimental: output format is vendor-controlled. */
export class CursorAgentSession implements AgentSession {
  private sessionId: string | undefined;
  private primed: boolean;
  private abort: AbortController | undefined;
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
    const bin = this.ctx.cliPath ?? findCli({ names: ['agent', 'cursor-agent'] });
    if (!bin) return { text: '', passed: false, costUsd: 0, error: 'Cursor agent CLI not installed' };
    const cwd = await this.ctx.resolveCwd(this.config);
    const input = this.primed ? digest : primedInput(await buildFullPrompt(this.config, this.roster, cwd, this.ctx), digest);
    this.primed = true;

    const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust', '--model', this.config.model];
    if (cwd) args.push('--workspace', cwd);
    args.push(...cursorModeArgs(this.config.workspaceMode, this.config.permissionMode, currentMode(this.ctx, this.config)));
    if (this.sessionId) args.push('--resume', this.sessionId);
    args.push(input);

    this.abort = new AbortController();
    const acc: CursorAcc = { text: '', streamed: '' };
    const result = await spawnJsonl(bin, args, {
      cwd,
      env: this.ctx.env,
      signal: this.abort.signal,
      onLine: (event) =>
        applyCursorEvent(acc, event, {
          started: (id, model) => {
            if (id !== this.sessionId) {
              this.sessionId = id;
              this.ctx.onEvent({ type: 'started', sessionId: id, model, apiKeySource: 'cursor login' });
            }
          },
          partial: (t) => this.ctx.onEvent({ type: 'partial', text: t }),
          activity: (t) => this.ctx.onEvent({ type: 'activity', text: t }),
          edited: (file) => cwd && this.ctx.guardrails?.noteEdit(this.config.id, cwd, file),
        }),
    });
    this.abort = undefined;
    const text = acc.text || acc.streamed;
    let error = acc.error;
    if (result.aborted) error = 'interrupted';
    else if (result.code !== 0 && !error) error = result.stderr.split('\n').slice(-3).join(' ') || `agent exited with ${result.code}`;
    return { text, passed: false, costUsd: 0, billing: this.ctx.env.CURSOR_API_KEY ? 'api' : 'subscription', error };
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

function listModels(bin: string): Promise<{ ok: boolean; models: ModelOption[]; output: string }> {
  return new Promise((resolve) => {
    execFile(bin, ['--list-models'], { timeout: 15_000 }, (err, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`.trim();
      if (err || /no models available/i.test(output)) return resolve({ ok: false, models: [], output });
      const models = output
        .split('\n')
        .map((l) => l.trim().replace(/^[-*•]\s*/, '').split(/\s+/)[0] ?? '')
        .filter((m) => /^[a-z0-9][a-z0-9.-]*$/i.test(m))
        .map((id) => ({ id, label: id }));
      resolve({ ok: true, models, output });
    });
  });
}

export const cursorProvider: Provider = {
  id: 'cursor',
  title: 'Cursor agent',
  vendor: 'Cursor',
  enforcement: 'gates',
  costUsd: false,
  experimental: true,
  loginCommand: 'agent login',
  installCommand: 'curl https://cursor.com/install -fsSL | bash',
  defaultModel: 'sonnet-4.5',
  staticModels: [
    { id: 'sonnet-4.5', label: 'sonnet-4.5' },
    { id: 'gpt-5', label: 'gpt-5' },
    { id: 'auto', label: 'auto' },
  ],
  async detect(env, configuredPath) {
    const bin = findCli({ names: ['agent', 'cursor-agent'], configured: configuredPath });
    if (!bin) {
      return { installed: false, authenticated: false, detail: 'Cursor agent CLI not installed', setupHint: 'Install with `curl https://cursor.com/install -fsSL | bash`, then run `agent login`.' };
    }
    if (env.CURSOR_API_KEY) return { installed: true, cliPath: bin, authenticated: true, detail: 'API key from environment', setupHint: '' };
    const { ok, models } = await listModels(bin);
    return {
      installed: true,
      cliPath: bin,
      authenticated: ok,
      detail: ok ? `signed in, ${models.length} models` : 'installed, not signed in',
      setupHint: 'Run `agent login` in a terminal, or set CURSOR_API_KEY.',
      models: ok ? models : undefined,
    };
  },
  createSession(agent, roster, ctx) {
    return new CursorAgentSession(agent, roster, ctx);
  },
};
