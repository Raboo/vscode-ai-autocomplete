import * as vscode from 'vscode';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { EXTENSION_ID, argvPath, withProposedApiOptIn } from '../nextEdit/optIn';
import type { Log } from '../log';
import type { Secrets } from '../config/secrets';
import { usesFor, writesToWorkspace, type BackendUse } from '../config/settings';
import { readSettings } from '../config/vscodeSettings';
import type { OpenOptions } from './backendsPanel';
import { describeOutcome, relativeTime, type OutcomeLog } from '../completion/outcomes';
import type { StatusBar } from './statusBar';
import { menuEntries, menuGroups, menuInputs } from './statusModel';

export const SNOOZE_KEY = 'snoozedUntil';

export interface Snooze {
  get(): number;
  /** persist=false keeps the value in memory only (until restart) and removes any persisted snooze. */
  set(until: number, persist: boolean): Promise<void>;
}

export interface CommandDeps {
  context: vscode.ExtensionContext;
  status: StatusBar;
  outcomes: OutcomeLog;
  secrets: Secrets;
  snooze: Snooze;
  channel: vscode.OutputChannel;
  log: Log;
  /** Clears every backend's backoff and shows idle, so the next keystroke sends a request. */
  retry(): void;
  /** Opens (or reveals) the Backends page. */
  manageBackends(o: OpenOptions): void;
  /** Whether VS Code's native Next Edit UI is available (the proposed API is enabled for this extension). */
  nativeNextEdit(): boolean;
  /** A completion was accepted (after the stats are counted): prefetches the next one on local llama.cpp. */
  completionAccepted(): void;
  /** A Next Edit item was accepted. */
  nextEditAccepted(): void;
  /** Tab on a Next Edit shown as decorations: jump to it, or apply it. */
  nextEditTab(): Promise<void>;
  /** Esc on a Next Edit shown as decorations. */
  nextEditDismiss(): void;
  /** The local llama-servers; `stopEverywhere` stops them in every window and says whether any was running. */
  localServers: { stopEverywhere(): Promise<boolean> };
  /** Set Up Local Model (opens the Local Models page; a test argument runs the one-button setup), Remove Downloaded Models, and the page. */
  localModels: { setUp(arg: unknown): Promise<unknown>; remove(): Promise<void>; manage(): void };
}

/** Writes `key` where its value comes from: the workspace when it sets one, otherwise user settings. */
async function update(key: string, value: unknown): Promise<void> {
  const config = vscode.workspace.getConfiguration('aiAutocomplete');
  // A workspace still on the old fim.* name (not moved: untrusted) sets the value too.
  const old = key.startsWith('completions.') ? config.inspect(`fim.${key.slice('completions.'.length)}`) : undefined;
  const inWorkspace = writesToWorkspace(config.inspect(key)) || writesToWorkspace(old);
  await config.update(key, value, inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
}

/** Turns a switch on or off where its value comes from. */
async function setSwitch(key: 'enabled' | 'completions.enabled' | 'nextEdit.enabled', on: boolean): Promise<void> {
  await update(key, on);
}

/** Selects the completion backend in user settings, or in the workspace when it already selects one. Completions turned off are turned back on. */
export async function useBackend(id: string): Promise<void> {
  await update('completions.backend', id);
  if (!readSettings().settings.fim.enabled) await setSwitch('completions.enabled', true);
}

/** Selects the Next Edit backend, by the same rule as `useBackend`. Next Edit turned off is turned back on. */
export async function useNextEditBackend(id: string): Promise<void> {
  await update('nextEdit.backend', id);
  if (!readSettings().settings.nextEdit.enabled) await setSwitch('nextEdit.enabled', true);
}

/** Tells the user there is no backend yet, with the two ways to get one: a local model, or a server they already run. */
export function offerFirstBackend(message: string): void {
  const local = 'Set Up Local Model';
  const server = 'Connect a Server';
  const start = 'Get Started';
  void vscode.window.showInformationMessage(message, local, server, start).then((c) => {
    if (c === local) return vscode.commands.executeCommand('aiAutocomplete.setUpLocalModel');
    if (c === server) return vscode.commands.executeCommand('aiAutocomplete.manageBackends', { add: true });
    if (c === start) return vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXTENSION_ID}#getStarted`, false);
    return undefined;
  });
}

/** The command argument as OpenOptions; anything else opens the page as it is. */
function openOptions(arg: unknown): OpenOptions {
  if (typeof arg !== 'object' || arg === null) return {};
  const o = arg as { add?: unknown; focus?: unknown };
  return { ...(o.add === true ? { add: true } : {}), ...(typeof o.focus === 'string' ? { focus: o.focus } : {}) };
}

const USE_NAMES: Record<BackendUse, string> = { completions: 'completions', nextEdit: 'Next Edit' };

/** Backends the user can pick from, optionally only those serving `use`. Tells the user when there are none. */
function pickableBackends(use?: BackendUse): string[] | undefined {
  const all = readSettings().settings.backends;
  if (all.length === 0) {
    offerFirstBackend('AI Autocomplete: no backends yet.');
    return undefined;
  }
  const ids = all.filter((b) => use === undefined || usesFor(b, use)).map((b) => b.id);
  if (ids.length === 0 && use !== undefined) {
    void vscode.window.showInformationMessage(`AI Autocomplete: no backend is set up for ${USE_NAMES[use]}. Open "AI Autocomplete: Manage Backends" to set one up.`);
    return undefined;
  }
  return ids;
}

async function pickBackend(placeHolder: string, use?: BackendUse): Promise<string | undefined> {
  const ids = pickableBackends(use);
  return ids ? vscode.window.showQuickPick(ids, { placeHolder }) : undefined;
}

const OFF = 'Off';

/** The backends serving `use` plus Off, the current choice marked; resolves to the picked id, OFF, or undefined when dismissed. */
async function pickBackendOrOff(placeHolder: string, use: BackendUse, current: string | undefined, off: boolean): Promise<string | undefined> {
  const ids = pickableBackends(use);
  if (!ids) return undefined;
  const mark = (yes: boolean) => (yes ? { description: 'current' } : {});
  const pick = await vscode.window.showQuickPick<vscode.QuickPickItem>(
    [...ids.map((id) => ({ label: id, ...mark(!off && id === current) })), { label: OFF, ...mark(off) }],
    { placeHolder },
  );
  return pick?.label;
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
      const groups = menuGroups(menuEntries(d.status.state(), menuInputs(readSettings().settings, d.nativeNextEdit())));
      const items = groups.flatMap((g): (vscode.QuickPickItem & { id?: string })[] => [
        ...(g.title ? [{ label: g.title, kind: vscode.QuickPickItemKind.Separator }] : []),
        ...g.entries,
      ]);
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'AI Autocomplete' });
      if (!pick?.id) return;
      if (pick.id === 'resume') await resume();
      else await vscode.commands.executeCommand(`aiAutocomplete.${pick.id}`);
    }),
    reg('retry', () => d.retry()),
    reg('toggleEnabled', async () => {
      await setSwitch('enabled', !readSettings().settings.enabled);
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
    // Off turns the feature off and keeps its backend, so picking one again turns it back on.
    reg('selectBackend', async () => {
      const { fim } = readSettings().settings;
      const pick = await pickBackendOrOff('Select the completion backend', 'completions', fim.backendId, !fim.enabled);
      if (pick === undefined) return;
      await (pick === OFF ? setSwitch('completions.enabled', false) : useBackend(pick));
    }),
    reg('selectNextEditBackend', async () => {
      const { nextEdit } = readSettings().settings;
      const pick = await pickBackendOrOff('Select the Next Edit backend', 'nextEdit', nextEdit.backendId, !nextEdit.enabled || nextEdit.backendId === undefined);
      if (pick === undefined) return;
      await (pick === OFF ? setSwitch('nextEdit.enabled', false) : useNextEditBackend(pick));
    }),
    reg('manageBackends', (arg) => d.manageBackends(openOptions(arg))),
    reg('openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`)),
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
    reg('whyNoSuggestion', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      const list = doc ? d.outcomes.forUri(doc.uri.toString()) : [];
      if (list.length === 0) {
        void vscode.window.showInformationMessage('No completion requests for this file yet.');
        return;
      }
      const now = Date.now();
      await vscode.window.showQuickPick(
        list.map((o) => ({ label: describeOutcome(o), description: relativeTime(now, o.at) })),
        { placeHolder: 'Why no suggestion? The latest completion requests for this file, newest first' },
      );
    }),
    reg('accepted', () => {
      accepted++;
      d.outcomes.accepted();
      d.status.setStats(accepted);
      d.completionAccepted();
    }),
    reg('nextEditAccepted', () => d.nextEditAccepted()),
    reg('nextEditTab', () => d.nextEditTab()),
    reg('nextEditDismiss', () => d.nextEditDismiss()),
    reg('stopLocalModels', async () => {
      const stopped = await d.localServers.stopEverywhere();
      void vscode.window.showInformationMessage(stopped ? 'Stopped local models in all windows.' : 'No local models are running.');
    }),
    reg('setUpLocalModel', (arg) => d.localModels.setUp(arg)),
    reg('removeLocalModels', () => d.localModels.remove()),
    reg('manageLocalModels', () => d.localModels.manage()),
    reg('enableNativeNextEdit', async () => {
      const manual = async () => {
        await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
        void vscode.window.showInformationMessage(`Add "enable-proposed-api": ["${EXTENSION_ID}"] to argv.json, then quit and reopen VS Code.`);
      };
      // Running on the remote side of a remote window, this home is the remote machine's; VS Code reads the local argv.json.
      const remoteSide = vscode.env.remoteName !== undefined && d.context.extension.extensionKind === vscode.ExtensionKind.Workspace;
      const path = remoteSide ? undefined : argvPath(vscode.env.appName, homedir(), process.env);
      if (!path) return manual();
      try {
        const text = await readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return '';
          throw err;
        });
        const next = withProposedApiOptIn(text, EXTENSION_ID);
        if (next === undefined) {
          void vscode.window.showInformationMessage('AI Autocomplete: native Next Edit UI is already enabled. If Next Edit still shows only ghost text, quit and reopen VS Code.');
          return;
        }
        await writeFile(path, next, 'utf8');
        void vscode.window.showInformationMessage('AI Autocomplete: native Next Edit UI enabled. Quit and reopen VS Code to finish.');
      } catch (err) {
        d.log.debug(`enable native next edit failed: ${err instanceof Error ? err.message : String(err)}`);
        return manual();
      }
    }),
  ];
}
