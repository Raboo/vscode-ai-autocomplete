import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultSpawn,
  freePort,
  LlamaServerProcess,
  llamaServerArgs,
  LocalRuntimeError,
  type ChildLike,
} from '../../../src/local/llamaServer';

class FakeChild extends EventEmitter implements ChildLike {
  readonly pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: Array<NodeJS.Signals | undefined> = [];
  exitOnSignal: NodeJS.Signals | undefined = 'SIGTERM';

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (signal === this.exitOnSignal || signal === 'SIGKILL') this.exit(null, signal ?? 'SIGTERM');
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

const servers: Server[] = [];

async function listen(handler: Parameters<typeof createServer>[1], port = 0): Promise<Server> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return server;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

function startOpts(child: FakeChild, port: number, over: Partial<Parameters<typeof LlamaServerProcess.start>[0]> = {}) {
  return {
    binary: '/bin/llama-server',
    args: ['-m', 'x'],
    port,
    spawnFn: () => child,
    log: () => {},
    timeoutMs: 5000,
    pollMs: 10,
    ...over,
  };
}

describe('llamaServerArgs', () => {
  it('returns the exact argument array', () => {
    expect(llamaServerArgs({ file: '/m/a.gguf', modelName: 'qwen', port: 8123, contextTokens: 8192 })).toEqual([
      '-m', '/m/a.gguf', '--alias', 'qwen', '--host', '127.0.0.1', '--port', '8123',
      '-c', '8192', '-ngl', '99', '-fa', 'on', '-np', '1', '--cache-reuse', '256', '--no-webui',
    ]);
  });
});

describe('freePort', () => {
  it('returns the preferred port when it is free', async () => {
    const probe = await listen(() => {});
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    expect(await freePort(port)).toBe(port);
  });

  it('returns another port when the preferred one is held', async () => {
    const held = await listen(() => {});
    const port = (held.address() as AddressInfo).port;
    const got = await freePort(port);
    expect(got).not.toBe(port);
    expect(got).toBeGreaterThan(0);
  });

  it('returns an OS-assigned port without a preference', async () => {
    expect(await freePort()).toBeGreaterThan(0);
  });
});

describe('LlamaServerProcess.start', () => {
  it('resolves once /health answers 200 (503 first) and logs each output line', async () => {
    let calls = 0;
    const urls: Array<string | undefined> = [];
    const server = await listen((req, res) => {
      urls.push(req.url);
      calls += 1;
      res.writeHead(calls === 1 ? 503 : 200);
      res.end();
    });
    const port = (server.address() as AddressInfo).port;
    const child = new FakeChild();
    const lines: string[] = [];
    const pending = LlamaServerProcess.start(startOpts(child, port, { log: (l) => lines.push(l) }));
    child.stderr.write('loading model\npartial');
    child.stderr.write(' line\n');
    child.stdout.write('ready\n');
    const proc = await pending;
    expect(proc.port).toBe(port);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(urls.every((u) => u === '/health')).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(lines).toEqual(expect.arrayContaining(['loading model', 'partial line', 'ready']));
  });

  it('treats connection refused as not ready yet', async () => {
    const probe = await listen(() => {});
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const child = new FakeChild();
    const pending = LlamaServerProcess.start(startOpts(child, port));
    await new Promise((r) => setTimeout(r, 40));
    const server = await listen((_req, res) => res.writeHead(200).end(), port);
    expect(server).toBeDefined();
    await expect(pending).resolves.toBeInstanceOf(LlamaServerProcess);
  });

  it('rejects with the last 20 output lines when the child exits early', async () => {
    const server = await listen((_req, res) => res.writeHead(503).end());
    const port = (server.address() as AddressInfo).port;
    const child = new FakeChild();
    const pending = LlamaServerProcess.start(startOpts(child, port));
    const assertion = expect(pending).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof LocalRuntimeError)) return false;
      return e.message.includes('line 30') && e.message.includes('line 11') && !e.message.includes('line 10\n') && !/line 10$/.test(e.message);
    });
    child.stderr.write(Array.from({ length: 30 }, (_v, i) => `line ${i + 1}`).join('\n') + '\n');
    await new Promise((r) => setTimeout(r, 20));
    child.exit(1);
    await assertion;
    await expect(pending.catch((e: Error) => e.message)).resolves.toContain('code 1');
  });

  it('sends SIGTERM and rejects when the deadline passes', async () => {
    const server = await listen((_req, res) => res.writeHead(503).end());
    const port = (server.address() as AddressInfo).port;
    const child = new FakeChild();
    await expect(LlamaServerProcess.start(startOpts(child, port, { timeoutMs: 100 }))).rejects.toBeInstanceOf(LocalRuntimeError);
    expect(child.signals).toEqual(['SIGTERM']);
  });
});

describe('LlamaServerProcess.start deadline escalation', () => {
  it('escalates to SIGKILL when the child ignores SIGTERM at the deadline', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.exitOnSignal = undefined;
    const loading = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    const pending = LlamaServerProcess.start(startOpts(child, 1, { fetchFn: loading, timeoutMs: 100 }));
    const assertion = expect(pending).rejects.toBeInstanceOf(LocalRuntimeError);
    await vi.advanceTimersByTimeAsync(100);
    expect(child.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('LlamaServerProcess.stop', () => {
  async function started(child: FakeChild): Promise<LlamaServerProcess> {
    const server = await listen((_req, res) => res.writeHead(200).end());
    return LlamaServerProcess.start(startOpts(child, (server.address() as AddressInfo).port));
  }

  it('sends SIGTERM and resolves on exit', async () => {
    const child = new FakeChild();
    const proc = await started(child);
    await proc.stop();
    expect(child.signals).toEqual(['SIGTERM']);
    await expect(proc.exited).resolves.toBeUndefined();
  });

  it('sends SIGKILL after 5 s when the child has not exited', async () => {
    const child = new FakeChild();
    child.exitOnSignal = undefined;
    const proc = await started(child);
    vi.useFakeTimers();
    let done = false;
    const stopping = proc.stop().then(() => { done = true; });
    expect(child.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(4999);
    expect(child.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    await stopping;
    expect(done).toBe(true);
  });

  it('resolves immediately when the child already exited', async () => {
    const child = new FakeChild();
    const proc = await started(child);
    child.exit(0);
    await proc.stop();
    expect(child.signals).toEqual([]);
  });
});

describe('stream errors', () => {
  it('does not throw when an output stream errors', async () => {
    const server = await listen((_req, res) => res.writeHead(200).end());
    const child = new FakeChild();
    const pending = LlamaServerProcess.start(startOpts(child, (server.address() as AddressInfo).port));
    child.stdout.destroy(new Error('pipe broke'));
    await expect(pending).resolves.toBeInstanceOf(LlamaServerProcess);
  });
});

describe('defaultSpawn', () => {
  it('reports a missing binary as an exit instead of an unhandled error', async () => {
    const child = defaultSpawn('/definitely/not/a/binary', []);
    const code = await new Promise((r) => child.once('exit', (c) => r(c)));
    expect(code).toBeNull();
    expect(child.spawnError?.message).toContain('ENOENT');
  });

  it('start fails with the spawn error message for a missing binary', async () => {
    const closed = await listen(() => {});
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    await expect(
      LlamaServerProcess.start({ binary: '/definitely/not/a/binary', args: [], port, spawnFn: defaultSpawn, log: () => {}, pollMs: 10 }),
    ).rejects.toThrow(/Could not start llama-server: spawn .*ENOENT/);
  });
});
