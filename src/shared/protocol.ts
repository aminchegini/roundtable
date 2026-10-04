// Types shared by the extension host and the webview.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// bypassPermissions is deliberately not offered.
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'auto';
export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk'];

export type WorkspaceMode = 'shared' | 'worktree' | 'read-only';
export const WORKSPACE_MODES: WorkspaceMode[] = ['shared', 'worktree', 'read-only'];

export const MODELS = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5-20251001',
];

export interface AgentConfig {
  id: string;
  name: string;
  color: string;
  /** Role text appended to the Claude Code system prompt. */
  role: string;
  model: string;
  effort: Effort;
  permissionMode: PermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
  workspaceMode: WorkspaceMode;
  /** Read-only agent that must approve plans (reviewer-veto guardrail). */
  reviewer?: boolean;
  /** May edit paths the protected-paths guardrail blocks for everyone else. */
  canEditProtected?: boolean;
}

export type AgentStatus = 'idle' | 'speaking' | 'error';

export interface AgentView {
  config: AgentConfig;
  status: AgentStatus;
  costUsd: number;
  /** Model reported by the live session, if it has started. */
  liveModel?: string;
}

export const USER_ID = 'user';

export interface RoomMessage {
  id: number;
  /** USER_ID, an agent id, or 'system'. */
  from: string;
  text: string;
  ts: number;
}

export type StopReason = 'all-passed' | 'max-rounds' | 'budget' | 'stopped' | 'all-failed';

export interface RoomStatus {
  running: boolean;
  round: number;
  maxRounds: number;
  costUsd: number;
  budgetUsd: number;
  stopReason?: StopReason;
  /** Active process locks, from guardrails. */
  locks?: { review?: string; spec?: string };
}

// ---- guardrails ----

export type GuardrailLayer = 'gate' | 'knowledge' | 'process';
export type GuardrailStatus = 'ready' | 'needs-setup' | 'missing-tool';

export type FieldSpec = {
  key: string;
  label: string;
  help?: string;
} & (
  | { type: 'boolean' }
  | { type: 'text' }
  | { type: 'number' }
  | { type: 'select'; options: string[] }
  /** Comma-separated list in the UI, string[] in config. */
  | { type: 'list' }
);

/** `.roundtable/guardrails.json` */
export interface GuardrailsFile {
  preset?: string;
  enabled: Record<string, true | Record<string, unknown>>;
  disabled: string[];
}

export interface GuardrailEntry {
  id: string;
  title: string;
  summary: string;
  layer: GuardrailLayer;
  /** False when the guardrail does not fit the detected stack. */
  applies: boolean;
  enabled: boolean;
  status: GuardrailStatus;
  config: Record<string, unknown>;
  fields: FieldSpec[];
}

export interface SetupItem {
  kind: 'write' | 'install' | 'agents';
  description: string;
  detail: string;
}

export interface GuardrailsView {
  /** One-line description of the detected project. */
  profile: string;
  hasWorkspace: boolean;
  presets: Array<{ id: string; title: string; summary: string; guardrailIds: string[] }>;
  file: GuardrailsFile;
  entries: GuardrailEntry[];
  /** Pending setup actions for the enabled guardrails. */
  setup: SetupItem[];
  busy: boolean;
}

export interface SpecView {
  status: 'pending' | 'approved' | 'changes';
  markdown: string;
  agentName: string;
}

export interface PermissionRequest {
  requestId: string;
  agentId: string;
  toolName: string;
  /** Short human-readable rendering of the tool input. */
  detail: string;
  canAlways: boolean;
}

export type PermissionDecision = 'allow' | 'always' | 'deny';

export type HostToWebview =
  | { type: 'state'; agents: AgentView[]; messages: RoomMessage[]; room: RoomStatus; permissions: PermissionRequest[]; guardrails: GuardrailsView; spec: SpecView | undefined }
  | { type: 'message'; message: RoomMessage }
  | { type: 'partial'; agentId: string; text: string }
  | { type: 'activity'; agentId: string; text: string }
  | { type: 'agents'; agents: AgentView[] }
  | { type: 'room'; room: RoomStatus }
  | { type: 'permissions'; permissions: PermissionRequest[] }
  | { type: 'guardrails'; guardrails: GuardrailsView }
  | { type: 'spec'; spec: SpecView | undefined };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'reset' }
  | { type: 'saveAgent'; config: AgentConfig }
  | { type: 'addAgent' }
  | { type: 'removeAgent'; id: string }
  | { type: 'permissionResponse'; requestId: string; decision: PermissionDecision }
  | { type: 'setGuardrails'; file: GuardrailsFile }
  | { type: 'applySetup' }
  | { type: 'specDecision'; decision: 'approve' | 'changes'; note: string };
