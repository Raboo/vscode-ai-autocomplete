import * as vscode from 'vscode';
import type { Log } from '../log';
import type { Secrets } from '../config/secrets';
import { readSettings } from '../config/vscodeSettings';
import type { StatusBar } from './statusBar';

export const SNOOZE_KEY = 'snoozedUntil';

export interface Snooze {
  get(): number;
  /** persist=false keeps the value in memory only (until restart). */
  set(until: number, persist: boolean): Promise<void>;
}

export interface CommandDeps {
  context: vscode.ExtensionContext;
  status: StatusBar;
  secrets: Secrets;
  snooze: Snooze;
  channel: vscode.OutputChannel;
  log: Log;
}

const MENU: { label: string; command: string }[] = [
  { label: 'Toggle completions on/off', command: 'aiAutocomplete.toggle' },
  { label: 'Snooze...', command: 'aiAutocomplete.snooze' },
  { label: 'Select backend...', command: 'aiAutocomplete.selectBackend' },
  { label: 'Set API key...', command: 'aiAutocomplete.setApiKey' },
  { label: 'Show log', command: 'aiAutocomplete.showLog' },
  { label: 'About', command: 'aiAutocomplete.about' },
];

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
  return [
    reg('menu', async () => {
      const pick = await vscode.window.showQuickPick(MENU, { placeHolder: 'AI Autocomplete' });
      if (pick) await vscode.commands.executeCommand(pick.command);
    }),
    reg('toggle', async () => {
      const on = readSettings().settings.fim.enabled;
      await vscode.workspace.getConfiguration('aiAutocomplete').update('fim.enabled', !on, vscode.ConfigurationTarget.Global);
      d.status.refresh();
    }),
    reg('snooze', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '15 minutes', ms: 15 * 60_000 },
          { label: '1 hour', ms: 60 * 60_000 },
          { label: 'Until restart', ms: undefined },
        ],
        { placeHolder: 'Snooze AI Autocomplete' },
      );
      if (!pick) return;
      if (pick.ms === undefined) await d.snooze.set(Number.MAX_SAFE_INTEGER, false);
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
      const key = await vscode.window.showInputBox({ prompt: `API key for "${id}"`, password: true, ignoreFocusOut: true });
      if (key === undefined || key === '') return;
      await d.secrets.set(id, key);
      void vscode.window.showInformationMessage(`AI Autocomplete: API key saved for "${id}".`);
    }),
    reg('showLog', () => d.channel.show(true)),
    reg('about', async () => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(d.context.extensionUri, 'NOTICE'));
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    reg('accepted', () => {
      accepted++;
      d.status.setStats(accepted);
    }),
  ];
}
