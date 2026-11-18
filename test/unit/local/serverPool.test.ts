import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import { parseSettings, type Inspected, type Settings } from '../../../src/config/settings';
import type { ManagedServer } from '../../../src/local/backendEntry';
import { LocalRuntimeError, type ChildLike, type PortState } from '../../../src/local/llamaServer';
import { ServerPool, StartCancelled, type Launch, type LaunchOptions, type RunningServer, type ServerPoolDeps } from '../../../src/local/serverPool';

let nextPid = 100;

class FakeChild extends EventEmitter implements ChildLike {
  readonly pid = nextPid++;
  stdout = null;
  stderr = null;
  readonly signals: string[] = [];
  exited = false;
  constructor(private readonly ignoreTerm: boolean) {
    super();
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    if (signal === 'SIGKILL' || !this.ignoreTerm) this.exit(signal ?? null);
    return true;
  }
  exit(signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    queueMicrotask(() => this.emit('exit', null, signal));
  }
}

interface Launched {
  o: LaunchOptions;
  child: FakeChild;
  ready(): void;
}

/** A launch whose children start loading and become ready when `ready()` is called (or at once with `autoReady`). */
function fakeLaunch(opts: { autoReady?: boolean; ignoreTerm?: boolean } = {}): { launch: Launch; launched: Launched[] } {
  const launched: Launched[] = [];
  const launch: Launch = (o) => {
    const child = new FakeChild(opts.ignoreTerm ?? false);
    o.spawned(child);
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    return new Promise<RunningServer>((resolve, reject) => {
      const ready = (): void =>
        resolve({
          port: o.port,
          pid: child.pid,
          exitInfo: () => 'code 134',
          lastOutput: () => ['ggml_abort: out of memory'],
          exited,
          stop: async () => {
            child.kill('SIGTERM');
            await exited;
          },
        });
      launched.push({ o, child, ready });
      void exited.then(() => reject(new LocalRuntimeError('llama-server exited before it was ready.')));
      if (opts.autoReady) ready();
    });
  };
  return { launch, launched };
}

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

function settings(): Settings {
  const inspected: Record<string, Inspected<unknown>> = {
    backends: { globalValue: ['a', 'b'].map((id) => ({ id, kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012' })) },
    'completions.backend': { globalValue: 'a' },
    'nextEdit.enabled': { globalValue: true },
    'nextEdit.backend': { globalValue: 'b' },
  };
  return parseSettings({ inspect: <T>(key: string) => inspected[key] as Inspected<T> | undefined }).settings;
}

const server = (id: string, port = 8012, pid?: number): ManagedServer => ({ backendId: id, recipeId: 'sweep-1.5b', file: `/m/${id}.gguf`, port, ...(pid ? { pid } : {}) });
/** The alias of the sweep-1.5b recipe. */
const ALIAS = 'sweep-next-edit-1.5b';

/** A sleep where the 15 s watch waits until `fire()`; shorter waits (loading polls, the exit check) end on the next turn. */
function fakeSleep() {
  const watches = new Set<() => void>();
  const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (ms < 10_000) return void setTimeout(resolve, 0);
      const done = (): void => {
        watches.delete(done);
        resolve();
      };
      watches.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  return {
    sleep,
    /** Ends every pending watch wait and lets what follows run. */
    fire: async (): Promise<void> => {
      for (const done of [...watches]) done();
      await tick(5);
    },
    pending: (): number => watches.size,
  };
}

function setup(o: {
  launch: Launch;
  freePort?: ServerPoolDeps['freePort'];
  managed?: ManagedServer[];
  writeManaged?: ServerPoolDeps['writeManaged'];
  probe?: ServerPoolDeps['probe'];
  alive?: ServerPoolDeps['alive'];
  settings?: () => Settings;
}) {
  const logs: { level: string; m: string }[] = [];
  const at = (level: string) => (m: string) => void logs.push({ level, m });
  let managed: unknown = o.managed ?? [];
  const ports: number[] = [];
  const probes: number[] = [];
  const moved: number[] = [];
  const terminated: number[] = [];
  const unexpected: string[] = [];
  const ready: string[] = [];
  const clock = fakeSleep();
  const pool = new ServerPool({
    launch: o.launch,
    binary: () => '/bin/llama-server',
    freePort: o.freePort ?? ((p) => (ports.push(p), Promise.resolve(p))),
    fileExists: () => true,
    readManaged: () => managed,
    writeManaged:
      o.writeManaged ??
      ((list) => {
        managed = list;
        return Promise.resolve();
      }),
    moveBackend: (_id, port) => (moved.push(port), Promise.resolve()),
    settings: o.settings ?? settings,
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
    probe: (port, alias) => {
      probes.push(port);
      return o.probe ? o.probe(port, alias) : Promise.resolve<PortState>('none');
    },
    alive: o.alive ?? (() => false),
    terminate: (pid) => void terminated.push(pid),
    stoppedUnexpectedly: (id) => void unexpected.push(id),
    onReady: (id) => void ready.push(id),
    sleep: clock.sleep,
    killGraceMs: 20,
  });
  return {
    pool,
    logs,
    errors: () => logs.filter((l) => l.level === 'error').map((l) => l.m),
    ports,
    probes,
    moved,
    terminated,
    unexpected,
    ready,
    clock,
    managed: () => managed,
    setManaged: (list: ManagedServer[]) => void (managed = list),
  };
}

/** A probe that answers from a mutable state per port (none for any other). */
function ports(states: Record<number, PortState>): ServerPoolDeps['probe'] {
  return (port) => Promise.resolve(states[port] ?? 'none');
}

describe('ServerPool', () => {
  test('concurrent starts for one backend give one process', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool } = setup({ launch });
    const first = pool.start(server('a'));
    const second = pool.start(server('a'));
    await expect(first).rejects.toBeInstanceOf(StartCancelled);
    await expect(second).resolves.toMatchObject({ port: 8012 });
    expect(launched).toHaveLength(1);
    expect(pool.running()).toEqual(['a']);
  });

  test('a stop during the initial wait means no spawn', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const port = deferred<number>();
    const { pool } = setup({ launch, freePort: () => port.promise });
    const started = pool.start(server('a'));
    expect(pool.active()).toEqual(['a']);
    const stopped = pool.stop('a');
    port.resolve(8012);
    await stopped;
    await expect(started).rejects.toBeInstanceOf(StartCancelled);
    expect(launched).toHaveLength(0);
    expect(pool.active()).toEqual([]);
  });

  test('stopAll during startSelected means no further spawns', async () => {
    const { launch, launched } = fakeLaunch();
    const { pool, errors } = setup({ launch, managed: [server('a'), server('b', 8013)] });
    const run = pool.startSelected();
    await tick();
    expect(launched).toHaveLength(1);
    expect(pool.running()).toEqual([]);
    expect(pool.active()).toEqual(['a']);
    await pool.stopAll();
    await run;
    expect(launched).toHaveLength(1);
    expect(launched[0].child.signals).toEqual(['SIGTERM']);
    expect(pool.active()).toEqual([]);
    expect(errors()).toEqual([]);
  });

  test('a start after dispose is refused', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool } = setup({ launch });
    pool.dispose();
    await expect(pool.start(server('a'))).rejects.toBeInstanceOf(StartCancelled);
    await pool.startSelected();
    expect(launched).toHaveLength(0);
  });

  test('dispose stops ready and loading servers', async () => {
    const { launch, launched } = fakeLaunch();
    const { pool } = setup({ launch });
    const a = pool.start(server('a'));
    const b = pool.start(server('b', 8013));
    await tick();
    launched[0].ready();
    await a;
    pool.dispose();
    await expect(b).rejects.toBeInstanceOf(StartCancelled);
    expect(launched.map((l) => l.child.signals)).toEqual([['SIGTERM'], ['SIGTERM']]);
  });

  test('an unexpected exit is logged once with its exit code and last output, and the user is told; an asked-for stop is not', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool, errors, unexpected } = setup({ launch });
    await pool.start(server('a'));
    launched[0].child.exit();
    await tick(5);
    expect(errors()).toEqual(['llama-server a exited unexpectedly (code 134).\nLast output:\nggml_abort: out of memory']);
    expect(unexpected).toEqual(['a']);
    expect(pool.active()).toEqual([]);
    await pool.stop('a');
    await pool.start(server('a'));
    await pool.stop('a');
    await tick(5);
    expect(errors()).toHaveLength(1);
    expect(unexpected).toEqual(['a']);
  });

  test('an exit after Stop Local Models in another window (the record lost its pid) is not an error', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool, errors, unexpected, logs, setManaged } = setup({ launch });
    await pool.start(server('a'));
    setManaged([server('a')]);
    launched[0].child.exit('SIGTERM');
    await tick(5);
    expect(errors()).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(logs.map((l) => l.m)).toContain('llama-server a was stopped by Stop Local Models in another window.');
  });

  test('a restart of a loading server waits for the old child to exit (SIGKILL after the grace period) before choosing the port', async () => {
    const { launch, launched } = fakeLaunch({ ignoreTerm: true });
    const oldExitedWhenAsked: boolean[] = [];
    const { pool } = setup({
      launch,
      freePort: (p) => {
        oldExitedWhenAsked.push(launched[0]?.child.exited ?? true);
        return Promise.resolve(p);
      },
    });
    const first = pool.start(server('a'));
    await tick();
    expect(launched).toHaveLength(1);
    const second = pool.start(server('a'));
    await expect(first).rejects.toBeInstanceOf(StartCancelled);
    await tick(40);
    expect(launched[0].child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(launched).toHaveLength(2);
    expect(oldExitedWhenAsked).toEqual([true, true]);
    expect(launched[1].o.port).toBe(8012);
    launched[1].ready();
    await expect(second).resolves.toMatchObject({ port: 8012 });
  });

  test('a started server is recorded with its port and pid; a record failure is logged as such, not as a failed start', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const ok = setup({ launch, freePort: () => Promise.resolve(9001), managed: [server('a', 8012, 7)] });
    await ok.pool.startSelected();
    expect(ok.managed()).toEqual([server('a', 9001, launched[0].child.pid)]);
    expect(ok.moved).toEqual([9001]);

    const failing = setup({ launch, freePort: () => Promise.resolve(9001), managed: [server('a')], writeManaged: () => Promise.reject(new Error('disk full')) });
    await failing.pool.startSelected();
    expect(failing.errors()).toEqual(['local model "a": saving its server (port 9001) failed']);
    expect(failing.pool.running()).toEqual(['a']);
  });

  test('a server that became ready is reported once; a failed or cancelled start is not', async () => {
    const { launch, launched } = fakeLaunch();
    const { pool, ready } = setup({ launch });
    const started = pool.start(server('a'));
    await tick();
    expect(ready).toEqual([]);
    launched[0].ready();
    await started;
    expect(ready).toEqual(['a']);

    const cancelled = pool.start(server('b'));
    await tick();
    await pool.stop('b');
    await expect(cancelled).rejects.toBeInstanceOf(StartCancelled);
    const failing = setup({ launch: () => Promise.reject(new LocalRuntimeError('boom')) });
    await expect(failing.pool.start(server('a'))).rejects.toThrow('boom');
    expect(ready).toEqual(['a']);
    expect(failing.ready).toEqual([]);
  });

  test('a start failure is logged as an error', async () => {
    const launch: Launch = () => Promise.reject(new LocalRuntimeError('boom'));
    const { pool, errors } = setup({ launch, managed: [server('a')] });
    await pool.startSelected();
    expect(errors()).toEqual(['local model "a" could not start']);
    expect(pool.active()).toEqual([]);
  });
});

describe('ServerPool across windows', () => {
  test("a server already answering on the saved port with the recipe's alias is adopted: no spawn, no move, no new record", async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const managed = [server('a', 8012, 555)];
    const { pool, moved, managed: saved, probes, ready } = setup({ launch, managed, probe: (port, alias) => Promise.resolve(port === 8012 && alias === ALIAS ? 'ours' : 'none') });
    await pool.startSelected();
    expect(launched).toHaveLength(0);
    expect(moved).toEqual([]);
    expect(saved()).toEqual(managed);
    expect(probes).toEqual([8012]);
    expect(pool.running()).toEqual(['a']);
    await expect(pool.start(server('a'))).resolves.toEqual({ port: 8012, pid: 555, adopted: true });
    expect(ready).toEqual(['a', 'a']);
  });

  test('stopping or disposing an adopted server leaves it running and ends the watch', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool, clock, terminated, probes } = setup({ launch, managed: [server('a', 8012, 555)], probe: ports({ 8012: 'ours' }) });
    await pool.startSelected();
    expect(clock.pending()).toBe(1);
    await pool.stop('a');
    expect(clock.pending()).toBe(0);
    await pool.startSelected();
    expect(clock.pending()).toBe(1);
    pool.dispose();
    expect(clock.pending()).toBe(0);
    await clock.fire();
    expect(probes).toEqual([8012, 8012]);
    expect(launched).toHaveLength(0);
    expect(terminated).toEqual([]);
  });

  test('a llama-server still loading on the saved port (another window at the same start) is waited for, then adopted', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const states: PortState[] = ['loading', 'loading', 'ours'];
    const { pool, moved } = setup({ launch, managed: [server('a')], probe: () => Promise.resolve(states.shift() ?? 'ours') });
    await pool.startSelected();
    expect(launched).toHaveLength(0);
    expect(moved).toEqual([]);
    expect(pool.running()).toEqual(['a']);
  });

  test('a stop while waiting for a loading server cancels the start', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool } = setup({ launch, probe: ports({ 8012: 'loading' }) });
    const started = pool.start(server('a'));
    await tick(5);
    await pool.stop('a');
    await expect(started).rejects.toBeInstanceOf(StartCancelled);
    expect(launched).toHaveLength(0);
  });

  test('a launch that lost the saved port to another window starting at the same moment adopts that server', async () => {
    const states: Record<number, PortState> = {};
    const launch: Launch = () => {
      states[8012] = 'ours';
      return Promise.reject(new LocalRuntimeError('llama-server exited (code 1) before it was ready.'));
    };
    const { pool, errors } = setup({ launch, managed: [server('a')], probe: ports(states) });
    await pool.startSelected();
    expect(errors()).toEqual([]);
    expect(pool.running()).toEqual(['a']);
  });

  test('when the adopted server goes away (its window closed), this window starts its own on the saved port and records it', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const states: Record<number, PortState> = { 8012: 'ours' };
    const { pool, clock, managed, moved } = setup({ launch, managed: [server('a', 8012, 555)], probe: ports(states) });
    await pool.startSelected();
    await clock.fire();
    expect(launched).toHaveLength(0);
    states[8012] = 'none';
    await clock.fire();
    expect(launched).toHaveLength(1);
    expect(launched[0].o.port).toBe(8012);
    expect(moved).toEqual([]);
    expect(managed()).toEqual([server('a', 8012, launched[0].child.pid)]);
    expect(pool.running()).toEqual(['a']);
    expect(clock.pending()).toBe(0);
  });

  test('a gone server whose record lost its pid (Stop Local Models) is not started again', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const states: Record<number, PortState> = { 8012: 'ours' };
    const { pool, clock, setManaged } = setup({ launch, managed: [server('a', 8012, 555)], probe: ports(states) });
    await pool.startSelected();
    states[8012] = 'none';
    setManaged([server('a')]);
    await clock.fire();
    expect(launched).toHaveLength(0);
    expect(pool.active()).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  test('a gone server whose port is held by something else (another window loading its own) is watched on, then adopted', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const states: Record<number, PortState> = { 8012: 'ours' };
    let free = false;
    const { pool, clock } = setup({ launch, managed: [server('a', 8012, 555)], probe: ports(states), freePort: (p) => Promise.resolve(free ? p : 40000) });
    await pool.startSelected();
    states[8012] = 'none';
    await clock.fire();
    expect(launched).toHaveLength(0);
    expect(clock.pending()).toBe(1);
    states[8012] = 'ours';
    free = true;
    await clock.fire();
    expect(launched).toHaveLength(0);
    expect(pool.running()).toEqual(['a']);
  });

  test('a port held by a server that is not ours keeps the old behaviour: a new port and the backend moves', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool, moved } = setup({ launch, managed: [server('a')], freePort: () => Promise.resolve(9001) });
    await pool.startSelected();
    expect(launched[0].o.port).toBe(9001);
    expect(moved).toEqual([9001]);
  });
});

describe('ServerPool.stopEverywhere', () => {
  test("clears the pids, stops this window's servers and sends SIGTERM to live recorded servers that still serve their alias", async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const records = [server('a', 8012), server('b', 8013, 501), server('c', 8014, 502), server('d', 8015, 503)];
    const { pool, managed, terminated } = setup({
      launch,
      managed: records,
      // b: another window's, alive and serving; c: its pid is gone; d: alive, but its port serves something else now.
      alive: (pid) => pid === 501 || pid === 503,
      probe: ports({ 8013: 'ours' }),
    });
    await pool.start(server('a'));
    await expect(pool.stopEverywhere()).resolves.toBe(true);
    expect(launched[0].child.signals).toEqual(['SIGTERM']);
    expect(terminated).toEqual([501]);
    expect(managed()).toEqual([server('a', 8012), server('b', 8013), server('c', 8014), server('d', 8015)]);
    expect(pool.active()).toEqual([]);
  });

  test('says so when nothing ran anywhere', async () => {
    const { launch } = fakeLaunch({ autoReady: true });
    const { pool, terminated } = setup({ launch, managed: [server('a', 8012, 501)] });
    await expect(pool.stopEverywhere()).resolves.toBe(false);
    expect(terminated).toEqual([]);
  });

  test('stops only by pid a server this window adopted', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool, terminated, clock } = setup({ launch, managed: [server('a', 8012, 501)], alive: () => true, probe: ports({ 8012: 'ours' }) });
    await pool.startSelected();
    await expect(pool.stopEverywhere()).resolves.toBe(true);
    expect(terminated).toEqual([501]);
    expect(clock.pending()).toBe(0);
    expect(launched).toHaveLength(0);
  });
});

describe('ServerPool.selectionChanged', () => {
  function selecting(fim: string | undefined, ids = ['a', 'b']): Settings {
    const inspected: Record<string, Inspected<unknown>> = {
      backends: { globalValue: ids.map((id) => ({ id, kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012' })) },
      ...(fim ? { 'completions.backend': { globalValue: fim } } : {}),
    };
    return parseSettings({ inspect: <T>(key: string) => inspected[key] as Inspected<T> | undefined }).settings;
  }

  test('starts the server of a backend that became selected and stops the one no longer selected', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool } = setup({ launch, managed: [server('a'), server('b', 8013)] });
    await pool.selectionChanged(selecting('b'), selecting('a'));
    expect(pool.running()).toEqual(['a']);
    await pool.selectionChanged(selecting('a'), selecting('b'));
    expect(launched[0].child.signals).toEqual(['SIGTERM']);
    expect(pool.running()).toEqual(['b']);
  });

  test('a server stopped with Stop Local Models stays stopped through a change that keeps its selection', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool } = setup({ launch, managed: [server('a')] });
    await pool.selectionChanged(selecting('b'), selecting('a'));
    await pool.stopEverywhere();
    await pool.selectionChanged(selecting('a'), selecting('a'));
    expect(launched).toHaveLength(1);
    expect(pool.active()).toEqual([]);
  });
});
