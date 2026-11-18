import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadModel } from '../../../src/local/download';
import {
  HfError,
  authFor,
  checkUpdate,
  ggufFiles,
  repoCommit,
  tokenHeader,
  updateModelFile,
} from '../../../src/local/huggingFace';
import type { LocalModel } from '../../../src/local/modelList';

type Handler = (req: IncomingMessage, res: ServerResponse, base: string) => void;
let server: Server;
let base: string;
let handler: Handler;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hf-test-'));
  server = createServer((req, res) => handler(req, res, base));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const json = (res: ServerResponse, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

describe('tokenHeader', () => {
  it('sends the header for https huggingface.co only', () => {
    expect(tokenHeader(new URL('https://huggingface.co/x'), 't')).toEqual({ Authorization: 'Bearer t' });
    expect(tokenHeader(new URL('https://cdn-lfs.huggingface.co/x'), 't')).toEqual({});
    expect(tokenHeader(new URL('http://huggingface.co/x'), 't')).toEqual({});
    expect(tokenHeader(new URL('https://huggingface.co/x'), undefined)).toEqual({});
  });
  it('authFor gives the Authorization value per URL, for downloads and API calls alike', () => {
    expect(authFor('t')(new URL('https://huggingface.co/o/r/resolve/c/f.gguf'))).toBe('Bearer t');
    expect(authFor('t')(new URL('https://cas-bridge.xethub.hf.co/x'))).toBeUndefined();
    expect(authFor(undefined)(new URL('https://huggingface.co/x'))).toBeUndefined();
  });
});

describe('API', () => {
  it('reads the commit and maps 401, 404, 500, network errors', async () => {
    handler = (req, res) => {
      if (req.url === '/api/models/a/b') return json(res, { sha: 'c1' });
      res.writeHead(req.url === '/api/models/p/q' ? 401 : req.url === '/api/models/n/o' ? 404 : 500);
      res.end('secret body');
    };
    expect(await repoCommit('a/b', { apiBase: base })).toBe('c1');
    const kind = async (repo: string, o = { apiBase: base }) =>
      repoCommit(repo, o).catch((e: unknown) => (e instanceof HfError ? e.kind : 'other'));
    expect(await kind('p/q')).toBe('auth');
    expect(await kind('n/o')).toBe('notFound');
    expect(await kind('x/y')).toBe('http');
    const failing = (() => Promise.reject(new Error('boom'))) as unknown as typeof fetch;
    expect(await repoCommit('a/b', { apiBase: base, fetchFn: failing }).catch((e: HfError) => e.kind)).toBe('network');
  });

  it('joins tree pages and flags unsupported files', async () => {
    handler = (req, res, b) => {
      const u = new URL(req.url ?? '', b);
      if (u.searchParams.get('page') === '2') {
        return json(res, [
          { type: 'file', path: 'sub/m-00001-of-00002.gguf', size: 3, lfs: { oid: 'ee' } },
          { type: 'file', path: 'mmproj-f16.gguf', size: 4, lfs: { oid: 'ff' } },
        ]);
      }
      expect(u.pathname).toBe('/api/models/a/b/tree/rev');
      expect(u.searchParams.get('recursive')).toBe('true');
      json(
        res,
        [
          { type: 'directory', path: 'sub' },
          { type: 'file', path: 'm.gguf', size: 1, lfs: { oid: 'aa' } },
          { type: 'file', path: 'plain.gguf', size: 2 },
          { type: 'file', path: 'README.md', size: 2 },
        ],
        { link: `<${b}/api/models/a/b/tree/rev?recursive=true&page=2>; rel="next"` },
      );
    };
    const files = await ggufFiles('a/b', 'rev', { apiBase: base });
    expect(files).toEqual([
      { path: 'm.gguf', bytes: 1, sha256: 'aa', supported: true },
      { path: 'plain.gguf', bytes: 2, supported: false },
      { path: 'sub/m-00001-of-00002.gguf', bytes: 3, sha256: 'ee', supported: false },
      { path: 'mmproj-f16.gguf', bytes: 4, sha256: 'ff', supported: false },
    ]);
  });

  it('sends the token through the same rule', async () => {
    const seen: Array<string | undefined> = [];
    const f = ((url: URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? undefined);
      return Promise.resolve(new Response(JSON.stringify({ sha: 'x' })));
    }) as unknown as typeof fetch;
    await repoCommit('a/b', { token: 't', fetchFn: f });
    await repoCommit('a/b', { token: 't', fetchFn: f, apiBase: base });
    expect(seen).toEqual(['Bearer t', undefined]);
  });
});

describe('checkUpdate', () => {
  const model = (over: Partial<LocalModel> = {}): LocalModel =>
    ({ name: 'm', repo: 'a/b', revision: 'old', file: 'm.gguf', bytes: 1, sha256: 'aa', builtIn: false, ...over }) as LocalModel;

  it('reports upToDate, available and gone', async () => {
    let sha = 'old';
    let files: unknown[] = [];
    handler = (req, res) => {
      if (req.url === '/api/models/a/b') return json(res, { sha, lastModified: '2026-01-02T00:00:00.000Z' });
      json(res, files);
    };
    expect(await checkUpdate(model(), { apiBase: base })).toEqual({ kind: 'upToDate' });
    sha = 'new';
    files = [{ type: 'file', path: 'm.gguf', size: 9, lfs: { oid: 'bb' } }];
    expect(await checkUpdate(model(), { apiBase: base })).toEqual({
      kind: 'available',
      revision: 'new',
      bytes: 9,
      sha256: 'bb',
      date: '2026-01-02T00:00:00.000Z',
    });
    files = [{ type: 'file', path: 'other.gguf', size: 9, lfs: { oid: 'bb' } }];
    expect(await checkUpdate(model(), { apiBase: base })).toEqual({ kind: 'gone' });
  });
});

describe('download auth per hop', () => {
  it('drops Authorization on a redirect to another host', async () => {
    const content = Buffer.from('hello world');
    const seen: Array<string | undefined> = [];
    handler = (req, res, b) => {
      seen.push(req.headers.authorization);
      if (req.url === '/start') {
        res.writeHead(302, { location: b.replace('127.0.0.1', 'localhost') + '/file' });
        return res.end();
      }
      res.writeHead(200);
      res.end(content);
    };
    await downloadModel({
      url: `${base}/start`,
      dest: join(dir, 'f.gguf'),
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      signal: new AbortController().signal,
      onProgress: () => undefined,
      freeBytes: async () => 1e12,
      authFor: (u) => (u.hostname === '127.0.0.1' ? 'Bearer t' : undefined),
    });
    expect(seen).toEqual(['Bearer t', undefined]);
  });
});

describe('updateModelFile', () => {
  const newContent = Buffer.from('new file content');
  const sha = createHash('sha256').update(newContent).digest('hex');
  const opts = (url: string, signal = new AbortController().signal) => ({
    dest: join(dir, 'f.gguf'),
    url,
    bytes: newContent.length,
    sha256: sha,
    signal,
    onProgress: () => undefined,
    freeBytes: async () => 1e12,
  });
  const exists = (p: string) => stat(p).then(() => true, () => false);

  it('replaces the old file on success', async () => {
    await writeFile(join(dir, 'f.gguf'), 'old');
    handler = (_q, res) => {
      res.writeHead(200);
      res.end(newContent);
    };
    await updateModelFile(opts(`${base}/f`));
    expect((await readFile(join(dir, 'f.gguf'))).toString()).toBe('new file content');
    expect(await exists(join(dir, 'f.gguf.update'))).toBe(false);
    expect(await exists(join(dir, 'f.gguf.update.part'))).toBe(false);
  });

  it('keeps the old file and removes leftovers on a checksum failure', async () => {
    await writeFile(join(dir, 'f.gguf'), 'old');
    handler = (_q, res) => {
      res.writeHead(200);
      res.end(Buffer.from('X'.repeat(newContent.length)));
    };
    await expect(updateModelFile(opts(`${base}/f`))).rejects.toThrow();
    expect((await readFile(join(dir, 'f.gguf'))).toString()).toBe('old');
    expect(await exists(join(dir, 'f.gguf.update.part'))).toBe(false);
    expect(await exists(join(dir, 'f.gguf.update'))).toBe(false);
  });

  it('keeps the old file on cancel', async () => {
    await writeFile(join(dir, 'f.gguf'), 'old');
    const ac = new AbortController();
    ac.abort();
    await expect(updateModelFile(opts(`${base}/f`, ac.signal))).rejects.toThrow();
    expect((await readFile(join(dir, 'f.gguf'))).toString()).toBe('old');
    expect(await exists(join(dir, 'f.gguf.update.part'))).toBe(false);
  });
});
