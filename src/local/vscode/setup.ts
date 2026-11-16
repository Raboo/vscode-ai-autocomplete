import * as vscode from 'vscode';
import { readdir, rm, stat } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { join, relative } from 'node:path';
import { createBackend } from '../../backends';
import type { BackendUse, Settings } from '../../config/settings';
import { readSettings } from '../../config/vscodeSettings';
import type { Log } from '../../log';
import { runConnectionTest } from '../../manage/connectionTest';
import { upsertBackend } from '../../manage/form';
import type { TestStep } from '../../manage/protocol';
import { useBackend, useNextEditBackend } from '../../ui/commands';
import { MANAGED_KEY, localBackendEntry, localBackendId, parseManaged, serversToStart, type LocalRuntime, type ManagedServer } from '../backendEntry';
import { DownloadError, downloadModel } from '../download';
import { LmStudio, defaultExec } from '../lmStudio';
import { downloadUrl, fitsMemory, modelPathSegments, type Recipe } from '../recipes';
import { INSTALL_HINT, findRuntime, type RuntimeId } from '../runtimes';
import type { RunningServer } from '../serverPool';
import { realEnv } from './servers';

export interface SetupDeps {
  context: vscode.ExtensionContext;
  log: Log;
  settings(): Settings;
  /** The recipes to offer (RECIPES, or a test's own). */
  recipes(): readonly Recipe[];
  servers: {
    start(m: ManagedServer): Promise<RunningServer>;
    stop(backendId: string): Promise<void>;
    record(m: ManagedServer): Promise<void>;
    forget(backendId: string): Promise<void>;
  };
  /** Opens the Backends page on a backend. */
  openBackend(id: string): void;
}

/** `replace: true` skips the "Replace the backend?" question (tests only). */
export interface SetupArg { recipe: string; runtime: LocalRuntime; replace?: boolean }

/** What a setup ended with; the command returns it so tests can check it. */
export type SetupOutcome =
  | { ok: true; backendId: string; steps: TestStep[] }
  | { ok: false; message: string }
  | undefined;

const PREFERRED_PORT = 8012;
const RECOMMENDED = 'sweep-1.5b';
const PROGRESS_MS = 250;
const RUNTIMES: readonly LocalRuntime[] = ['llamaServer', 'lmStudio'];
const RUNTIME_ID: Record<LocalRuntime, RuntimeId> = { llamaServer: 'llamaServer', lmStudio: 'lms' };
const RUNTIME_LABEL: Record<LocalRuntime, string> = { llamaServer: 'llama-server', lmStudio: 'LM Studio' };
const RUNTIME_NOTE: Record<LocalRuntime, string> = {
  llamaServer: 'runs the model as a process VS Code starts and stops',
  lmStudio: 'loads the model into LM Studio',
};
const USE_LABEL: Record<BackendUse, string> = { completions: 'Completions', nextEdit: 'Next Edit' };
/** The settings selecting a backend that setup may change (through useBackend and useNextEditBackend). */
const SELECTION_KEYS = ['fim.backend', 'fim.enabled', 'nextEdit.backend', 'nextEdit.enabled'] as const;

const isEntry = (e: unknown): e is Record<string, unknown> => typeof e === 'object' && e !== null && !Array.isArray(e);
const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('aiAutocomplete');
const userBackends = (): unknown => config().inspect('backends')?.globalValue;
const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;
const size = (bytes: number): string => (bytes >= 1e8 ? gb(bytes) : `${Math.max(1, Math.round(bytes / 1e6))} MB`);
const mb = (bytes: number): number => Math.round(bytes / 1e6);
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Where downloaded models live: `<globalStorage>/models`. */
export function modelsDir(context: vscode.ExtensionContext): string {
  return join(context.globalStorageUri.fsPath, 'models');
}

function runtimePath(runtime: LocalRuntime, s: Settings): string | undefined {
  const override = runtime === 'llamaServer' ? s.local.llamaServerPath : s.local.lmsPath;
  return findRuntime(RUNTIME_ID[runtime], realEnv(), override);
}

/** The command argument as a SetupArg; undefined (after an error message) when it names an unknown recipe or runtime. */
function parseArg(arg: unknown, recipes: readonly Recipe[]): { recipe: Recipe; runtime: LocalRuntime; replace: boolean } | undefined {
  const o = isEntry(arg) ? arg : {};
  const recipe = recipes.find((r) => r.id === o.recipe);
  const runtime = RUNTIMES.find((r) => r === o.runtime);
  if (!recipe || !runtime) {
    void vscode.window.showErrorMessage('AI Autocomplete: unknown local model or runtime.');
    return undefined;
  }
  return { recipe, runtime, replace: o.replace === true };
}

async function pickRuntime(s: Settings): Promise<LocalRuntime | undefined> {
  type Item = vscode.QuickPickItem & { runtime: LocalRuntime; found: boolean };
  const items: Item[] = RUNTIMES.map((runtime) => {
    const found = runtimePath(runtime, s) !== undefined;
    return found
      ? { label: RUNTIME_LABEL[runtime], description: RUNTIME_NOTE[runtime], runtime, found }
      : { label: RUNTIME_LABEL[runtime], description: 'not installed', detail: INSTALL_HINT[RUNTIME_ID[runtime]], runtime, found };
  });
  items.sort((a, b) => Number(b.found) - Number(a.found));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Run the local model with' });
  if (!pick) return undefined;
  if (!pick.found) {
    void vscode.window.showInformationMessage(INSTALL_HINT[RUNTIME_ID[pick.runtime]]);
    return undefined;
  }
  return pick.runtime;
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

/** Downloads the recipe's file with a cancellable progress notification; undefined when the user cancelled. */
async function download(d: SetupDeps, r: Recipe, dest: string): Promise<'downloaded' | 'present' | undefined> {
  const url = downloadUrl(r);
  const host = new URL(url).host;
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Downloading ${r.label} from ${host}`, cancellable: true },
    async (progress, token) => {
      const ctl = new AbortController();
      const sub = token.onCancellationRequested(() => ctl.abort());
      let shownPercent = 0;
      let shownAt = 0;
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
            if (percent === shownPercent && now - shownAt < PROGRESS_MS) return;
            progress.report({ increment: Math.max(0, percent - shownPercent), message: `${percent}% (${mb(received)} of ${mb(total)} MB)` });
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
        sub.dispose();
      }
    },
  );
}

/** Starts the model and returns the port it is served on, plus the record of a llama-server it started. */
async function startRuntime(d: SetupDeps, r: Recipe, runtime: LocalRuntime, binary: string, file: string): Promise<{ port: number; managed?: ManagedServer }> {
  if (runtime === 'lmStudio') {
    // LM Studio is the user's app: a failure here or later leaves its server running and any model it loaded, on purpose.
    const lms = new LmStudio(binary, defaultExec);
    const modelKey = await lms.importModel(file, r.repo);
    const port = await lms.ensureServer();
    await lms.load(modelKey, r.contextTokens, r.modelName);
    return { port };
  }
  // The pool stops a server already running for this backend, then takes the preferred port or a free one.
  const m: ManagedServer = { backendId: localBackendId(r, runtime), recipeId: r.id, file, port: PREFERRED_PORT };
  const proc = await d.servers.start(m);
  return { port: proc.port, managed: { ...m, port: proc.port } };
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

interface UndoPlan {
  id: string;
  recipe: Recipe;
  /** This backend's managed server before the run. */
  previous: ManagedServer | undefined;
  /** The llama-server this run started. */
  managed: ManagedServer | undefined;
  /** Settings as they were just before the run wrote any. */
  before: { backends: unknown; selection: Selection } | undefined;
  /** Whether the run started a llama-server, which halts the previous one first. */
  startAttempted: boolean;
}

/**
 * Takes a failed run back: stops the server it started, restores the backends and the selection, puts the previous
 * record back (or forgets the new one) and starts the previous server again when its backend is still selected.
 * Never throws: a cleanup failure is logged.
 */
async function undo(d: SetupDeps, u: UndoPlan): Promise<void> {
  try {
    if (u.managed) await d.servers.stop(u.id);
    if (u.before) {
      await config().update('backends', u.before.backends, vscode.ConfigurationTarget.Global);
      await restoreSelection(u.before.selection);
    }
    if (u.previous) await d.servers.record(u.previous);
    else if (u.managed) await d.servers.forget(u.id);
  } catch (err) {
    d.log.error(`local model setup (${u.recipe.id}): cleaning up after a failure failed`, err);
  }
  const previous = u.previous;
  if (!previous || !u.startAttempted || serversToStart([previous], readSettings().settings).length === 0) return;
  // Not awaited: the model may take a while to load, and the error should show now.
  void d.servers
    .start(previous)
    .then((proc) => (proc.port !== previous.port ? d.servers.record({ ...previous, port: proc.port }) : undefined))
    .catch((err: unknown) => d.log.error(`local model "${previous.backendId}" could not start again`, err));
}

let busy = false;

/**
 * AI Autocomplete: Set Up Local Model. With an argument (`SetupArg`) the pickers are skipped. Downloads the recipe's file,
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
  let runtime: LocalRuntime;
  let replace = false;
  if (arg !== undefined) {
    const parsed = parseArg(arg, d.recipes());
    if (!parsed) return undefined;
    ({ recipe, runtime, replace } = parsed);
  } else {
    const rt = await pickRuntime(d.settings());
    if (!rt) return undefined;
    const r = await pickRecipe(d.recipes());
    if (!r) return undefined;
    runtime = rt;
    recipe = r;
  }

  const binary = runtimePath(runtime, d.settings());
  if (!binary) {
    const text = `${RUNTIME_LABEL[runtime]} was not found. ${INSTALL_HINT[RUNTIME_ID[runtime]]}`;
    void vscode.window.showErrorMessage(text);
    return { ok: false, message: text };
  }

  const id = localBackendId(recipe, runtime);
  const exists = (Array.isArray(userBackends()) ? (userBackends() as unknown[]) : []).some((e) => isEntry(e) && e.id === id);
  if (exists && !replace) {
    const yes: vscode.MessageItem = { title: 'Yes' };
    const pick = await vscode.window.showWarningMessage(`Replace the backend ${id}?`, { modal: true }, yes, { title: 'No', isCloseAffordance: true });
    if (pick !== yes) return undefined;
  }

  const segments = modelPathSegments(recipe);
  if (!segments) {
    const text = `AI Autocomplete: the local model "${recipe.id}" has an invalid file path.`;
    void vscode.window.showErrorMessage(text);
    return { ok: false, message: text };
  }

  // A re-run replaces this backend's server: on a failure, the previous record and server come back.
  const previous = parseManaged(d.context.globalState.get(MANAGED_KEY)).find((e) => e.backendId === id);
  let managed: ManagedServer | undefined;
  let before: { backends: unknown; selection: Selection } | undefined;
  let startAttempted = false;
  try {
    const file = join(modelsDir(d.context), ...segments);
    const got = await download(d, recipe, file);
    if (got === undefined) {
      void vscode.window.showInformationMessage('The download was cancelled.');
      return undefined;
    }
    startAttempted = runtime === 'llamaServer';
    const started = await busyWith(`Starting ${recipe.label}…`, () => startRuntime(d, recipe, runtime, binary, file));
    managed = started.managed;
    before = { backends: userBackends(), selection: selection() };
    await config().update('backends', upsertBackend(userBackends(), localBackendEntry(recipe, runtime, started.port), id), vscode.ConfigurationTarget.Global);
    if (managed) await d.servers.record(managed);
    if (recipe.uses.includes('completions')) await useBackend(id);
    if (recipe.uses.includes('nextEdit')) await useNextEditBackend(id);
  } catch (err) {
    await undo(d, { id, recipe, previous, managed, before, startAttempted });
    d.log.error(`local model setup (${recipe.id}, ${runtime}) failed`, err);
    const text = `Setting up ${recipe.label} failed: ${message(err)}`;
    void vscode.window.showErrorMessage(text);
    return { ok: false, message: text };
  }

  const steps = await busyWith(`Testing ${id}…`, () => test(d, id));
  const failed = steps.find((s) => s.state === 'fail');
  if (failed) {
    void vscode.window.showWarningMessage(`Local model ${id} is set up, but the test failed: ${failed.text}${failed.hint ? ` (${failed.hint})` : ''}`, 'Open Backends').then((c) => c && d.openBackend(id));
  } else {
    void vscode.window.showInformationMessage(`Local model ready: ${id}`);
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

/** AI Autocomplete: Remove Downloaded Models. Stops and forgets the managed servers that use a deleted file. */
export async function removeLocalModels(d: SetupDeps): Promise<void> {
  const dir = modelsDir(d.context);
  const files = await listFiles(dir);
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
    { modal: true, detail: 'Models imported into LM Studio keep their data there. A local backend that uses a deleted file stops working until you set it up again.' },
    yes,
  );
  if (answer !== yes) return;
  const managed = parseManaged(d.context.globalState.get(MANAGED_KEY));
  const failed: string[] = [];
  for (const p of picks) {
    try {
      for (const m of managed.filter((e) => e.file === p.file.path)) {
        await d.servers.stop(m.backendId);
        await d.servers.forget(m.backendId);
      }
      await rm(p.file.path, { force: true });
    } catch (err) {
      d.log.error(`could not delete ${p.file.path}`, err);
      failed.push(p.label);
    }
  }
  if (failed.length > 0) void vscode.window.showErrorMessage(`Could not delete: ${failed.join(', ')}.`);
  else void vscode.window.showInformationMessage(`Deleted ${picks.length === 1 ? picks[0].label : `${picks.length} files`}.`);
}
