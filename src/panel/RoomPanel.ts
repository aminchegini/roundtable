import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { blankAgent, defaultAgents, loadAgents, saveAgents } from '../room/config';
import { Room, type RoomSnapshot } from '../room/Room';
import { SdkAgentSession, describeToolUse } from '../room/SdkAgentSession';
import { ensureWorktree } from '../room/worktrees';
import type {
  AgentConfig,
  AgentView,
  HostToWebview,
  PermissionDecision,
  PermissionRequest,
  WebviewToHost,
} from '../shared/protocol';

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');

const SNAPSHOT_KEY = 'roundtable.snapshot';
const SESSIONS_KEY = 'roundtable.sessions';
const AGENTS_KEY = 'roundtable.agents';
export const API_KEY_SECRET = 'roundtable.apiKey';

interface PendingPermission {
  request: PermissionRequest;
  resolve(decision: PermissionDecision): void;
}

export class RoomPanel {
  private static current: RoomPanel | undefined;

  static async open(context: vscode.ExtensionContext, log: vscode.OutputChannel): Promise<void> {
    if (RoomPanel.current) {
      RoomPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('roundtable.room', 'Roundtable', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
    });
    RoomPanel.current = new RoomPanel(panel, context, log);
    try {
      await RoomPanel.current.init();
    } catch (err) {
      panel.dispose();
      throw err;
    }
  }

  private room: Room | undefined;
  private liveModels = new Map<string, string>();
  private permissions = new Map<string, PendingPermission>();
  private nextPermissionId = 1;
  private webviewReady = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) {
    panel.onDidDispose(() => this.dispose());
    panel.webview.onDidReceiveMessage((m: WebviewToHost) => {
      this.onMessage(m).catch((err) => this.reportError(err));
    });
  }

  private get workspaceDir(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private async init(): Promise<void> {
    const sdk: Sdk = await import('@anthropic-ai/claude-agent-sdk');
    const agents = await this.loadAgentConfigs();
    const snapshot = this.context.workspaceState.get<RoomSnapshot>(SNAPSHOT_KEY);
    this.room = await this.createRoom(sdk, agents, snapshot);
    this.panel.webview.html = this.html();
  }

  private async createRoom(sdk: Sdk, agents: AgentConfig[], snapshot: RoomSnapshot | undefined): Promise<Room> {
    const claudePath = resolveClaudePath();
    const env = await this.sessionEnv();
    this.log.appendLine(`claude executable: ${claudePath ?? '(SDK built-in)'}`);

    return new Room(
      {
        getCaps: () => {
          const cfg = vscode.workspace.getConfiguration('roundtable');
          return { maxRounds: cfg.get('maxRounds', 6), budgetUsd: cfg.get('budgetUsd', 2) };
        },
        emit: (event) => {
          if (event.type === 'message') this.send({ type: 'message', message: event.message });
          else if (event.type === 'agents') this.send({ type: 'agents', agents: this.agentViews() });
          else this.send({ type: 'room', room: this.room!.status });
          if (event.type !== 'agents') void this.persist();
        },
        createSession: (config, roster) => {
          const id = config.id;
          return new SdkAgentSession(config, roster, {
            sdk,
            claudePath,
            env,
            resumeId: this.sessionIds()[id],
            resolveCwd: (c) => this.resolveCwd(c),
            onEvent: (event) => {
              if (event.type === 'partial') this.send({ type: 'partial', agentId: id, text: event.text });
              else if (event.type === 'activity') this.send({ type: 'activity', agentId: id, text: event.text });
              else {
                this.liveModels.set(id, event.model);
                this.log.appendLine(`[${config.name}] session ${event.sessionId} model=${event.model} auth=${event.apiKeySource}`);
                void this.context.workspaceState.update(SESSIONS_KEY, { ...this.sessionIds(), [id]: event.sessionId });
                this.send({ type: 'agents', agents: this.agentViews() });
              }
            },
            requestPermission: (toolName, input, canAlways, signal) =>
              this.requestPermission(id, toolName, input, canAlways, signal),
          });
        },
      },
      agents,
      snapshot,
    );
  }

  private sessionIds(): Record<string, string> {
    return this.context.workspaceState.get<Record<string, string>>(SESSIONS_KEY) ?? {};
  }

  /** Agents use the existing Claude Code login unless a fallback API key was stored. */
  private async sessionEnv(): Promise<Record<string, string | undefined>> {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const key = await this.context.secrets.get(API_KEY_SECRET);
    if (key) env.ANTHROPIC_API_KEY = key;
    return env;
  }

  private async resolveCwd(config: AgentConfig): Promise<string | undefined> {
    const dir = this.workspaceDir;
    if (!dir || config.workspaceMode !== 'worktree') return dir;
    try {
      return await ensureWorktree(dir, this.context.globalStorageUri.fsPath, config.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      void vscode.window.showWarningMessage(
        `Roundtable: could not create a worktree for ${config.name}; using the shared workspace. ${reason}`,
      );
      return dir;
    }
  }

  // ---- agent config persistence ----

  private async loadAgentConfigs(): Promise<AgentConfig[]> {
    const dir = this.workspaceDir;
    const stored = dir ? await loadAgents(dir) : this.context.globalState.get<AgentConfig[]>(AGENTS_KEY);
    return stored && stored.length > 0 ? stored : defaultAgents();
  }

  private async saveAgentConfigs(): Promise<void> {
    const agents = this.room?.agentViews.map((a) => a.config) ?? [];
    const dir = this.workspaceDir;
    if (dir) await saveAgents(dir, agents);
    else await this.context.globalState.update(AGENTS_KEY, agents);
  }

  private async persist(): Promise<void> {
    if (this.room) await this.context.workspaceState.update(SNAPSHOT_KEY, this.room.snapshot);
  }

  // ---- webview bridge ----

  private agentViews(): AgentView[] {
    return (this.room?.agentViews ?? []).map((a) => ({ ...a, liveModel: this.liveModels.get(a.config.id) }));
  }

  private send(message: HostToWebview): void {
    if (this.webviewReady) void this.panel.webview.postMessage(message);
  }

  private sendState(): void {
    if (!this.room) return;
    this.send({
      type: 'state',
      agents: this.agentViews(),
      messages: this.room.transcript,
      room: this.room.status,
      permissions: [...this.permissions.values()].map((p) => p.request),
    });
  }

  private async onMessage(m: WebviewToHost): Promise<void> {
    const room = this.room;
    if (!room) return;
    switch (m.type) {
      case 'ready':
        this.webviewReady = true;
        this.sendState();
        break;
      case 'send':
        if (m.text.trim()) room.postUserMessage(m.text.trim());
        break;
      case 'stop':
        await room.stop();
        break;
      case 'saveAgent':
        await room.saveAgent(m.config);
        await this.saveAgentConfigs();
        break;
      case 'addAgent':
        await room.addAgent(blankAgent(room.agentViews.map((a) => a.config)));
        await this.saveAgentConfigs();
        break;
      case 'removeAgent':
        await room.removeAgent(m.id);
        await this.saveAgentConfigs();
        break;
      case 'permissionResponse':
        this.resolvePermission(m.requestId, m.decision);
        break;
      case 'reset':
        await this.reset();
        break;
    }
  }

  /** Clears the transcript and starts every agent on a fresh session. */
  private async reset(): Promise<void> {
    const room = this.room;
    if (!room) return;
    await room.stop();
    const agents = room.agentViews.map((a) => a.config);
    room.dispose();
    for (const id of [...this.permissions.keys()]) this.resolvePermission(id, 'deny');
    this.liveModels.clear();
    await this.context.workspaceState.update(SNAPSHOT_KEY, undefined);
    await this.context.workspaceState.update(SESSIONS_KEY, undefined);
    const sdk: Sdk = await import('@anthropic-ai/claude-agent-sdk');
    this.room = await this.createRoom(sdk, agents, undefined);
    this.sendState();
  }

  // ---- permissions ----

  private requestPermission(
    agentId: string,
    toolName: string,
    input: Record<string, unknown>,
    canAlways: boolean,
    signal: AbortSignal,
  ): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      const requestId = String(this.nextPermissionId++);
      const request: PermissionRequest = {
        requestId,
        agentId,
        toolName,
        detail: describeToolUse(toolName, input),
        canAlways,
      };
      this.permissions.set(requestId, { request, resolve });
      signal.addEventListener('abort', () => this.resolvePermission(requestId, 'deny'), { once: true });
      this.sendPermissions();
    });
  }

  private resolvePermission(requestId: string, decision: PermissionDecision): void {
    const pending = this.permissions.get(requestId);
    if (!pending) return;
    this.permissions.delete(requestId);
    pending.resolve(decision);
    this.sendPermissions();
  }

  private sendPermissions(): void {
    this.send({ type: 'permissions', permissions: [...this.permissions.values()].map((p) => p.request) });
  }

  // ---- lifecycle ----

  private reportError(err: unknown): void {
    const text = err instanceof Error ? err.message : String(err);
    this.log.appendLine(`error: ${text}`);
    void vscode.window.showErrorMessage(`Roundtable: ${text}`);
  }

  private dispose(): void {
    RoomPanel.current = undefined;
    for (const id of [...this.permissions.keys()]) this.resolvePermission(id, 'deny');
    this.room?.dispose();
  }

  private html(): string {
    const webview = this.panel.webview;
    const base = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.css'));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}">
<title>Roundtable</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function resolveClaudePath(): string | undefined {
  const configured = vscode.workspace.getConfiguration('roundtable').get<string>('claudePath', '').trim();
  if (configured) return configured;
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  return candidates.find((p) => fs.existsSync(p));
}
