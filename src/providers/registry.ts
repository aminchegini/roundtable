import type { AgentConfig, ModelOption, ProviderId, ProviderView } from '../shared/protocol';
import { claudeProvider } from './claude';
import { codexProvider } from './codex';
import { copilotProvider } from './copilot';
import { cursorProvider } from './cursor';
import { geminiProvider } from './gemini';
import { resetCliCache } from './cli';
import type { Provider, ProviderStatus } from './types';

export const PROVIDERS: Provider[] = [claudeProvider, codexProvider, geminiProvider, copilotProvider, cursorProvider];

export function getProvider(id: ProviderId): Provider {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) throw new Error(`Unknown provider ${id}`);
  return provider;
}

/** Detection results cached until `refresh()`; the UI shows installed/signed-in state and models. */
export class ProviderRegistry {
  private status = new Map<ProviderId, ProviderStatus>();
  private pending: Promise<void> | undefined;
  private listeners = new Set<() => void>();

  constructor(
    private readonly env: () => Record<string, string | undefined>,
    /** User-configured executable paths per provider (settings), empty = auto-detect. */
    private readonly configuredPaths: () => Partial<Record<ProviderId, string>> = () => ({}),
  ) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Detect every provider (in parallel); resolves when all are done. */
  refresh(): Promise<void> {
    resetCliCache();
    this.pending ??= Promise.all(
      PROVIDERS.map(async (p) => {
        try {
          this.status.set(p.id, await p.detect(this.env(), this.configuredPaths()[p.id]));
        } catch (err) {
          this.status.set(p.id, { installed: false, authenticated: false, detail: err instanceof Error ? err.message : String(err), setupHint: '' });
        }
        for (const l of this.listeners) l();
      }),
    ).then(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  statusOf(id: ProviderId): ProviderStatus | undefined {
    return this.status.get(id);
  }

  /** Executable to run for a vendor, if detection found one. */
  cliPath(id: ProviderId): string | undefined {
    return this.status.get(id)?.cliPath;
  }

  models(id: ProviderId): ModelOption[] {
    const provider = getProvider(id);
    const seen = new Set<string>();
    return [...provider.staticModels, ...(this.status.get(id)?.models ?? [])].filter((m) => !seen.has(m.id) && seen.add(m.id));
  }

  views(): ProviderView[] {
    return PROVIDERS.map((p) => {
      const s = this.status.get(p.id);
      return {
        id: p.id,
        title: p.title,
        vendor: p.vendor,
        installed: s?.installed ?? false,
        authenticated: s?.authenticated ?? 'unknown',
        detail: s?.detail ?? 'checking…',
        setupHint: s?.setupHint ?? '',
        loginCommand: p.loginCommand,
        installCommand: p.installCommand,
        cliPath: s?.cliPath,
        models: this.models(p.id),
        enforcement: p.enforcement,
        costUsd: p.costUsd,
        experimental: p.experimental,
      };
    });
  }

  /** True when an agent's provider is signed in (or we cannot tell). */
  usable(agent: AgentConfig): boolean {
    const s = this.status.get(agent.provider);
    return !s || (s.installed && s.authenticated !== false);
  }
}
