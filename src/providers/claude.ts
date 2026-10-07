import { readFileSync } from 'node:fs';
import { SdkAgentSession } from '../room/SdkAgentSession';
import { MODELS } from '../shared/protocol';
import { exists, home } from './shared';
import type { Provider } from './types';

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');

let sdkPromise: Promise<Sdk> | undefined;
function loadSdk(): Promise<Sdk> {
  sdkPromise ??= import('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

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
  defaultModel: 'claude-sonnet-5-5',
  staticModels: MODELS.map((id) => ({ id, label: id.replace(/^claude-/, '').replace(/-\d{8}$/, '') })),
  async detect(env) {
    const bin = env.ROUNDTABLE_CLAUDE_PATH ?? [home('.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find(exists);
    // The SDK bundles its own executable, so Claude is always installed; the login is what matters.
    // Credentials live in ~/.claude/.credentials.json on Linux and in the keychain on macOS,
    // where ~/.claude.json records the signed-in account instead.
    const credentials = exists(home('.claude', '.credentials.json')) || hasOauthAccount();
    const apiKey = !!env.ANTHROPIC_API_KEY;
    return {
      installed: true,
      authenticated: credentials || apiKey ? true : 'unknown',
      detail: apiKey ? 'API key from environment' : credentials ? `Claude Code login${bin ? '' : ' (SDK bundled CLI)'}` : 'no stored login found; checked on first use',
      setupHint: 'Install Claude Code (npm i -g @anthropic-ai/claude-code) and run `claude` once to sign in, or run "Roundtable: Set API Key".',
    };
  },
  createSession(agent, roster, ctx) {
    return new LazyClaudeSession(agent, roster, ctx);
  },
};
