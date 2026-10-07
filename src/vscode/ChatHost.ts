import * as vscode from 'vscode';
import type { RoomController } from '../room/RoomController';
import type { Workspace } from '../room/Workspace';
import type { HostToWebview, WebviewToHost } from '../shared/protocol';

export interface ChatHostActions {
  openInEditor(): void;
  openDoc(doc: string): void;
  refreshProviders(): Promise<void>;
  login(provider: string): void;
}

/**
 * Bridges one webview (sidebar view or editor panel) to the workspace's active
 * room. Several hosts can be open; they all follow the workspace's active room.
 */
export class ChatHost implements vscode.Disposable {
  private ready = false;
  private activeRoomId: string | undefined;
  private unsubscribeRoom: (() => void) | undefined;
  private readonly subscriptions: Array<() => void> = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly workspace: Workspace,
    private readonly location: 'sidebar' | 'editor',
    extensionUri: vscode.Uri,
    private readonly actions: ChatHostActions,
  ) {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')] };
    webview.html = html(webview, extensionUri);
    const messages = webview.onDidReceiveMessage((m: WebviewToHost) => {
      this.handle(m).catch((err) => {
        void vscode.window.showErrorMessage(`Roundtable: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    this.subscriptions.push(() => messages.dispose());
    this.subscriptions.push(
      workspace.onChange((event) => {
        switch (event.type) {
          case 'rooms':
            if (workspace.rooms.activeRoomId !== this.activeRoomId) this.followActiveRoom();
            else this.send({ type: 'rooms', rooms: workspace.roomsView() });
            break;
          case 'agents':
            this.send({ type: 'allAgents', agents: workspace.agentViews() });
            if (this.controller) this.send({ type: 'agents', agents: this.controller.agentViews() });
            break;
          case 'providers':
            this.send({ type: 'providers', providers: workspace.providers.views() });
            break;
          case 'guardrails':
            this.send({ type: 'guardrails', guardrails: workspace.guardrailsView() });
            // The room's own view may inherit the workspace file.
            this.sendState();
            break;
          case 'navigate':
            this.send({ type: 'navigate', view: event.view });
            break;
        }
      }),
    );
  }

  private get controller(): RoomController | undefined {
    return this.activeRoomId ? this.workspace.controller(this.activeRoomId) : undefined;
  }

  private followActiveRoom(): void {
    this.unsubscribeRoom?.();
    this.activeRoomId = this.workspace.rooms.activeRoomId;
    this.unsubscribeRoom = this.activeRoomId ? this.workspace.onControllerEvent(this.activeRoomId, (event) => this.send(event)) : undefined;
    this.sendState();
  }

  private send(message: HostToWebview): void {
    if (this.ready) void this.webview.postMessage(message);
  }

  private sendState(): void {
    this.send({
      type: 'state',
      roomState: this.controller?.state(),
      allAgents: this.workspace.agentViews(),
      rooms: this.workspace.roomsView(),
      providers: this.workspace.providers.views(),
      guardrails: this.workspace.guardrailsView(),
      location: this.location,
    });
  }

  private async handle(m: WebviewToHost): Promise<void> {
    const ws = this.workspace;
    const controller = this.controller;
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.followActiveRoom();
        return;
      case 'send':
        controller?.send(m.text);
        return;
      case 'stop':
        await controller?.stop();
        return;
      case 'reset':
        if (this.activeRoomId) {
          await ws.resetRoom(this.activeRoomId);
          this.followActiveRoom();
        }
        return;
      case 'saveAgent':
        await ws.saveAgent(m.config);
        return;
      case 'addAgent': {
        const agent = await ws.addAgent();
        if (this.activeRoomId && ws.rooms.get(this.activeRoomId)?.kind === 'group') {
          await ws.setParticipants(this.activeRoomId, [...(ws.rooms.get(this.activeRoomId)?.agentIds ?? []), agent.id]);
        }
        return;
      }
      case 'removeAgent':
        await ws.removeAgent(m.id);
        return;
      case 'pinAgent':
        await ws.pinAgent(m.id, m.pinned);
        return;
      case 'permissionResponse':
        controller?.permissionResponse(m.requestId, m.decision);
        return;
      case 'setGuardrails':
        await ws.setGuardrails(m.file);
        return;
      case 'applySetup': {
        const lines = await ws.runGuardrailSetup();
        for (const line of lines) controller?.room.postSystem(line);
        return;
      }
      case 'specDecision':
        controller?.specDecision(m.decision, m.note);
        return;
      case 'switchRoom':
        ws.rooms.setActive(m.id);
        return;
      case 'createRoom':
        ws.createRoom({ name: m.name, kind: m.kind, agentIds: m.agentIds });
        return;
      case 'renameRoom':
        ws.rooms.rename(m.id, m.name);
        return;
      case 'pinRoom':
        ws.rooms.pin(m.id, m.pinned);
        return;
      case 'deleteRoom':
        await ws.deleteRoom(m.id);
        return;
      case 'setParticipants':
        await ws.setParticipants(m.id, m.agentIds);
        return;
      case 'updateRoom':
        ws.updateRoom(m.id, m.patch);
        if (m.id === this.activeRoomId) this.sendState();
        return;
      case 'openInEditor':
        this.actions.openInEditor();
        return;
      case 'refreshProviders':
        await this.actions.refreshProviders();
        return;
      case 'openDoc':
        this.actions.openDoc(m.doc);
        return;
      case 'login':
        this.actions.login(m.provider);
        return;
    }
  }

  dispose(): void {
    this.unsubscribeRoom?.();
    for (const s of this.subscriptions) s();
  }
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const base = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.css'));
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}">
<title>Roundtable</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
