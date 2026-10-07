// Types shared by the extension host and the webview.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// bypassPermissions is deliberately not offered.
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'auto';
export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk'];

export type WorkspaceMode = 'shared' | 'worktree' | 'read-only';
export const WORKSPACE_MODES: WorkspaceMode[] = ['shared', 'worktree', 'read-only'];

export type ProviderId = 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor';
export const PROVIDER_IDS: ProviderId[] = ['claude', 'codex', 'gemini', 'copilot', 'cursor'];

export interface ModelOption {
  id: string;
  label: string;
}

/** Guardrail enforcement a provider supports: in-process PreToolUse hooks, or only gates run after each turn. */
export type Enforcement = 'full' | 'gates';

export interface ProviderView {
  id: ProviderId;
  title: string;
  vendor: string;
  installed: boolean;
  authenticated: boolean | 'unknown';
  /** One line: "signed in as …", "not installed", "login unknown". */
  detail: string;
  /** How to get it working, shown when unavailable. */
  setupHint: string;
  /** Interactive sign-in command, run in a terminal by the Sign in button. */
  loginCommand: string;
  models: ModelOption[];
  enforcement: Enforcement;
  /** Reports USD cost; otherwise only tokens. */
  costUsd: boolean;
  experimental?: boolean;
}

/** Claude models offered in pickers; every picker also accepts free text. */
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
  provider: ProviderId;
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
  pinned?: boolean;
  /** Spending/usage limits for this agent in every room. Missing = DEFAULT_LIMITS. */
  limits?: Limits;
  /** Guardrails forced on or off for this agent, on top of the room's set. */
  guardrails?: GuardrailOverrides;
}

export interface RoomMeta {
  id: string;
  name: string;
  /** A DM is a room with exactly one agent. */
  kind: 'group' | 'dm';
  agentIds: string[];
  pinned: boolean;
  createdAt: number;
  lastActivity: number;
  /** Room-level limits. Missing = DEFAULT_LIMITS. */
  limits?: Limits;
  /** Rounds after each user message before agents stop; missing = workspace setting. */
  maxRounds?: number;
  /** Custom guardrails for this room; missing = inherit the workspace file. */
  guardrails?: GuardrailsFile;
}

export type AgentStatus = 'idle' | 'speaking' | 'error';

export interface Tokens {
  input: number;
  output: number;
}

/** How a vendor bills this agent's session: a plan (subscription) or metered API usage. */
export type BillingKind = 'subscription' | 'api' | 'unknown';

/** One rate-limit window the vendor reported (e.g. Claude's 5-hour / 7-day windows). */
export interface QuotaInfo {
  /** Short window name: "5h", "7d", "7d Opus". */
  window: string;
  /** 0–100, how much of the window is used. */
  usedPercent: number;
  /** Epoch ms when the window resets, when known. */
  resetsAt?: number;
}

export interface AgentView {
  config: AgentConfig;
  status: AgentStatus;
  /** Vendor's own estimate (Claude only); meaningful for API billing, informational otherwise. */
  costUsd: number;
  tokens: Tokens;
  billing: BillingKind;
  quota?: QuotaInfo[];
  /** Set when a limit keeps this agent from taking turns. */
  benched?: BenchReason;
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

export type StopReason = 'all-passed' | 'max-rounds' | 'budget' | 'quota' | 'tokens' | 'stopped' | 'all-failed' | 'all-benched';

export interface RoomStatus {
  running: boolean;
  round: number;
  maxRounds: number;
  costUsd: number;
  /** Estimated USD across agents billed by API key; the budget cap applies to this. */
  apiCostUsd: number;
  /** Total tokens across agents, for providers that report no USD. */
  tokens: Tokens;
  /** Billing picture of the room: every agent on a plan, every agent metered, or a mix. */
  billing: 'subscription' | 'api' | 'mixed' | 'unknown';
  /** The most-used quota window among subscription agents, if any vendor reports one. */
  quota?: QuotaInfo & { agentName: string };
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

/** Per-agent adjustments layered on top of the room's guardrails. */
export interface GuardrailOverrides {
  enabled: Record<string, true | Record<string, unknown>>;
  disabled: string[];
}

/**
 * Spending and usage limits. The same shape applies to a room (stops the
 * debate) and to an agent (benches that agent). Zero means "no limit".
 */
export interface Limits {
  /** API-billed agents may run. Off by default: metered usage must be opted into. */
  allowApi: boolean;
  /** Approximate USD cap for API-billed usage; 0 = unlimited. Only meaningful when allowApi. */
  apiBudgetUsd: number;
  /** Stop when a subscription agent's fullest quota window reaches this % used; 0 = ignore. */
  quotaStopPercent: number;
  /** Total tokens (input + output) across turns; 0 = unlimited. */
  maxTokens: number;
}

export const DEFAULT_LIMITS: Limits = { allowApi: false, apiBudgetUsd: 0, quotaStopPercent: 0, maxTokens: 0 };

/** Why an agent is benched in a room right now. */
export type BenchReason = 'api-not-allowed' | 'api-budget' | 'quota' | 'tokens' | 'provider-unavailable';

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

export interface RoomsView {
  rooms: RoomMeta[];
  activeRoomId: string | undefined;
}

export interface RoomState {
  agents: AgentView[];
  messages: RoomMessage[];
  room: RoomStatus;
  permissions: PermissionRequest[];
  spec: SpecView | undefined;
  /** Effective limits and rounds for this room (room override or workspace default). */
  limits: Limits;
  maxRounds: number;
  /** Guardrails as this room sees them (custom file or the inherited workspace file). */
  guardrails: GuardrailsView;
  inheritsGuardrails: boolean;
}

export type HostToWebview =
  | { type: 'state'; roomState: RoomState | undefined; allAgents: AgentView[]; rooms: RoomsView; providers: ProviderView[]; guardrails: GuardrailsView; location: 'sidebar' | 'editor' }
  | { type: 'rooms'; rooms: RoomsView }
  | { type: 'allAgents'; agents: AgentView[] }
  | { type: 'providers'; providers: ProviderView[] }
  | { type: 'message'; message: RoomMessage }
  | { type: 'partial'; agentId: string; text: string }
  | { type: 'activity'; agentId: string; text: string }
  | { type: 'agents'; agents: AgentView[] }
  | { type: 'room'; room: RoomStatus }
  | { type: 'permissions'; permissions: PermissionRequest[] }
  | { type: 'guardrails'; guardrails: GuardrailsView }
  | { type: 'spec'; spec: SpecView | undefined }
  | { type: 'navigate'; view: 'room' | 'guardrails' | 'help' | 'room-settings' };

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
  | { type: 'specDecision'; decision: 'approve' | 'changes'; note: string }
  | { type: 'switchRoom'; id: string }
  | { type: 'createRoom'; name?: string; kind: 'group' | 'dm'; agentIds: string[] }
  | { type: 'renameRoom'; id: string; name: string }
  | { type: 'pinRoom'; id: string; pinned: boolean }
  | { type: 'deleteRoom'; id: string }
  | { type: 'setParticipants'; id: string; agentIds: string[] }
  | { type: 'updateRoom'; id: string; patch: { limits?: Limits; maxRounds?: number | null; guardrails?: GuardrailsFile | null } }
  | { type: 'pinAgent'; id: string; pinned: boolean }
  | { type: 'openInEditor' }
  | { type: 'refreshProviders' }
  | { type: 'login'; provider: ProviderId }
  | { type: 'openDoc'; doc: string };
