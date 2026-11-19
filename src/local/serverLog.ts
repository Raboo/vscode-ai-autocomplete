// The llama-server log shared by every window: `<globalStorage>/llama-server.log`. The window that owns the router
// process appends its output (a section line at each start); every window's Local Models page reads the last lines.
import { mkdir, open, readFile, stat, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const SERVER_LOG_FILE = 'llama-server.log';
/** Past this size the file is cut to its last KEEP_BYTES. */
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_BYTES = 1024 * 1024;
/** Lines are written in batches at most this often. */
const FLUSH_MS = 200;
/** How much of the end of the file a tail reads. */
const TAIL_BYTES = 256 * 1024;

/** The line that starts a section: one per router start. */
export function sectionLine(at: Date, port: number): string {
  return `===== llama-server started on port ${port} at ${at.toISOString()} =====`;
}

/** The text cut to its last `keep` bytes from a line start, when it is longer than `max`; undefined when it is not. */
export function trimmed(text: string, max: number, keep: number): string | undefined {
  if (Buffer.byteLength(text, 'utf8') <= max) return undefined;
  const buf = Buffer.from(text, 'utf8');
  const tail = buf.subarray(buf.length - keep).toString('utf8');
  const nl = tail.indexOf('\n');
  return nl >= 0 ? tail.slice(nl + 1) : tail;
}

/** The last `n` lines of the file, or undefined when it does not exist or cannot be read. */
export async function readLogTail(path: string, n: number): Promise<string[] | undefined> {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = (await fh.stat()).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, size - len);
    let lines = buf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
    if (len < size) lines = lines.slice(1);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n);
  } catch {
    return undefined;
  } finally {
    await fh.close();
  }
}

export interface ServerLogOptions {
  now?(): Date;
  maxBytes?: number;
  keepBytes?: number;
  /** Write failures (logged once by the caller, never thrown). */
  onError?(err: unknown): void;
}

/** Appends router output to the shared file in batches; failures never reach the router. */
export class ServerLogFile {
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private failed = false;
  /** A section starts: the file is cut (when past the limit) before it is written. */
  private trimNext = false;

  constructor(readonly path: string, private readonly o: ServerLogOptions = {}) {}

  /** A new section: the router starts on `port`. */
  start(port: number): void {
    // Lines of the section before go out first, so the cut happens at the section boundary.
    void this.flush();
    this.trimNext = true;
    this.line(sectionLine(this.o.now?.() ?? new Date(), port));
  }

  line(text: string): void {
    this.pending.push(text);
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS);
  }

  /** Writes what is pending; resolves when every write so far is done. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const lines = this.pending;
    const trim = this.trimNext;
    this.pending = [];
    this.trimNext = false;
    if (lines.length > 0) this.chain = this.chain.then(() => this.write(lines, trim));
    return this.chain;
  }

  /** Appends the lines; with `trim` (a new section), first cuts the file when it is past the limit. */
  private async write(lines: string[], trim: boolean): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const max = this.o.maxBytes ?? MAX_BYTES;
      if (trim && ((await stat(this.path).catch(() => undefined))?.size ?? 0) > max) {
        const cut = trimmed(await readFile(this.path, 'utf8'), max, this.o.keepBytes ?? KEEP_BYTES);
        if (cut !== undefined) await writeFile(this.path, cut, 'utf8');
      }
      await appendFile(this.path, `${lines.join('\n')}\n`, 'utf8');
    } catch (err) {
      if (!this.failed) this.o.onError?.(err);
      this.failed = true;
    }
  }
}
