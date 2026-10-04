import type { HookCallbackMatcher, HookEvent, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { ZodRawShape } from 'zod';
import type { AgentConfig, FieldSpec, GuardrailLayer, GuardrailStatus, GuardrailsFile } from '../shared/protocol';
import type { Runner } from './runner';

export type { FieldSpec, GuardrailStatus, GuardrailsFile };
export type Layer = GuardrailLayer;

/** What detection found in the open project. */
export interface ProjectProfile {
  root: string | undefined;
  git: boolean;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | undefined;
  node: boolean;
  typescript: boolean;
  tsconfig: string | undefined;
  eslint: boolean;
  testRunner: 'vitest' | 'jest' | 'mocha' | undefined;
  testCommand: string | undefined;
  scripts: Record<string, string>;
  /** Top-level source directories, relative to root (e.g. src/room). */
  srcDirs: string[];
  /** Locally installed CLI tools (node_modules/.bin or PATH). */
  tools: { tsc: boolean; eslint: boolean; depcruise: boolean; gitleaks: boolean };
  files: { agentsMd: boolean; claudeMd: boolean; architectureYml: boolean; adrDir: boolean; depcruiseConfig: boolean };
}

export type SetupAction =
  | { kind: 'write'; path: string; content: string; description: string }
  | { kind: 'install'; packages: string[]; description: string }
  | { kind: 'agents'; description: string; patch(agent: AgentConfig): AgentConfig };

/** Per-room state shared by all hooks; owned by GuardrailRuntime. */
export interface RoomState {
  /** Increments on every user message. */
  requestId: number;
  /** Request id the reviewer approved, if any. */
  approvedRequest: number | undefined;
  spec: { status: 'none' | 'pending' | 'approved' | 'changes'; markdown: string; agentId: string; requestId: number };
}

/** Per-agent, per-turn state; reset when the agent's turn starts. */
export interface TurnState {
  editedFiles: Set<string>;
  stopBlocks: number;
  lastRun: Map<string, number>;
}

export interface HookCtx<C = unknown> {
  agent: AgentConfig;
  roster: AgentConfig[];
  /** Project root (workspace folder). */
  root: string;
  /** Directory the agent works in (workspace or its worktree). */
  cwd: string;
  profile: ProjectProfile;
  config: C;
  room: RoomState;
  turn: TurnState;
  runner: Runner;
  /** Post a system message to the room. */
  report(text: string): void;
  /** Ask the host to re-evaluate overrides (locks, permission modes) for every agent. */
  stateChanged(): void;
}

export interface ToolSpec {
  name: string;
  description: string;
  schema: ZodRawShape;
  handler(args: Record<string, unknown>): Promise<string>;
}

export type HookMap = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

export interface GuardrailDef<C = any> {
  id: string;
  title: string;
  summary: string;
  layer: Layer;
  fields: FieldSpec[];
  appliesTo(profile: ProjectProfile): boolean;
  defaults(profile: ProjectProfile): C;
  status(profile: ProjectProfile, config: C, agents: AgentConfig[]): GuardrailStatus;
  setup?(profile: ProjectProfile, config: C, agents: AgentConfig[]): Promise<SetupAction[]>;
  hooks?(ctx: HookCtx<C>): HookMap;
  /** Return a reason to keep the agent working, or undefined to let it finish. */
  stopCheck?(ctx: HookCtx<C>, lastMessage: string): Promise<string | undefined>;
  prompt?(ctx: HookCtx<C>): string | Promise<string>;
  tools?(ctx: HookCtx<C>): ToolSpec[];
  /** Extra tools to disallow for this agent (e.g. reviewer is read-only). */
  disallowedTools?(ctx: HookCtx<C>): string[];
}

export interface Preset {
  id: string;
  title: string;
  summary: string;
  /** Guardrail id → config overrides on top of defaults (true = defaults). */
  guardrails: Record<string, true | Record<string, unknown>>;
}

// ---- hook output helpers ----

export const MUTATING_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit';

export function deny(reason: string): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

export function allow(): HookJSONOutput {
  return {};
}

export function feedback(text: string): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } };
}

export function block(reason: string): HookJSONOutput {
  return { decision: 'block', reason };
}

/** File path a mutating tool call targets, if any. */
export function toolFilePath(input: unknown): string | undefined {
  const obj = (input ?? {}) as Record<string, unknown>;
  const value = obj.file_path ?? obj.notebook_path ?? obj.path;
  return typeof value === 'string' ? value : undefined;
}

/** Text a Write/Edit call will put into the file. */
export function toolWrittenText(input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (typeof obj.content === 'string') return obj.content;
  if (typeof obj.new_string === 'string') return obj.new_string;
  if (Array.isArray(obj.edits)) {
    return obj.edits.map((e) => (typeof (e as any)?.new_string === 'string' ? (e as any).new_string : '')).join('\n');
  }
  return '';
}

export function bashCommand(input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  return typeof obj.command === 'string' ? obj.command : '';
}
