import type { Settings } from '../config/settings';
import type { Log } from '../log';
import { parseManaged, portFor, selectionChange, serversToStart, type ManagedServer } from './backendEntry';
import { LlamaServerProcess, LocalRuntimeError, defaultSpawn, formatTail, llamaServerArgs, type ChildLike, type PortState, type SpawnLike } from './llamaServer';
import { RECIPES, type Recipe } from './recipes';
import { INSTALL_HINT } from './runtimes';

const KILL_GRACE_MS = 5000;
/** How often a window checks a server it adopted. */
const WATCH_MS = 15_000;
/** How often, and how many times, a start checks again on a llama-server still loading on the saved port (2 minutes). */
const LOADING_POLL_MS = 500;
const LOADING_POLLS = 240;
/** How long an unexpected exit waits for a Stop Local Models in another window to reach this window's global state. */
const EXIT_CHECK_MS = 1000;

/** A llama-server that answered its health check. */
export interface RunningServer {
  readonly port: number;
  readonly pid?: number;
  readonly exited: Promise<void>;
  stop(): Promise<void>;
  /** How the process ended, for example `code 1` or `signal SIGKILL`. */
  exitInfo?(): string;
  /** The last lines the server wrote. */
  lastOutput?(): string[];
}

/**
 * The server a start ended with: one this window started, or one already running on the saved port (started by another
 * window, or left by an earlier session) that this window adopted. An adopted server is never stopped by this window;
 * the window watches it and starts its own when it goes away.
 */
export interface Started {
  port: number;
  pid?: number;
  adopted: boolean;
}

const sleepFor = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/** `m` with the server it now runs on; a missing pid leaves the field out. */
function withServer(m: ManagedServer, port: number, pid: number | undefined): ManagedServer {
  const { backendId, recipeId, file } = m;
  return pid === undefined ? { backendId, recipeId, file, port } : { backendId, recipeId, file, port, pid };
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
  /** What answers on a port: our llama-server serving the alias, a llama-server still loading, or neither. */
  probe(port: number, alias: string): Promise<PortState>;
  /** Whether a process with this pid exists. */
  alive(pid: number): boolean;
  /** Sends SIGTERM to a process this window did not start. */
  terminate(pid: number): void;
  /** A server this window started exited without being asked to. */
  stoppedUnexpectedly(backendId: string): void;
  /** A server for the backend answers now (started or adopted): requests that failed while it loaded may go again. */
  onReady?(backendId: string): void;
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  recipes?(): readonly Recipe[];
  killGraceMs?: number;
}

/** A start that a stop, a newer start or shutdown cut short: not a failure worth an error. */
export class StartCancelled extends LocalRuntimeError {}

/** One backend's server, from the start request until it is stopped or exits. */
interface Slot {
  cancelled: boolean;
  /** Aborted when the slot is halted: ends its waits and its watch. */
  readonly abort: AbortController;
  child?: ChildLike;
  childExited?: Promise<void>;
  /** The server this window started. */
  proc?: RunningServer;
  /** The port of a server another window (or an earlier session) runs, which this window watches. */
  adoptedPort?: number;
  /** Settles when the start that owns this slot has finished, either way. */
  settled: Promise<void>;
}

/**
 * The llama-server processes of the local backends: at most one per backend, each stoppable while it is still loading.
 * A server already running on the saved port with the recipe's alias (another window's) is adopted instead of started.
 */
export class ServerPool {
  private readonly slots = new Map<string, Slot>();
  /** Bumped by stopAll and dispose, so a startSelected loop in progress stops. */
  private generation = 0;
  private disposed = false;
  private warnedMissing = false;

  constructor(private readonly d: ServerPoolDeps) {}

  /** Starts the server for `m.backendId`; an earlier one for that backend (running or loading) is stopped and has exited first. */
  start(m: ManagedServer): Promise<Started> {
    if (this.disposed) return Promise.reject(new StartCancelled('Local models are shut down.'));
    const previous = this.slots.get(m.backendId);
    // Registered before anything is awaited: a second start or a stop sees this one at once.
    const slot: Slot = { cancelled: false, abort: new AbortController(), settled: Promise.resolve() };
    this.slots.set(m.backendId, slot);
    const run = this.run(m, slot, previous);
    slot.settled = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async run(m: ManagedServer, slot: Slot, previous: Slot | undefined): Promise<Started> {
    const id = m.backendId;
    const cancelled = (): StartCancelled => new StartCancelled(`llama-server for "${id}" was stopped while starting.`);
    try {
      if (previous) await this.halt(previous);
      if (slot.cancelled) throw cancelled();
      const problem = this.problem(m);
      const recipe = this.recipes().find((r) => r.id === m.recipeId);
      if (problem || !recipe) throw new LocalRuntimeError(problem ?? `Unknown local model "${m.recipeId}".`);
      const alias = recipe.modelName;
      // Another window's server (or one left by an earlier session) on the saved port serves this window too.
      if (await this.ours(m.port, alias, slot)) return this.adopt(id, slot, m.port, alias);
      if (slot.cancelled) throw cancelled();
      const binary = this.d.binary();
      if (!binary) throw new LocalRuntimeError(`llama-server was not found. ${INSTALL_HINT.llamaServer}`);

      const { port, changed } = await portFor(m.port, (p) => this.d.freePort(p));
      if (slot.cancelled) throw cancelled();
      if (changed) {
        await this.d.moveBackend(id, port);
        this.d.log.debug(`llama-server ${id}: port ${port} replaces a taken one; baseUrl updated`);
        if (slot.cancelled) throw cancelled();
      }
      let proc: RunningServer;
      try {
        proc = await this.d.launch({
          binary,
          args: llamaServerArgs({ file: m.file, modelName: alias, port, contextTokens: recipe.contextTokens }),
          port,
          log: (line) => this.d.log.debug(`llama-server ${id}: ${line}`),
          spawned: (child) => {
            slot.child = child;
            slot.childExited = new Promise((resolve) => child.once('exit', () => resolve()));
            if (slot.cancelled) child.kill('SIGTERM');
          },
        });
      } catch (err) {
        // Another window started its server on the saved port at the same moment, and this one lost the port.
        if (!slot.cancelled && !changed && (await this.ours(port, alias, slot))) return this.adopt(id, slot, port, alias);
        throw err;
      }
      if (slot.cancelled) {
        await proc.stop();
        throw cancelled();
      }
      slot.proc = proc;
      void proc.exited.then(() => this.exitedUnasked(id, slot, proc));
      this.d.log.debug(`llama-server ${id}: ready on port ${port}`);
      this.d.onReady?.(id);
      return { port, adopted: false, ...(proc.pid !== undefined ? { pid: proc.pid } : {}) };
    } catch (err) {
      if (this.slots.get(id) === slot) this.slots.delete(id);
      if (slot.cancelled && !(err instanceof StartCancelled)) throw cancelled();
      throw err;
    }
  }

  /** Whether `port` serves `alias`; a llama-server still loading there is waited for (until the slot is halted). */
  private async ours(port: number, alias: string, slot: Slot): Promise<boolean> {
    for (let polls = 0; ; polls++) {
      const state = await this.d.probe(port, alias);
      if (slot.cancelled) return false;
      if (state !== 'loading') return state === 'ours';
      if (polls >= LOADING_POLLS) return false;
      if (polls === 0) this.d.log.debug(`llama-server on port ${port} is loading; waiting for it`);
      await this.sleep(LOADING_POLL_MS, slot.abort.signal);
    }
  }

  private adopt(id: string, slot: Slot, port: number, alias: string): Started {
    slot.adoptedPort = port;
    const pid = this.managed().find((e) => e.backendId === id && e.port === port)?.pid;
    this.d.log.info(`llama-server ${id}: using the one already running on port ${port}`);
    void this.watch(id, slot, port, alias);
    this.d.onReady?.(id);
    return { port, adopted: true, ...(pid !== undefined ? { pid } : {}) };
  }

  /**
   * Checks an adopted server every 15 s. When it is gone (the window that ran it closed), this window starts its own,
   * unless Stop Local Models stopped it (its record has no pid then) or something else already holds the port (another
   * window's server loading: the next check adopts it).
   */
  private async watch(id: string, slot: Slot, port: number, alias: string): Promise<void> {
    while (!slot.cancelled) {
      await this.sleep(WATCH_MS, slot.abort.signal);
      if (slot.cancelled) return;
      const state = await this.d.probe(port, alias).catch((): PortState => 'none');
      if (slot.cancelled) return;
      if (state !== 'none') continue;
      const rec = this.managed().find((e) => e.backendId === id);
      if (!rec || rec.pid === undefined) {
        this.drop(id, slot);
        this.d.log.info(`llama-server ${id}: the server on port ${port} was stopped; not starting one`);
        return;
      }
      if (rec.port === port && (await this.d.freePort(port).catch(() => 0)) !== port) continue;
      if (slot.cancelled) return;
      this.d.log.info(`llama-server ${id}: the server on port ${port} is gone; starting one in this window`);
      void this.startRecorded(rec);
      return;
    }
  }

  /** A server this window started exited without a stop: logs why and tells the user, unless Stop Local Models ran in another window. */
  private async exitedUnasked(id: string, slot: Slot, proc: RunningServer): Promise<void> {
    // A stop marks the slot first, so only an exit nobody here asked for gets past this.
    if (slot.cancelled) return;
    this.drop(id, slot);
    // Stop Local Models clears the pids before it stops anything; give that write time to arrive from another window.
    await this.sleep(EXIT_CHECK_MS, new AbortController().signal);
    if (this.disposed) return;
    const rec = this.managed().find((e) => e.backendId === id);
    if (rec && rec.pid === undefined) {
      this.d.log.info(`llama-server ${id} was stopped by Stop Local Models in another window.`);
      return;
    }
    const info = proc.exitInfo?.();
    this.d.log.error(`llama-server ${id} exited unexpectedly${info ? ` (${info})` : ''}.${formatTail(proc.lastOutput?.() ?? [])}`);
    this.d.stoppedUnexpectedly(id);
  }

  /** Removes `slot` (when it is still the backend's) without stopping anything. */
  private drop(id: string, slot: Slot): void {
    slot.cancelled = true;
    slot.abort.abort();
    if (this.slots.get(id) === slot) this.slots.delete(id);
  }

  /** Starts (or adopts) `m`'s server and saves where a server this window started runs. Failures are logged, never thrown. */
  private async startRecorded(m: ManagedServer): Promise<void> {
    let started: Started;
    try {
      started = await this.start(m);
    } catch (err) {
      if (err instanceof StartCancelled) this.d.log.debug(err.message);
      else this.d.log.error(`local model "${m.backendId}" could not start`, err);
      return;
    }
    if (started.adopted || (started.port === m.port && started.pid === m.pid)) return;
    try {
      await this.record(withServer(m, started.port, started.pid));
    } catch (err) {
      this.d.log.error(`local model "${m.backendId}": saving its server (port ${started.port}) failed`, err);
    }
  }

  /** Starts the servers in `todo` that have no slot yet, one after another; a stopAll or dispose in between ends the run. */
  private async startEach(todo: ManagedServer[]): Promise<void> {
    const generation = this.generation;
    const current = (): boolean => !this.disposed && this.generation === generation;
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
      await this.startRecorded(m);
    }
  }

  /** Starts the recorded servers whose backend is selected. Failures are logged, never thrown. */
  async startSelected(): Promise<void> {
    try {
      await this.startEach(serversToStart(this.managed(), this.d.settings()));
    } catch (err) {
      this.d.log.error('local models: starting the selected servers failed', err);
    }
  }

  /**
   * After a settings change: starts the servers whose backend became selected and stops the ones whose backend is no
   * longer selected or no longer exists. Servers stopped with Stop Local Models stay stopped while their selection stays.
   */
  async selectionChanged(before: Settings, after: Settings): Promise<void> {
    try {
      const change = selectionChange(this.managed(), before, after, this.active());
      for (const id of change.stop) {
        this.d.log.debug(`llama-server ${id}: its backend is no longer selected; stopping it`);
        await this.stop(id);
      }
      await this.startEach(change.start);
    } catch (err) {
      this.d.log.error('local models: following the settings change failed', err);
    }
  }

  /** Stops the server for `backendId`, also one still loading; resolves when it has exited. */
  async stop(backendId: string): Promise<void> {
    const slot = this.slots.get(backendId);
    if (!slot) return;
    this.slots.delete(backendId);
    await this.halt(slot);
  }

  /** Stops every server this window started (and its watches of adopted ones) and any startSelected run in progress. */
  async stopAll(): Promise<void> {
    this.generation++;
    await Promise.all([...this.slots.keys()].map((id) => this.stop(id)));
  }

  /**
   * Stop Local Models: stops this window's servers, then sends SIGTERM to the recorded servers other windows (or a
   * session that ended without stopping them) run, when their pid is alive and their port still serves the recipe's
   * alias. The pids are cleared first, so no window starts them again. Whether anything was stopped.
   */
  async stopEverywhere(): Promise<boolean> {
    const records = this.managed();
    const others = records.filter((r): r is ManagedServer & { pid: number } => r.pid !== undefined);
    if (others.length > 0) await this.d.writeManaged(records.map((r) => withServer(r, r.port, undefined)));
    const here = this.active().length;
    await this.stopAll();
    let stopped = 0;
    for (const r of others) {
      const recipe = this.recipes().find((e) => e.id === r.recipeId);
      if (!recipe || !this.d.alive(r.pid)) continue;
      if ((await this.d.probe(r.port, recipe.modelName)) !== 'ours') continue;
      this.d.terminate(r.pid);
      this.d.log.info(`llama-server ${r.backendId}: sent SIGTERM to pid ${r.pid} on port ${r.port}`);
      stopped++;
    }
    return here > 0 || stopped > 0;
  }

  /** Saves `m` (replacing the entry for its backend), so it starts again next session. */
  async record(m: ManagedServer): Promise<void> {
    await this.d.writeManaged([...this.managed().filter((e) => e.backendId !== m.backendId), m]);
  }

  async forget(backendId: string): Promise<void> {
    await this.d.writeManaged(this.managed().filter((e) => e.backendId !== backendId));
  }

  /** Backend ids of the servers that are ready: started by this window or adopted. */
  running(): string[] {
    return [...this.slots].filter(([, s]) => s.proc !== undefined || s.adoptedPort !== undefined).map(([id]) => id);
  }

  /** Backend ids of the servers that are ready (or adopted) or still starting. */
  active(): string[] {
    return [...this.slots.keys()];
  }

  /** Sends SIGTERM to every server this window started, ends its watches and refuses new starts. */
  dispose(): void {
    this.disposed = true;
    this.generation++;
    for (const id of [...this.slots.keys()]) void this.stop(id);
  }

  /** Cancels a slot's start and its watch, stops its process (SIGKILL after the grace period) and waits for both. An adopted server keeps running. */
  private async halt(slot: Slot): Promise<void> {
    slot.cancelled = true;
    slot.abort.abort();
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

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return (this.d.sleep ?? sleepFor)(ms, signal);
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
