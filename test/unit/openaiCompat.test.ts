import { afterEach, describe, expect, test } from 'vitest';
import { OpenAiCompatBackend } from '../../src/backends/openaiCompat';
import { HttpError, StreamError } from '../../src/backends/http';
import type { FimRequest } from '../../src/backends/types';
import type { BackendConfig, HostFlavor } from '../../src/types';
import { startMockHttp } from './helpers/mockHttp';

type Mock = Awaited<ReturnType<typeof startMockHttp>>;
let m: Mock;
afterEach(async () => {
  await m?.close();
});

const cfg = (baseUrl: string, o: Partial<BackendConfig> = {}): BackendConfig => ({
  id: 'o',
  kind: 'openai',
  baseUrl,
  fimMode: 'auto',
  headers: {},
  ...o,
});

const req = (o: Partial<FimRequest> = {}): FimRequest => ({
  model: 'm',
  payload: { route: 'template', prompt: '<tpl>' },
  stop: [],
  sampling: { maxTokens: 128, temperature: 0.1, topP: 0.95 },
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

const SSE = ['{"choices":[{"text":"a"}]}', '{"choices":[{"text":"b"}]}', '[DONE]'];
const key = (k?: string) => async () => k;
const hosted = async (flavor: HostFlavor, r: Partial<FimRequest> = {}) => {
  m = await startMockHttp(() => ({ sse: SSE }));
  const b = new OpenAiCompatBackend(cfg(`${m.url}/v1`, { hostFlavor: flavor }), key());
  await collect(b.streamFim(req(r)));
  return m.requests[0].body;
};

describe('OpenAiCompatBackend', () => {
  test('template route posts /completions with prompt and parses choices[0].text', async () => {
    m = await startMockHttp(() => ({ sse: SSE }));
    const b = new OpenAiCompatBackend(cfg(`${m.url}/v1`), key());
    expect((await collect(b.streamFim(req()))).join('')).toBe('ab');
    expect(m.requests[0].url).toBe('/v1/completions');
    expect(m.requests[0].body).toMatchObject({ model: 'm', prompt: '<tpl>', max_tokens: 128, temperature: 0.1, top_p: 0.95, stream: true });
  });

  test('native route sends prompt=prefix and suffix, no extra files', async () => {
    m = await startMockHttp(() => ({ sse: SSE }));
    const b = new OpenAiCompatBackend(cfg(`${m.url}/v1`, { hostFlavor: 'ollama' }), key());
    await collect(
      b.streamFim(req({ payload: { route: 'native', prefix: 'PRE', suffix: 'SUF', extra: [{ path: 'a.ts', text: 'x' }], filePath: 'f.ts', repoName: 'r' } })),
    );
    const body = m.requests[0].body;
    expect(body.prompt).toBe('PRE');
    expect(body.suffix).toBe('SUF');
    expect(body.extra).toBeUndefined();
    expect(body.input_extra).toBeUndefined();
  });

  test('top_k only for self-hosted flavors', async () => {
    const sampling = { maxTokens: 8, topK: 40 };
    expect((await hosted('generic', { sampling })).top_k).toBeUndefined();
    expect((await hosted('vllm', { sampling })).top_k).toBe(40);
  });

  test('omits undefined sampling fields and model', async () => {
    const body = await hosted('vllm', { model: undefined, sampling: { maxTokens: 8 } });
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
  });

  test('hosted flavors cap stop list at 4, self-hosted do not', async () => {
    const stop = ['1', '2', '3', '4', '5', '6'];
    expect((await hosted('deepseek', { stop })).stop).toEqual(['1', '2', '3', '4']);
    expect((await hosted('vllm', { stop })).stop).toEqual(stop);
  });

  test('extraBody is spread last', async () => {
    const body = await hosted('vllm', { extraBody: { temperature: 0.9, foo: 1 } });
    expect(body.temperature).toBe(0.9);
    expect(body.foo).toBe(1);
  });

  test('supportsNativeFim only for deepseek and ollama', () => {
    const s = (f: HostFlavor) => new OpenAiCompatBackend(cfg('http://x/v1', { hostFlavor: f }), key()).supportsNativeFim();
    expect(s('deepseek')).toBe(true);
    expect(s('ollama')).toBe(true);
    for (const f of ['generic', 'vllm', 'lmstudio', 'openrouter', 'together', 'fireworks', 'mistral', 'llamacpp'] as const) {
      expect(s(f)).toBe(false);
    }
  });

  test('tolerates events without choices and empty data; malformed JSON throws', async () => {
    m = await startMockHttp(() => ({ sse: ['', '{"id":"x"}', '{"choices":[]}', '{"choices":[{"text":""}]}', '{"choices":[{"text":"z"}]}', '[DONE]'] }));
    const b = new OpenAiCompatBackend(cfg(`${m.url}/v1`), key());
    expect(await collect(b.streamFim(req()))).toEqual(['z']);
    await m.close();
    m = await startMockHttp(() => ({ sse: ['{bad'] }));
    const b2 = new OpenAiCompatBackend(cfg(`${m.url}/v1`), key());
    await expect(collect(b2.streamFim(req()))).rejects.toThrow();
  });

  test('sends bearer key and merges config headers; omits when empty', async () => {
    m = await startMockHttp(() => ({ sse: SSE }));
    const b = new OpenAiCompatBackend(cfg(`${m.url}/v1`, { headers: { 'x-a': '1' } }), key('sk'));
    await collect(b.streamFim(req()));
    expect(m.requests[0].headers.authorization).toBe('Bearer sk');
    expect(m.requests[0].headers['x-a']).toBe('1');
    const b2 = new OpenAiCompatBackend(cfg(`${m.url}/v1`), key(''));
    await collect(b2.streamFim(req()));
    expect(m.requests[1].headers.authorization).toBeUndefined();
  });

  test('an error event inside the stream throws StreamError (oMLX memory guard)', async () => {
    m = await startMockHttp(() => ({ sse: ['{"choices":[{"text":"a"}]}', '{"error":{"message":"oMLX prefill memory guard rejected this prompt"},"message":"x"}'] }));
    const b = new OpenAiCompatBackend(cfg(`${m.url}/v1`), key());
    const err = await collect(b.streamFim(req())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamError);
    expect((err as StreamError).message).toBe('oMLX prefill memory guard rejected this prompt');
  });

  test('HTTP errors throw HttpError', async () => {
    m = await startMockHttp(() => ({ status: 500, json: { error: 'no' } }));
    const b = new OpenAiCompatBackend(cfg(`${m.url}/v1`), key());
    await expect(collect(b.streamFim(req()))).rejects.toBeInstanceOf(HttpError);
  });

  describe('detectModel', () => {
    const signal = () => new AbortController().signal;
    test('returns the sole model id via GET /models', async () => {
      m = await startMockHttp(() => ({ json: { data: [{ id: 'qwen' }] } }));
      const b = new OpenAiCompatBackend(cfg(`${m.url}/v1`), key('sk'));
      expect(await b.detectModel(signal())).toBe('qwen');
      expect(m.requests[0].url).toBe('/v1/models');
      expect(m.requests[0].headers.authorization).toBe('Bearer sk');
    });
    test('does not follow a redirect to another host', async () => {
      const other = await startMockHttp(() => ({ json: { data: [{ id: 'elsewhere' }] } }));
      try {
        m = await startMockHttp(() => ({ status: 307, headers: { location: `${other.url}/v1/models` } }));
        expect(await new OpenAiCompatBackend(cfg(`${m.url}/v1`), key()).detectModel(signal())).toBeUndefined();
        expect(other.requests).toHaveLength(0);
      } finally {
        await other.close();
      }
    });
    test('undefined for multiple models, empty, non-ok, or unreachable', async () => {
      m = await startMockHttp(() => ({ json: { data: [{ id: 'a' }, { id: 'b' }] } }));
      expect(await new OpenAiCompatBackend(cfg(`${m.url}/v1`), key()).detectModel(signal())).toBeUndefined();
      await m.close();
      m = await startMockHttp(() => ({ json: { data: [] } }));
      expect(await new OpenAiCompatBackend(cfg(`${m.url}/v1`), key()).detectModel(signal())).toBeUndefined();
      await m.close();
      m = await startMockHttp(() => ({ status: 404 }));
      expect(await new OpenAiCompatBackend(cfg(`${m.url}/v1`), key()).detectModel(signal())).toBeUndefined();
      const dead = `${m.url}/v1`;
      await m.close();
      expect(await new OpenAiCompatBackend(cfg(dead), key()).detectModel(signal())).toBeUndefined();
    });
  });

  describe('listModels', () => {
    const signal = () => new AbortController().signal;
    test('listModels lists ids and vLLM max_model_len', async () => {
      m = await startMockHttp(() => ({ json: { data: [{ id: 'a', max_model_len: 32768 }, { id: 'b' }, { id: 5 }, { id: 'c', max_model_len: 'x' }] } }));
      const b = new OpenAiCompatBackend(cfg(`${m.url}/v1`), key('sk'));
      expect(await b.listModels(signal())).toEqual({ models: ['a', 'b', 'c'], contextWindows: { a: 32768 } });
      expect(m.requests.map((r) => r.url)).toEqual(['/v1/models']);
      expect(m.requests[0].headers.authorization).toBe('Bearer sk');
    });
    test('throws HttpError on non-ok', async () => {
      m = await startMockHttp(() => ({ status: 401 }));
      await expect(new OpenAiCompatBackend(cfg(`${m.url}/v1`), key()).listModels(signal())).rejects.toBeInstanceOf(HttpError);
    });
    test('lmstudio adds loaded_context_length from /api/v0/models at the origin', async () => {
      m = await startMockHttp(({ url }) =>
        url === '/api/v0/models'
          ? { json: { data: [{ id: 'a', loaded_context_length: 16384 }, { id: 'b', loaded_context_length: 'n' }] } }
          : { json: { data: [{ id: 'a' }, { id: 'b' }] } },
      );
      const b = new OpenAiCompatBackend(cfg(`${m.url}/v1`, { hostFlavor: 'lmstudio' }), key('sk'));
      expect(await b.listModels(signal())).toEqual({ models: ['a', 'b'], contextWindows: { a: 16384 } });
      expect(m.requests.map((r) => r.url)).toEqual(['/v1/models', '/api/v0/models']);
      expect(m.requests[1].headers.authorization).toBe('Bearer sk');
    });
    test('lmstudio ignores a failing /api/v0/models', async () => {
      m = await startMockHttp(({ url }) => (url === '/api/v0/models' ? { status: 500 } : { json: { data: [{ id: 'a' }] } }));
      const b = new OpenAiCompatBackend(cfg(`${m.url}/v1`, { hostFlavor: 'lmstudio' }), key());
      expect(await b.listModels(signal())).toEqual({ models: ['a'], contextWindows: {} });
    });
    test('lmstudio ignores malformed /api/v0/models JSON', async () => {
      m = await startMockHttp(({ url }) => (url === '/api/v0/models' ? { json: 'nope' } : { json: { data: [{ id: 'a' }] } }));
      const b = new OpenAiCompatBackend(cfg(`${m.url}/v1`, { hostFlavor: 'lmstudio' }), key());
      expect(await b.listModels(signal())).toEqual({ models: ['a'], contextWindows: {} });
    });
    test('lmstudio detectModel makes one request: it needs no context windows', async () => {
      m = await startMockHttp(({ url }) =>
        url === '/api/v0/models' ? { json: { data: [{ id: 'a', loaded_context_length: 16384 }] } } : { json: { data: [{ id: 'a' }] } },
      );
      const b = new OpenAiCompatBackend(cfg(`${m.url}/v1`, { hostFlavor: 'lmstudio' }), key());
      expect(await b.detectModel(signal())).toBe('a');
      expect(m.requests.map((r) => r.url)).toEqual(['/v1/models']);
    });
    test('detectModel: one model -> id, two -> undefined, 500 -> undefined', async () => {
      m = await startMockHttp(() => ({ json: { data: [{ id: 'one' }] } }));
      expect(await new OpenAiCompatBackend(cfg(`${m.url}/v1`), key()).detectModel(signal())).toBe('one');
      await m.close();
      m = await startMockHttp(() => ({ json: { data: [{ id: 'a' }, { id: 'b' }] } }));
      expect(await new OpenAiCompatBackend(cfg(`${m.url}/v1`), key()).detectModel(signal())).toBeUndefined();
      await m.close();
      m = await startMockHttp(() => ({ status: 500 }));
      expect(await new OpenAiCompatBackend(cfg(`${m.url}/v1`), key()).detectModel(signal())).toBeUndefined();
    });
  });
});
