import * as vscode from 'vscode';
import { readdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createBackend } from '../../backends';
import type { Secrets } from '../../config/secrets';
import type { BackendUse, Settings } from '../../config/settings';
import { readSettings } from '../../config/vscodeSettings';
import type { Log } from '../../log';
import { runConnectionTest } from '../../manage/connectionTest';
import type { TestStep } from '../../manage/protocol';
import { DEFAULT_PORT, LOCAL_BACKEND_ID, MANAGED_KEY, localEntryPort, parseManaged, routerWanted } from '../backendEntry';
import { DownloadError, downloadModel } from '../download';
import { HfError, authFor, pinnedFileUrl } from '../huggingFace';
import { mergeModels, type LocalModel } from '../modelList';
import { useEdits, type SettingWrite } from '../page/edits';
import type { DownloadView } from '../page/protocol';
import { downloadUrl, modelPathSegments, type Recipe } from '../recipes';
import type { ServerPool } from '../serverPool';
import { setupArgument } from '../setupArg';
import { modelsDir } from './servers';

/** What the Local Models page and the local model commands work with. */
export interface LocalDeps {
  context: vscode.ExtensionContext;
  log: Log;
  secrets: Secrets;
  settings(): Settings;
  /** The built-in models (RECIPES, or a test's own). */
  recipes(): readonly Recipe[];
  /** The router of the `local` backend. */
  router: ServerPool;
  downloads: Downloads;
  /** Opens the Backends page on a backend. */
  openBackend(id: string): void;
  /** Opens (or reveals) the Local Models page. */
  openPage(): void;
}

/** What a setup ended with; the command returns it so tests can check it. */
export type SetupOutcome =
  | { ok: true; backendId: string; steps: TestStep[] }
  | { ok: false; message: string }
  | undefined;

/** The model the first-run offer sets up. */
export const DEFAULT_RECIPE = 'sweep-1.5b';
const PROGRESS_MS = 250;
const HF_HOST = 'huggingface.co';
/** The settings selecting a backend that setup may change. */
const SELECTION_KEYS = ['completions.backend', 'completions.enabled', 'nextEdit.backend', 'nextEdit.enabled'] as const;

export const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('aiAutocomplete');
/** A user-settings (global) value: the page and setup write user settings only. */
export const userValue = (key: string): unknown => config().inspect(key)?.globalValue;
export const writeUser = async (key: string, value: unknown): Promise<void> => {
  await config().update(key, value, vscode.ConfigurationTarget.Global);
};
const size = (bytes: number): string => (bytes >= 1e8 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The model list: built-ins with the user's changes, plus added models. */
export function localModels(d: Pick<LocalDeps, 'recipes' | 'settings'>): { models: LocalModel[]; problems: string[] } {
  return mergeModels(d.recipes(), d.settings().local.models);
}

/** The default model of the first-run offer: Sweep 1.5B, or a test's first recipe. */
export function defaultModelName(recipes: readonly Recipe[]): string | undefined {
  return (recipes.find((r) => r.id === DEFAULT_RECIPE) ?? recipes[0])?.modelName;
}

/** Where a model's file goes, or undefined for an unsafe path. */
export function modelPath(d: Pick<LocalDeps, 'context' | 'settings'>, m: Pick<LocalModel, 'repo' | 'file'>, dir = modelsDir(d.context, d.settings())): string | undefined {
  const segments = modelPathSegments(m);
  return segments ? join(dir, ...segments) : undefined;
}

export const hfRepoPage = (repo: string): string => `https://${HF_HOST}/${repo.split('/').map(encodeURIComponent).join('/')}`;

/** A Hugging Face failure as fixed text, with the repo page when access was refused. */
export function hfProblem(err: unknown, repo: string): { error: string; link?: string } {
  if (err instanceof HfError) return { error: err.message, ...(err.kind === 'auth' ? { link: hfRepoPage(repo) } : {}) };
  return { error: 'The request to Hugging Face failed; see the log.' };
}

interface Job { ctl: AbortController; received: number; part?: string }

/**
 * The downloads of this window, one per model name: progress for the page (changes at most every 250 ms), Cancel, and
 * the last failure. Several may run at once.
 */
export class Downloads {
  private readonly jobs = new Map<string, Job>();
  private readonly failures = new Map<string, { error: string; link?: string }>();
  private readonly listeners = new Set<() => void>();
  private shownAt = 0;

  onChange(listener: () => void): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private changed(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.shownAt < PROGRESS_MS) return;
    this.shownAt = now;
    for (const l of this.listeners) l();
  }

  running(name?: string): boolean {
    return name === undefined ? this.jobs.size > 0 : this.jobs.has(name);
  }

  /** `.part` files being written now; Remove Downloaded Models leaves them out. */
  parts(): Set<string> {
    return new Set([...this.jobs.values()].map((j) => j.part).filter((p): p is string => p !== undefined));
  }

  /** The page's view of each model with a running or failed download. */
  views(): Record<string, DownloadView> {
    const out: Record<string, DownloadView> = {};
    for (const [name, f] of this.failures) out[name] = { kind: 'failed', error: f.error, ...(f.link ? { link: f.link } : {}) };
    for (const [name, j] of this.jobs) out[name] = { kind: 'running', received: j.received };
    return out;
  }

  clearFailure(name: string): void {
    if (this.failures.delete(name)) this.changed(true);
  }

  cancel(name: string): void {
    this.jobs.get(name)?.ctl.abort();
  }

  cancelAll(): void {
    for (const j of this.jobs.values()) j.ctl.abort();
  }

  /**
   * Runs `work` as the download of `name`; resolves undefined when it was cancelled. A failure is kept for the page
   * (fixed text; a 401/403 from Hugging Face gets the access text and the repo link) and thrown.
   */
  async run<T>(name: string, o: { part?: string; repo: string }, work: (signal: AbortSignal, progress: (received: number) => void) => Promise<T>): Promise<T | undefined> {
    if (this.jobs.has(name)) throw new DownloadError('This model is already downloading.', 'http');
    const job: Job = { ctl: new AbortController(), received: 0, ...(o.part ? { part: o.part } : {}) };
    this.jobs.set(name, job);
    this.failures.delete(name);
    this.changed(true);
    try {
      return await work(job.ctl.signal, (received) => {
        job.received = received;
        this.changed(false);
      });
    } catch (err) {
      if (err instanceof DownloadError && err.kind === 'cancelled') return undefined;
      const denied = err instanceof DownloadError && /status 40[13]\b/.test(err.message);
      this.failures.set(name, denied ? { error: new HfError('auth').message, link: hfRepoPage(o.repo) }
        : { error: err instanceof DownloadError ? err.message : 'The download failed; see the log.' });
      throw err;
    } finally {
      this.jobs.delete(name);
      this.changed(true);
    }
  }
}

/** The address of a model's file: the recipe's for a built-in model, the pinned commit's for an added one. */
function fileUrl(d: Pick<LocalDeps, 'recipes'>, m: LocalModel): string {
  const recipe = m.builtIn ? d.recipes().find((r) => r.modelName === m.name) : undefined;
  return recipe ? downloadUrl(recipe) : pinnedFileUrl(m.repo, m.revision, m.file);
}

/**
 * Downloads a model's file (resuming, sha256-checked) with the Hugging Face token for huggingface.co only, then makes
 * the router read the presets again. Undefined when cancelled; failures are thrown (and shown on the page's row).
 */
export async function downloadFile(d: LocalDeps, m: LocalModel, onProgress?: (received: number) => void): Promise<'downloaded' | 'present' | undefined> {
  const dest = modelPath(d, m);
  if (!dest) throw new DownloadError(`The local model "${m.name}" has an invalid file path.`, 'url');
  const token = await d.secrets.getHfToken();
  const result = await d.downloads.run(m.name, { part: `${dest}.part`, repo: m.repo }, (signal, progress) => downloadModel({
    url: fileUrl(d, m), dest, bytes: m.bytes, sha256: m.sha256, signal, authFor: authFor(token),
    onProgress: (received) => {
      progress(received);
      onProgress?.(received);
    },
  }));
  if (result !== undefined) {
    d.log.debug(`local model ${m.name}: ${result === 'present' ? 'file already present' : 'downloaded'}`);
    await d.router.syncPresets();
  }
  return result;
}

/** The port `local` is (or will be) on: the running router's, `local`'s own, the record's, or the default. */
export function routerPort(d: Pick<LocalDeps, 'router' | 'context'>): number {
  return d.router.port() ?? localEntryPort(userValue('backends')) ?? parseManaged(d.context.globalState.get(MANAGED_KEY))?.port ?? DEFAULT_PORT;
}

/** Writes `[key, value]` pairs to user settings in order. */
export async function writeAll(writes: SettingWrite[]): Promise<void> {
  for (const [key, value] of writes) await writeUser(key, value);
}

/**
 * Use for…: writes `local`'s model for these uses and selects `local` for each at the User target. The router starts
 * first when it is not running (its failure shows on the page), and the selection change loads the model.
 */
export async function useModel(d: LocalDeps, name: string, uses: BackendUse[]): Promise<void> {
  const state = d.router.state();
  if (state === 'stopped' || state === 'failed') {
    try {
      await d.router.start();
    } catch (err) {
      d.log.error('local models: llama-server could not start', err);
    }
  }
  const r = useEdits({ backends: userValue('backends'), name, uses, port: routerPort(d), settings: d.settings() });
  await writeUser('backends', r.backends);
  await writeAll(r.writes);
  // The selection may be unchanged (no settings event loads it): load it now.
  if (d.router.state() === 'running') await d.router.warm([name]);
}

type Selection = { key: (typeof SELECTION_KEYS)[number]; global: unknown; workspace: unknown }[];

function selection(): Selection {
  return SELECTION_KEYS.map((key) => {
    const i = config().inspect(key);
    return { key, global: i?.globalValue, workspace: i?.workspaceValue };
  });
}

async function restoreSelection(saved: Selection): Promise<void> {
  for (const s of saved) {
    const now = config().inspect(s.key);
    if (now?.globalValue !== s.global) await config().update(s.key, s.global, vscode.ConfigurationTarget.Global);
    if (now?.workspaceValue !== s.workspace) await config().update(s.key, s.workspace, vscode.ConfigurationTarget.Workspace);
  }
}

function busyWith<T>(title: string, work: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, work);
}

/** The Backends page's connection Test of `id`, run on the entry itself so it does not wait for the backends to be rebuilt. */
async function test(d: LocalDeps, id: string): Promise<TestStep[]> {
  const settings = readSettings().settings;
  const cfg = settings.backends.find((b) => b.id === id);
  if (!cfg) return [{ id: 'reach', state: 'fail', text: 'the backend was not saved' }];
  const r = await runConnectionTest(
    { backend: createBackend(cfg, async () => undefined), settings, localOnly: settings.privacy.localOnly, isLocal: async () => true, signal: new AbortController().signal, log: d.log },
    () => undefined,
  );
  return r.steps;
}

/** Takes a failed run back: the backends and the selection, and the router when this run started it and `local` is not selected. */
async function undo(d: LocalDeps, name: string, before: { backends: unknown; selection: Selection } | undefined, startedHere: boolean): Promise<void> {
  try {
    if (before) {
      await writeUser('backends', before.backends);
      await restoreSelection(before.selection);
    }
    if (startedHere && !routerWanted(readSettings().settings)) await d.router.stopHere();
  } catch (err) {
    d.log.error(`local model setup (${name}): cleaning up after a failure failed`, err);
  }
}

/** Downloads with a notification that can cancel it; the page's row shows the same progress. */
function downloadWithNotice(d: LocalDeps, m: LocalModel): Thenable<'downloaded' | 'present' | undefined> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Setting up ${m.label}`, cancellable: true },
    async (progress, token) => {
      const sub = token.onCancellationRequested(() => d.downloads.cancel(m.name));
      let shown = 0;
      progress.report({ message: 'checking the file…' });
      try {
        return await downloadFile(d, m, (received) => {
          const percent = m.bytes > 0 ? Math.floor((received / m.bytes) * 100) : 0;
          if (percent === shown) return;
          progress.report({ increment: percent - shown, message: `downloading: ${percent}% of ${size(m.bytes)}` });
          shown = percent;
        });
      } finally {
        sub.dispose();
      }
    },
  );
}

let busy = false;

/** Whether a one-button setup runs now (the page's offer shows it). */
export function settingUp(): boolean {
  return busy;
}

/**
 * The one-button setup (the page's first-run offer; tests run it through the command): download, start the router,
 * use the model for its uses, then run the Backends page's Test of `local` and show the result. A failure restores the
 * backends and the selection, and stops the router it started.
 */
export async function setUpModel(d: LocalDeps, m: LocalModel): Promise<SetupOutcome> {
  if (busy) {
    void vscode.window.showInformationMessage('A local model is already being set up.');
    return undefined;
  }
  busy = true;
  try {
    return await setUp(d, m);
  } finally {
    busy = false;
  }
}

async function setUp(d: LocalDeps, m: LocalModel): Promise<SetupOutcome> {
  // Before the download: a missing or too old llama-server (no router mode) fails here, not after gigabytes.
  const problem = await d.router.binaryProblem();
  if (problem !== undefined) {
    void vscode.window.showErrorMessage(problem);
    return { ok: false, message: problem };
  }
  let before: { backends: unknown; selection: Selection } | undefined;
  let startedHere = false;
  try {
    const got = await downloadWithNotice(d, m);
    if (got === undefined) {
      void vscode.window.showInformationMessage('The download was cancelled.');
      return undefined;
    }
    // Taken before the start: the pool moves the backend's baseUrl when the port is taken, and a failure puts it back.
    before = { backends: userValue('backends'), selection: selection() };
    if (d.router.state() !== 'running') {
      startedHere = true;
      await busyWith('Starting the local model server…', () => d.router.start());
    }
    const r = useEdits({ backends: userValue('backends'), name: m.name, uses: m.uses, port: routerPort(d), settings: d.settings() });
    await writeUser('backends', r.backends);
    await writeAll(r.writes);
    await d.router.warm([m.name]);
  } catch (err) {
    await undo(d, m.name, before, startedHere);
    d.log.error(`local model setup (${m.name}) failed`, err);
    const text = `Setting up ${m.label} failed: ${message(err)}`;
    void vscode.window.showErrorMessage(text);
    return { ok: false, message: text };
  }

  const id = LOCAL_BACKEND_ID;
  const steps = await busyWith(`Testing ${id}…`, () => test(d, id));
  const failed = steps.find((s) => s.state === 'fail');
  if (failed) {
    void vscode.window.showWarningMessage(`Local model ${m.label} is set up, but the test failed: ${failed.text}${failed.hint ? ` (${failed.hint})` : ''}`, 'Open Backends').then((c) => c && d.openBackend(id));
  } else {
    void vscode.window.showInformationMessage(`Local model ready (${m.label}). Start typing in a code file; press Tab to accept a suggestion.`);
  }
  return { ok: true, backendId: id, steps };
}

/**
 * AI Autocomplete: Set Up Local Model opens the Local Models page (its first-run offer is the one-button setup). In
 * tests an argument (`SetupArg`) runs that setup for a recipe instead and returns the outcome.
 */
export async function setUpLocalModel(d: LocalDeps, arg?: unknown): Promise<SetupOutcome> {
  if (vscode.env.remoteName !== undefined) {
    void vscode.window.showInformationMessage('The local model helper works in local windows only.');
    return undefined;
  }
  const parsed = setupArgument(arg, d.recipes(), d.context.extensionMode === vscode.ExtensionMode.Test);
  if (parsed === 'invalid') {
    void vscode.window.showErrorMessage('AI Autocomplete: unknown local model.');
    return undefined;
  }
  if (parsed === 'none') {
    d.openPage();
    return undefined;
  }
  const m = localModels(d).models.find((x) => x.name === parsed.recipe.modelName);
  if (!m) return undefined;
  return setUpModel(d, m);
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

/**
 * AI Autocomplete: Remove Downloaded Models. Offers the files of the model list in the configured models folder (and
 * their partial downloads, except running ones); the router's presets then drop the deleted files.
 */
export async function removeLocalModels(d: LocalDeps): Promise<void> {
  const dir = modelsDir(d.context, d.settings());
  const known = new Map<string, string>();
  for (const m of localModels(d).models) {
    const path = modelPath(d, m, dir);
    if (path) {
      known.set(path, m.name);
      known.set(`${path}.part`, m.name);
    }
  }
  const running = d.downloads.parts();
  const files = (await listFiles(dir)).filter((f) => known.has(f.path) && !running.has(f.path));
  if (files.length === 0) {
    void vscode.window.showInformationMessage('No downloaded models.');
    return;
  }
  const picks = await vscode.window.showQuickPick(
    files.map((f) => ({ label: known.get(f.path) ?? relative(dir, f.path), description: `${size(f.bytes)}${f.path.endsWith('.part') ? ' — partial download' : ''}`, detail: relative(dir, f.path), file: f })),
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
  await d.router.syncPresets();
  if (failed.length > 0) void vscode.window.showErrorMessage(`Could not delete: ${failed.join(', ')}.`);
  else void vscode.window.showInformationMessage(`Deleted ${picks.length === 1 ? picks[0].label : `${picks.length} files`}.`);
}
