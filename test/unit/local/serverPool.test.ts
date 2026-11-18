import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import { parseSettings, type Inspected, type Settings } from '../../../src/config/settings';
import type { ManagedServer } from '../../../src/local/backendEntry';
import { LocalRuntimeError, type ChildLike } from '../../../src/local/llamaServer';
import type { LocalModel } from '../../../src/local/modelList';
import type { PortState } from '../../../src/local/router';
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
    o.log('router listening');
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

const LOCAL = { id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012', use: ['completions', 'nextEdit'], model: 'qwen2.5-coder-3b', nextEditModel: 'sweep-next-edit-1.5b' };

function makeSettings(map: Record<string, unknown> = {}, backends: unknown[] = [LOCAL]): Settings {
  const inspected: Record<string, Inspected<unknown>> = {
    backends: { globalValue: backends },
    'completions.backend': { globalValue: 'local' },
    'nextEdit.backend': { globalValue: 'local' },
  };
  for (const [k, v] of Object.entries(map)) inspected[k] = { globalValue: v };
  return parseSettings({ inspect: <T>(key: string) => inspected[key] as Inspected<T> | undefined }).settings;
}
const deselected = (): Settings => makeSettings({ 'completions.enabled': false, 'nextEdit.enabled': false });

const PRESETS = '/g/presets.ini';
const record = (port = 8012, pid?: number, modelsMax = 1): ManagedServer => ({ port, presetsPath: PRESETS, modelsMax, ...(pid ? { pid } : {}) });
/** The record a restart in some window writes while it stops the old router. */
const restarting = (port = 8012, modelsMax = 1): ManagedServer => ({ ...record(port, undefined, modelsMax), restarting: true });
/** The models downloaded in these tests (all built-ins otherwise count as not downloaded). */
const DOWNLOADED = ['sweep-next-edit-1.5b', 'qwen2.5-coder-3b'];

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
  managed?: ManagedServer;
  writeManaged?: ServerPoolDeps['writeManaged'];
  probe?: ServerPoolDeps['probe'];
  alive?: ServerPoolDeps['alive'];
  binary?: () => string | undefined;
  help?: string;
  settings?: () => Settings;
  downloaded?: string[];
  load?: (port: number, name: string) => Promise<void>;
  reload?: (port: number) => void;
  focused?: boolean;
}) {
  const logs: { level: string; m: string }[] = [];
  const at = (level: string) => (m: string) => void logs.push({ level, m });
  let managed: unknown = o.managed;
  const ports: number[] = [];
  const probes: { port: number; names: string[] }[] = [];
  const moved: number[] = [];
  const terminated: number[] = [];
  const unexpected: number[] = [];
  const ready: string[] = [];
  const presets: string[] = [];
  const helps: string[] = [];
  const reloads: number[] = [];
  const loads: string[] = [];
  const writes: (ManagedServer | undefined)[] = [];
  const clock = fakeSleep();
  const downloaded = o.downloaded ?? DOWNLOADED;
  const pool = new ServerPool({
    launch: o.launch,
    binary: o.binary ?? (() => '/bin/llama-server'),
    helpText: (b) => (helps.push(b), Promise.resolve(o.help ?? '  --models-preset PATH   presets file\n')),
    freePort: o.freePort ?? ((p) => (ports.push(p), Promise.resolve(p))),
    presetsPath: PRESETS,
    writePresets: (text) => (presets.push(text), Promise.resolve()),
    downloadedPath: (m: LocalModel) => (downloaded.includes(m.name) ? `/models/${m.repo}/${m.file}` : undefined),
    readManaged: () => managed,
    writeManaged:
      o.writeManaged ??
      ((rec) => {
        managed = rec;
        writes.push(rec);
        return Promise.resolve();
      }),
    moveBackend: (port) => (moved.push(port), Promise.resolve()),
    settings: o.settings ?? (() => makeSettings()),
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
    probe: (port, names) => {
      probes.push({ port, names });
      return o.probe ? o.probe(port, names) : Promise.resolve<PortState>('none');
    },
    router: (port) => ({
      load: (name) => (loads.push(name), o.load ? o.load(port, name) : Promise.resolve()),
      reload: () => (reloads.push(port), o.reload?.(port), Promise.resolve()),
    }),
    alive: o.alive ?? (() => false),
    terminate: (pid) => void terminated.push(pid),
    stoppedUnexpectedly: () => void unexpected.push(1),
    onReady: (id) => void ready.push(id),
    focused: () => o.focused ?? true,
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
    presets,
    helps,
    reloads,
    loads,
    writes,
    clock,
    managed: () => managed,
    setManaged: (rec: ManagedServer | undefined) => void (managed = rec),
  };
}

/** A probe that answers from a mutable state per port (none for any other). */
function portStates(states: Record<number, PortState>): ServerPoolDeps['probe'] {
  return (port) => Promise.resolve(states[port] ?? 'none');
}

const flag = (args: string[], f: string): string | undefined => args[args.indexOf(f) + 1];

describe('ServerPool', () => {
  test('start writes the presets of the downloaded, not hidden models and launches the router with them', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const hidden = () => makeSettings({ 'local.models': [{ name: 'qwen2.5-coder-3b', hidden: true }] });
    const { pool, presets, managed, ready } = setup({ launch, settings: hidden });
    const started = await pool.start();
    expect(started).toEqual({ port: 8012, pid: launched[0].child.pid, adopted: false });
    expect(launched[0].o.args).toEqual(['--models-preset', PRESETS, '--models-max', '1', '--host', '127.0.0.1', '--port', '8012', '--no-webui']);
    expect(launched[0].o.binary).toBe('/bin/llama-server');
    expect(presets).toHaveLength(1);
    expect(presets[0]).toContain('[sweep-next-edit-1.5b]\nmodel = /models/sweepai/sweep-next-edit-1.5B/sweep-next-edit-1.5b.q8_0.v2.gguf\nc = 16384\nnp = 2\n');
    expect(presets[0]).not.toContain('qwen2.5-coder-3b');
    expect(presets[0]).not.toContain('mellum');
    expect(managed()).toEqual(record(8012, launched[0].child.pid));
    expect(ready).toEqual(['local']);
    expect(pool.state()).toBe('running');
    expect(pool.port()).toBe(8012);
  });

  test('models in memory sets --models-max and the record', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool, managed } = setup({ launch, settings: () => makeSettings({ 'local.modelsInMemory': 2 }) });
    await pool.start();
    expect(flag(launched[0].o.args, '--models-max')).toBe('2');
    expect(managed()).toEqual(record(8012, launched[0].child.pid, 2));
  });

  test('a presets render failure (a bad hand-edited setting) fails the start with a fixed message and launches nothing', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const bad = () => makeSettings({ 'local.models': [{ name: 'evil', repo: 'a/b', revision: 'r', file: 'x\ny.gguf', bytes: 1, sha256: 's' }] });
    const { pool, errors, presets } = setup({ launch, settings: bad, downloaded: ['evil'] });
    await expect(pool.start()).rejects.toThrow(/presets file/);
    expect(launched).toHaveLength(0);
    expect(presets).toEqual([]);
    expect(pool.state()).toBe('failed');
    expect(pool.failure()).toMatch(/presets file/);
    expect(errors().some((e) => e.includes('presets'))).toBe(true);
  });

  test('the router output is kept (last 200 lines) and logged at debug', async () => {
    const { launch } = fakeLaunch({ autoReady: true });
    const { pool, logs } = setup({ launch });
    await pool.start();
    expect(pool.lastOutput()).toEqual(['router listening']);
    expect(logs).toContainEqual({ level: 'debug', m: 'llama-server: router listening' });
    for (let i = 0; i < 205; i++) await pool.restart();
    expect(pool.lastOutput()).toHaveLength(200);
  });

  test('state changes are announced', async () => {
    const { launch, launched } = fakeLaunch();
    const { pool } = setup({ launch });
    const seen: string[] = [];
    const sub = pool.onChange(() => seen.push(pool.state()));
    const started = pool.start();
    await tick();
    launched[0].ready();
    await started;
    await pool.stopHere();
    sub.dispose();
    const again = pool.start();
    await pool.stopHere();
    await again.catch(() => undefined);
    expect(seen).toEqual(['starting', 'running', 'stopped']);
  });

  test('concurrent starts give one process', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool } = setup({ launch });
    const first = pool.start();
    const second = pool.start();
    await expect(first).rejects.toBeInstanceOf(StartCancelled);
    await expect(second).resolves.toMatchObject({ port: 8012 });
    expect(launched).toHaveLength(1);
    expect(pool.state()).toBe('running');
  });

  test('a stop during the initial wait means no spawn', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const port = deferred<number>();
    const { pool } = setup({ launch, freePort: () => port.promise });
    const started = pool.start();
    expect(pool.state()).toBe('starting');
    const stopped = pool.stopHere();
    port.resolve(8012);
    await stopped;
    await expect(started).rejects.toBeInstanceOf(StartCancelled);
    expect(launched).toHaveLength(0);
    expect(pool.state()).toBe('stopped');
  });

  test('a start after dispose is refused', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool } = setup({ launch });
    pool.dispose();
    await expect(pool.start()).rejects.toBeInstanceOf(StartCancelled);
    await pool.startSelected();
    expect(launched).toHaveLength(0);
  });

  test('dispose stops a loading router', async () => {
    const { launch, launched } = fakeLaunch();
    const { pool } = setup({ launch });
    const started = pool.start();
    await tick();
    pool.dispose();
    await expect(started).rejects.toBeInstanceOf(StartCancelled);
    expect(launched[0].child.signals).toEqual(['SIGTERM']);
  });

  test('an unexpected exit is logged once with its exit code and last output, and the user is told; an asked-for stop is not', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool, errors, unexpected } = setup({ launch });
    await pool.start();
    launched[0].child.exit();
    await tick(5);
    expect(errors()).toEqual(['llama-server exited unexpectedly (code 134).\nLast output:\nggml_abort: out of memory']);
    expect(unexpected).toHaveLength(1);
    expect(pool.state()).toBe('failed');
    await pool.start();
    await pool.stopHere();
    await tick(5);
    expect(errors()).toHaveLength(1);
    expect(unexpected).toHaveLength(1);
    expect(pool.state()).toBe('stopped');
  });

  test('an exit after Stop Local Models in another window (the record lost its pid) is not an error', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool, errors, unexpected, logs, setManaged } = setup({ launch });
    await pool.start();
    setManaged(record());
    launched[0].child.exit('SIGTERM');
    await tick(5);
    expect(errors()).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(logs.map((l) => l.m)).toContain('llama-server was stopped by Stop Local Models in another window.');
    expect(pool.state()).toBe('stopped');
  });

  test('a restart of a loading router waits for the old child to exit (SIGKILL after the grace period) before choosing the port', async () => {
    const { launch, launched } = fakeLaunch({ ignoreTerm: true });
    const oldExitedWhenAsked: boolean[] = [];
    const { pool } = setup({
      launch,
      freePort: (p) => {
        oldExitedWhenAsked.push(launched[0]?.child.exited ?? true);
        return Promise.resolve(p);
      },
    });
    const first = pool.start();
    await tick();
    expect(launched).toHaveLength(1);
    const second = pool.start();
    await expect(first).rejects.toBeInstanceOf(StartCancelled);
    await tick(40);
    expect(launched[0].child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(launched).toHaveLength(2);
    expect(oldExitedWhenAsked).toEqual([true, true]);
    launched[1].ready();
    await expect(second).resolves.toMatchObject({ port: 8012 });
  });

  test('a record failure is logged as such, not as a failed start', async () => {
    const { launch } = fakeLaunch({ autoReady: true });
    const { pool, errors } = setup({ launch, writeManaged: () => Promise.reject(new Error('disk full')) });
    await pool.startSelected();
    expect(errors()).toEqual(['local models: saving the router (port 8012) failed']);
    expect(pool.state()).toBe('running');
  });

  test('a start failure is logged as an error and leaves the state failed', async () => {
    const launch: Launch = () => Promise.reject(new LocalRuntimeError('boom'));
    const { pool, errors, ready } = setup({ launch });
    await pool.startSelected();
    expect(errors()).toEqual(['local models: llama-server could not start']);
    expect(pool.state()).toBe('failed');
    expect(pool.failure()).toBe('boom');
    expect(ready).toEqual([]);
  });
});

describe('ServerPool: llama-server checks', () => {
  test('no llama-server: failed with the install hint, nothing thrown from startSelected', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool } = setup({ launch, binary: () => undefined });
    await pool.startSelected();
    expect(launched).toHaveLength(0);
    expect(pool.state()).toBe('failed');
    expect(pool.failure()).toMatch(/llama-server was not found\. Install llama\.cpp/);
  });

  test('a llama-server without router mode: failed with the update hint', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool } = setup({ launch, help: '  -m, --model FNAME\n' });
    await pool.startSelected();
    expect(launched).toHaveLength(0);
    expect(pool.state()).toBe('failed');
    expect(pool.failure()).toMatch(/too old for the local model helper; update llama\.cpp\. Install llama\.cpp/);
  });

  test('binaryProblem names a missing or too old llama-server, nothing for a router-capable one', async () => {
    const { launch } = fakeLaunch({ autoReady: true });
    expect(await setup({ launch }).pool.binaryProblem()).toBeUndefined();
    expect(await setup({ launch, binary: () => undefined }).pool.binaryProblem()).toMatch(/not found/);
    expect(await setup({ launch, help: 'old' }).pool.binaryProblem()).toMatch(/too old/);
  });

  test('the help text is read once per binary path', async () => {
    const { launch } = fakeLaunch({ autoReady: true });
    let binary = '/bin/llama-server';
    const { pool, helps } = setup({ launch, binary: () => binary });
    await pool.start();
    await pool.start();
    binary = '/opt/llama-server';
    await pool.start();
    expect(helps).toEqual(['/bin/llama-server', '/opt/llama-server']);
  });
});

describe('ServerPool: presets, warm-up, restart', () => {
  test('syncPresets on a running router rewrites the file and reloads once; when stopped it only writes', async () => {
    const { launch } = fakeLaunch({ autoReady: true });
    const { pool, presets, reloads } = setup({ launch });
    await pool.syncPresets();
    expect(presets).toHaveLength(1);
    expect(reloads).toEqual([]);
    await pool.start();
    const before = reloads.length;
    await pool.syncPresets();
    expect(presets).toHaveLength(3);
    expect(reloads.length - before).toBe(1);
  });

  test('warm posts load for each distinct name, up to models in memory', async () => {
    const { launch } = fakeLaunch({ autoReady: true });
    const { pool, loads } = setup({ launch, settings: () => makeSettings({ 'local.modelsInMemory': 2 }) });
    await pool.warm(['a']);
    expect(loads).toEqual([]);
    await pool.start();
    await tick();
    loads.length = 0;
    await pool.warm(['a', 'a', 'b', 'c']);
    expect(loads).toEqual(['a', 'b']);
  });

  test('a failed load is logged at debug only', async () => {
    const { launch } = fakeLaunch({ autoReady: true });
    const { pool, logs } = setup({ launch, load: () => Promise.reject(new Error('400')) });
    await pool.start();
    await pool.warm(['a']);
    expect(logs.filter((l) => l.level !== 'debug' && l.level !== 'info')).toEqual([]);
  });

  test('after a start the selected models are loaded (completions first, at most models in memory)', async () => {
    const { launch } = fakeLaunch({ autoReady: true });
    const { pool, loads } = setup({ launch });
    await pool.start();
    await tick();
    expect(loads).toEqual(['qwen2.5-coder-3b']);
  });

  test('a models in memory change restarts the router this window runs', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    let s = makeSettings();
    const { pool, managed } = setup({ launch, settings: () => s });
    await pool.startSelected();
    const before = s;
    s = makeSettings({ 'local.modelsInMemory': 2 });
    await pool.settingsChanged(before, s);
    expect(launched).toHaveLength(2);
    expect(launched[0].child.signals).toEqual(['SIGTERM']);
    expect(flag(launched[1].o.args, '--models-max')).toBe('2');
    expect(managed()).toEqual(record(8012, launched[1].child.pid, 2));
  });

  test('a models in memory change in a window without focus restarts nothing', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    let s = makeSettings();
    const { pool } = setup({ launch, settings: () => s, focused: false });
    await pool.startSelected();
    const before = s;
    s = makeSettings({ 'local.modelsInMemory': 2 });
    await pool.settingsChanged(before, s);
    expect(launched).toHaveLength(1);
  });

  test("restart from a window that adopted the router stops the owner's process by pid, then starts its own", async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const states: Record<number, PortState> = { 8012: 'ours' };
    const { pool, terminated, managed } = setup({
      launch,
      managed: record(8012, 555),
      alive: (pid) => pid === 555,
      probe: portStates(states),
      settings: () => makeSettings({ 'local.modelsInMemory': 2 }),
    });
    await pool.startSelected();
    expect(launched).toHaveLength(0);
    const restarted = pool.restart();
    await tick();
    expect(terminated).toEqual([555]);
    // The record says a restart is under way: no pid, the new models in memory.
    expect(managed()).toEqual(restarting(8012, 2));
    states[8012] = 'none';
    await restarted;
    expect(launched).toHaveLength(1);
    expect(launched[0].o.port).toBe(8012);
    expect(managed()).toEqual(record(8012, launched[0].child.pid, 2));
  });

  test('the owner window whose router another window restarted (same models in memory) watches the new one instead of reporting an error', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const states: Record<number, PortState> = {};
    const { pool, errors, unexpected, setManaged, clock, logs } = setup({ launch, probe: portStates(states) });
    await pool.start();
    setManaged(restarting());
    launched[0].child.exit('SIGTERM');
    await tick(5);
    expect(errors()).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(pool.state()).toBe('running');
    expect(clock.pending()).toBe(1);
    expect(logs.map((l) => l.m)).not.toContain('llama-server was stopped by Stop Local Models in another window.');
  });

  test('a restart with the same models in memory marks the record, and a failed start clears the mark', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const t = setup({ launch });
    await t.pool.start();
    const pid = launched[0].child.pid;
    await t.pool.restart();
    expect(t.writes.slice(1)).toEqual([restarting(), record(8012, launched[1].child.pid)]);
    expect(t.managed()).toEqual(record(8012, launched[1].child.pid));
    expect(pid).not.toBe(launched[1].child.pid);

    const failing = setup({ launch: () => Promise.reject(new LocalRuntimeError('boom')), managed: record(8012, 555) });
    await failing.pool.restart();
    expect(failing.managed()).toEqual(record());
    expect(failing.pool.state()).toBe('failed');
  });

  test('a model list change rewrites the presets and reloads; a selection change warms the new models', async () => {
    const { launch } = fakeLaunch({ autoReady: true });
    let s = makeSettings();
    const { pool, reloads, loads, presets } = setup({ launch, settings: () => s });
    await pool.startSelected();
    await tick();
    loads.length = 0;
    const r = reloads.length;
    const p = presets.length;
    let before = s;
    s = makeSettings({ 'local.models': [{ name: 'sweep-next-edit-1.5b', contextTokens: 4096 }] });
    await pool.settingsChanged(before, s);
    expect(presets.length - p).toBe(1);
    expect(reloads.length - r).toBe(1);
    expect(loads).toEqual([]);
    before = s;
    s = makeSettings({ 'local.models': [{ name: 'sweep-next-edit-1.5b', contextTokens: 4096 }] }, [{ ...LOCAL, model: 'sweep-next-edit-1.5b' }]);
    await pool.settingsChanged(before, s);
    expect(loads).toEqual(['sweep-next-edit-1.5b']);
    expect(reloads.length - r).toBe(1);
  });
});

describe('ServerPool across windows', () => {
  test('a router already answering on the saved port with every preset model is adopted: no spawn, no move, no new record', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool, moved, managed: saved, probes, ready } = setup({
      launch,
      managed: record(8012, 555),
      probe: (port, names) => Promise.resolve(port === 8012 && names.length > 0 ? 'ours' : 'none'),
    });
    await pool.startSelected();
    expect(launched).toHaveLength(0);
    expect(moved).toEqual([]);
    expect(saved()).toEqual(record(8012, 555));
    expect(probes[0]).toEqual({ port: 8012, names: DOWNLOADED });
    expect(pool.state()).toBe('running');
    await expect(pool.start()).resolves.toEqual({ port: 8012, pid: 555, adopted: true });
    expect(ready).toEqual(['local', 'local']);
  });

  test('the recorded router (live pid) that lacks a model is reloaded (another window wrote new presets) and then adopted', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    let reloaded = false;
    const { pool, reloads } = setup({
      launch,
      managed: record(8012, 555),
      alive: (pid) => pid === 555,
      probe: (_port, names) => Promise.resolve(names.length === 0 || reloaded ? 'ours' : 'none'),
      reload: () => void (reloaded = true),
    });
    await pool.startSelected();
    expect(reloads).toEqual([8012]);
    expect(launched).toHaveLength(0);
    expect(pool.state()).toBe('running');
  });

  test('a router we did not start (no live recorded pid) is never reloaded nor adopted without our models', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const anyRouter: ServerPoolDeps['probe'] = (_port, names) => Promise.resolve(names.length === 0 ? 'ours' : 'none');
    const foreign = setup({ launch, managed: record(8012, 555), alive: () => false, probe: anyRouter, freePort: () => Promise.resolve(9001) });
    await foreign.pool.startSelected();
    expect(foreign.reloads).toEqual([]);
    expect(launched).toHaveLength(1);
    expect(foreign.moved).toEqual([9001]);

    // No downloaded models: any router lists all of none, so only the recorded one is adopted.
    const empty = setup({ launch, downloaded: [], probe: anyRouter, freePort: () => Promise.resolve(9002) });
    await empty.pool.startSelected();
    expect(launched).toHaveLength(2);
    const recorded = setup({ launch, downloaded: [], managed: record(8012, 555), alive: () => true, probe: anyRouter });
    await recorded.pool.startSelected();
    expect(launched).toHaveLength(2);
    expect(recorded.pool.state()).toBe('running');
  });

  test("without a record the saved port is local's baseUrl port", async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const s = () => makeSettings({}, [{ ...LOCAL, baseUrl: 'http://127.0.0.1:8100' }]);
    const { pool, probes, moved } = setup({ launch, settings: s });
    await pool.startSelected();
    expect(probes[0].port).toBe(8100);
    expect(launched[0].o.port).toBe(8100);
    expect(moved).toEqual([]);
  });

  test('stopping or disposing an adopted router leaves it running and ends the watch', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool, clock, terminated } = setup({ launch, managed: record(8012, 555), probe: portStates({ 8012: 'ours' }) });
    await pool.startSelected();
    expect(clock.pending()).toBe(1);
    await pool.stopHere();
    expect(clock.pending()).toBe(0);
    await pool.startSelected();
    expect(clock.pending()).toBe(1);
    pool.dispose();
    expect(clock.pending()).toBe(0);
    await clock.fire();
    expect(launched).toHaveLength(0);
    expect(terminated).toEqual([]);
  });

  test('a router still loading on the saved port (another window at the same start) is waited for, then adopted', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const states: PortState[] = ['loading', 'loading', 'ours'];
    const { pool, moved } = setup({ launch, managed: record(), probe: () => Promise.resolve(states.shift() ?? 'ours') });
    await pool.startSelected();
    expect(launched).toHaveLength(0);
    expect(moved).toEqual([]);
    expect(pool.state()).toBe('running');
  });

  test('a stop while waiting for a loading router cancels the start', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool } = setup({ launch, probe: portStates({ 8012: 'loading' }) });
    const started = pool.start();
    await tick(5);
    await pool.stopHere();
    await expect(started).rejects.toBeInstanceOf(StartCancelled);
    expect(launched).toHaveLength(0);
  });

  test('a launch that lost the saved port to another window starting at the same moment adopts that router', async () => {
    const states: Record<number, PortState> = {};
    const launch: Launch = () => {
      states[8012] = 'ours';
      return Promise.reject(new LocalRuntimeError('llama-server exited (code 1) before it was ready.'));
    };
    const { pool, errors } = setup({ launch, managed: record(), probe: portStates(states) });
    await pool.startSelected();
    expect(errors()).toEqual([]);
    expect(pool.state()).toBe('running');
  });

  test('when the adopted router goes away (its window closed), this window starts its own on the saved port and records it', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const states: Record<number, PortState> = { 8012: 'ours' };
    const { pool, clock, managed, moved } = setup({ launch, managed: record(8012, 555), probe: portStates(states) });
    await pool.startSelected();
    await clock.fire();
    expect(launched).toHaveLength(0);
    states[8012] = 'none';
    await clock.fire();
    expect(launched).toHaveLength(1);
    expect(launched[0].o.port).toBe(8012);
    expect(moved).toEqual([]);
    expect(managed()).toEqual(record(8012, launched[0].child.pid));
    expect(pool.state()).toBe('running');
    expect(clock.pending()).toBe(0);
  });

  test('a gone router whose record lost its pid (Stop Local Models) is not started again', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const states: Record<number, PortState> = { 8012: 'ours' };
    const { pool, clock, setManaged } = setup({ launch, managed: record(8012, 555), probe: portStates(states) });
    await pool.startSelected();
    states[8012] = 'none';
    setManaged(record());
    await clock.fire();
    expect(launched).toHaveLength(0);
    expect(pool.state()).toBe('stopped');
    expect(clock.pending()).toBe(0);
  });

  test('a gone router whose record says a restart is under way (marked, same models in memory) is watched on', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const states: Record<number, PortState> = { 8012: 'ours' };
    const { pool, clock, setManaged } = setup({ launch, managed: record(8012, 555), probe: portStates(states) });
    await pool.startSelected();
    states[8012] = 'none';
    setManaged(restarting());
    await clock.fire();
    expect(launched).toHaveLength(0);
    expect(clock.pending()).toBe(1);
    states[8012] = 'ours';
    setManaged(record(8012, 777));
    await clock.fire();
    expect(pool.state()).toBe('running');
    expect(launched).toHaveLength(0);
  });

  test('a gone router whose port is held by something else (another window loading its own) is watched on, then adopted', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const states: Record<number, PortState> = { 8012: 'ours' };
    let free = false;
    const { pool, clock } = setup({ launch, managed: record(8012, 555), probe: portStates(states), freePort: (p) => Promise.resolve(free ? p : 40000) });
    await pool.startSelected();
    states[8012] = 'none';
    await clock.fire();
    expect(launched).toHaveLength(0);
    expect(clock.pending()).toBe(1);
    states[8012] = 'ours';
    free = true;
    await clock.fire();
    expect(launched).toHaveLength(0);
    expect(pool.state()).toBe('running');
  });

  test('a port held by something that is not our router: a new free port, and local moves there', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool, moved, managed } = setup({ launch, managed: record(), freePort: () => Promise.resolve(9001) });
    await pool.startSelected();
    expect(launched[0].o.port).toBe(9001);
    expect(flag(launched[0].o.args, '--port')).toBe('9001');
    expect(moved).toEqual([9001]);
    expect(managed()).toEqual(record(9001, launched[0].child.pid));
  });
});

describe('ServerPool.stopEverywhere', () => {
  test("clears the pid, stops this window's router", async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool, managed, terminated } = setup({ launch });
    await pool.start();
    await expect(pool.stopEverywhere()).resolves.toBe(true);
    expect(launched[0].child.signals).toEqual(['SIGTERM']);
    expect(terminated).toEqual([]);
    expect(managed()).toEqual(record());
    expect(pool.state()).toBe('stopped');
  });

  test("sends SIGTERM to another window's router when its pid is alive and a router answers on its port", async () => {
    const { launch } = fakeLaunch({ autoReady: true });
    const live = setup({ launch, managed: record(8012, 501), alive: (pid) => pid === 501, probe: portStates({ 8012: 'ours' }) });
    await expect(live.pool.stopEverywhere()).resolves.toBe(true);
    expect(live.terminated).toEqual([501]);
    expect(live.managed()).toEqual(record());

    const gone = setup({ launch, managed: record(8012, 502), alive: () => false, probe: portStates({ 8012: 'ours' }) });
    await expect(gone.pool.stopEverywhere()).resolves.toBe(false);
    expect(gone.terminated).toEqual([]);

    const other = setup({ launch, managed: record(8012, 503), alive: () => true });
    await expect(other.pool.stopEverywhere()).resolves.toBe(false);
    expect(other.terminated).toEqual([]);
  });

  test('stops only by pid a router this window adopted', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool, terminated, clock } = setup({ launch, managed: record(8012, 501), alive: () => true, probe: portStates({ 8012: 'ours' }) });
    await pool.startSelected();
    await expect(pool.stopEverywhere()).resolves.toBe(true);
    expect(terminated).toEqual([501]);
    expect(clock.pending()).toBe(0);
    expect(launched).toHaveLength(0);
  });
});

describe('ServerPool.settingsChanged (selection)', () => {
  test('starts the router when local became selected and stops it when it no longer is', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool } = setup({ launch });
    await pool.settingsChanged(deselected(), makeSettings());
    expect(pool.state()).toBe('running');
    await pool.settingsChanged(makeSettings(), deselected());
    expect(launched[0].child.signals).toEqual(['SIGTERM']);
    expect(pool.state()).toBe('stopped');
  });

  test('a router stopped with Stop Local Models stays stopped through a change that keeps its selection', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool } = setup({ launch });
    await pool.settingsChanged(deselected(), makeSettings());
    await pool.stopEverywhere();
    await pool.settingsChanged(makeSettings(), makeSettings({ 'completions.debounceMs': 100 }));
    expect(launched).toHaveLength(1);
    expect(pool.state()).toBe('stopped');
  });

  test('startSelected starts nothing while local is not selected', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool } = setup({ launch, settings: deselected });
    await pool.startSelected();
    expect(launched).toHaveLength(0);
    expect(pool.state()).toBe('stopped');
  });
});
