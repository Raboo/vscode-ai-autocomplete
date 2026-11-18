import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { renameBackendEntry } from '../../config/rename';
import type { Settings } from '../../config/settings';
import type { Log } from '../../log';
import { DEFAULT_PORT, LOCAL_BACKEND_ID, MANAGED_KEY, localEntryPort, parseManaged, upsertLocalEntry } from '../backendEntry';
import { freePort, type SpawnLike } from '../llamaServer';
import { LEGACY_MANAGED_KEY, legacyServers, planMigration, type LegacyServer } from '../migrate';
import type { LocalModel } from '../modelList';
import { RECIPES, modelPathSegments, type Recipe } from '../recipes';
import { RouterClient, probeRouter } from '../router';
import { findRuntime, type RuntimeEnv } from '../runtimes';
import { ServerPool, launchLlamaServer } from '../serverPool';

export interface LocalServersDeps {
  context: vscode.ExtensionContext;
  log: Log;
  settings(): Settings;
  /** Shows the output channel. */
  showLog(): void;
  spawnFn?: SpawnLike;
  /** The built-in models; RECIPES when unset (tests swap in their own). */
  recipes?(): readonly Recipe[];
  /** The `local` backend's router answers now (started or adopted). */
  onReady?(backendId: string): void;
}

const HELP_TIMEOUT_MS = 10_000;
const LEGACY_PROBE_MS = 2000;

/** The machine as runtime lookup sees it: platform, home, PATH and the file system. */
export function realEnv(): RuntimeEnv {
  return {
    platform: process.platform,
    home: homedir(),
    pathEnv: process.env.PATH ?? '',
    exists: (p) => existsSync(p),
  };
}

/** Where downloaded models live: `aiAutocomplete.local.modelsDir`, or `<globalStorage>/models`. */
export function modelsDir(context: vscode.ExtensionContext, s: Settings): string {
  return s.local.modelsDir ?? join(context.globalStorageUri.fsPath, 'models');
}

/** `<models folder>/<owner>/<name>/<file>` when that file is there with the model's size (its sha256 was checked when it was downloaded). */
export function downloadedPath(dir: string, m: LocalModel): string | undefined {
  const segments = modelPathSegments(m);
  if (!segments) return undefined;
  const path = join(dir, ...segments);
  try {
    return statSync(path).size === m.bytes ? path : undefined;
  } catch {
    return undefined;
  }
}

/** `<binary> --help` (an argument array, never a shell), stdout and stderr together. */
function helpText(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, ['--help'], { timeout: HELP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const text = `${stdout}\n${stderr}`;
      // Some builds exit non-zero after printing the help; the text is what counts.
      if (err && text.trim() === '') reject(err);
      else resolve(text);
    });
  });
}

const isEntry = (e: unknown): e is Record<string, unknown> => typeof e === 'object' && e !== null && !Array.isArray(e);
const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('aiAutocomplete');

/** Points `local`'s `baseUrl` in user settings at `port`; a backend not written yet is left alone. */
async function moveBackend(port: number): Promise<void> {
  const list = config().inspect('backends')?.globalValue;
  const entry = Array.isArray(list) ? (list as unknown[]).find((e) => isEntry(e) && e.id === LOCAL_BACKEND_ID) : undefined;
  if (!isEntry(entry)) return;
  let baseUrl = `http://127.0.0.1:${port}`;
  if (typeof entry.baseUrl === 'string') {
    try {
      const url = new URL(entry.baseUrl);
      url.port = String(port);
      baseUrl = url.toString().replace(/\/$/, '');
    } catch {
      // not a URL: write the plain local one
    }
  }
  const next = (list as unknown[]).map((e) => (isEntry(e) && e.id === LOCAL_BACKEND_ID ? { ...renameBackendEntry(e).entry, baseUrl } : e));
  await config().update('backends', next, vscode.ConfigurationTarget.Global);
}

/** Whether a process with this pid exists and this user may signal it (signal 0 sends nothing). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminate(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // gone already
  }
}

/** Whether an old per-model llama-server still serves its record's port: `/props` names its file or its alias. */
async function legacyServing(rec: LegacyServer, recipes: readonly Recipe[]): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${rec.port}/props`, { signal: AbortSignal.timeout(LEGACY_PROBE_MS) });
    if (res.status !== 200) {
      await res.body?.cancel();
      return false;
    }
    const props = (await res.json()) as { model_path?: unknown; model_alias?: unknown };
    const alias = recipes.find((r) => r.id === rec.recipeId)?.modelName;
    return (rec.file !== undefined && props.model_path === rec.file) || (alias !== undefined && props.model_alias === alias);
  } catch {
    return false;
  }
}

/** The llama-server router of the `local` backend, with its record in global state and `local` in user settings. */
export class LocalServers implements vscode.Disposable {
  /** The router, for the Local Models page. */
  readonly pool: ServerPool;

  constructor(private readonly d: LocalServersDeps) {
    const state = d.context.globalState;
    const storage = d.context.globalStorageUri.fsPath;
    const presetsPath = join(storage, 'presets.ini');
    this.pool = new ServerPool({
      launch: launchLlamaServer(d.spawnFn),
      binary: () => findRuntime('llamaServer', realEnv(), d.settings().local.llamaServerPath),
      helpText,
      freePort: (p) => freePort(p),
      presetsPath,
      writePresets: async (text) => {
        await mkdir(storage, { recursive: true });
        await writeFile(presetsPath, text, 'utf8');
      },
      downloadedPath: (m) => downloadedPath(modelsDir(d.context, d.settings()), m),
      readManaged: () => state.get(MANAGED_KEY),
      writeManaged: async (rec) => state.update(MANAGED_KEY, rec),
      moveBackend,
      settings: () => d.settings(),
      log: d.log,
      probe: (port, names) => probeRouter(port, names),
      router: (port) => new RouterClient(`http://127.0.0.1:${port}`),
      alive,
      terminate,
      stoppedUnexpectedly: () => {
        void vscode.window.showErrorMessage('The local model server stopped unexpectedly.', 'Show Log').then((c) => c && d.showLog());
      },
      onReady: (id) => d.onReady?.(id),
      focused: () => vscode.window.state.focused,
      ...(d.recipes ? { recipes: d.recipes } : {}),
    });
  }

  /** Activation: moves old per-model helper backends to `local` (once, when there are any), then starts the router when `local` is selected. Never throws. */
  async activate(): Promise<void> {
    await this.migrate();
    await this.pool.startSelected();
  }

  /**
   * Old `local-<recipe>` llama-server backends: their processes stop, `local` takes over their selections (written in
   * the order that never leaves a selection naming a missing backend), they are removed, and their records are cleared.
   */
  private async migrate(): Promise<void> {
    const state = this.d.context.globalState;
    try {
      const raw = config().inspect('backends')?.globalValue;
      const backends = Array.isArray(raw) ? (raw as unknown[]) : [];
      const legacy = state.get(LEGACY_MANAGED_KEY);
      const plan = planMigration({ backends, managed: legacy, settings: this.d.settings() });
      if (plan.log === '') {
        if (legacy !== undefined) await state.update(LEGACY_MANAGED_KEY, undefined);
        return;
      }
      const recipes = this.d.recipes?.() ?? RECIPES;
      for (const rec of legacyServers(legacy)) {
        if (rec.pid === undefined || !plan.stopPids.includes(rec.pid) || !alive(rec.pid)) continue;
        if (await legacyServing(rec, recipes)) terminate(rec.pid);
      }
      let list = backends;
      if (plan.local) {
        const port = localEntryPort(list) ?? parseManaged(state.get(MANAGED_KEY))?.port ?? DEFAULT_PORT;
        list = upsertLocalEntry(list, plan.local, port);
        await config().update('backends', list, vscode.ConfigurationTarget.Global);
      }
      if (plan.select.completions) await config().update('completions.backend', LOCAL_BACKEND_ID, vscode.ConfigurationTarget.Global);
      if (plan.select.nextEdit) await config().update('nextEdit.backend', LOCAL_BACKEND_ID, vscode.ConfigurationTarget.Global);
      if (plan.removeIds.length > 0) {
        list = list.filter((e) => !(isEntry(e) && typeof e.id === 'string' && plan.removeIds.includes(e.id)));
        await config().update('backends', list, vscode.ConfigurationTarget.Global);
      }
      await state.update(LEGACY_MANAGED_KEY, undefined);
      this.d.log.info(plan.log);
    } catch (err) {
      this.d.log.error('local models: moving the old local backends to the router failed', err);
    }
  }

  startSelected(): Promise<void> {
    return this.pool.startSelected();
  }

  settingsChanged(before: Settings, after: Settings): Promise<void> {
    return this.pool.settingsChanged(before, after);
  }

  /** This window's router only (deactivate). */
  stopHere(): Promise<void> {
    return this.pool.stopHere();
  }

  stopEverywhere(): Promise<boolean> {
    return this.pool.stopEverywhere();
  }

  dispose(): void {
    this.pool.dispose();
  }
}
