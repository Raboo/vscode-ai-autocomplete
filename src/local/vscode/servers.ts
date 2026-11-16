import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Settings } from '../../config/settings';
import type { Log } from '../../log';
import { upsertBackend } from '../../manage/form';
import { MANAGED_KEY, type ManagedServer } from '../backendEntry';
import { freePort, type SpawnLike } from '../llamaServer';
import type { Recipe } from '../recipes';
import { findRuntime, type RuntimeEnv } from '../runtimes';
import { ServerPool, launchLlamaServer, type RunningServer } from '../serverPool';

export interface LocalServersDeps {
  context: vscode.ExtensionContext;
  log: Log;
  settings(): Settings;
  spawnFn?: SpawnLike;
  /** The recipes managed servers may use; RECIPES when unset (tests swap in their own). */
  recipes?(): readonly Recipe[];
}

/** The machine as runtime lookup sees it: platform, home, PATH and the file system. */
export function realEnv(): RuntimeEnv {
  return {
    platform: process.platform,
    home: homedir(),
    pathEnv: process.env.PATH ?? '',
    exists: (p) => existsSync(p),
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    },
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
  await config.update('backends', upsertBackend(list, { ...entry, baseUrl }, backendId), vscode.ConfigurationTarget.Global);
}

/** The llama-server processes the extension started, with their records in global state and their backends in user settings. */
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
      ...(d.recipes ? { recipes: d.recipes } : {}),
    });
  }

  start(m: ManagedServer): Promise<RunningServer> {
    return this.pool.start(m);
  }

  startSelected(): Promise<void> {
    return this.pool.startSelected();
  }

  stop(backendId: string): Promise<void> {
    return this.pool.stop(backendId);
  }

  stopAll(): Promise<void> {
    return this.pool.stopAll();
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
