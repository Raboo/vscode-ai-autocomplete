import * as vscode from 'vscode';
import type { Log } from '../log';
import type { Secrets } from '../config/secrets';
import { readSettings } from '../config/vscodeSettings';
import type { StatusBar } from './statusBar';
import { menuEntries } from './statusModel';

export const SNOOZE_KEY = 'snoozedUntil';

export interface Snooze {
  get(): number;
  /** persist=false keeps the value in memory only (until restart) and removes any persisted snooze. */
  set(until: number, persist: boolean): Promise<void>;
}

export interface CommandDeps {
  context: vscode.ExtensionContext;
  status: StatusBar;
  secrets: Secrets;
  snooze: Snooze;
  channel: vscode.OutputChannel;
  log: Log;
  /** Clears every backend's backoff and shows idle, so the next keystroke sends a request. */
  retry(): void;
}

async function pickBackend(placeHolder: string): Promise<string | undefined> {
  const ids = readSettings().settings.backends.map((b) => b.id);
  if (ids.length === 0) {
    void vscode.window.showInformationMessage('AI Autocomplete: no backends configured. Add one to "aiAutocomplete.backends" in your user settings.');
    return undefined;
  }
  return vscode.window.showQuickPick(ids, { placeHolder });
}

export function registerCommands(d: CommandDeps): vscode.Disposable[] {
  let accepted = 0;
  const reg = (id: string, fn: (...args: unknown[]) => unknown): vscode.Disposable => vscode.commands.registerCommand(`aiAutocomplete.${id}`, fn);
  const resume = async (): Promise<void> => {
    await d.snooze.set(0, false);
    d.status.refresh();
  };
  return [
    reg('menu', async () => {
      const pick = await vscode.window.showQuickPick(menuEntries(d.status.state()), { placeHolder: 'AI Autocomplete' });
      if (!pick) return;
      if (pick.id === 'resume') await resume();
      else await vscode.commands.executeCommand(`aiAutocomplete.${pick.id}`);
    }),
    reg('retry', () => d.retry()),
    reg('toggle', async () => {
      const on = readSettings().settings.fim.enabled;
      await vscode.workspace.getConfiguration('aiAutocomplete').update('fim.enabled', !on, vscode.ConfigurationTarget.Global);
      d.status.refresh();
    }),
    reg('snooze', async () => {
      const snoozed = d.snooze.get() > Date.now();
      const pick = await vscode.window.showQuickPick<vscode.QuickPickItem & { ms: number | 'restart' | 'resume' }>(
        [
          ...(snoozed ? [{ label: 'Resume now', ms: 'resume' as const }] : []),
          { label: '15 minutes', ms: 15 * 60_000 },
          { label: '1 hour', ms: 60 * 60_000 },
          { label: 'Until restart', ms: 'restart' },
        ],
        { placeHolder: 'Snooze AI Autocomplete' },
      );
      if (!pick) return;
      if (pick.ms === 'resume') return resume();
      if (pick.ms === 'restart') await d.snooze.set(Number.MAX_SAFE_INTEGER, false);
      else await d.snooze.set(Date.now() + pick.ms, true);
      d.status.refresh();
    }),
    reg('selectBackend', async () => {
      const id = await pickBackend('Select the completion backend');
      if (!id) return;
      const target = (vscode.workspace.workspaceFolders?.length ?? 0) > 0 ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration('aiAutocomplete').update('fim.backend', id, target);
    }),
    reg('setApiKey', async () => {
      const id = await pickBackend('Set the API key for which backend?');
      if (!id) return;
      const key = await vscode.window.showInputBox({ prompt: `API key for "${id}" (leave empty to delete the stored key)`, password: true, ignoreFocusOut: true });
      if (key === undefined) return;
      if (key === '') {
        const yes: vscode.MessageItem = { title: 'Yes' };
        const pick = await vscode.window.showWarningMessage(`Delete the stored API key for "${id}"?`, { modal: true }, yes, { title: 'No', isCloseAffordance: true });
        if (pick !== yes) return;
        await d.secrets.delete(id);
        void vscode.window.showInformationMessage(`AI Autocomplete: API key deleted for "${id}".`);
        return;
      }
      await d.secrets.set(id, key);
      void vscode.window.showInformationMessage(`AI Autocomplete: API key saved for "${id}".`);
    }),
    reg('showLog', () => d.channel.show(true)),
    reg('about', async () => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(d.context.extensionUri, 'NOTICE'));
      await vscode.window.showTextDocument(doc, { preview: true });
      await vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession');
    }),
    reg('accepted', () => {
      accepted++;
      d.status.setStats(accepted);
    }),
  ];
}
