import * as vscode from 'vscode';
import type { Workspace } from '../room/Workspace';

/** Shows the active room and whether an agent is speaking or waiting for approval. */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly unsubscribe: () => void;

  constructor(private readonly workspace: Workspace) {
    this.item.command = 'roundtable.openChat';
    this.unsubscribe = workspace.onChange(() => this.render());
    this.render();
    this.item.show();
  }

  private render(): void {
    const id = this.workspace.rooms.activeRoomId;
    const room = id ? this.workspace.rooms.get(id) : undefined;
    if (!room) {
      this.item.text = '$(comment-discussion) Roundtable';
      this.item.tooltip = 'Open Roundtable';
      return;
    }
    const activity = this.workspace.activity(room.id);
    const state = activity.pending > 0 ? ` · $(shield) ${activity.pending} waiting` : activity.running ? ` · $(sync~spin) ${activity.speaker ?? 'thinking'}` : '';
    this.item.text = `$(comment-discussion) ${room.name}${state}`;
    this.item.tooltip = `Roundtable — ${room.name}${activity.running ? ` (${activity.speaker ?? 'an agent'} is speaking)` : ''}`;
  }

  dispose(): void {
    this.unsubscribe();
    this.item.dispose();
  }
}
