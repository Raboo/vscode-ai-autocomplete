import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { classifyError, getJson, HttpError, joinUrl, postJson, StreamError, throwIfStreamError } from '../../src/backends/http';
import { startMockHttp } from './helpers/mockHttp';

describe('joinUrl', () => {
  test('joins with exactly one slash', () => {
    expect(joinUrl('http://h:8000/v1/', '/completions')).toBe('http://h:8000/v1/completions');
    expect(joinUrl('http://h', 'infill')).toBe('http://h/infill');
  });
});

describe('classifyError', () => {
  test('abort', () => {
    expect(classifyError(new DOMException('x', 'AbortError'))).toEqual({ kind: 'abort' });
  });
  test('timeout is a network failure', () => {
    expect(classifyError(new DOMException('x', 'TimeoutError'))).toEqual({ kind: 'network' });
  });
  test('http', () => {
    expect(classifyError(new HttpError(429, '', ''))).toEqual({ kind: 'http', status: 429 });
  });
  test('network', () => {
    expect(classifyError(new TypeError('fetch failed'))).toEqual({ kind: 'network' });
  });
  test('an error inside a stream is a failure like a network one', () => {
    expect(classifyError(new StreamError('x'))).toEqual({ kind: 'network' });
  });
});

describe('throwIfStreamError', () => {
  const thrown = (ev: unknown): unknown => {
    try {
      throwIfStreamError(ev);
    } catch (err) {
      return err;
    }
    return undefined;
  };
  test('passes events without an error', () => {
    for (const ev of [{ choices: [] }, { error: null }, null, 5, '[x]']) expect(thrown(ev)).toBeUndefined();
  });
  test('error.message, a string error, or fixed text', () => {
    const oMlx = thrown({ error: { message: 'prefill memory guard rejected this prompt' }, message: 'other' });
    expect(oMlx).toBeInstanceOf(StreamError);
    expect((oMlx as StreamError).name).toBe('StreamError');
    expect((oMlx as StreamError).message).toBe('prefill memory guard rejected this prompt');
    expect((thrown({ error: 'model not loaded' }) as StreamError).message).toBe('model not loaded');
    expect((thrown({ error: { code: 500 } }) as StreamError).message).toBe('the server sent an error event');
  });
});

describe('postJson', () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  test('sends JSON and returns the response on 200', async () => {
    let seen = { ct: '', body: '' };
    const base = await listen((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = { ct: String(req.headers['content-type']), body };
        res.end('ok');
      });
    });
    const r = await postJson(base, { a: 1 }, { signal: new AbortController().signal, timeoutMs: 2000 });
    expect(await r.text()).toBe('ok');
    expect(seen).toEqual({ ct: 'application/json', body: '{"a":1}' });
  });

  test('500 rejects with HttpError carrying status and truncated body', async () => {
    const base = await listen((_req, res) => {
      res.statusCode = 500;
      res.end('x'.repeat(2000));
    });
    const err = await postJson(base, {}, { signal: new AbortController().signal, timeoutMs: 2000 }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(500);
    expect((err as HttpError).bodyText).toHaveLength(500);
    expect((err as HttpError).url).toBe(base);
  });

  test('a redirect is not followed: it rejects with HttpError and the other host gets nothing', async () => {
    const other = await startMockHttp(() => ({ json: {} }));
    try {
      const base = await listen((_req, res) => {
        res.writeHead(308, { location: `${other.url}/infill` });
        res.end();
      });
      const err = await postJson(`${base}/infill`, { input_prefix: 'code' }, { signal: new AbortController().signal, timeoutMs: 2000 }).catch((e) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(308);
      expect(other.requests).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  test('timeout rejects and classifies as network', async () => {
    const base = await listen(() => {
      /* never answers */
    });
    const err = await postJson(base, {}, { signal: new AbortController().signal, timeoutMs: 50 }).catch((e) => e);
    expect(err).toBeDefined();
    expect(classifyError(err)).toEqual({ kind: 'network' });
  });

  test('caller abort rejects and classifies as abort', async () => {
    const base = await listen(() => {
      /* never answers */
    });
    const ac = new AbortController();
    const p = postJson(base, {}, { signal: ac.signal, timeoutMs: 5000 }).catch((e) => e);
    setTimeout(() => ac.abort(), 30);
    expect(classifyError(await p)).toEqual({ kind: 'abort' });
  });
});

describe('getJson', () => {
  test('returns parsed JSON and sends headers', async () => {
    const m = await startMockHttp(() => ({ json: { a: 1 } }));
    try {
      const out = await getJson(`${m.url}/x`, { headers: { authorization: 'Bearer k' }, signal: new AbortController().signal, timeoutMs: 2000 });
      expect(out).toEqual({ a: 1 });
      expect(m.requests[0].headers.authorization).toBe('Bearer k');
    } finally {
      await m.close();
    }
  });
  test('getJson throws HttpError on 302 without following it', async () => {
    const other = await startMockHttp(() => ({ json: {} }));
    const m = await startMockHttp(() => ({ status: 302, headers: { location: `${other.url}/y` } }));
    try {
      const err = await getJson(`${m.url}/x`, { signal: new AbortController().signal, timeoutMs: 2000 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(302);
      expect(other.requests).toHaveLength(0);
    } finally {
      await m.close();
      await other.close();
    }
  });
});
