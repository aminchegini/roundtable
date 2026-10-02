import * as vscode from 'vscode';
import { API_KEY_SECRET, RoomPanel } from './panel/RoomPanel';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Roundtable');
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand('roundtable.open', async () => {
      try {
        await RoomPanel.open(context, log);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        log.appendLine(`failed to open room: ${text}`);
        void vscode.window.showErrorMessage(`Roundtable: ${text}`);
      }
    }),
    vscode.commands.registerCommand('roundtable.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'Roundtable fallback API key',
        prompt: 'Leave empty to remove the stored key and use your Claude Code login.',
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) return;
      if (key) await context.secrets.store(API_KEY_SECRET, key);
      else await context.secrets.delete(API_KEY_SECRET);
      void vscode.window.showInformationMessage(
        key ? 'Roundtable: API key stored. Reset the room to apply.' : 'Roundtable: API key removed. Reset the room to apply.',
      );
    }),
  );
}

export function deactivate(): void {}
