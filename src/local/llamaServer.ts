import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const LAST_LINES = 20;
const HEALTH_TIMEOUT_MS = 2000;
const KILL_GRACE_MS = 5000;
const OUTPUT_DRAIN_MS = 100;

/** A failure of a local runtime (llama-server or LM Studio) with a message fit for the user. */
export class LocalRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalRuntimeError';
  }
}

export function llamaServerArgs(o: { file: string; modelName: string; port: number; contextTokens: number }): string[] {
  return [
    '-m', o.file,
    '--alias', o.modelName,
    '--host', '127.0.0.1',
    '--port', String(o.port),
    '-c', String(o.contextTokens),
    '-ngl', '99',
    '-fa', 'on',
    '-np', '1',
    '--cache-reuse', '256',
    '--no-webui',
  ];
}

function listenOn(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      server.close((err) => (err ? reject(err) : resolve(bound)));
    });
  });
}

/** The preferred port when it can be bound on 127.0.0.1, otherwise an OS-assigned one. */
export async function freePort(preferred?: number): Promise<number> {
  if (preferred !== undefined && preferred > 0) {
    try {
      return await listenOn(preferred);
    } catch {
      // taken or not allowed: fall through to an OS-assigned port
    }
  }
  return listenOn(0);
}

export interface ChildLike {
  readonly pid?: number;
  /** Set when the process could not be started at all (for example ENOENT). */
  readonly spawnError?: Error;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type SpawnLike = (cmd: string, args: string[]) => ChildLike;

export const defaultSpawn: SpawnLike = (cmd, args) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  // A binary that cannot start (ENOENT, EACCES) emits 'error' and no 'exit': keep the error and
  // report an exit. Without a pid the spawn itself failed; other errors (a failed kill) are ignored.
  child.on('error', (err) => {
    if (child.pid !== undefined) return;
    Object.assign(child, { spawnError: err });
    child.emit('exit', null, null);
  });
  return child;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Calls `onLine` for every complete line of a stream, and for the unterminated rest at its end. */
function forEachLine(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): Promise<void> {
  if (!stream) return Promise.resolve();
  let rest = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk: string | Buffer) => {
    rest += chunk.toString();
    const parts = rest.split(/\r?\n/);
    rest = parts.pop() ?? '';
    for (const line of parts) onLine(line);
  });
  return new Promise((resolve) => {
    const end = (): void => {
      if (rest) onLine(rest);
      rest = '';
      resolve();
    };
    stream.once('end', end);
    stream.once('close', end);
    stream.on('error', end);
  });
}

export interface StartOptions {
  binary: string;
  args: string[];
  port: number;
  spawnFn: SpawnLike;
  fetchFn?: typeof fetch;
  log(line: string): void;
  timeoutMs?: number;
  pollMs?: number;
}

export class LlamaServerProcess {
  readonly exited: Promise<void>;
  private hasExited = false;
  private exitText = '';
  /** The last lines the server wrote (stdout and stderr). */
  private readonly tail: string[] = [];

  private constructor(
    readonly port: number,
    private readonly child: ChildLike,
  ) {
    this.exited = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        this.hasExited = true;
        this.exitText = signal ? `signal ${signal}` : `code ${code}`;
        resolve();
      });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** How the process ended (`code 1`, `signal SIGTERM`); empty while it runs. */
  exitInfo(): string {
    return this.exitText;
  }

  /** The last lines the server wrote. */
  lastOutput(): string[] {
    return [...this.tail];
  }

  static async start(o: StartOptions): Promise<LlamaServerProcess> {
    const fetchFn = o.fetchFn ?? fetch;
    const timeoutMs = o.timeoutMs ?? 120_000;
    const pollMs = o.pollMs ?? 500;

    const child = o.spawnFn(o.binary, o.args);
    const proc = new LlamaServerProcess(o.port, child);
    const tail = proc.tail;
    const onLine = (line: string): void => {
      tail.push(line);
      if (tail.length > LAST_LINES) tail.shift();
      o.log(line);
    };
    const drained = Promise.all([forEachLine(child.stdout, onLine), forEachLine(child.stderr, onLine)]);

    const deadline = Date.now() + timeoutMs;
    const url = `http://127.0.0.1:${o.port}/health`;
    while (!proc.hasExited) {
      if (await healthy(fetchFn, url)) {
        if (proc.hasExited) break;
        return proc;
      }
      if (proc.hasExited) break;
      if (Date.now() >= deadline) {
        await proc.stop();
        throw new LocalRuntimeError(`llama-server did not become ready within ${Math.round(timeoutMs / 1000)} s.${formatTail(tail)}`);
      }
      await Promise.race([sleep(pollMs), proc.exited]);
    }
    // Let the last output reach the log before building the message.
    await Promise.race([drained, sleep(OUTPUT_DRAIN_MS)]);
    if (child.spawnError) throw new LocalRuntimeError(`Could not start llama-server: ${child.spawnError.message}`);
    throw new LocalRuntimeError(`llama-server exited (${proc.exitText}) before it was ready.${formatTail(tail)}`);
  }

  /** SIGTERM, then SIGKILL after 5 s; resolves when the child has exited. */
  async stop(): Promise<void> {
    if (this.hasExited) return;
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), KILL_GRACE_MS);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function formatTail(lines: string[]): string {
  return lines.length > 0 ? `\nLast output:\n${lines.join('\n')}` : '';
}

async function healthy(fetchFn: typeof fetch, url: string): Promise<boolean> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    await res.body?.cancel();
    return res.status === 200;
  } catch {
    return false;
  }
}

/** What answers on a port: our llama-server serving `alias`, a llama-server still loading (503), or neither. */
export type PortState = 'ours' | 'loading' | 'none';

/** Probes `127.0.0.1:<port>`: `/health` 200 and `/v1/models` (or `/props` `model_alias`) naming `alias` is ours. */
export async function probePort(port: number, alias: string, fetchFn: typeof fetch = fetch): Promise<PortState> {
  const base = `http://127.0.0.1:${port}`;
  const get = async (path: string): Promise<{ status: number; json: unknown }> => {
    const res = await fetchFn(`${base}${path}`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    let json: unknown;
    try {
      json = res.status === 200 ? await res.json() : undefined;
    } catch {
      json = undefined;
    }
    if (json === undefined) await res.body?.cancel().catch(() => undefined);
    return { status: res.status, json };
  };
  try {
    const health = await get('/health');
    if (health.status === 503) return 'loading';
    if (health.status !== 200) return 'none';
    const models = await get('/v1/models');
    const data = (models.json as { data?: unknown } | undefined)?.data;
    if (Array.isArray(data) && data.some((m) => (m as { id?: unknown } | null)?.id === alias)) return 'ours';
    const props = await get('/props');
    return (props.json as { model_alias?: unknown } | undefined)?.model_alias === alias ? 'ours' : 'none';
  } catch {
    return 'none';
  }
}
