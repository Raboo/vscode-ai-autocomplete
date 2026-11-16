import type { Settings } from '../config/settings';
import type { Log } from '../log';
import { parseManaged, portFor, serversToStart, type ManagedServer } from './backendEntry';
import { LlamaServerProcess, LocalRuntimeError, defaultSpawn, llamaServerArgs, type ChildLike, type SpawnLike } from './llamaServer';
import { RECIPES, type Recipe } from './recipes';
import { INSTALL_HINT } from './runtimes';

const KILL_GRACE_MS = 5000;

/** A llama-server that answered its health check. */
export interface RunningServer {
  readonly port: number;
  readonly exited: Promise<void>;
  stop(): Promise<void>;
}

export interface LaunchOptions {
  binary: string;
  args: string[];
  port: number;
  log(line: string): void;
  /** Called as soon as the process exists, before it is ready. */
  spawned(child: ChildLike): void;
}

/** Starts a server; resolves when it is ready, rejects when it exits first or misses its deadline. */
export type Launch = (o: LaunchOptions) => Promise<RunningServer>;

export function launchLlamaServer(spawnFn: SpawnLike = defaultSpawn): Launch {
  return (o) =>
    LlamaServerProcess.start({
      binary: o.binary,
      args: o.args,
      port: o.port,
      log: o.log,
      spawnFn: (cmd, args) => {
        const child = spawnFn(cmd, args);
        o.spawned(child);
        return child;
      },
    });
}

export interface ServerPoolDeps {
  launch: Launch;
  /** The llama-server executable, or undefined when it is not installed. */
  binary(): string | undefined;
  freePort(preferred: number): Promise<number>;
  fileExists(path: string): boolean;
  /** The managed servers as stored (untrusted). */
  readManaged(): unknown;
  writeManaged(list: ManagedServer[]): Promise<void>;
  /** Points the backend's `baseUrl` at a new port. */
  moveBackend(backendId: string, port: number): Promise<void>;
  settings(): Settings;
  log: Log;
  recipes?(): readonly Recipe[];
  killGraceMs?: number;
}

/** A start that a stop, a newer start or shutdown cut short: not a failure worth an error. */
export class StartCancelled extends LocalRuntimeError {}

/** One backend's server, from the start request until it is stopped or exits. */
interface Slot {
  cancelled: boolean;
  child?: ChildLike;
  childExited?: Promise<void>;
  proc?: RunningServer;
  /** Settles when the start that owns this slot has finished, either way. */
  settled: Promise<void>;
}

/** The llama-server processes the extension started: at most one per backend, each stoppable while it is still loading. */
export class ServerPool {
  private readonly slots = new Map<string, Slot>();
  /** Bumped by stopAll and dispose, so a startSelected loop in progress stops. */
  private generation = 0;
  private disposed = false;
  private warnedMissing = false;

  constructor(private readonly d: ServerPoolDeps) {}

  /** Starts the server for `m.backendId`; an earlier one for that backend (running or loading) is stopped and has exited first. */
  start(m: ManagedServer): Promise<RunningServer> {
    if (this.disposed) return Promise.reject(new StartCancelled('Local models are shut down.'));
    const previous = this.slots.get(m.backendId);
    // Registered before anything is awaited: a second start or a stop sees this one at once.
    const slot: Slot = { cancelled: false, settled: Promise.resolve() };
    this.slots.set(m.backendId, slot);
    const run = this.run(m, slot, previous);
    slot.settled = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async run(m: ManagedServer, slot: Slot, previous: Slot | undefined): Promise<RunningServer> {
    const id = m.backendId;
    const cancelled = (): StartCancelled => new StartCancelled(`llama-server for "${id}" was stopped while starting.`);
    try {
      if (previous) await this.halt(previous);
      if (slot.cancelled) throw cancelled();
      const problem = this.problem(m);
      const recipe = this.recipes().find((r) => r.id === m.recipeId);
      if (problem || !recipe) throw new LocalRuntimeError(problem ?? `Unknown local model "${m.recipeId}".`);
      const binary = this.d.binary();
      if (!binary) throw new LocalRuntimeError(`llama-server was not found. ${INSTALL_HINT.llamaServer}`);

      const { port, changed } = await portFor(m.port, (p) => this.d.freePort(p));
      if (slot.cancelled) throw cancelled();
      if (changed) {
        await this.d.moveBackend(id, port);
        this.d.log.debug(`llama-server ${id}: port ${port} replaces a taken one; baseUrl updated`);
        if (slot.cancelled) throw cancelled();
      }
      const proc = await this.d.launch({
        binary,
        args: llamaServerArgs({ file: m.file, modelName: recipe.modelName, port, contextTokens: recipe.contextTokens }),
        port,
        log: (line) => this.d.log.debug(`llama-server ${id}: ${line}`),
        spawned: (child) => {
          slot.child = child;
          slot.childExited = new Promise((resolve) => child.once('exit', () => resolve()));
          if (slot.cancelled) child.kill('SIGTERM');
        },
      });
      if (slot.cancelled) {
        await proc.stop();
        throw cancelled();
      }
      slot.proc = proc;
      void proc.exited.then(() => {
        // A stop marks the slot first, so only an exit nobody asked for gets here.
        if (slot.cancelled) return;
        slot.cancelled = true;
        if (this.slots.get(id) === slot) this.slots.delete(id);
        this.d.log.error(`llama-server ${id} exited unexpectedly.`);
      });
      this.d.log.debug(`llama-server ${id}: ready on port ${port}`);
      return proc;
    } catch (err) {
      if (this.slots.get(id) === slot) this.slots.delete(id);
      if (slot.cancelled && !(err instanceof StartCancelled)) throw cancelled();
      throw err;
    }
  }

  /** Starts the recorded servers whose backend is selected. Failures are logged, never thrown. */
  async startSelected(): Promise<void> {
    const generation = this.generation;
    const current = (): boolean => !this.disposed && this.generation === generation;
    try {
      const todo = serversToStart(this.managed(), this.d.settings());
      for (const m of todo) {
        if (!current()) return;
        if (this.slots.has(m.backendId)) continue;
        const problem = this.problem(m);
        if (problem) {
          this.d.log.warn(`local model "${m.backendId}" not started: ${problem}`);
          continue;
        }
        if (!this.d.binary()) {
          if (!this.warnedMissing) this.d.log.warn(`local models not started: llama-server was not found. ${INSTALL_HINT.llamaServer}`);
          this.warnedMissing = true;
          return;
        }
        let proc: RunningServer;
        try {
          proc = await this.start(m);
        } catch (err) {
          if (err instanceof StartCancelled) this.d.log.debug(err.message);
          else this.d.log.error(`local model "${m.backendId}" could not start`, err);
          continue;
        }
        if (proc.port === m.port) continue;
        try {
          await this.record({ ...m, port: proc.port });
        } catch (err) {
          this.d.log.error(`local model "${m.backendId}": saving its new port ${proc.port} failed`, err);
        }
      }
    } catch (err) {
      this.d.log.error('local models: starting the selected servers failed', err);
    }
  }

  /** Stops the server for `backendId`, also one still loading; resolves when it has exited. */
  async stop(backendId: string): Promise<void> {
    const slot = this.slots.get(backendId);
    if (!slot) return;
    this.slots.delete(backendId);
    await this.halt(slot);
  }

  /** Stops every server and any startSelected run in progress. */
  async stopAll(): Promise<void> {
    this.generation++;
    await Promise.all([...this.slots.keys()].map((id) => this.stop(id)));
  }

  /** Saves `m` (replacing the entry for its backend), so it starts again next session. */
  async record(m: ManagedServer): Promise<void> {
    await this.d.writeManaged([...this.managed().filter((e) => e.backendId !== m.backendId), m]);
  }

  async forget(backendId: string): Promise<void> {
    await this.d.writeManaged(this.managed().filter((e) => e.backendId !== backendId));
  }

  /** Backend ids of the servers that are ready. */
  running(): string[] {
    return [...this.slots].filter(([, s]) => s.proc !== undefined).map(([id]) => id);
  }

  /** Backend ids of the servers that are ready or still starting. */
  active(): string[] {
    return [...this.slots.keys()];
  }

  /** Sends SIGTERM to every server left and refuses new starts. */
  dispose(): void {
    this.disposed = true;
    this.generation++;
    for (const id of [...this.slots.keys()]) void this.stop(id);
  }

  /** Cancels a slot's start, stops its process (SIGKILL after the grace period) and waits for both. */
  private async halt(slot: Slot): Promise<void> {
    slot.cancelled = true;
    if (slot.proc) await slot.proc.stop();
    else if (slot.child && slot.childExited) {
      slot.child.kill('SIGTERM');
      const child = slot.child;
      const timer = setTimeout(() => child.kill('SIGKILL'), this.d.killGraceMs ?? KILL_GRACE_MS);
      try {
        await slot.childExited;
      } finally {
        clearTimeout(timer);
      }
    }
    await slot.settled;
  }

  private recipes(): readonly Recipe[] {
    return this.d.recipes?.() ?? RECIPES;
  }

  private managed(): ManagedServer[] {
    return parseManaged(this.d.readManaged());
  }

  /** Why `m` cannot be started (unknown recipe, missing file), or undefined. */
  private problem(m: ManagedServer): string | undefined {
    if (!this.recipes().some((r) => r.id === m.recipeId)) return `Unknown local model "${m.recipeId}".`;
    if (!this.d.fileExists(m.file)) return `The model file ${m.file} is missing.`;
    return undefined;
  }
}
