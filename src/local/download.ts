import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

export type DownloadErrorKind = 'space' | 'http' | 'checksum' | 'url' | 'cancelled' | 'write';

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly kind: DownloadErrorKind,
    /** The HTTP status of a refused request (`http` errors only), e.g. 401/403 for a gated Hugging Face repo. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export interface DownloadOptions {
  url: string;
  dest: string;
  bytes: number;
  sha256: string;
  signal: AbortSignal;
  onProgress(received: number, total: number): void;
  fetchFn?: typeof fetch;
  /** The `Authorization` value for a request to this URL, asked per hop so a redirect to another host can drop it. */
  authFor?(url: URL): string | undefined;
  /** Free bytes on the volume holding `dir`. Defaults to `fs.statfs`. */
  freeBytes?(dir: string): Promise<number>;
}

const MAX_REDIRECTS = 5;
const SPACE_MARGIN = 1.1;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function cancelled(): DownloadError {
  return new DownloadError('The download was cancelled.', 'cancelled');
}

/** Hashes a file; with a `signal`, stops with a `cancelled` DownloadError between chunks. */
export async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    if (signal?.aborted) {
      throw cancelled();
    }
    hash.update(chunk as Buffer);
  }
  if (signal?.aborted) {
    throw cancelled();
  }
  return hash.digest('hex');
}

async function sizeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

/** Turns a file system error into a DownloadError with fixed text (never the raw error). */
function fsError(err: unknown): DownloadError {
  if (err instanceof DownloadError) {
    return err;
  }
  if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC') {
    return new DownloadError('The disk ran out of space while saving the model.', 'space');
  }
  return new DownloadError('Could not write the model file.', 'write');
}

async function defaultFreeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DownloadError('The download address is not a valid URL.', 'url');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new DownloadError('The download address must use https.', 'url');
  }
  return url;
}

/** Sends the request and follows redirects by hand, so every hop is checked. */
async function open(o: DownloadOptions, partBytes: number): Promise<Response> {
  const doFetch = o.fetchFn ?? fetch;
  let current = checkUrl(o.url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = {};
    if (partBytes > 0) {
      headers.range = `bytes=${partBytes}-`;
    }
    const auth = o.authFor?.(current);
    if (auth) {
      headers.authorization = auth;
    }
    const res = await doFetch(current, { headers, redirect: 'manual', signal: o.signal });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      current = checkUrl(new URL(location, current).href);
      continue;
    }
    return res;
  }
  throw new DownloadError('The download was redirected too many times.', 'http');
}

async function stream(
  o: DownloadOptions,
  res: Response,
  part: string,
  partBytes: number,
): Promise<void> {
  let offset = partBytes;
  if (res.status === 206) {
    const m = /^bytes (\d+)-/.exec(res.headers.get('content-range') ?? '');
    if (!m || Number(m[1]) !== partBytes) {
      await res.body?.cancel();
      throw new DownloadError('The server resumed from the wrong position.', 'http');
    }
  } else if (res.status === 200) {
    offset = 0; // the server ignored the Range header: start over
  } else {
    if (res.status === 416) {
      await rm(part, { force: true }); // the partial file does not fit the server's file: start over next time
    }
    await res.body?.cancel();
    throw new DownloadError(`The server answered with status ${res.status}.`, 'http', res.status);
  }
  if (!res.body) {
    throw new DownloadError('The server sent no data.', 'http');
  }
  let received = offset;
  o.onProgress(received, o.bytes);
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (received > o.bytes) {
        cb(new DownloadError('The server sent more data than expected.', 'http'));
        return;
      }
      o.onProgress(received, o.bytes);
      cb(null, chunk);
    },
  });
  const sink = createWriteStream(part, { flags: offset === 0 ? 'w' : 'a' });
  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), counter, sink);
  } catch (err) {
    // File system errors carry a `syscall`; network and abort errors do not.
    if (typeof (err as NodeJS.ErrnoException | undefined)?.syscall === 'string') {
      throw fsError(err);
    }
    if (err instanceof DownloadError) {
      if (!sink.closed) {
        await once(sink, 'close'); // the file may still be opening: remove it only once it is closed
      }
      await rm(part, { force: true }); // more bytes than the recipe says: the file is wrong
    }
    throw err;
  }
}

/** Downloads `o.url` to `o.dest` (resuming `<dest>.part`) and verifies the SHA-256. */
export async function downloadModel(o: DownloadOptions): Promise<'downloaded' | 'present'> {
  try {
    return await run(o);
  } catch (err) {
    if (err instanceof DownloadError) {
      throw err;
    }
    if (o.signal.aborted) {
      throw cancelled();
    }
    throw fsError(err);
  }
}

async function run(o: DownloadOptions): Promise<'downloaded' | 'present'> {
  const part = `${o.dest}.part`;
  const dir = dirname(o.dest);
  await mkdir(dir, { recursive: true });

  if (
    (await sizeOf(o.dest)) === o.bytes &&
    (await sha256File(o.dest, o.signal)) === o.sha256.toLowerCase()
  ) {
    return 'present';
  }

  let partBytes = (await sizeOf(part)) ?? 0;
  if (partBytes > o.bytes) {
    await rm(part, { force: true });
    partBytes = 0;
  }
  const free = await (o.freeBytes ?? defaultFreeBytes)(dir);
  if (free < (o.bytes - partBytes) * SPACE_MARGIN) {
    throw new DownloadError('There is not enough free disk space for this model.', 'space');
  }

  if (partBytes < o.bytes) {
    try {
      const res = await open(o, partBytes);
      await stream(o, res, part, partBytes);
    } catch (err) {
      if (err instanceof DownloadError) {
        throw err;
      }
      if (o.signal.aborted) {
        throw cancelled();
      }
      throw new DownloadError('The download failed: the connection was interrupted.', 'http');
    }
  }

  const size = await sizeOf(part);
  if (size !== undefined && size < o.bytes) {
    throw new DownloadError('The download ended early; run it again to resume.', 'http');
  }
  if ((await sha256File(part, o.signal)) !== o.sha256.toLowerCase()) {
    await rm(part, { force: true });
    throw new DownloadError('The downloaded file does not match its checksum.', 'checksum');
  }
  if (o.signal.aborted) {
    throw cancelled();
  }
  await rename(part, o.dest);
  return 'downloaded';
}
