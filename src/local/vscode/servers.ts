import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Settings } from '../../config/settings';
import type { Log } from '../../log';
import { upsertBackend } from '../../manage/form';
import { MANAGED_KEY, parseManaged, portFor, serversToStart, type ManagedServer } from '../backendEntry';
import { LlamaServerProcess, LocalRuntimeError, defaultSpawn, freePort, llamaServerArgs, type ChildLike, type SpawnLike } from '../llamaServer';
import { RECIPES } from '../recipes';
import { INSTALL_HINT, findRuntime, type RuntimeEnv } from '../runtimes';

export interface LocalServersDeps {
  context: vscode.ExtensionContext;
  log: Log;
  settings(): Settings;
  spawnFn?: SpawnLike;
}

/** A server still waiting for its first healthy answer; `child` is set once it is spawned. */
interface Starting {
  child?: ChildLike;
  cancelled: boolean;
}

/** A start that `stop` cut short: not a failure worth an error. */
class StartCancelled extends LocalRuntimeError {}

function realEnv(): RuntimeEnv {
  return {
    platform: process.platform,
    home: homedir(),
    pathEnv: process.env.PATH ?? '',
    exists: (p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
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

/** The llama-server processes the extension started: started, watched, stopped. */
export class LocalServers implements vscode.Disposable {
  private readonly servers = new Map<string, LlamaServerProcess>();
  private readonly starting = new Map<string, Starting>();
  private readonly spawnFn: SpawnLike;
  private warnedMissing = false;

  constructor(private readonly d: LocalServersDeps) {
    this.spawnFn = d.spawnFn ?? defaultSpawn;
  }

  /** Starts the server for `m.backendId`, stopping a running one first. A taken port is replaced and the backend's `baseUrl` follows. */
  async start(m: ManagedServer): Promise<LlamaServerProcess> {
    const id = m.backendId;
    await this.stop(id);
    const recipe = RECIPES.find((r) => r.id === m.recipeId);
    const problem = this.problem(m);
    if (!recipe || problem) throw new LocalRuntimeError(problem ?? `Unknown local model "${m.recipeId}".`);
    const binary = this.binary();
    if (!binary) throw new LocalRuntimeError(`llama-server was not found. ${INSTALL_HINT.llamaServer}`);

    const pending: Starting = { cancelled: false };
    this.starting.set(id, pending);
    try {
      const { port, changed } = await portFor(m.port, freePort);
      if (changed) await this.moveBackend(id, port);
      if (pending.cancelled) throw new StartCancelled(`llama-server for "${id}" was stopped while starting.`);
      const proc = await LlamaServerProcess.start({
        binary,
        args: llamaServerArgs({ file: m.file, modelName: recipe.modelName, port, contextTokens: recipe.contextTokens }),
        port,
        spawnFn: (cmd, args) => {
          const child = this.spawnFn(cmd, args);
          pending.child = child;
          return child;
        },
        log: (line) => this.d.log.debug(`llama-server ${id}: ${line}`),
      });
      if (pending.cancelled) {
        await proc.stop();
        throw new StartCancelled(`llama-server for "${id}" was stopped while starting.`);
      }
      this.servers.set(id, proc);
      void proc.exited.then(() => {
        // stop() removes the server first, so only an exit nobody asked for is still in the map.
        if (this.servers.get(id) !== proc) return;
        this.servers.delete(id);
        this.d.log.error(`llama-server ${id} exited unexpectedly.`);
      });
      this.d.log.debug(`llama-server ${id}: ready on port ${port}`);
      return proc;
    } catch (err) {
      if (pending.cancelled && !(err instanceof StartCancelled)) throw new StartCancelled(`llama-server for "${id}" was stopped while starting.`);
      throw err;
    } finally {
      if (this.starting.get(id) === pending) this.starting.delete(id);
    }
  }

  /** Starts the recorded servers whose backend is selected. Failures are logged, never thrown. */
  async startSelected(): Promise<void> {
    try {
      const todo = serversToStart(parseManaged(this.d.context.globalState.get(MANAGED_KEY)), this.d.settings());
      for (const m of todo) {
        if (this.servers.has(m.backendId) || this.starting.has(m.backendId)) continue;
        const problem = this.problem(m);
        if (problem) {
          this.d.log.warn(`local model "${m.backendId}" not started: ${problem}`);
          continue;
        }
        if (!this.binary()) {
          if (!this.warnedMissing) this.d.log.warn(`local models not started: llama-server was not found. ${INSTALL_HINT.llamaServer}`);
          this.warnedMissing = true;
          return;
        }
        try {
          const proc = await this.start(m);
          if (proc.port !== m.port) await this.record({ ...m, port: proc.port });
        } catch (err) {
          if (err instanceof StartCancelled) this.d.log.debug(err.message);
          else this.d.log.error(`local model "${m.backendId}" could not start`, err);
        }
      }
    } catch (err) {
      this.d.log.error('local models: starting the selected servers failed', err);
    }
  }

  /** Stops the server for `backendId`, also one still starting. */
  async stop(backendId: string): Promise<void> {
    const pending = this.starting.get(backendId);
    if (pending) {
      pending.cancelled = true;
      pending.child?.kill('SIGTERM');
      this.starting.delete(backendId);
    }
    const proc = this.servers.get(backendId);
    if (!proc) return;
    this.servers.delete(backendId);
    await proc.stop();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...new Set([...this.starting.keys(), ...this.servers.keys()])].map((id) => this.stop(id)));
  }

  /** Saves `m` in global state (replacing the entry for its backend), so it starts again next session. */
  async record(m: ManagedServer): Promise<void> {
    const rest = this.managed().filter((e) => e.backendId !== m.backendId);
    await this.d.context.globalState.update(MANAGED_KEY, [...rest, m]);
  }

  async forget(backendId: string): Promise<void> {
    await this.d.context.globalState.update(MANAGED_KEY, this.managed().filter((e) => e.backendId !== backendId));
  }

  /** Backend ids of the servers that are running and ready. */
  running(): string[] {
    return [...this.servers.keys()];
  }

  /** Sends SIGTERM to every server left (stop() escalates to SIGKILL after its grace period). */
  dispose(): void {
    for (const id of [...this.starting.keys(), ...this.servers.keys()]) void this.stop(id);
  }

  private managed(): ManagedServer[] {
    return parseManaged(this.d.context.globalState.get(MANAGED_KEY));
  }

  /** Why `m` cannot be started (unknown recipe, missing file), or undefined. */
  private problem(m: ManagedServer): string | undefined {
    if (!RECIPES.some((r) => r.id === m.recipeId)) return `Unknown local model "${m.recipeId}".`;
    if (!existsSync(m.file)) return `The model file ${m.file} is missing.`;
    return undefined;
  }

  private binary(): string | undefined {
    return findRuntime('llamaServer', realEnv(), this.d.settings().local.llamaServerPath);
  }

  /** Points the backend's `baseUrl` in user settings at the new port; a backend not written yet is left alone. */
  private async moveBackend(backendId: string, port: number): Promise<void> {
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
    this.d.log.debug(`llama-server ${backendId}: port ${port} replaces a taken one; baseUrl updated`);
  }
}
