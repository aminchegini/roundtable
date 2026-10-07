import * as vscode from 'vscode';
import type { Workspace } from '../room/Workspace';
import type { AgentConfig, RoomMeta } from '../shared/protocol';

export type TreeNode =
  | { kind: 'section'; id: 'pinned' | 'rooms' | 'dms' | 'agents'; label: string }
  | { kind: 'room'; room: RoomMeta }
  | { kind: 'agent'; agent: AgentConfig };

const PROVIDER_ICON: Record<AgentConfig['provider'], string> = {
  claude: 'sparkle',
  codex: 'terminal',
  gemini: 'star',
  copilot: 'github',
  cursor: 'edit',
};

/** Sidebar tree: pinned items, rooms, direct messages, agents. */
export class RoomsTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly unsubscribe: () => void;

  constructor(private readonly workspace: Workspace) {
    this.unsubscribe = workspace.onChange(() => this.emitter.fire(undefined));
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      const rooms = this.workspace.rooms.list();
      const pinned = rooms.some((r) => r.pinned) || this.workspace.agents.some((a) => a.pinned);
      return [
        ...(pinned ? [{ kind: 'section', id: 'pinned', label: 'Pinned' } as const] : []),
        { kind: 'section', id: 'rooms', label: 'Rooms' },
        { kind: 'section', id: 'dms', label: 'Direct messages' },
        { kind: 'section', id: 'agents', label: 'Agents' },
      ];
    }
    if (node.kind !== 'section') return [];
    const rooms = this.workspace.rooms.list();
    switch (node.id) {
      case 'pinned':
        return [
          ...rooms.filter((r) => r.pinned).map((room) => ({ kind: 'room', room }) as const),
          ...this.workspace.agents.filter((a) => a.pinned).map((agent) => ({ kind: 'agent', agent }) as const),
        ];
      case 'rooms':
        return rooms.filter((r) => r.kind === 'group' && !r.pinned).map((room) => ({ kind: 'room', room }));
      case 'dms':
        return rooms.filter((r) => r.kind === 'dm' && !r.pinned).map((room) => ({ kind: 'room', room }));
      case 'agents':
        return this.workspace.agents.filter((a) => !a.pinned).map((agent) => ({ kind: 'agent', agent }));
    }
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'section') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = `section-${node.id}`;
      return item;
    }
    if (node.kind === 'room') {
      const { room } = node;
      const activity = this.workspace.activity(room.id);
      const active = this.workspace.rooms.activeRoomId === room.id;
      const item = new vscode.TreeItem(room.name);
      const names = room.agentIds.map((id) => this.workspace.agents.find((a) => a.id === id)?.name ?? '?');
      const preview = room.lastMessage ? `${room.lastMessage.from ? `${room.lastMessage.from}: ` : ''}${room.lastMessage.text.replace(/\s+/g, ' ').slice(0, 60)}` : undefined;
      const modeTag = room.mode ? ` · ${room.mode}` : '';
      item.description = activity.paused
        ? `paused${modeTag}`
        : activity.running
          ? `${activity.speaker ?? '…'} speaking${modeTag}`
          : activity.pending > 0
            ? `${activity.pending} approval${activity.pending > 1 ? 's' : ''} waiting`
            : (preview ?? (room.kind === 'dm' ? 'DM' : `${names.length} agents`)) + modeTag;
      item.tooltip = new vscode.MarkdownString(
        `**${room.name}** — ${room.kind === 'dm' ? 'direct message with' : 'room with'} ${names.join(', ') || 'nobody yet'}${room.mode ? `\n\nMode: ${room.mode} (overrides agents)` : ''}${room.lastMessage ? `\n\n_${room.lastMessage.from || 'system'}:_ ${room.lastMessage.text}` : ''}`,
      );
      item.iconPath = new vscode.ThemeIcon(
        activity.paused ? 'debug-pause' : activity.running ? 'sync~spin' : room.kind === 'dm' ? 'comment' : 'comment-discussion',
        active ? new vscode.ThemeColor('focusBorder') : undefined,
      );
      item.contextValue = `${room.kind}${room.pinned ? '-pinned' : ''}`;
      item.command = { command: 'roundtable.switchRoom', title: 'Open', arguments: [room.id] };
      return item;
    }
    const { agent } = node;
    const item = new vscode.TreeItem(agent.name);
    const provider = this.workspace.providers.views().find((p) => p.id === agent.provider);
    const unavailable = provider && (!provider.installed || provider.authenticated === false);
    item.description = `${provider?.title ?? agent.provider} · ${agent.model}${agent.mode && agent.mode !== 'build' ? ` · ${agent.mode}` : ''}${agent.reviewer ? ' · reviewer' : ''}${unavailable ? ' · unavailable' : ''}`;
    item.tooltip = new vscode.MarkdownString(
      `**${agent.name}** — ${provider?.title ?? agent.provider} ${agent.model}\n\n${agent.role || '_no role_'}\n\n${unavailable ? `⚠ ${provider?.detail}` : (provider?.detail ?? '')}`,
    );
    item.iconPath = new vscode.ThemeIcon(PROVIDER_ICON[agent.provider] ?? 'person', unavailable ? new vscode.ThemeColor('errorForeground') : undefined);
    item.contextValue = `agent${agent.pinned ? '-pinned' : ''}`;
    item.command = { command: 'roundtable.openDm', title: 'Message', arguments: [agent.id] };
    return item;
  }

  dispose(): void {
    this.unsubscribe();
    this.emitter.dispose();
  }
}
