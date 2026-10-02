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
  | { type: 'state'; agents: AgentView[]; messages: RoomMessage[]; room: RoomStatus; permissions: PermissionRequest[] }
  | { type: 'message'; message: RoomMessage }
  | { type: 'partial'; agentId: string; text: string }
  | { type: 'activity'; agentId: string; text: string }
  | { type: 'agents'; agents: AgentView[] }
  | { type: 'room'; room: RoomStatus }
  | { type: 'permissions'; permissions: PermissionRequest[] };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'reset' }
  | { type: 'saveAgent'; config: AgentConfig }
  | { type: 'addAgent' }
  | { type: 'removeAgent'; id: string }
  | { type: 'permissionResponse'; requestId: string; decision: PermissionDecision };
