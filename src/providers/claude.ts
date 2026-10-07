import { readFileSync } from 'node:fs';
import { SdkAgentSession } from '../room/SdkAgentSession';
import { MODELS } from '../shared/protocol';
import { findCli } from './cli';
import { exists, home } from './shared';
import type { Provider } from './types';
import { loadVendor } from './vendorLoader';

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');

const loadSdk = () => loadVendor<Sdk>('claude');

/** Wraps a lazily loaded SDK session so the room can create sessions synchronously. */
class LazyClaudeSession {
  private inner: Promise<SdkAgentSession>;
  constructor(...args: ConstructorParameters<typeof SdkAgentSession> extends [infer A, infer R, infer C, unknown] ? [A, R, C] : never) {
    this.inner = loadSdk().then((sdk) => new SdkAgentSession(args[0], args[1], args[2], sdk));
  }
  runTurn(prompt: string) {
    return this.inner.then((s) => s.runTurn(prompt));
  }
  interrupt() {
    return this.inner.then((s) => s.interrupt());
  }
  applyConfig(...a: Parameters<SdkAgentSession['applyConfig']>) {
    return this.inner.then((s) => s.applyConfig(...a));
  }
  restart() {
    void this.inner.then((s) => s.restart());
  }
  forget() {
    void this.inner.then((s) => s.forget());
  }
  dispose() {
    void this.inner.then((s) => s.dispose());
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
