import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getProvider, PROVIDERS } from './providers/registry';
import { Workspace, type KeyValue } from './room/Workspace';
import type { AgentConfig, ProviderId, RoomMeta } from './shared/protocol';
import { ChatHost } from './vscode/ChatHost';
import { RoomsTree, type TreeNode } from './vscode/RoomsTree';
import { StatusBar } from './vscode/StatusBar';

export const API_KEY_SECRET = 'roundtable.apiKey';

let workspace: Workspace | undefined;
let editorPanel: vscode.WebviewPanel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Roundtable');
  context.subscriptions.push(log);

  const memento = (m: vscode.Memento): KeyValue => ({ get: (k) => m.get(k), set: (k, v) => Promise.resolve(m.update(k, v)) });
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const ws = await Workspace.open({
    root,
    state: memento(context.workspaceState),
    globalState: memento(context.globalState),
    storageDir: context.globalStorageUri.fsPath,
    env: async () => {
      const env: Record<string, string | undefined> = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      const key = await context.secrets.get(API_KEY_SECRET);
      if (key) env.ANTHROPIC_API_KEY = key;
      const claudePath = resolveClaudePath();
      if (claudePath) env.ROUNDTABLE_CLAUDE_PATH = claudePath;
      return env;
    },
    claudePath: resolveClaudePath(),
    caps: () => {
      const cfg = vscode.workspace.getConfiguration('roundtable');
      return { maxRounds: cfg.get('maxRounds', 6), budgetUsd: cfg.get('budgetUsd', 2) };
    },
    log: (text) => log.appendLine(text),
    warn: (text) => void vscode.window.showWarningMessage(`Roundtable: ${text}`),
  });
  workspace = ws;
  context.subscriptions.push({ dispose: () => ws.dispose() });

  const actions = {
    openInEditor: () => openEditorPanel(context, ws),
    openDoc: (doc: string) => openDoc(context, doc),
    refreshProviders: () => ws.providers.refresh(),
  };

  // Sidebar: tree + chat view.
  const tree = new RoomsTree(ws);
  const treeView = vscode.window.createTreeView('roundtable.rooms', { treeDataProvider: tree, showCollapseAll: false });
  context.subscriptions.push(tree, treeView);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'roundtable.chat',
      {
        resolveWebviewView(view) {
          const host = new ChatHost(view.webview, ws, 'sidebar', context.extensionUri, actions);
          view.onDidDispose(() => host.dispose());
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
  context.subscriptions.push(new StatusBar(ws));

  const pickAgent = async (title: string, filter?: (a: AgentConfig) => boolean): Promise<AgentConfig | undefined> => {
    const agents = ws.agents.filter(filter ?? (() => true));
    const pick = await vscode.window.showQuickPick(
      agents.map((a) => ({ label: a.name, description: `${getProvider(a.provider).title} · ${a.model}`, detail: a.role.split('\n')[0], agent: a })),
      { title, placeHolder: 'Pick an agent' },
    );
    return pick?.agent;
  };
  const pickRoom = async (title: string): Promise<RoomMeta | undefined> => {
    const pick = await vscode.window.showQuickPick(
      ws.rooms.list().map((r) => ({ label: `${r.pinned ? '$(pinned) ' : ''}${r.name}`, description: r.kind === 'dm' ? 'DM' : `${r.agentIds.length} agents`, room: r })),
      { title, placeHolder: 'Pick a room' },
    );
    return pick?.room;
  };
  const roomFrom = async (arg: unknown, title: string): Promise<RoomMeta | undefined> => {
    if (typeof arg === 'string') return ws.rooms.get(arg);
    const node = arg as TreeNode | undefined;
    if (node?.kind === 'room') return node.room;
    const active = ws.rooms.activeRoomId ? ws.rooms.get(ws.rooms.activeRoomId) : undefined;
    return active ?? pickRoom(title);
  };
  const agentFrom = async (arg: unknown, title: string): Promise<AgentConfig | undefined> => {
    if (typeof arg === 'string') return ws.agents.find((a) => a.id === arg);
    const node = arg as TreeNode | undefined;
    if (node?.kind === 'agent') return node.agent;
    return pickAgent(title);
  };
  const showChat = async () => {
    if (vscode.workspace.getConfiguration('roundtable').get<string>('chatLocation', 'sidebar') === 'editor') openEditorPanel(context, ws);
    else await vscode.commands.executeCommand('roundtable.chat.focus');
  };

  const register = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await fn(...args);
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          log.appendLine(`${id}: ${text}`);
          void vscode.window.showErrorMessage(`Roundtable: ${text}`);
        }
      }),
    );

  register('roundtable.openChat', showChat);
  register('roundtable.open', showChat); // v1 command id
  register('roundtable.openInEditor', () => openEditorPanel(context, ws));
  register('roundtable.switchRoom', async (arg) => {
    const room = typeof arg === 'string' ? ws.rooms.get(arg) : await pickRoom('Switch room');
    if (room) {
      ws.rooms.setActive(room.id);
      await showChat();
    }
  });
  register('roundtable.newRoom', async () => {
    const name = await vscode.window.showInputBox({ title: 'New room', prompt: 'Room name', value: `Room ${ws.rooms.list().filter((r) => r.kind === 'group').length + 1}` });
    if (name === undefined) return;
    const picks = await vscode.window.showQuickPick(
      ws.agents.map((a) => ({ label: a.name, description: `${getProvider(a.provider).title} · ${a.model}`, picked: true, agent: a })),
      { title: `Participants of ${name}`, canPickMany: true },
    );
    if (!picks) return;
    ws.createRoom({ name, kind: 'group', agentIds: picks.map((p) => p.agent.id) });
    await showChat();
  });
  register('roundtable.newDm', async (arg) => {
    const agent = await agentFrom(arg, 'Message an agent');
    if (!agent) return;
    ws.dmWith(agent.id);
    await showChat();
  });
  register('roundtable.openDm', async (arg) => {
    const agent = await agentFrom(arg, 'Message an agent');
    if (!agent) return;
    ws.dmWith(agent.id);
    await showChat();
  });
  register('roundtable.renameRoom', async (arg) => {
    const room = await roomFrom(arg, 'Rename room');
    if (!room) return;
    const name = await vscode.window.showInputBox({ title: 'Rename room', value: room.name });
    if (name) ws.rooms.rename(room.id, name);
  });
  register('roundtable.pinRoom', async (arg) => {
    const room = await roomFrom(arg, 'Pin room');
    if (room) ws.rooms.pin(room.id, true);
  });
  register('roundtable.unpinRoom', async (arg) => {
    const room = await roomFrom(arg, 'Unpin room');
    if (room) ws.rooms.pin(room.id, false);
  });
  register('roundtable.deleteRoom', async (arg) => {
    const room = await roomFrom(arg, 'Delete room');
    if (!room) return;
    const ok = await vscode.window.showWarningMessage(`Delete "${room.name}" and its transcript?`, { modal: true }, 'Delete');
    if (ok === 'Delete') await ws.deleteRoom(room.id);
  });
  register('roundtable.resetRoom', async (arg) => {
    const room = await roomFrom(arg, 'Reset room');
    if (!room) return;
    const ok = await vscode.window.showWarningMessage(`Clear the transcript of "${room.name}" and start its agents fresh?`, { modal: true }, 'Reset');
    if (ok === 'Reset') await ws.resetRoom(room.id);
  });
  register('roundtable.editParticipants', async (arg) => {
    const room = await roomFrom(arg, 'Edit participants');
    if (!room || room.kind === 'dm') return;
    const picks = await vscode.window.showQuickPick(
      ws.agents.map((a) => ({ label: a.name, description: `${getProvider(a.provider).title} · ${a.model}`, picked: room.agentIds.includes(a.id), agent: a })),
      { title: `Participants of ${room.name}`, canPickMany: true },
    );
    if (picks) await ws.setParticipants(room.id, picks.map((p) => p.agent.id));
  });
  register('roundtable.newAgent', async () => {
    const providers = ws.providers.views();
    const pick = await vscode.window.showQuickPick(
      providers.map((p) => ({
        label: `${p.title}${p.experimental ? ' (experimental)' : ''}`,
        description: p.vendor,
        detail: p.installed && p.authenticated !== false ? p.detail : `⚠ ${p.detail} — ${p.setupHint}`,
        id: p.id,
      })),
      { title: 'New agent — provider', placeHolder: 'Which vendor runs this agent?' },
    );
    if (!pick) return;
    const agent = await ws.addAgent(pick.id);
    ws.dmWith(agent.id);
    await showChat();
  });
  register('roundtable.renameAgent', async (arg) => {
    const agent = await agentFrom(arg, 'Rename agent');
    if (!agent) return;
    const name = await vscode.window.showInputBox({ title: 'Rename agent', value: agent.name });
    if (name) await ws.saveAgent({ ...agent, name: name.trim().replace(/\s+/g, '-') });
  });
  register('roundtable.pinAgent', async (arg) => {
    const agent = await agentFrom(arg, 'Pin agent');
    if (agent) await ws.pinAgent(agent.id, true);
  });
  register('roundtable.unpinAgent', async (arg) => {
    const agent = await agentFrom(arg, 'Unpin agent');
    if (agent) await ws.pinAgent(agent.id, false);
  });
  register('roundtable.deleteAgent', async (arg) => {
    const agent = await agentFrom(arg, 'Delete agent');
    if (!agent) return;
    const ok = await vscode.window.showWarningMessage(`Delete agent "${agent.name}"? Its DM and room memberships go with it.`, { modal: true }, 'Delete');
    if (ok === 'Delete') await ws.removeAgent(agent.id);
  });
  register('roundtable.changeModel', async (arg) => {
    const agent = await agentFrom(arg, 'Change model');
    if (!agent) return;
    const views = ws.providers.views();
    const items: Array<vscode.QuickPickItem & { provider?: ProviderId; model?: string }> = [];
    for (const p of views) {
      const available = p.installed && p.authenticated !== false;
      items.push({ label: `${p.title} — ${p.vendor}${available ? '' : ` (${p.detail})`}`, kind: vscode.QuickPickItemKind.Separator });
      for (const m of p.models) {
        items.push({
          label: `${available ? '' : '$(circle-slash) '}${m.label}`,
          description: m.id !== m.label ? m.id : undefined,
          detail: available ? undefined : p.setupHint,
          picked: p.id === agent.provider && m.id === agent.model,
          provider: p.id,
          model: m.id,
        });
      }
    }
    items.push({ label: 'Other…', description: 'type a model id', provider: agent.provider });
    const pick = await vscode.window.showQuickPick(items, { title: `Model for ${agent.name}`, placeHolder: `${getProvider(agent.provider).title} · ${agent.model}`, matchOnDescription: true });
    if (!pick?.provider) return;
    let model = pick.model;
    if (!model) {
      model = await vscode.window.showInputBox({ title: `Model id for ${agent.name}`, value: agent.model });
      if (!model) return;
    }
    await ws.saveAgent({ ...agent, provider: pick.provider, model });
  });
  register('roundtable.sendSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const selection = editor.document.getText(editor.selection.isEmpty ? undefined : editor.selection);
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    const line = editor.selection.start.line + 1;
    const text = `From ${rel}:${line}\n\`\`\`${editor.document.languageId}\n${selection}\n\`\`\``;
    const roomId = ws.rooms.activeRoomId;
    if (!roomId) return;
    ws.controller(roomId)?.send(text);
    await showChat();
  });
  register('roundtable.refreshProviders', () => ws.providers.refresh());
  register('roundtable.openGuardrails', async () => {
    await showChat();
    ws.navigate('guardrails');
  });
  register('roundtable.help', async () => {
    await showChat();
    ws.navigate('help');
  });
  register('roundtable.setApiKey', async () => {
    const key = await vscode.window.showInputBox({
      title: 'Roundtable fallback API key (Claude)',
      prompt: 'Leave empty to remove the stored key and use your Claude Code login.',
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) return;
    if (key) await context.secrets.store(API_KEY_SECRET, key);
    else await context.secrets.delete(API_KEY_SECRET);
    void vscode.window.showInformationMessage(`Roundtable: API key ${key ? 'stored' : 'removed'}. Reload the window to apply.`);
  });

  log.appendLine(`Roundtable ready: ${ws.agents.length} agents, ${ws.rooms.list().length} rooms, providers: ${PROVIDERS.map((p) => p.id).join(', ')}`);
}

function openEditorPanel(context: vscode.ExtensionContext, ws: Workspace): void {
  if (editorPanel) {
    editorPanel.reveal();
    return;
  }
  const panel = vscode.window.createWebviewPanel('roundtable.room', 'Roundtable', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
  const host = new ChatHost(panel.webview, ws, 'editor', context.extensionUri, {
    openInEditor: () => panel.reveal(),
    openDoc: (doc) => openDoc(context, doc),
    refreshProviders: () => ws.providers.refresh(),
  });
  editorPanel = panel;
  panel.onDidDispose(() => {
    host.dispose();
    editorPanel = undefined;
  });
}

function openDoc(context: vscode.ExtensionContext, doc: string): void {
  const uri = vscode.Uri.joinPath(context.extensionUri, 'docs', doc.replace(/[^a-z0-9/_.-]/gi, ''));
  void vscode.commands.executeCommand('markdown.showPreview', uri);
}

function resolveClaudePath(): string | undefined {
  const configured = vscode.workspace.getConfiguration('roundtable').get<string>('claudePath', '').trim();
  if (configured) return configured;
  return [path.join(os.homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find((p) => fs.existsSync(p));
}

export function deactivate(): void {
  workspace?.dispose();
}
