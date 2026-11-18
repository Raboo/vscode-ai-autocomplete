import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { renameBackendEntry } from '../../config/rename';
import type { Settings } from '../../config/settings';
import type { Log } from '../../log';
import { upsertBackend } from '../../manage/form';
import { MANAGED_KEY, type ManagedServer } from '../backendEntry';
import { freePort, probePort, type SpawnLike } from '../llamaServer';
import type { Recipe } from '../recipes';
import { findRuntime, type RuntimeEnv } from '../runtimes';
import { ServerPool, launchLlamaServer, type Started } from '../serverPool';

export interface LocalServersDeps {
  context: vscode.ExtensionContext;
  log: Log;
  settings(): Settings;
  /** Shows the output channel. */
  showLog(): void;
  spawnFn?: SpawnLike;
  /** The recipes managed servers may use; RECIPES when unset (tests swap in their own). */
  recipes?(): readonly Recipe[];
  /** A backend's server answers now (started or adopted). */
  onReady?(backendId: string): void;
}

/** The machine as runtime lookup sees it: platform, home, PATH and the file system. */
export function realEnv(): RuntimeEnv {
  return {
    platform: process.platform,
    home: homedir(),
    pathEnv: process.env.PATH ?? '',
    exists: (p) => existsSync(p),
  };
}

const isEntry = (e: unknown): e is Record<string, unknown> => typeof e === 'object' && e !== null && !Array.isArray(e);

/** Points the backend's `baseUrl` in user settings at `port`; a backend not written yet is left alone. */
async function moveBackend(backendId: string, port: number): Promise<void> {
  const config = vscode.workspace.getConfiguration('aiAutocomplete');
  const list = config.inspect('backends')?.globalValue;
  const entry = Array.isArray(list) ? (list as unknown[]).find((e) => isEntry(e) && e.id === backendId) : undefined;
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
  await config.update('backends', upsertBackend(list, { ...renameBackendEntry(entry).entry, baseUrl }, backendId), vscode.ConfigurationTarget.Global);
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

/** The llama-server processes of the local backends, with their records in global state and their backends in user settings. */
export class LocalServers implements vscode.Disposable {
  private readonly pool: ServerPool;

  constructor(d: LocalServersDeps) {
    const state = d.context.globalState;
    this.pool = new ServerPool({
      launch: launchLlamaServer(d.spawnFn),
      binary: () => findRuntime('llamaServer', realEnv(), d.settings().local.llamaServerPath),
      freePort: (p) => freePort(p),
      fileExists: (p) => existsSync(p),
      readManaged: () => state.get(MANAGED_KEY),
      writeManaged: async (list) => state.update(MANAGED_KEY, list),
      moveBackend,
      settings: () => d.settings(),
      log: d.log,
      probe: (port, alias) => probePort(port, alias),
      alive,
      terminate,
      stoppedUnexpectedly: (id) => {
        void vscode.window.showErrorMessage(`Local model ${id} stopped unexpectedly.`, 'Show Log').then((c) => c && d.showLog());
      },
      onReady: (id) => d.onReady?.(id),
      ...(d.recipes ? { recipes: d.recipes } : {}),
    });
  }

  start(m: ManagedServer): Promise<Started> {
    return this.pool.start(m);
  }

  startSelected(): Promise<void> {
    return this.pool.startSelected();
  }

  stop(backendId: string): Promise<void> {
    return this.pool.stop(backendId);
  }

  selectionChanged(before: Settings, after: Settings): Promise<void> {
    return this.pool.selectionChanged(before, after);
  }

  stopAll(): Promise<void> {
    return this.pool.stopAll();
  }

  stopEverywhere(): Promise<boolean> {
    return this.pool.stopEverywhere();
  }

  record(m: ManagedServer): Promise<void> {
    return this.pool.record(m);
  }

  forget(backendId: string): Promise<void> {
    return this.pool.forget(backendId);
  }

  running(): string[] {
    return this.pool.running();
  }

  active(): string[] {
    return this.pool.active();
  }

  dispose(): void {
    this.pool.dispose();
  }
}
