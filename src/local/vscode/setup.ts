import * as vscode from 'vscode';
import { readdir, rm, stat } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { join, relative } from 'node:path';
import { createBackend } from '../../backends';
import type { BackendUse, Settings } from '../../config/settings';
import { readSettings } from '../../config/vscodeSettings';
import type { Log } from '../../log';
import { runConnectionTest } from '../../manage/connectionTest';
import type { TestStep } from '../../manage/protocol';
import { useBackend, useNextEditBackend } from '../../ui/commands';
import { LOCAL_BACKEND_ID, routerWanted, upsertLocalEntry } from '../backendEntry';
import { DownloadError, downloadModel } from '../download';
import { downloadUrl, fitsMemory, modelPathSegments, type Recipe } from '../recipes';
import { INSTALL_HINT, findRuntime } from '../runtimes';
import type { ServerPool } from '../serverPool';
import { setupArgument } from '../setupArg';
import { modelsDir, realEnv } from './servers';

export interface SetupDeps {
  context: vscode.ExtensionContext;
  log: Log;
  settings(): Settings;
  /** The recipes to offer (RECIPES, or a test's own). */
  recipes(): readonly Recipe[];
  /** The router of the `local` backend. */
  router: Pick<ServerPool, 'start' | 'state' | 'port' | 'syncPresets' | 'stopHere'>;
  /** Opens the Backends page on a backend. */
  openBackend(id: string): void;
}

/** What a setup ended with; the command returns it so tests can check it. */
export type SetupOutcome =
  | { ok: true; backendId: string; steps: TestStep[] }
  | { ok: false; message: string }
  | undefined;

const RECOMMENDED = 'sweep-1.5b';
const PROGRESS_MS = 250;
const USE_LABEL: Record<BackendUse, string> = { completions: 'Completions', nextEdit: 'Next Edit' };
/** The settings selecting a backend that setup may change (through useBackend and useNextEditBackend). */
const SELECTION_KEYS = ['completions.backend', 'completions.enabled', 'nextEdit.backend', 'nextEdit.enabled'] as const;

const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('aiAutocomplete');
const userBackends = (): unknown => config().inspect('backends')?.globalValue;
const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;
const size = (bytes: number): string => (bytes >= 1e8 ? gb(bytes) : `${Math.max(1, Math.round(bytes / 1e6))} MB`);
const mb = (bytes: number): number => Math.round(bytes / 1e6);
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function llamaServerPath(s: Settings): string | undefined {
  return findRuntime('llamaServer', realEnv(), s.local.llamaServerPath);
}

async function pickRecipe(recipes: readonly Recipe[]): Promise<Recipe | undefined> {
  const memory = totalmem();
  const ordered = [...recipes].sort((a, b) => Number(b.id === RECOMMENDED) - Number(a.id === RECOMMENDED));
  const items = ordered.map((r) => ({
    label: r.label,
    description: [r.uses.map((u) => USE_LABEL[u]).join(' · '), gb(r.bytes), ...(r.id === RECOMMENDED ? ['recommended'] : [])].join(' — '),
    ...(fitsMemory(r, memory) ? {} : { detail: 'may not fit in memory' }),
    recipe: r,
  }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Choose a model' });
  return pick?.recipe;
}

/** The `.part` files of the downloads running in this window, which Remove Downloaded Models leaves out. */
const downloading = new Set<string>();

/** Downloads the recipe's file with a cancellable progress notification; undefined when the user cancelled. */
async function download(d: SetupDeps, r: Recipe, dest: string): Promise<'downloaded' | 'present' | undefined> {
  const url = downloadUrl(r);
  const host = new URL(url).host;
  const part = `${dest}.part`;
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, cancellable: true },
    async (progress, token) => {
      const ctl = new AbortController();
      const sub = token.onCancellationRequested(() => ctl.abort());
      let shownPercent = 0;
      let shownAt = 0;
      // Until the server answers, setup may be checking the hash of a file already there.
      let started = false;
      progress.report({ message: `Checking ${r.label}…` });
      downloading.add(part);
      try {
        const result = await downloadModel({
          url,
          dest,
          bytes: r.bytes,
          sha256: r.sha256,
          signal: ctl.signal,
          onProgress: (received, total) => {
            const percent = total > 0 ? Math.floor((received / total) * 100) : 0;
            const now = Date.now();
            if (started && percent === shownPercent && now - shownAt < PROGRESS_MS) return;
            started = true;
            const text = `Downloading ${r.label} from ${host}: ${percent}% (${mb(received)} of ${mb(total)} MB)`;
            progress.report({ increment: Math.max(0, percent - shownPercent), message: text });
            shownPercent = percent;
            shownAt = now;
          },
        });
        d.log.debug(`local model ${r.id}: ${result === 'present' ? 'file already present' : 'downloaded'}`);
        return result;
      } catch (err) {
        if (err instanceof DownloadError && err.kind === 'cancelled') return undefined;
        throw err;
      } finally {
        downloading.delete(part);
        sub.dispose();
      }
    },
  );
}

type Selection = { key: (typeof SELECTION_KEYS)[number]; global: unknown; workspace: unknown }[];

function selection(): Selection {
  return SELECTION_KEYS.map((key) => {
    const i = config().inspect(key);
    return { key, global: i?.globalValue, workspace: i?.workspaceValue };
  });
}

/** Puts the selection settings back where they were, in user and workspace settings alike. */
async function restoreSelection(saved: Selection): Promise<void> {
  for (const s of saved) {
    const now = config().inspect(s.key);
    if (now?.globalValue !== s.global) await config().update(s.key, s.global, vscode.ConfigurationTarget.Global);
    if (now?.workspaceValue !== s.workspace) await config().update(s.key, s.workspace, vscode.ConfigurationTarget.Workspace);
  }
}

/** Shows a notification without a cancel button while `work` runs. */
function busyWith<T>(title: string, work: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, work);
}

/** The Test of the written backend, run on the entry itself so it does not wait for the extension to rebuild its backends. */
async function test(d: SetupDeps, id: string): Promise<TestStep[]> {
  const settings = readSettings().settings;
  const cfg = settings.backends.find((b) => b.id === id);
  if (!cfg) return [{ id: 'reach', state: 'fail', text: 'the backend was not saved' }];
  const r = await runConnectionTest(
    { backend: createBackend(cfg, async () => undefined), settings, localOnly: settings.privacy.localOnly, isLocal: async () => true, signal: new AbortController().signal, log: d.log },
    () => undefined,
  );
  return r.steps;
}

/**
 * Takes a failed run back: restores the backends and the selection, and stops the router when this run started it and
 * `local` is not selected now. Never throws: a cleanup failure is logged.
 */
async function undo(d: SetupDeps, recipe: Recipe, before: { backends: unknown; selection: Selection } | undefined, startedHere: boolean): Promise<void> {
  try {
    if (before) {
      await config().update('backends', before.backends, vscode.ConfigurationTarget.Global);
      await restoreSelection(before.selection);
    }
    if (startedHere && !routerWanted(readSettings().settings)) await d.router.stopHere();
  } catch (err) {
    d.log.error(`local model setup (${recipe.id}): cleaning up after a failure failed`, err);
  }
}

let busy = false;

/**
 * AI Autocomplete: Set Up Local Model. In tests an argument (`SetupArg`) skips the pickers. Downloads the recipe's file,
 * starts it, writes and selects the backend, then runs the Test. A failure writes no backend and stops the server it started.
 */
export async function setUpLocalModel(d: SetupDeps, arg?: unknown): Promise<SetupOutcome> {
  if (vscode.env.remoteName !== undefined) {
    void vscode.window.showInformationMessage('The local model helper works in local windows only.');
    return undefined;
  }
  if (busy) {
    void vscode.window.showInformationMessage('A local model is already being set up.');
    return undefined;
  }
  busy = true;
  try {
    return await setUp(d, arg);
  } finally {
    busy = false;
  }
}

async function setUp(d: SetupDeps, arg: unknown): Promise<SetupOutcome> {
  let recipe: Recipe;
  // A test argument's `replace` asked to skip the "Replace the backend?" question; `local` is shared, so there is none now.
  const parsed = setupArgument(arg, d.recipes(), d.context.extensionMode === vscode.ExtensionMode.Test);
  if (parsed === 'invalid') {
    void vscode.window.showErrorMessage('AI Autocomplete: unknown local model.');
    return undefined;
  }
  if (parsed !== 'none') {
    recipe = parsed.recipe;
  } else {
    const r = await pickRecipe(d.recipes());
    if (!r) return undefined;
    recipe = r;
  }

  if (!llamaServerPath(d.settings())) {
    const text = `llama-server was not found. ${INSTALL_HINT.llamaServer}`;
    void vscode.window.showErrorMessage(text);
    return { ok: false, message: text };
  }

  const segments = modelPathSegments(recipe);
  if (!segments) {
    const text = `AI Autocomplete: the local model "${recipe.id}" has an invalid file path.`;
    void vscode.window.showErrorMessage(text);
    return { ok: false, message: text };
  }

  const id = LOCAL_BACKEND_ID;
  let before: { backends: unknown; selection: Selection } | undefined;
  let startedHere = false;
  try {
    const file = join(modelsDir(d.context, d.settings()), ...segments);
    const got = await download(d, recipe, file);
    if (got === undefined) {
      void vscode.window.showInformationMessage('The download was cancelled.');
      return undefined;
    }
    // Taken before the start: the pool moves the backend's baseUrl when the port is taken, and a failure puts it back.
    before = { backends: userBackends(), selection: selection() };
    let port = d.router.state() === 'running' ? d.router.port() : undefined;
    if (port !== undefined) {
      // The router reads the presets again and serves the new file.
      await d.router.syncPresets();
    } else {
      startedHere = true;
      port = (await busyWith('Starting the local model server…', () => d.router.start())).port;
    }
    const models = {
      ...(recipe.uses.includes('completions') ? { model: recipe.modelName } : {}),
      ...(recipe.uses.includes('nextEdit') ? { nextEditModel: recipe.modelName } : {}),
    };
    await config().update('backends', upsertLocalEntry(userBackends(), models, port), vscode.ConfigurationTarget.Global);
    // Selecting `local` loads the model on the router (the warm-up follows the selection).
    if (recipe.uses.includes('completions')) await useBackend(id);
    if (recipe.uses.includes('nextEdit')) await useNextEditBackend(id);
  } catch (err) {
    await undo(d, recipe, before, startedHere);
    d.log.error(`local model setup (${recipe.id}) failed`, err);
    const text = `Setting up ${recipe.label} failed: ${message(err)}`;
    void vscode.window.showErrorMessage(text);
    return { ok: false, message: text };
  }

  const steps = await busyWith(`Testing ${id}…`, () => test(d, id));
  const failed = steps.find((s) => s.state === 'fail');
  if (failed) {
    void vscode.window.showWarningMessage(`Local model ${recipe.label} is set up, but the test failed: ${failed.text}${failed.hint ? ` (${failed.hint})` : ''}`, 'Open Backends').then((c) => c && d.openBackend(id));
  } else {
    void vscode.window.showInformationMessage(`Local model ready (${recipe.label}). Start typing in a code file; press Tab to accept a suggestion.`);
  }
  return { ok: true, backendId: id, steps };
}

/** Every file under `dir`, with its size; none when the folder does not exist. */
async function listFiles(dir: string): Promise<{ path: string; bytes: number }[]> {
  let names: string[];
  try {
    names = await readdir(dir, { recursive: true });
  } catch {
    return [];
  }
  const out: { path: string; bytes: number }[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const s = await stat(path).catch(() => undefined);
    if (s?.isFile()) out.push({ path, bytes: s.size });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** AI Autocomplete: Remove Downloaded Models. The router's presets drop the deleted files. */
export async function removeLocalModels(d: SetupDeps): Promise<void> {
  const dir = modelsDir(d.context, d.settings());
  // A partial download that is running now is not offered: deleting it would break that download.
  const files = (await listFiles(dir)).filter((f) => !downloading.has(f.path));
  if (files.length === 0) {
    void vscode.window.showInformationMessage('No downloaded models.');
    return;
  }
  const picks = await vscode.window.showQuickPick(
    files.map((f) => ({ label: relative(dir, f.path), description: `${size(f.bytes)}${f.path.endsWith('.part') ? ' — partial download' : ''}`, file: f })),
    { canPickMany: true, placeHolder: 'Delete which downloaded models?' },
  );
  if (!picks || picks.length === 0) return;
  const total = picks.reduce((n, p) => n + p.file.bytes, 0);
  const yes: vscode.MessageItem = { title: 'Delete' };
  const answer = await vscode.window.showWarningMessage(
    `Delete ${picks.length === 1 ? picks[0].label : `${picks.length} files`} (${size(total)})?`,
    { modal: true, detail: 'A local model whose file is deleted stops working until it is downloaded again.' },
    yes,
  );
  if (answer !== yes) return;
  const failed: string[] = [];
  for (const p of picks) {
    try {
      await rm(p.file.path, { force: true });
    } catch (err) {
      d.log.error(`could not delete ${p.file.path}`, err);
      failed.push(p.label);
    }
  }
  // The presets list downloaded models only: the router stops serving the deleted ones.
  await d.router.syncPresets();
  if (failed.length > 0) void vscode.window.showErrorMessage(`Could not delete: ${failed.join(', ')}.`);
  else void vscode.window.showInformationMessage(`Deleted ${picks.length === 1 ? picks[0].label : `${picks.length} files`}.`);
}
