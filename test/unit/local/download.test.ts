import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DownloadError, downloadModel, sha256File } from '../../../src/local/download';

const CONTENT = Buffer.from('0123456789'.repeat(1000));
const SHA = createHash('sha256').update(CONTENT).digest('hex');

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let dir: string;
let server: Server;
let base: string;
let ranges: Array<string | undefined>;
let handler: Handler;

const serveWithRange: Handler = (req, res) => {
  const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
  if (range) {
    const start = Number(range[1]);
    res.writeHead(206, { 'content-range': `bytes ${start}-${CONTENT.length - 1}/${CONTENT.length}` });
    res.end(CONTENT.subarray(start));
  } else {
    res.writeHead(200);
    res.end(CONTENT);
  }
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dl-test-'));
  ranges = [];
  handler = serveWithRange;
  server = createServer((req, res) => {
    ranges.push(req.headers.range);
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

function opts(over: Partial<Parameters<typeof downloadModel>[0]> = {}) {
  return {
    url: `${base}/model.gguf`,
    dest: join(dir, 'models', 'model.gguf'),
    bytes: CONTENT.length,
    sha256: SHA,
    signal: new AbortController().signal,
    onProgress: () => {},
    freeBytes: async () => 1e12,
    ...over,
  };
}

async function seedPart(dest: string, data: Buffer): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(`${dest}.part`, data);
}

async function failure(p: Promise<unknown>): Promise<DownloadError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DownloadError);
    return e as DownloadError;
  }
  throw new Error('expected a DownloadError');
}

describe('downloadModel', () => {
  it('returns present without a request when dest has the right bytes and checksum', async () => {
    const o = opts();
    await downloadModel(o);
    ranges.length = 0;
    expect(await downloadModel(o)).toBe('present');
    expect(ranges).toEqual([]);
  });

  it('downloads a full file, reports progress up to total and leaves no .part', async () => {
    const o = opts();
    const seen: Array<[number, number]> = [];
    expect(await downloadModel({ ...o, onProgress: (r, t) => seen.push([r, t]) })).toBe('downloaded');
    expect(await readFile(o.dest)).toEqual(CONTENT);
    expect(seen.at(-1)).toEqual([CONTENT.length, CONTENT.length]);
    await expect(stat(`${o.dest}.part`)).rejects.toThrow();
  });

  it('resumes from an existing .part with a Range request', async () => {
    const o = opts();
    await seedPart(o.dest, CONTENT.subarray(0, 4000));
    const seen: number[] = [];
    expect(await downloadModel({ ...o, onProgress: (r) => seen.push(r) })).toBe('downloaded');
    expect(ranges).toEqual(['bytes=4000-']);
    expect(await readFile(o.dest)).toEqual(CONTENT);
    expect(seen[0]).toBe(4000);
  });

  it('restarts from byte 0 when the server answers a Range request with 200', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end(CONTENT);
    };
    const o = opts();
    await seedPart(o.dest, Buffer.from('garbage-that-must-go'));
    expect(await downloadModel(o)).toBe('downloaded');
    expect(ranges).toEqual(['bytes=20-']);
    expect(await readFile(o.dest)).toEqual(CONTENT);
  });

  it('deletes the .part and throws checksum on a mismatch', async () => {
    const o = opts({ sha256: 'a'.repeat(64) });
    const e = await failure(downloadModel(o));
    expect(e.kind).toBe('checksum');
    await expect(stat(`${o.dest}.part`)).rejects.toThrow();
    await expect(stat(o.dest)).rejects.toThrow();
  });

  it('follows a redirect and sends Range on every hop', async () => {
    const o = opts();
    await seedPart(o.dest, CONTENT.subarray(0, 100));
    handler = (req, res) => {
      if (req.url === '/model.gguf') {
        res.writeHead(302, { location: '/cdn/blob' });
        res.end();
      } else {
        serveWithRange(req, res);
      }
    };
    expect(await downloadModel(o)).toBe('downloaded');
    expect(ranges).toEqual(['bytes=100-', 'bytes=100-']);
    expect(await readFile(o.dest)).toEqual(CONTENT);
  });

  it('rejects a redirect to a non-loopback http URL', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: 'http://example.com/model.gguf' });
      res.end();
    };
    const e = await failure(downloadModel(opts()));
    expect(e.kind).toBe('url');
  });

  it('rejects a non-loopback http start URL without a request', async () => {
    const e = await failure(downloadModel(opts({ url: 'http://example.com/model.gguf' })));
    expect(e.kind).toBe('url');
    expect(ranges).toEqual([]);
  });

  it('gives up after 5 redirects', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: '/again' });
      res.end();
    };
    const e = await failure(downloadModel(opts()));
    expect(e.kind).toBe('http');
    expect(ranges).toHaveLength(6);
  });

  it('throws http on a 404', async () => {
    handler = (_req, res) => {
      res.writeHead(404);
      res.end('nope');
    };
    const e = await failure(downloadModel(opts()));
    expect(e.kind).toBe('http');
  });

  it('throws space before any request when the disk is too small', async () => {
    const o = opts();
    await seedPart(o.dest, CONTENT.subarray(0, 4000));
    const need = (CONTENT.length - 4000) * 1.1;
    const e = await failure(downloadModel({ ...o, freeBytes: async () => need - 1 }));
    expect(e.kind).toBe('space');
    expect(ranges).toEqual([]);
    expect(await downloadModel({ ...o, freeBytes: async () => need + 1 })).toBe('downloaded');
  });

  it('keeps the .part and throws cancelled when aborted mid-stream', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.write(CONTENT.subarray(0, 3000));
      // never ends
    };
    const ac = new AbortController();
    const o = opts({
      signal: ac.signal,
      onProgress: (r) => {
        if (r >= 3000) setTimeout(() => ac.abort(), 50);
      },
    });
    const e = await failure(downloadModel(o));
    expect(e.kind).toBe('cancelled');
    const kept = (await stat(`${o.dest}.part`)).size;
    expect(kept).toBe(3000);
  });

  it('keeps the .part and throws http when the stream ends early', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end(CONTENT.subarray(0, 2000));
    };
    const o = opts();
    const e = await failure(downloadModel(o));
    expect(e.kind).toBe('http');
    expect((await stat(`${o.dest}.part`)).size).toBe(2000);
  });
});

describe('sha256File', () => {
  it('hashes a file', async () => {
    const p = join(dir, 'f');
    await writeFile(p, CONTENT);
    expect(await sha256File(p)).toBe(SHA);
  });
});
