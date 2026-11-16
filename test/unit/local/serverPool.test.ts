import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import { parseSettings, type Inspected, type Settings } from '../../../src/config/settings';
import type { ManagedServer } from '../../../src/local/backendEntry';
import { LocalRuntimeError, type ChildLike } from '../../../src/local/llamaServer';
import { ServerPool, StartCancelled, type Launch, type LaunchOptions, type RunningServer, type ServerPoolDeps } from '../../../src/local/serverPool';

class FakeChild extends EventEmitter implements ChildLike {
  readonly pid = 1;
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
    'fim.backend': { globalValue: 'a' },
    'nextEdit.enabled': { globalValue: true },
    'nextEdit.backend': { globalValue: 'b' },
  };
  return parseSettings({ inspect: <T>(key: string) => inspected[key] as Inspected<T> | undefined }).settings;
}

const server = (id: string, port = 8012): ManagedServer => ({ backendId: id, recipeId: 'sweep-1.5b', file: `/m/${id}.gguf`, port });

function setup(o: { launch: Launch; freePort?: ServerPoolDeps['freePort']; managed?: ManagedServer[]; writeManaged?: ServerPoolDeps['writeManaged'] }) {
  const logs: { level: string; m: string }[] = [];
  const at = (level: string) => (m: string) => void logs.push({ level, m });
  let managed: unknown = o.managed ?? [];
  const ports: number[] = [];
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
    moveBackend: () => Promise.resolve(),
    settings,
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
    killGraceMs: 20,
  });
  return { pool, logs, errors: () => logs.filter((l) => l.level === 'error').map((l) => l.m), ports, managed: () => managed };
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

  test('an unexpected exit is logged once; an asked-for stop is not', async () => {
    const { launch, launched } = fakeLaunch({ autoReady: true });
    const { pool, errors } = setup({ launch });
    await pool.start(server('a'));
    launched[0].child.exit();
    await tick();
    expect(errors()).toEqual(['llama-server a exited unexpectedly.']);
    expect(pool.active()).toEqual([]);
    await pool.stop('a');
    await pool.start(server('a'));
    await pool.stop('a');
    await tick();
    expect(errors()).toHaveLength(1);
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

  test('a moved port is recorded; a record failure is logged as such, not as a failed start', async () => {
    const { launch } = fakeLaunch({ autoReady: true });
    const ok = setup({ launch, freePort: () => Promise.resolve(9001), managed: [server('a')] });
    await ok.pool.startSelected();
    expect(ok.managed()).toEqual([server('a', 9001)]);

    const failing = setup({ launch, freePort: () => Promise.resolve(9001), managed: [server('a')], writeManaged: () => Promise.reject(new Error('disk full')) });
    await failing.pool.startSelected();
    expect(failing.errors()).toEqual(['local model "a": saving its new port 9001 failed']);
    expect(failing.pool.running()).toEqual(['a']);
  });

  test('a start failure is logged as an error', async () => {
    const launch: Launch = () => Promise.reject(new LocalRuntimeError('boom'));
    const { pool, errors } = setup({ launch, managed: [server('a')] });
    await pool.startSelected();
    expect(errors()).toEqual(['local model "a" could not start']);
    expect(pool.active()).toEqual([]);
  });
});
