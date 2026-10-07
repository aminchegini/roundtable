import type { HookMap, ToolSpec } from '../guardrails/types';
import type { AgentSession } from '../room/Room';
import type { AgentConfig, Enforcement, InteractionMode, ModelOption, ProviderId } from '../shared/protocol';

export type SessionEvent =
  | { type: 'partial'; text: string }
  | { type: 'activity'; text: string }
  | { type: 'started'; sessionId: string; model: string; apiKeySource: string };

/** What the guardrail runtime contributes to one agent's session. */
export interface SessionGuardrails {
  buildHooks(agent: AgentConfig, roster: AgentConfig[], cwd: string): HookMap;
  buildPrompt(agent: AgentConfig, roster: AgentConfig[], cwd: string): Promise<string>;
  buildTools(agent: AgentConfig, roster: AgentConfig[], cwd: string): ToolSpec[];
  buildDisallowed(agent: AgentConfig, roster: AgentConfig[], cwd: string): string[];
  /** Text-protocol instructions for providers without room tools. */
  textProtocolPrompt(agent: AgentConfig): string;
  /** Record a file an agent changed (providers without hooks call this from their own events). */
  noteEdit(agentId: string, cwd: string, file: string): void;
  /** Run a PreToolUse decision through the configured hooks (for providers with in-process hooks). */
  preToolUse(agent: AgentConfig, roster: AgentConfig[], cwd: string, toolName: string, input: unknown): Promise<string | undefined>;
}

export interface SessionContext {
  /** Working directory for this agent (workspace, worktree, or undefined). */
  resolveCwd(config: AgentConfig): Promise<string | undefined>;
  env: Record<string, string | undefined>;
  /** Session / thread id from a previous run, to resume its history. */
  resumeId: string | undefined;
  guardrails?: SessionGuardrails;
  /** Mode in force for this agent (room override applied). Read at session start/restart. */
  mode?(): InteractionMode;
  /** Claude only: path to the Claude Code executable. */
  claudePath?: string;
  onEvent(event: SessionEvent): void;
  requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    canAlways: boolean,
    signal: AbortSignal,
  ): Promise<'allow' | 'always' | 'deny'>;
}

/** True when a turn error means the vendor wants the user to sign in (again). */
export function isAuthError(text: string): boolean {
  return /OAuth session expired|Failed to authenticate|not (logged|signed) in|Invalid authentication|authentication (failed|required)|\b401\b|unauthori[sz]ed|login required|please (run|use) .*login|no (stored )?credentials|API key (is )?(missing|invalid)|(token|session|credential)s? (has |have |is |are )?(expired|invalid|revoked)|missing bearer/i.test(text);
}

export interface ProviderStatus {
  installed: boolean;
  authenticated: boolean | 'unknown';
  detail: string;
  setupHint: string;
  /** Models discovered at detection time (Copilot, Cursor); merged with the static list. */
  models?: ModelOption[];
}

export interface Provider {
  id: ProviderId;
  title: string;
  vendor: string;
  enforcement: Enforcement;
  costUsd: boolean;
  experimental?: boolean;
  /** Default model for a new agent of this provider. */
  defaultModel: string;
  /** Shell command that signs the user in interactively (run in a VS Code terminal). */
  loginCommand: string;
  staticModels: ModelOption[];
  detect(env: Record<string, string | undefined>): Promise<ProviderStatus>;
  createSession(agent: AgentConfig, roster: AgentConfig[], ctx: SessionContext): AgentSession;
}
