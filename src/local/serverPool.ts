import type { Settings } from '../config/settings';
import type { Log } from '../log';
import { DEFAULT_PORT, LOCAL_BACKEND_ID, parseManaged, portFor, routerWanted, selectedModels, type ManagedServer } from './backendEntry';
import { LlamaServerProcess, LocalRuntimeError, defaultSpawn, formatTail, type ChildLike, type SpawnLike } from './llamaServer';
import { mergeModels, type LocalModel } from './modelList';
import { RECIPES, type Recipe } from './recipes';
import { renderPresets, routerArgs, supportsRouter, supportsSpeculative, type PortState } from './router';
import { INSTALL_HINT } from './runtimes';

const KILL_GRACE_MS = 5000;
/** How often a window checks a router it adopted. */
const WATCH_MS = 15_000;
/** How often, and how many times, a start checks again on a llama-server still loading on the saved port (2 minutes). */
const LOADING_POLL_MS = 500;
const LOADING_POLLS = 240;
/** How long an unexpected exit waits for a Stop Local Models (or a restart) in another window to reach this window's global state. */
const EXIT_CHECK_MS = 1000;
/** How long a restart waits for another window's router to let go of the port (10 s). */
const RELEASE_POLL_MS = 250;
const RELEASE_POLLS = 40;
/** Router output kept for the page. */
const OUTPUT_LINES = 200;

export const PRESETS_FAILED = 'The local model settings could not be written as a presets file; check aiAutocomplete.local.models.';
export const TOO_OLD = 'This llama-server is too old for the local model helper; update llama.cpp.';

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
 * The router a start ended with: one this window started, or one already running on the saved port (started by another
 * window, or left by an earlier session) that this window adopted. An adopted router is never stopped by this window
 * (except by Stop Local Models or a restart); the window watches it and starts its own when it goes away.
 */
export interface Started {
  port: number;
  pid?: number;
  adopted: boolean;
}

export type PoolState = 'stopped' | 'starting' | 'running' | 'failed';

export interface Disposable {
  dispose(): void;
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

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `rec` without its pid: nobody should be serving it (Stop Local Models, or a restart that failed). */
function withoutPid(rec: ManagedServer): ManagedServer {
  return { port: rec.port, presetsPath: rec.presetsPath, modelsMax: rec.modelsMax };
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

/** The router's HTTP calls the pool makes. */
export interface RouterCalls {
  load(name: string): Promise<void>;
  reload(): Promise<void>;
}

export interface ServerPoolDeps {
  launch: Launch;
  /** The llama-server executable, or undefined when it is not installed. */
  binary(): string | undefined;
  /** `<binary> --help` output (rejects when it cannot run). */
  helpText(binary: string): Promise<string>;
  freePort(preferred: number): Promise<number>;
  /** Where the presets file lives: `<globalStorage>/presets.ini`. */
  presetsPath: string;
  writePresets(text: string): Promise<void>;
  /** The model's file when it is downloaded (present with the expected size), else undefined. */
  downloadedPath(m: LocalModel): string | undefined;
  /** The router record as stored (untrusted). */
  readManaged(): unknown;
  writeManaged(rec: ManagedServer | undefined): Promise<void>;
  /** Points `local`'s `baseUrl` at a new port. */
  moveBackend(port: number): Promise<void>;
  settings(): Settings;
  log: Log;
  /** What answers on a port: our router listing every name (any router for none), a llama-server still loading, or neither. */
  probe(port: number, names: string[]): Promise<PortState>;
  router(port: number): RouterCalls;
  /** Whether a process with this pid exists. */
  alive(pid: number): boolean;
  /** Sends SIGTERM to a process this window did not start. */
  terminate(pid: number): void;
  /** The router this window started exited without being asked to. */
  stoppedUnexpectedly(): void;
  /** The router answers now (started or adopted): requests that failed while it loaded may go again. */
  onReady?(backendId: string): void;
  /** Whether this window has focus: a "Models in memory" change restarts the router from the focused window only. */
  focused?(): boolean;
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  recipes?(): readonly Recipe[];
  killGraceMs?: number;
  /** The log file shared by the windows: this window writes the output of the routers it starts. */
  serverLog?: { start(port: number): void; line(text: string): void; flush?(): Promise<void> };
}

/** A start that a stop, a newer start or shutdown cut short: not a failure worth an error. */
export class StartCancelled extends LocalRuntimeError {}

/** The router, from the start request until it is stopped or exits. */
interface Slot {
  cancelled: boolean;
  /** Aborted when the slot is halted: ends its waits and its watch. */
  readonly abort: AbortController;
  child?: ChildLike;
  childExited?: Promise<void>;
  /** The router this window started. */
  proc?: RunningServer;
  /** The port of a router another window (or an earlier session) runs, which this window watches. */
  adoptedPort?: number;
  /** `--models-max` of the router: the one this window started it with, or the record's when adopted. */
  modelsMax: number;
  /** Settles when the start that owns this slot has finished, either way. */
  settled: Promise<void>;
  /** The record this window's start replaced: another window's router, when two windows started at once. */
  replaced?: ManagedServer;
}

/**
 * The llama-server router of the `local` backend: at most one per window, stoppable while it is still loading. A router
 * already running on the saved port with the preset models (another window's) is adopted instead of started.
 */
export class ServerPool {
  private slot: Slot | undefined;
  private disposed = false;
  private failed: string | undefined;
  private readonly output: string[] = [];
  private readonly listeners = new Set<() => void>();
  private announced = '';
  /** Binaries whose help lists `--models-preset`, with whether each supports speculative decoding; a too-old one is checked again on the next start (it may be updated). */
  private readonly routerBinaries = new Map<string, boolean>();

  constructor(private readonly d: ServerPoolDeps) {}

  /** Starts the router; an earlier one of this window (running or loading) is stopped and has exited first. */
  start(): Promise<Started> {
    if (this.disposed) return Promise.reject(new StartCancelled('Local models are shut down.'));
    const previous = this.slot;
    // Registered before anything is awaited: a second start or a stop sees this one at once.
    const slot: Slot = { cancelled: false, abort: new AbortController(), modelsMax: this.d.settings().local.modelsInMemory, settled: Promise.resolve() };
    this.slot = slot;
    this.failed = undefined;
    this.changed();
    const run = this.run(slot, previous);
    slot.settled = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async run(slot: Slot, previous: Slot | undefined): Promise<Started> {
    const cancelled = (): StartCancelled => new StartCancelled('llama-server was stopped while starting.');
    try {
      if (previous) await this.halt(previous);
      if (slot.cancelled) throw cancelled();
      await this.knowSpeculative();
      const { text, names } = this.presets();
      await this.d.writePresets(text);
      if (slot.cancelled) throw cancelled();
      // The record as this start found it: one that differs when this start writes its own was written meanwhile (another window).
      const found = JSON.stringify(this.managed() ?? null);
      const saved = this.managed()?.port ?? this.settingsPort() ?? DEFAULT_PORT;
      // Another window's router (or one left by an earlier session) on the saved port serves this window too.
      if (await this.ours(saved, names, slot)) return this.adopt(slot, saved);
      if (slot.cancelled) throw cancelled();
      const binary = await this.routerBinary();
      if (slot.cancelled) throw cancelled();

      const { port, changed } = await portFor(saved, (p) => this.d.freePort(p));
      if (slot.cancelled) throw cancelled();
      if (changed) {
        await this.d.moveBackend(port);
        this.d.log.debug(`llama-server: port ${port} replaces a taken one; baseUrl of "${LOCAL_BACKEND_ID}" updated`);
        if (slot.cancelled) throw cancelled();
      }
      let proc: RunningServer;
      this.d.serverLog?.start(port);
      try {
        proc = await this.d.launch({
          binary,
          args: routerArgs({ presetsPath: this.d.presetsPath, modelsMax: slot.modelsMax, port }),
          port,
          log: (line) => this.output_(line),
          spawned: (child) => {
            slot.child = child;
            slot.childExited = new Promise((resolve) => child.once('exit', () => resolve()));
            if (slot.cancelled) child.kill('SIGTERM');
          },
        });
      } catch (err) {
        // Another window started its router on the saved port at the same moment, and this one lost the port.
        if (!slot.cancelled && !changed && (await this.ours(port, names, slot))) return this.adopt(slot, port);
        throw err;
      }
      if (slot.cancelled) {
        await proc.stop();
        throw cancelled();
      }
      slot.proc = proc;
      void proc.exited.then(() => {
        void this.d.serverLog?.flush?.();
        return this.exitedUnasked(slot, proc);
      });
      this.d.log.debug(`llama-server: router ready on port ${port}`);
      const replaced = this.managed();
      // Only a record written during this start can be another window's router started at the same moment; an older one
      // (an earlier session's, its pid maybe reused) is never put back.
      if (replaced && JSON.stringify(replaced) !== found) slot.replaced = replaced;
      const own: ManagedServer = { port, ...(proc.pid !== undefined ? { pid: proc.pid } : {}), presetsPath: this.d.presetsPath, modelsMax: slot.modelsMax };
      try {
        await this.d.writeManaged(own);
        void this.repairRecord(slot, own);
      } catch (err) {
        this.d.log.error(`local models: saving the router (port ${port}) failed`, err);
      }
      this.ready();
      return { port, adopted: false, ...(proc.pid !== undefined ? { pid: proc.pid } : {}) };
    } catch (err) {
      if (this.slot === slot) {
        this.slot = undefined;
        if (!slot.cancelled && !(err instanceof StartCancelled)) this.failed = err instanceof LocalRuntimeError ? err.message : 'llama-server could not start; see the log.';
        this.changed();
      }
      if (slot.cancelled && !(err instanceof StartCancelled)) throw cancelled();
      throw err;
    }
  }

  /** The presets text and the model names in it: downloaded, not hidden models only. A bad setting fails with a fixed message. */
  private presets(): { text: string; names: string[] } {
    const { models } = mergeModels(this.recipes(), this.d.settings().local.models);
    const served: LocalModel[] = [];
    const paths = new Map<string, string>();
    for (const m of models) {
      if (m.hidden) continue;
      const path = this.d.downloadedPath(m);
      if (path === undefined) continue;
      served.push(m);
      paths.set(m.name, path);
    }
    try {
      return { text: renderPresets(served, (m) => paths.get(m.name) as string, { speculative: this.speculative() }), names: served.map((m) => m.name) };
    } catch (err) {
      this.d.log.error('local models: writing the presets file failed', err);
      throw new LocalRuntimeError(PRESETS_FAILED);
    }
  }

  /** Reads the help text (cached) so presets know about speculation; an adopting window has no need for a local binary, so errors are ignored (the flag is then false). */
  private async knowSpeculative(): Promise<void> {
    try {
      await this.routerBinary();
    } catch {
      // no usable local binary: presets are rendered without speculation
    }
  }

  /** Whether the configured llama-server supports speculative decoding (known once it was checked for router mode). */
  private speculative(): boolean {
    const binary = this.d.binary();
    return binary !== undefined && this.routerBinaries.get(binary) === true;
  }

  /** Why no router can be started with the configured llama-server (missing, or too old), or undefined. Setup asks before it downloads. */
  async binaryProblem(): Promise<string | undefined> {
    try {
      await this.routerBinary();
      return undefined;
    } catch (err) {
      return message(err);
    }
  }

  /** The port of `local`'s baseUrl in the settings, when it is there. */
  private settingsPort(): number | undefined {
    const url = this.d.settings().backends.find((b) => b.id === LOCAL_BACKEND_ID)?.baseUrl;
    try {
      const port = url ? Number(new URL(url).port) : NaN;
      return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
    } catch {
      return undefined;
    }
  }

  /** Whether the router record names this port and a live pid: a router this extension started (in some window). */
  private owned(port: number): boolean {
    const rec = this.managed();
    return rec?.port === port && rec.pid !== undefined && this.d.alive(rec.pid);
  }

  /** The llama-server to start; it must support router mode (`--models-preset` in its help). */
  private async routerBinary(): Promise<string> {
    const binary = this.d.binary();
    if (!binary) throw new LocalRuntimeError(`llama-server was not found. ${INSTALL_HINT.llamaServer}`);
    if (this.routerBinaries.has(binary)) return binary;
    let help = '';
    try {
      help = await this.d.helpText(binary);
    } catch (err) {
      this.d.log.debug(`llama-server --help failed: ${message(err)}`);
    }
    if (!supportsRouter(help)) throw new LocalRuntimeError(`${TOO_OLD} ${INSTALL_HINT.llamaServer}`);
    this.routerBinaries.set(binary, supportsSpeculative(help));
    return binary;
  }

  /**
   * Whether `port` serves our router: one listing every preset model, or (with no models) the recorded one. A llama-server
   * still loading there is waited for (until the slot is halted). The recorded router that lacks a model (another window
   * wrote the presets after it started) is reloaded first; a router this extension did not start is never reloaded.
   */
  private async ours(port: number, names: string[], slot: Slot): Promise<boolean> {
    let reloaded = false;
    for (let polls = 0; ; polls++) {
      const state = await this.d.probe(port, names);
      if (slot.cancelled) return false;
      if (state === 'ours') return names.length > 0 || this.owned(port);
      if (state === 'none') {
        if (reloaded || names.length === 0 || !this.owned(port) || (await this.d.probe(port, [])) !== 'ours' || slot.cancelled) return false;
        reloaded = true;
        try {
          await this.d.router(port).reload();
          this.d.log.debug(`llama-server: reloaded the presets of the router on port ${port}`);
        } catch {
          return false;
        }
        continue;
      }
      if (polls >= LOADING_POLLS) return false;
      if (polls === 0) this.d.log.debug(`llama-server on port ${port} is loading; waiting for it`);
      await this.sleep(LOADING_POLL_MS, slot.abort.signal);
    }
  }

  private adopt(slot: Slot, port: number): Started {
    slot.adoptedPort = port;
    const rec = this.managed();
    const pid = rec?.port === port ? rec.pid : undefined;
    if (rec?.port === port) slot.modelsMax = rec.modelsMax;
    this.d.log.info(`llama-server: using the router already running on port ${port}`);
    void this.watch(slot, port);
    this.ready();
    return { port, adopted: true, ...(pid !== undefined ? { pid } : {}) };
  }

  /** The router answers: requests may go again, the selected models load. */
  private ready(): void {
    this.d.onReady?.(LOCAL_BACKEND_ID);
    this.changed();
    void this.warm(selectedModels(this.d.settings()));
  }

  /**
   * Checks an adopted router every 15 s. When it is gone (the window that ran it closed), this window starts its own,
   * unless Stop Local Models stopped it (its record has no pid then) or something else already holds the port (another
   * window's router loading: the next check adopts it). A record marked `restarting` is a restart in another window:
   * the watch goes on.
   */
  private async watch(slot: Slot, port: number): Promise<void> {
    while (!slot.cancelled) {
      await this.sleep(WATCH_MS, slot.abort.signal);
      if (slot.cancelled) return;
      const state = await this.d.probe(port, []).catch((): PortState => 'none');
      if (slot.cancelled) return;
      if (state !== 'none') continue;
      const rec = this.managed();
      if (rec?.restarting) continue;
      if (!rec || rec.pid === undefined) {
        this.drop(slot);
        this.d.log.info(`llama-server: the router on port ${port} was stopped; not starting one`);
        return;
      }
      if (rec.port === port && (await this.d.freePort(port).catch(() => 0)) !== port) continue;
      if (slot.cancelled) return;
      this.d.log.info(`llama-server: the router on port ${port} is gone; starting one in this window`);
      void this.startQuietly();
      return;
    }
  }

  /**
   * The router this window started exited without a stop: logs why and tells the user, unless Stop Local Models ran in
   * another window, or another window restarted it (this window then watches the new one).
   */
  private async exitedUnasked(slot: Slot, proc: RunningServer): Promise<void> {
    // A stop marks the slot first, so only an exit nobody here asked for gets past this.
    if (slot.cancelled) return;
    this.drop(slot);
    // Stop Local Models and a restart clear the pid before they stop anything; give that write time to arrive from another window.
    await this.sleep(EXIT_CHECK_MS, new AbortController().signal);
    if (this.disposed) return;
    const rec = this.managed();
    const restarted = rec !== undefined && (rec.restarting === true || (rec.pid !== undefined && rec.pid !== proc.pid));
    if (rec && restarted) {
      this.d.log.info('llama-server was restarted from another window; using its router');
      if (this.slot) return;
      const watcher: Slot = { cancelled: false, abort: new AbortController(), adoptedPort: rec.port, modelsMax: rec.modelsMax, settled: Promise.resolve() };
      this.slot = watcher;
      this.changed();
      void this.watch(watcher, rec.port);
      return;
    }
    if (rec && rec.pid === undefined) {
      this.d.log.info('llama-server was stopped by Stop Local Models in another window.');
      return;
    }
    // Two windows started at once: ours passed its health check against the other window's router on the same port,
    // then exited when it could not bind it. That router serves this window too.
    if (await this.adoptAfterExit(slot, proc)) return;
    const info = proc.exitInfo?.();
    this.d.log.error(`llama-server exited unexpectedly${info ? ` (${info})` : ''}.${formatTail(proc.lastOutput?.() ?? [])}`);
    this.failed = `llama-server exited unexpectedly${info ? ` (${info})` : ''}.`;
    this.changed();
    this.d.stoppedUnexpectedly();
  }

  /** After this window's router exited: adopts our router when one serves `port` (and no start is under way here). */
  private async adoptAfterExit(ended: Slot, proc: RunningServer): Promise<boolean> {
    const port = proc.port;
    if (this.slot || this.disposed) return false;
    let names: string[];
    try {
      names = this.presets().names;
    } catch {
      return false;
    }
    const rec = this.managed();
    const slot: Slot = { cancelled: false, abort: new AbortController(), modelsMax: rec?.modelsMax ?? this.d.settings().local.modelsInMemory, settled: Promise.resolve() };
    this.slot = slot;
    let found = false;
    const check = this.ours(port, names, slot).catch(() => false).then((ok) => (found = ok));
    slot.settled = check.then(() => undefined);
    await check;
    if (this.slot !== slot || slot.cancelled) return found || slot.cancelled;
    if (!found) {
      this.slot = undefined;
      return false;
    }
    this.d.log.info(`llama-server: another window's router took port ${port}; using it`);
    await this.forgetDeadPid(ended, proc);
    this.adopt(slot, port);
    return true;
  }

  /**
   * After a lost start race the record names this window's dead process: the winner's record (written during this
   * start, which then replaced it) is put back when its pid is alive on the same port. Otherwise the record stays: a dead
   * pid still lets a watch take over when the router goes, and Stop Local Models skips dead pids (the winner repairs
   * the record itself, see `repairRecord`).
   */
  private async forgetDeadPid(ended: Slot, proc: RunningServer): Promise<void> {
    const rec = this.managed();
    if (!rec || proc.pid === undefined || rec.pid !== proc.pid) return;
    const prev = ended.replaced;
    if (!(prev && prev.port === rec.port && prev.pid !== undefined && prev.pid !== proc.pid && this.d.alive(prev.pid))) return;
    try {
      await this.d.writeManaged(prev);
    } catch (err) {
      this.d.log.error('local models: saving the router failed', err);
    }
  }

  /**
   * The winner of a start race: a window that lost writes its record after this one and then exits. A moment after
   * writing, the record is written again when it names this port with a pid that is not alive (and no restart is marked).
   */
  private async repairRecord(slot: Slot, own: ManagedServer): Promise<void> {
    await this.sleep(EXIT_CHECK_MS, slot.abort.signal);
    if (slot.cancelled || this.disposed || this.slot !== slot) return;
    const rec = this.managed();
    if (!rec || rec.restarting || rec.port !== own.port || rec.pid === undefined || rec.pid === own.pid || this.d.alive(rec.pid)) return;
    try {
      await this.d.writeManaged(own);
      this.d.log.debug(`llama-server: the router record named a process that is gone (pid ${rec.pid}); written again`);
    } catch (err) {
      this.d.log.error('local models: saving the router failed', err);
    }
  }

  /** Removes `slot` (when it is still the current one) without stopping anything. */
  private drop(slot: Slot): void {
    slot.cancelled = true;
    slot.abort.abort();
    if (this.slot === slot) {
      this.slot = undefined;
      this.changed();
    }
  }

  /** Starts (or adopts) the router. Failures are logged, never thrown. */
  private async startQuietly(): Promise<void> {
    try {
      await this.start();
    } catch (err) {
      if (err instanceof StartCancelled) this.d.log.debug(err.message);
      else this.d.log.error('local models: llama-server could not start', err);
    }
  }

  /** Starts the router when `local` is selected and this window has none yet. Failures are logged, never thrown. */
  async startSelected(): Promise<void> {
    if (this.disposed || this.slot || !routerWanted(this.d.settings())) return;
    await this.startQuietly();
  }

  /**
   * After a settings change: starts the router when `local` became selected, stops this window's when it no longer is.
   * A router stopped with Stop Local Models stays stopped while the selection stays. With a router here: a "Models in
   * memory" change restarts it (from the focused window), a model list or models folder change rewrites the presets
   * and reloads, and a change of the selected models loads them.
   */
  async settingsChanged(before: Settings, after: Settings): Promise<void> {
    try {
      const was = routerWanted(before);
      const now = routerWanted(after);
      if (was && !now) {
        if (this.slot) this.d.log.debug(`llama-server: "${LOCAL_BACKEND_ID}" is no longer selected; stopping the router`);
        await this.stopHere();
        return;
      }
      if (now && !was && !this.slot) {
        await this.startQuietly();
        return;
      }
      if (!this.slot) return;
      if (before.local.modelsInMemory !== after.local.modelsInMemory) {
        if (this.d.focused?.() ?? true) await this.restart();
        return;
      }
      if (JSON.stringify(before.local.models) !== JSON.stringify(after.local.models) || before.local.modelsDir !== after.local.modelsDir) await this.syncPresets();
      const names = selectedModels(after);
      if (JSON.stringify(selectedModels(before)) !== JSON.stringify(names)) await this.warm(names);
    } catch (err) {
      this.d.log.error('local models: following the settings change failed', err);
    }
  }

  /** Rewrites the presets file and, when the router runs (here or adopted), makes it read the file again. Never throws. */
  async syncPresets(): Promise<void> {
    let text: string;
    try {
      await this.knowSpeculative();
      text = this.presets().text;
      await this.d.writePresets(text);
    } catch (err) {
      if (!(err instanceof LocalRuntimeError)) this.d.log.error('local models: writing the presets file failed', err);
      return;
    }
    const port = this.port();
    if (port === undefined || this.state() !== 'running') return;
    try {
      await this.d.router(port).reload();
      this.d.log.debug('llama-server: presets reloaded');
    } catch (err) {
      this.d.log.warn(`llama-server: reloading the presets failed: ${message(err)}`);
    }
  }

  /** Loads these models on the running router (each once, at most "Models in memory"); failures are logged at debug only. */
  async warm(names: string[]): Promise<void> {
    const port = this.port();
    if (port === undefined || this.state() !== 'running') return;
    const max = this.d.settings().local.modelsInMemory;
    for (const name of [...new Set(names)].slice(0, max)) {
      try {
        await this.d.router(port).load(name);
        this.d.log.debug(`llama-server: loaded ${name}`);
      } catch (err) {
        this.d.log.debug(`llama-server: loading ${name} failed: ${message(err)}`);
      }
    }
  }

  /**
   * Restarts the router from this window, which becomes its owner: the record loses its pid and is marked `restarting`
   * (other windows then wait for the new router instead of starting their own or taking it for Stop Local Models), this
   * window's router stops, or another window's by its pid; then this window starts one. A failed start clears the mark.
   * Failures are logged and show in `state()`.
   */
  async restart(): Promise<void> {
    if (this.disposed) return;
    const rec = this.managed();
    const modelsMax = this.d.settings().local.modelsInMemory;
    try {
      if (rec) await this.d.writeManaged({ ...withoutPid(rec), modelsMax, restarting: true });
    } catch (err) {
      this.d.log.error('local models: saving the router failed', err);
    }
    const slot = this.slot;
    const own = slot !== undefined && slot.adoptedPort === undefined;
    if (slot) {
      this.slot = undefined;
      await this.halt(slot);
    }
    if (!own && rec?.pid !== undefined && this.d.alive(rec.pid) && (await this.d.probe(rec.port, [])) !== 'none') {
      this.d.terminate(rec.pid);
      this.d.log.info(`llama-server: sent SIGTERM to pid ${rec.pid} on port ${rec.port} to restart it`);
      const signal = new AbortController().signal;
      for (let i = 0; i < RELEASE_POLLS && (await this.d.probe(rec.port, [])) !== 'none'; i++) await this.sleep(RELEASE_POLL_MS, signal);
    }
    await this.startQuietly();
    // A start that failed (or was cancelled) leaves the mark: the other windows stop waiting.
    const after = this.managed();
    if (after?.restarting) {
      try {
        await this.d.writeManaged(withoutPid(after));
      } catch (err) {
        this.d.log.error('local models: saving the router failed', err);
      }
    }
  }

  /**
   * Stop Local Models (and the page's Stop): clears the record's pid, so no window starts the router again, stops this
   * window's router, then sends SIGTERM to the recorded one another window (or a session that ended without stopping it)
   * runs, when its pid is alive and a router still answers on its port. Whether anything was stopped.
   */
  async stopEverywhere(): Promise<boolean> {
    const rec = this.managed();
    if (rec?.pid !== undefined) await this.d.writeManaged(withoutPid(rec));
    const here = this.slot !== undefined;
    await this.stopHere();
    if (rec?.pid === undefined || !this.d.alive(rec.pid)) return here;
    if ((await this.d.probe(rec.port, [])) !== 'ours') return here;
    this.d.terminate(rec.pid);
    this.d.log.info(`llama-server: sent SIGTERM to pid ${rec.pid} on port ${rec.port}`);
    return true;
  }

  /** The page's Stop: Stop Local Models. */
  async stop(): Promise<void> {
    await this.stopEverywhere();
  }

  /** Stops this window's router, also one still loading, or ends the watch of an adopted one; resolves when it has exited. */
  async stopHere(): Promise<void> {
    const slot = this.slot;
    this.failed = undefined;
    if (!slot) return this.changed();
    this.slot = undefined;
    this.changed();
    await this.halt(slot);
  }

  state(): PoolState {
    if (this.slot) return this.slot.proc !== undefined || this.slot.adoptedPort !== undefined ? 'running' : 'starting';
    return this.failed !== undefined ? 'failed' : 'stopped';
  }

  /** Why the last start failed (fixed text, or the runtime's message), while `state()` is `failed`. */
  failure(): string | undefined {
    return this.slot ? undefined : this.failed;
  }

  /** The router's port while it runs here or is adopted. */
  port(): number | undefined {
    return this.slot?.proc?.port ?? this.slot?.adoptedPort;
  }

  /** The last 200 lines this window's routers wrote. */
  lastOutput(): string[] {
    return [...this.output];
  }

  /** Called when the state, the port or the failure changes. */
  onChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  /** Sends SIGTERM to the router this window started, ends its watch and refuses new starts. */
  dispose(): void {
    this.disposed = true;
    void this.stopHere();
    void this.d.serverLog?.flush?.();
  }

  private changed(): void {
    const now = `${this.state()}|${this.port() ?? ''}|${this.failure() ?? ''}`;
    if (now === this.announced) return;
    this.announced = now;
    for (const l of [...this.listeners]) l();
  }

  private output_(line: string): void {
    this.output.push(line);
    if (this.output.length > OUTPUT_LINES) this.output.splice(0, this.output.length - OUTPUT_LINES);
    this.d.serverLog?.line(line);
    this.d.log.debug(`llama-server: ${line}`);
  }

  /** Cancels a slot's start and its watch, stops its process (SIGKILL after the grace period) and waits for both. An adopted router keeps running. */
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

  private managed(): ManagedServer | undefined {
    return parseManaged(this.d.readManaged());
  }
}
