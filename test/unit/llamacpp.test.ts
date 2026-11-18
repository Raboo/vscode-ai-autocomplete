import { afterEach, describe, expect, test, vi } from 'vitest';
import { LlamaCppBackend } from '../../src/backends/llamacpp';
import { HttpError, StreamError } from '../../src/backends/http';
import type { FimRequest } from '../../src/backends/types';
import type { BackendConfig } from '../../src/types';
import { startMockHttp } from './helpers/mockHttp';

type Mock = Awaited<ReturnType<typeof startMockHttp>>;
let m: Mock;
afterEach(async () => {
  await m?.close();
});

const cfg = (baseUrl: string, headers: Record<string, string> = {}): BackendConfig => ({
  id: 'l',
  kind: 'llamacpp',
  baseUrl,
  fimMode: 'auto',
  use: { completions: true, nextEdit: true },
  headers,
});

const req = (o: Partial<FimRequest> = {}): FimRequest => ({
  payload: { route: 'template', prompt: 'hello' },
  stop: [],
  sampling: { maxTokens: 16 },
  extraBody: {},
  signal: new AbortController().signal,
  timeoutMs: 5000,
  ...o,
});

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const s of it) {
    out.push(s);
  }
  return out;
}

const posts = () => m.requests.filter((r) => !r.url.startsWith('/props'));
const SSE = ['{"content":"ret"}', '{"content":"urn a"}', '{"content":"","stop":true}'];

describe('LlamaCppBackend', () => {
  test('native route posts /infill with llama.cpp fields and streams content', async () => {
    m = await startMockHttp(() => ({ sse: SSE }));
    const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
    const out = await collect(
      b.streamFim(
        req({
          payload: {
            route: 'native',
            prefix: 'P',
            suffix: 'S',
            extra: [{ path: 'x.ts', text: 'X' }],
            filePath: 'a.ts',
            repoName: 'r',
          },
          stop: ['\n\n\n'],
          sampling: { temperature: 0.1, topP: 0.95, topK: 40, maxTokens: 64 },
          timeMaxPredictMs: 500,
          extraBody: { min_p: 0.05 },
        }),
      ),
    );
    expect(out.join('')).toBe('return a');
    expect(posts()[0].url).toBe('/infill');
    expect(posts()[0].body).toMatchObject({
      input_prefix: 'P',
      input_suffix: 'S',
      input_extra: [{ filename: 'x.ts', text: 'X' }],
      prompt: '',
      n_predict: 64,
      temperature: 0.1,
      top_p: 0.95,
      top_k: 40,
      stop: ['\n\n\n'],
      stream: true,
      cache_prompt: true,
      t_max_predict_ms: 500,
      min_p: 0.05,
    });
    expect(posts()[0].body).not.toHaveProperty('model');
  });

  test('template route posts /completion with prompt', async () => {
    m = await startMockHttp(() => ({ sse: SSE }));
    const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
    const out = await collect(
      b.streamFim(req({ model: 'qwen', payload: { route: 'template', prompt: '<fim>x' } })),
    );
    expect(out.join('')).toBe('return a');
    expect(posts()[0].url).toBe('/completion');
    expect(posts()[0].body.prompt).toBe('<fim>x');
    expect(posts()[0].body.model).toBe('qwen');
    expect(posts()[0].body).not.toHaveProperty('input_prefix');
    expect(posts()[0].body).not.toHaveProperty('temperature');
  });

  test('sends Bearer key when set, omits it otherwise, merges config headers', async () => {
    m = await startMockHttp(() => ({ sse: SSE }));
    await collect(new LlamaCppBackend(cfg(m.url, { 'x-a': '1' }), async () => 'k').streamFim(req()));
    expect(posts()[0].headers.authorization).toBe('Bearer k');
    expect(posts()[0].headers['x-a']).toBe('1');
    await collect(new LlamaCppBackend(cfg(m.url), async () => undefined).streamFim(req()));
    expect(posts()[1].headers.authorization).toBeUndefined();
  });

  test('an error event inside the stream throws StreamError', async () => {
    m = await startMockHttp(() => ({ sse: ['{"error":{"code":500,"message":"context shift is disabled","type":"server_error"}}'] }));
    const err = await collect(new LlamaCppBackend(cfg(m.url), async () => undefined).streamFim(req())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamError);
    expect((err as StreamError).message).toBe('context shift is disabled');
  });

  test('llama.cpp reports a length stop', async () => {
    m = await startMockHttp(() => ({ sse: ['{"content":"a"}', '{"content":"","stop":true,"stop_type":"limit"}'] }));
    const onTruncated = vi.fn();
    const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
    expect(await collect(b.streamFim(req({ onTruncated })))).toEqual(['a']);
    expect(onTruncated).toHaveBeenCalledTimes(1);
  });

  test('an older llama.cpp reports a length stop with stopped_limit', async () => {
    m = await startMockHttp(() => ({ sse: ['{"content":"a"}', '{"content":"","stop":true,"stopped_limit":true,"stopped_eos":false}'] }));
    const onTruncated = vi.fn();
    expect(await collect(new LlamaCppBackend(cfg(m.url), async () => undefined).streamFim(req({ onTruncated })))).toEqual(['a']);
    expect(onTruncated).toHaveBeenCalledTimes(1);
  });

  test('an older llama.cpp normal stop is not a truncation', async () => {
    m = await startMockHttp(() => ({ sse: ['{"content":"a"}', '{"content":"","stop":true,"stopped_limit":false,"stopped_eos":true}'] }));
    const onTruncated = vi.fn();
    await collect(new LlamaCppBackend(cfg(m.url), async () => undefined).streamFim(req({ onTruncated })));
    expect(onTruncated).not.toHaveBeenCalled();
  });

  test('a normal stop is not a truncation', async () => {
    const onTruncated = vi.fn();
    for (const type of ['eos', 'word']) {
      m = await startMockHttp(() => ({ sse: ['{"content":"a"}', `{"content":"","stop":true,"stop_type":"${type}"}`] }));
      await collect(new LlamaCppBackend(cfg(m.url), async () => undefined).streamFim(req({ onTruncated })));
      await m.close();
    }
    m = await startMockHttp(() => ({ sse: SSE }));
    await collect(new LlamaCppBackend(cfg(m.url), async () => undefined).streamFim(req({ onTruncated })));
    expect(onTruncated).not.toHaveBeenCalled();
  });

  test('skips empty data events and throws on malformed JSON', async () => {
    m = await startMockHttp(() => ({ sse: ['', '{"content":"a"}'] }));
    const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
    expect(await collect(b.streamFim(req()))).toEqual(['a']);
    await m.close();
    m = await startMockHttp(() => ({ sse: ['{oops'] }));
    const b2 = new LlamaCppBackend(cfg(m.url), async () => undefined);
    await expect(collect(b2.streamFim(req()))).rejects.toThrow();
  });

  test('detectModel reads /props model_alias, else basename of model_path without .gguf', async () => {
    m = await startMockHttp(() => ({ json: { model_alias: 'alias', model_path: '/a/b.gguf' } }));
    const b = new LlamaCppBackend(cfg(m.url), async () => 'k');
    const sig = new AbortController().signal;
    expect(await b.detectModel(sig)).toBe('alias');
    expect(m.requests[0].url).toBe('/props');
    expect(m.requests[0].headers.authorization).toBe('Bearer k');
    await m.close();
    m = await startMockHttp(() => ({ json: { model_path: '/models/qwen2.5-coder-7b.gguf' } }));
    expect(await new LlamaCppBackend(cfg(m.url), async () => undefined).detectModel(sig)).toBe(
      'qwen2.5-coder-7b',
    );
    await m.close();
    m = await startMockHttp(() => ({ status: 500 }));
    expect(await new LlamaCppBackend(cfg(m.url), async () => undefined).detectModel(sig)).toBeUndefined();
    expect(
      await new LlamaCppBackend(cfg('http://127.0.0.1:1'), async () => undefined).detectModel(sig),
    ).toBeUndefined();
  });

  test('detectModel does not follow a redirect to another host', async () => {
    const other = await startMockHttp(() => ({ json: { model_alias: 'elsewhere' } }));
    try {
      m = await startMockHttp(() => ({ status: 308, headers: { location: `${other.url}/props` } }));
      expect(await new LlamaCppBackend(cfg(m.url), async () => undefined).detectModel(new AbortController().signal)).toBeUndefined();
      expect(m.requests).toHaveLength(1);
      expect(other.requests).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  test('routes: native, template and chat', () => {
    expect(new LlamaCppBackend(cfg('http://x'), async () => undefined).routes()).toEqual({ native: true, template: true, chat: true, nativeChatModels: false });
  });

  test('chat URL is /v1/chat/completions', async () => {
    m = await startMockHttp(() => ({ sse: ['[DONE]'] }));
    const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
    for await (const _ of b.streamChat({ messages: [], maxTokens: 1, stop: [], sampling: {}, thinking: {}, extraBody: {}, signal: new AbortController().signal, timeoutMs: 5000 })) void _;
    expect(m.requests[0].url).toBe('/v1/chat/completions');
  });

  test('HTTP 503 surfaces as HttpError', async () => {
    m = await startMockHttp(() => ({ status: 503, json: { error: 'loading' } }));
    const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
    const err = await collect(b.streamFim(req())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
  });

  test('listModels reads alias and n_ctx', async () => {
    m = await startMockHttp(() => ({ json: { model_alias: 'q', default_generation_settings: { n_ctx: 8192 } } }));
    const b = new LlamaCppBackend(cfg(m.url), async () => 'k');
    expect(await b.listModels(new AbortController().signal)).toEqual({ models: ['q'], contextWindows: { q: 8192 } });
    expect(m.requests[0].url).toBe('/props');
    expect(m.requests[0].headers.authorization).toBe('Bearer k');
  });
  test('listModels falls back to top-level n_ctx and model_path', async () => {
    m = await startMockHttp(() => ({ json: { model_path: '/m/Qwen.gguf', n_ctx: 4096 } }));
    const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
    expect(await b.listModels(new AbortController().signal)).toEqual({ models: ['Qwen'], contextWindows: { Qwen: 4096 } });
  });
  test('listModels throws HttpError on 401', async () => {
    m = await startMockHttp(() => ({ status: 401, json: { error: 'no' } }));
    const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
    await expect(b.listModels(new AbortController().signal)).rejects.toBeInstanceOf(HttpError);
  });
  describe('slots', () => {
    const native: FimRequest['payload'] = { route: 'native', prefix: 'P', suffix: 'S', extra: [], filePath: 'a.ts', repoName: 'r' };
    const run = async (slots: number | undefined, r: Partial<FimRequest>, detect = true): Promise<Record<string, unknown>> => {
      m = await startMockHttp(({ url }) => (url === '/props' ? { json: { model_alias: 'q', ...(slots !== undefined ? { total_slots: slots } : {}) } } : { sse: SSE }));
      const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
      if (detect) await b.detectModel(new AbortController().signal);
      await collect(b.streamFim(req(r)));
      const all = posts();
      return all[all.length - 1].body as Record<string, unknown>;
    };
    test('with 2 slots completions use slot 0 (infill and completion) and Next Edit slot 1', async () => {
      expect(await run(2, { payload: native })).toMatchObject({ id_slot: 0 });
      expect(await run(2, {})).toMatchObject({ id_slot: 0 });
      expect(await run(2, { slot: 'nextEdit' })).toMatchObject({ id_slot: 1 });
    });
    test('with 1 slot, 3 or more slots, unknown slots or no detection no id_slot is sent', async () => {
      expect(await run(3, { slot: 'nextEdit' })).not.toHaveProperty('id_slot');
      expect(await run(4, {})).not.toHaveProperty('id_slot');
      expect(await run(1, { slot: 'nextEdit' })).not.toHaveProperty('id_slot');
      expect(await run(undefined, {})).not.toHaveProperty('id_slot');
      expect(await run(2, {}, false)).not.toHaveProperty('id_slot');
    });
    describe('a failed request forgets the slot count, so it is learned again', () => {
      const learned = async (handler: Parameters<typeof startMockHttp>[0]): Promise<LlamaCppBackend> => {
        m = await startMockHttp(handler);
        const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
        await b.detectModel(new AbortController().signal);
        expect(b.slotCount()).toBe(2);
        return b;
      };
      test('HTTP error', async () => {
        const b = await learned(({ url }) => (url === '/props' ? { json: { model_alias: 'q', total_slots: 2 } } : { status: 400, json: { error: 'bad slot' } }));
        await expect(collect(b.streamFim(req()))).rejects.toBeInstanceOf(HttpError);
        expect(b.slotCount()).toBeUndefined();
      });
      test('stream error', async () => {
        const b = await learned(({ url }) => (url === '/props' ? { json: { model_alias: 'q', total_slots: 2 } } : { sse: ['{"error":{"message":"boom"}}'] }));
        await expect(collect(b.streamFim(req()))).rejects.toBeInstanceOf(StreamError);
        expect(b.slotCount()).toBeUndefined();
      });
      test('connection error', async () => {
        const b = await learned(({ url }) => (url === '/props' ? { json: { model_alias: 'q', total_slots: 2 } } : { sse: SSE }));
        await m.close();
        await expect(collect(b.streamFim(req()))).rejects.toThrow();
        expect(b.slotCount()).toBeUndefined();
      });
      test('a failed chat request (Next Edit) too', async () => {
        const b = await learned(({ url }) => (url === '/props' ? { json: { model_alias: 'q', total_slots: 2 } } : { status: 500, json: { error: 'down' } }));
        const chat = b.streamChat({ messages: [], maxTokens: 1, stop: [], sampling: {}, thinking: {}, extraBody: {}, signal: new AbortController().signal, timeoutMs: 5000 });
        await expect((async () => { for await (const _ of chat) void _; })()).rejects.toBeInstanceOf(HttpError);
        expect(b.slotCount()).toBeUndefined();
      });
      test('a request that succeeds or is aborted keeps it', async () => {
        const b = await learned(({ url }) => (url === '/props' ? { json: { model_alias: 'q', total_slots: 2 } } : { sse: SSE }));
        await collect(b.streamFim(req()));
        expect(b.slotCount()).toBe(2);
        const ac = new AbortController();
        ac.abort();
        await expect(collect(b.streamFim(req({ signal: ac.signal })))).rejects.toThrow();
        expect(b.slotCount()).toBe(2);
      });
    });
    describe('router mode: slots per model', () => {
      const propsUrls = (m: Mock) => m.requests.filter((r) => r.url.startsWith('/props')).map((r) => r.url);
      const settle = () => new Promise((r) => setTimeout(r, 50));
      test('the slot read names the model, without autoload', async () => {
        m = await startMockHttp(({ url }) => (url.startsWith('/props') ? { json: { total_slots: 2 } } : { sse: SSE }));
        const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
        await collect(b.streamFim(req({ model: 'my model/A' })));
        await settle();
        expect(propsUrls(m)).toEqual(['/props?model=my%20model%2FA&autoload=false']);
        const plain = new LlamaCppBackend(cfg(m.url), async () => undefined);
        await collect(plain.streamFim(req()));
        await settle();
        expect(propsUrls(m)[1]).toBe('/props');
      });
      test('counts are per model', async () => {
        m = await startMockHttp(({ url }) => (url.includes('model=A') ? { json: { total_slots: 2 } } : url.startsWith('/props') ? { json: { total_slots: 1 } } : { sse: SSE }));
        const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
        await collect(b.streamFim(req({ model: 'A' })));
        await collect(b.streamFim(req({ model: 'B', slot: 'nextEdit' })));
        await settle();
        expect(b.slotCount('A')).toBe(2);
        expect(b.slotCount('B')).toBe(1);
        await collect(b.streamFim(req({ model: 'A' })));
        await collect(b.streamFim(req({ model: 'B', slot: 'nextEdit' })));
        const bodies = posts().map((r) => r.body as Record<string, unknown>);
        expect(bodies[2]).toMatchObject({ id_slot: 0 });
        expect(bodies[3]).not.toHaveProperty('id_slot');
      });
      test('a 400 (model not loaded) leaves the count unknown and is read again after the retry delay', async () => {
        m = await startMockHttp(({ url }) => (url.startsWith('/props') ? { status: 400, json: { error: 'model is not loaded' } } : { sse: SSE }));
        const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
        const now = vi.spyOn(Date, 'now');
        try {
          now.mockReturnValue(1_000_000);
          await collect(b.streamFim(req({ model: 'A' })));
          await settle();
          now.mockReturnValue(1_010_000);
          await collect(b.streamFim(req({ model: 'A' })));
          await settle();
          expect(propsUrls(m)).toHaveLength(1);
          expect(b.slotCount('A')).toBeUndefined();
          expect(posts().every((r) => !('id_slot' in (r.body as object)))).toBe(true);
          now.mockReturnValue(1_031_000);
          await collect(b.streamFim(req({ model: 'A' })));
          await settle();
          expect(propsUrls(m)).toHaveLength(2);
        } finally {
          now.mockRestore();
        }
      });
      test('a failed request forgets only that model', async () => {
        m = await startMockHttp(({ url, body }) =>
          url.startsWith('/props') ? { json: { total_slots: 2 } } : (body as { model?: string }).model === 'A' ? { status: 500, json: {} } : { sse: SSE },
        );
        const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
        await collect(b.streamFim(req({ model: 'B' })));
        await collect(b.streamFim(req({ model: 'A' }))).catch(() => undefined);
        await settle();
        await collect(b.streamFim(req({ model: 'A' }))).catch(() => undefined);
        await settle();
        expect(b.slotCount('B')).toBe(2);
        await collect(b.streamFim(req({ model: 'A' }))).catch(() => undefined);
        expect(b.slotCount('A')).toBeUndefined();
      });
      test('model detection against a router reports no model', async () => {
        m = await startMockHttp(() => ({ json: { role: 'router', model_path: 'none', model_alias: 'llama-server', default_generation_settings: { n_ctx: 0 } } }));
        const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
        expect(await b.detectModel(new AbortController().signal)).toBeUndefined();
        expect((await b.listModels(new AbortController().signal)).models).toEqual([]);
      });
    });
    describe('without model detection', () => {
      const props = (m: Mock) => m.requests.filter((r) => r.url.startsWith('/props')).length;
      const settle = () => new Promise((r) => setTimeout(r, 50));
      test('the first request learns the slots, the second carries id_slot', async () => {
        m = await startMockHttp(({ url }) => (url.startsWith('/props') ? { json: { total_slots: 2 } } : { sse: SSE }));
        const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
        await collect(b.streamFim(req({ model: 'q' })));
        await settle();
        await collect(b.streamFim(req({ model: 'q', slot: 'nextEdit' })));
        const bodies = m.requests.filter((r) => !r.url.startsWith('/props')).map((r) => r.body as Record<string, unknown>);
        expect(bodies[0]).not.toHaveProperty('id_slot');
        expect(bodies[1]).toMatchObject({ id_slot: 1 });
      });
      test('concurrent first requests fetch /props once', async () => {
        m = await startMockHttp(({ url }) => (url === '/props' ? { json: { total_slots: 2 } } : { sse: SSE }));
        const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
        await Promise.all([collect(b.streamFim(req())), collect(b.streamFim(req())), collect(b.streamFim(req()))]);
        await settle();
        expect(props(m)).toBe(1);
      });
      test('a failed fetch is not retried within 30 s', async () => {
        m = await startMockHttp(({ url }) => (url === '/props' ? { status: 500, json: {} } : { sse: SSE }));
        const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
        const now = vi.spyOn(Date, 'now');
        try {
          now.mockReturnValue(1_000_000);
          await collect(b.streamFim(req()));
          await settle();
          now.mockReturnValue(1_020_000);
          await collect(b.streamFim(req()));
          await settle();
          expect(props(m)).toBe(1);
          now.mockReturnValue(1_031_000);
          await collect(b.streamFim(req()));
          await settle();
          expect(props(m)).toBe(2);
        } finally {
          now.mockRestore();
        }
      });
    });
  });
});
