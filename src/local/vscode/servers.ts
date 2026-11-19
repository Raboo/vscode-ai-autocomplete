import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { renameBackendEntry } from '../../config/rename';
import type { Settings } from '../../config/settings';
import type { Log } from '../../log';
import { LOCAL_BACKEND_ID, MANAGED_KEY, parseManaged } from '../backendEntry';
import { freePort, type SpawnLike } from '../llamaServer';
import { LEGACY_MANAGED_KEY, MIGRATED_KEY, applyMigration, type LegacyServer } from '../migrate';
import type { LocalModel } from '../modelList';
import { RECIPES, modelPathSegments, type Recipe } from '../recipes';
import { RouterClient, probeRouter } from '../router';
import { findRuntime, type RuntimeEnv } from '../runtimes';
import { SERVER_LOG_FILE, ServerLogFile } from '../serverLog';
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

/** The llama-server log every window shares: `<globalStorage>/llama-server.log`. */
export function serverLogPath(context: vscode.ExtensionContext): string {
  return join(context.globalStorageUri.fsPath, SERVER_LOG_FILE);
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
      serverLog: new ServerLogFile(serverLogPath(d.context), { onError: (err) => d.log.warn(`local models: writing the server log file failed: ${err instanceof Error ? err.message : String(err)}`) }),
      focused: () => vscode.window.state.focused,
      ...(d.recipes ? { recipes: d.recipes } : {}),
    });
  }

  /** Activation: moves old per-model helper backends to `local` (once), then starts the router when `local` is selected. Never throws. */
  async activate(): Promise<void> {
    await this.migrate();
    await this.pool.startSelected();
  }

  /** Old `local-<recipe>` llama-server backends move to `local`, once (a flag in global state). Never throws. */
  async migrate(): Promise<void> {
    const state = this.d.context.globalState;
    if (state.get(MIGRATED_KEY) === true) return;
    try {
      // Marked first: a second window starting at the same moment skips it once the flag reaches it, and applyMigration
      // re-reads the backends right before writing for the case where it has not.
      await state.update(MIGRATED_KEY, true);
      const raw = config().inspect('backends')?.globalValue;
      const recipes = this.d.recipes?.() ?? RECIPES;
      const routerPort = parseManaged(state.get(MANAGED_KEY))?.port;
      await applyMigration(
        { backends: Array.isArray(raw) ? (raw as unknown[]) : [], managed: state.get(LEGACY_MANAGED_KEY), settings: this.d.settings(), recipes, ...(routerPort !== undefined ? { routerPort } : {}) },
        {
          writeBackends: async (list) => config().update('backends', list, vscode.ConfigurationTarget.Global),
          select: async (use) => config().update(use === 'completions' ? 'completions.backend' : 'nextEdit.backend', LOCAL_BACKEND_ID, vscode.ConfigurationTarget.Global),
          alive,
          serving: (rec) => legacyServing(rec, recipes),
          terminate,
          finish: async () => {
            await state.update(LEGACY_MANAGED_KEY, undefined);
          },
          backendsNow: () => {
            const now = config().inspect('backends')?.globalValue;
            return Array.isArray(now) ? (now as unknown[]) : [];
          },
          log: this.d.log,
        },
      );
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
