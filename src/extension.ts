import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getProvider, PROVIDERS } from './providers/registry';
import { setVendorRoot } from './providers/vendorLoader';
import { Workspace, type KeyValue } from './room/Workspace';
import { MODES, MODE_HINTS, MODE_LABELS, type AgentConfig, type InteractionMode, type ProviderId, type RoomMeta } from './shared/protocol';
import { ChatHost } from './vscode/ChatHost';
import { RoomsTree, type TreeNode } from './vscode/RoomsTree';
import { StatusBar } from './vscode/StatusBar';

export const API_KEY_SECRET = 'roundtable.apiKey';

let workspace: Workspace | undefined;
let editorPanel: vscode.WebviewPanel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Roundtable');
  context.subscriptions.push(log);

  // Vendor SDK bundles live under the extension folder (dist/vendor/*.mjs).
  setVendorRoot(context.extensionUri.fsPath);
  const memento = (m: vscode.Memento): KeyValue => ({ get: (k) => m.get(k), set: (k, v) => Promise.resolve(m.update(k, v)) });
  const configuredPaths = (): Partial<Record<ProviderId, string>> => {
    const cfg = vscode.workspace.getConfiguration('roundtable');
    const read = (key: string) => cfg.get<string>(key, '').trim() || undefined;
    return { claude: read('claudePath'), codex: read('codexPath'), gemini: read('geminiPath'), copilot: read('copilotPath'), cursor: read('cursorPath') };
  };
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
      return env;
    },
    configuredPaths,
    defaults: () => ({ maxRounds: vscode.workspace.getConfiguration('roundtable').get('maxRounds', 6) }),
    log: (text) => log.appendLine(text),
    warn: (text) => void vscode.window.showWarningMessage(`Roundtable: ${text}`),
  });
  workspace = ws;
  context.subscriptions.push({ dispose: () => ws.dispose() });

  const actions = {
    openInEditor: () => openEditorPanel(context, ws),
    openDoc: (doc: string) => openDoc(context, doc),
    refreshProviders: () => ws.providers.refresh(),
    login: (provider: string) => void vscode.commands.executeCommand('roundtable.login', provider),
    install: (provider: string) => void vscode.commands.executeCommand('roundtable.install', provider),
  };

  // A vendor refused a turn (missing CLI or expired login): offer the fix right here.
  context.subscriptions.push({
    dispose: ws.onChange((event) => {
      if (event.type !== 'login-needed') return;
      const provider = getProvider(event.provider);
      const install = event.kind === 'install';
      void vscode.window
        .showWarningMessage(
          install
            ? `${provider.title} CLI is not installed (${event.agentName} could not answer). Install it to use this agent.`
            : `${provider.title} needs you to sign in (${event.agentName} could not answer): ${shorten(event.reason)}`,
          install ? 'Install' : 'Sign in',
          'Not now',
        )
        .then((choice) => {
          if (choice === 'Install') void vscode.commands.executeCommand('roundtable.install', event.provider, event.roomId);
          if (choice === 'Sign in') void vscode.commands.executeCommand('roundtable.login', event.provider, event.roomId);
        });
    }),
  });

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
  register('roundtable.login', async (arg, roomArg) => {
    let id = typeof arg === 'string' ? (arg as ProviderId) : undefined;
    if (!id) {
      const pick = await vscode.window.showQuickPick(
        ws.providers.views().map((p) => ({ label: p.title, description: p.detail, detail: `runs: ${p.loginCommand}`, id: p.id })),
        { title: 'Sign in to a provider' },
      );
      id = pick?.id;
    }
    if (!id) return;
    const provider = getProvider(id);
    const terminal = vscode.window.createTerminal({ name: `Roundtable · ${provider.title} sign-in` });
    terminal.show();
    terminal.sendText(provider.loginCommand);
    const roomId = typeof roomArg === 'string' ? roomArg : ws.rooms.activeRoomId;
    const choice = await vscode.window.showInformationMessage(
      `Finish the ${provider.title} sign-in in the terminal, then come back.`,
      'Done, retry',
      'Done',
    );
    if (!choice) return;
    const retried = await ws.retryAfterLogin(choice === 'Done, retry' ? roomId : undefined);
    const status = ws.providers.views().find((p) => p.id === id);
    const ok = status && status.installed && status.authenticated !== false;
    void vscode.window.showInformationMessage(
      ok
        ? `${provider.title}: ${status.detail}.${retried ? ' Your last message was sent again.' : ''}`
        : `${provider.title} still looks signed out (${status?.detail ?? 'unknown'}). ${provider.id === 'claude' ? 'Claude checks the login on the next turn; try sending a message.' : status?.setupHint ?? ''}`,
    );
  });
  register('roundtable.openGuardrails', async () => {
    await showChat();
    ws.navigate('guardrails');
  });
  register('roundtable.pause', () => {
    const id = ws.rooms.activeRoomId;
    if (id) ws.controller(id)?.pause();
  });
  register('roundtable.resume', () => {
    const id = ws.rooms.activeRoomId;
    if (id) ws.controller(id)?.resume();
  });
  const pickMode = async (title: string, allowInherit: string | undefined): Promise<InteractionMode | null | undefined> => {
    const items: Array<vscode.QuickPickItem & { mode: InteractionMode | null }> = MODES.map((m) => ({ label: MODE_LABELS[m], detail: MODE_HINTS[m], mode: m }));
    if (allowInherit) items.unshift({ label: allowInherit, mode: null });
    const pick = await vscode.window.showQuickPick(items, { title });
    return pick ? pick.mode : undefined;
  };
  register('roundtable.setRoomMode', async (arg) => {
    const room = await roomFrom(arg, 'Room mode');
    if (!room) return;
    const mode = await pickMode(`Mode for every agent in ${room.name}`, "Agents' own modes");
    if (mode !== undefined) ws.updateRoom(room.id, { mode });
  });
  register('roundtable.setAgentMode', async (arg) => {
    const agent = await agentFrom(arg, 'Agent mode');
    if (!agent) return;
    const mode = await pickMode(`Mode for ${agent.name}`, undefined);
    if (mode) await ws.setAgentMode(agent.id, mode);
  });
  register('roundtable.install', async (arg, roomArg) => {
    let id = typeof arg === 'string' ? (arg as ProviderId) : undefined;
    if (!id) {
      const pick = await vscode.window.showQuickPick(
        ws.providers.views().map((p) => ({ label: p.title, description: p.installed ? `installed: ${p.cliPath}` : 'not installed', detail: `runs: ${p.installCommand}`, id: p.id })),
        { title: 'Install a vendor CLI' },
      );
      id = pick?.id;
    }
    if (!id) return;
    const provider = getProvider(id);
    const terminal = vscode.window.createTerminal({ name: `Roundtable · ${provider.title} install` });
    terminal.show();
    terminal.sendText(provider.installCommand);
    const roomId = typeof roomArg === 'string' ? roomArg : ws.rooms.activeRoomId;
    const choice = await vscode.window.showInformationMessage(`Finish the ${provider.title} install in the terminal, then come back.`, 'Done, re-check', 'Done');
    if (!choice) return;
    await ws.providers.refresh();
    const status = ws.providers.views().find((p) => p.id === id);
    if (status?.installed) {
      const signedIn = status.authenticated !== false;
      const next = signedIn && choice === 'Done, re-check' ? await ws.retryAfterLogin(roomId) : false;
      void vscode.window.showInformationMessage(
        `${provider.title} found at ${status.cliPath}. ${signedIn ? (next ? 'Your last message was sent again.' : 'Ready.') : `Now sign in: ${status.setupHint}`}`,
        ...(signedIn ? [] : ['Sign in']),
      ).then((c) => {
        if (c === 'Sign in') void vscode.commands.executeCommand('roundtable.login', id, roomId);
      });
    } else {
      void vscode.window.showWarningMessage(`${provider.title} still not found. If it installed somewhere unusual, set roundtable.${id}Path to the executable.`);
    }
  });
  register('roundtable.roomSettings', async (arg) => {
    const room = await roomFrom(arg, 'Room settings');
    if (!room) return;
    ws.rooms.setActive(room.id);
    await showChat();
    ws.navigate('room-settings');
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

  // One-time notice: agents act under the user's own vendor accounts.
  if (!context.globalState.get<boolean>('roundtable.disclaimerShown')) {
    void vscode.window
      .showInformationMessage(
        'Roundtable drives each vendor\'s agent under your own account and terms. Every token, charge, quota and overage, and anything an agent does, is your responsibility; the author is not liable. Costs shown are estimates. No warranty.',
        'Read disclaimer',
        'Got it',
      )
      .then((choice) => {
        void context.globalState.update('roundtable.disclaimerShown', true);
        if (choice === 'Read disclaimer') openDoc(context, '../DISCLAIMER.md');
      });
  }

  log.appendLine(`Roundtable ready: ${ws.agents.length} agents, ${ws.rooms.list().length} rooms, providers: ${PROVIDERS.map((p) => p.id).join(', ')}`);
}

function shorten(text: string): string {
  const line = text.split('\n')[0] ?? text;
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
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
    login: (provider) => void vscode.commands.executeCommand('roundtable.login', provider),
    install: (provider) => void vscode.commands.executeCommand('roundtable.install', provider),
  });
  editorPanel = panel;
  panel.onDidDispose(() => {
    host.dispose();
    editorPanel = undefined;
  });
}

function openDoc(context: vscode.ExtensionContext, doc: string): void {
  // Only docs/*.md and the root DISCLAIMER.md are reachable from the webview.
  const safe = doc.replace(/[^a-z0-9/_.-]/gi, '');
  const uri = safe === '../DISCLAIMER.md' ? vscode.Uri.joinPath(context.extensionUri, 'DISCLAIMER.md') : vscode.Uri.joinPath(context.extensionUri, 'docs', safe.replace(/\.\./g, ''));
  void vscode.commands.executeCommand('markdown.showPreview', uri);
}


export function deactivate(): void {
  workspace?.dispose();
}
