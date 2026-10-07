import { readFileSync } from 'node:fs';
import { SdkAgentSession } from '../room/SdkAgentSession';
import { MODELS } from '../shared/protocol';
import { findCli } from './cli';
import { exists, home } from './shared';
import type { Provider } from './types';
import { loadVendor } from './vendorLoader';

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');

const loadSdk = () => loadVendor<Sdk>('claude');

/**
 * Defers both the vendor bundle import and the SDK session until the first
 * turn, so creating an agent costs nothing and never throws (the bundle may be
 * absent in unit tests or a broken install; the error then surfaces as a turn
 * failure the room can show).
 */
class LazyClaudeSession {
  private inner: Promise<SdkAgentSession> | undefined;
  constructor(
    private readonly agent: Parameters<typeof SdkAgentSession.prototype.applyConfig>[0],
    private readonly roster: Parameters<typeof SdkAgentSession.prototype.applyConfig>[1],
    private readonly ctx: ConstructorParameters<typeof SdkAgentSession>[2],
  ) {}
  private session(): Promise<SdkAgentSession> {
    this.inner ??= loadSdk().then((sdk) => new SdkAgentSession(this.agent, this.roster, this.ctx, sdk));
    return this.inner;
  }
  runTurn(prompt: string) {
    return this.session().then((s) => s.runTurn(prompt));
  }
  interrupt() {
    return this.inner ? this.inner.then((s) => s.interrupt()) : Promise.resolve();
  }
  applyConfig(...a: Parameters<SdkAgentSession['applyConfig']>) {
    return this.inner ? this.inner.then((s) => s.applyConfig(...a)) : Promise.resolve();
  }
  restart() {
    void this.inner?.then((s) => s.restart());
  }
  forget() {
    void this.inner?.then((s) => s.forget());
  }
  dispose() {
    void this.inner?.then((s) => s.dispose());
  }
}

function hasOauthAccount(): boolean {
  try {
    return /"oauthAccount"\s*:\s*\{/.test(readFileSync(home('.claude.json'), 'utf8'));
  } catch {
    return false;
  }
}

export const claudeProvider: Provider = {
  id: 'claude',
  title: 'Claude',
  vendor: 'Anthropic',
  enforcement: 'full',
  costUsd: true,
  loginCommand: 'claude /login',
  installCommand: 'npm install -g @anthropic-ai/claude-code',
  defaultModel: 'claude-sonnet-5-5',
  staticModels: MODELS.map((id) => ({ id, label: id.replace(/^claude-/, '').replace(/-\d{8}$/, '') })),
  async detect(env, configuredPath) {
    const cliPath = findCli({ names: ['claude'], configured: configuredPath });
    if (!cliPath) {
      return { installed: false, authenticated: false, detail: 'Claude Code CLI not installed', setupHint: 'Install Claude Code (npm install -g @anthropic-ai/claude-code), then run `claude` once to sign in.' };
    }
    // Credentials live in ~/.claude/.credentials.json on Linux and in the keychain on macOS,
    // where ~/.claude.json records the signed-in account instead.
    const credentials = exists(home('.claude', '.credentials.json')) || hasOauthAccount();
    const apiKey = !!env.ANTHROPIC_API_KEY;
    return {
      installed: true,
      cliPath,
      authenticated: credentials || apiKey ? true : 'unknown',
      detail: apiKey ? 'API key from environment' : credentials ? 'Claude Code login' : 'no stored login found; checked on first use',
      setupHint: 'Run `claude` once to sign in, or run "Roundtable: Set API Key".',
    };
  },
  createSession(agent, roster, ctx) {
    return new LazyClaudeSession(agent, roster, ctx);
  },
};
