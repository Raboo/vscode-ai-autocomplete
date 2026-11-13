import { afterEach, describe, expect, test } from 'vitest';
import { LlamaCppBackend } from '../../src/backends/llamacpp';
import { HttpError } from '../../src/backends/http';
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
    expect(m.requests[0].url).toBe('/infill');
    expect(m.requests[0].body).toMatchObject({
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
    expect(m.requests[0].body).not.toHaveProperty('model');
  });

  test('template route posts /completion with prompt', async () => {
    m = await startMockHttp(() => ({ sse: SSE }));
    const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
    const out = await collect(
      b.streamFim(req({ model: 'qwen', payload: { route: 'template', prompt: '<fim>x' } })),
    );
    expect(out.join('')).toBe('return a');
    expect(m.requests[0].url).toBe('/completion');
    expect(m.requests[0].body.prompt).toBe('<fim>x');
    expect(m.requests[0].body.model).toBe('qwen');
    expect(m.requests[0].body).not.toHaveProperty('input_prefix');
    expect(m.requests[0].body).not.toHaveProperty('temperature');
  });

  test('sends Bearer key when set, omits it otherwise, merges config headers', async () => {
    m = await startMockHttp(() => ({ sse: SSE }));
    await collect(new LlamaCppBackend(cfg(m.url, { 'x-a': '1' }), async () => 'k').streamFim(req()));
    expect(m.requests[0].headers.authorization).toBe('Bearer k');
    expect(m.requests[0].headers['x-a']).toBe('1');
    await collect(new LlamaCppBackend(cfg(m.url), async () => undefined).streamFim(req()));
    expect(m.requests[1].headers.authorization).toBeUndefined();
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

  test('supportsNativeFim is true', () => {
    expect(new LlamaCppBackend(cfg('http://x'), async () => undefined).supportsNativeFim()).toBe(true);
  });

  test('HTTP 503 surfaces as HttpError', async () => {
    m = await startMockHttp(() => ({ status: 503, json: { error: 'loading' } }));
    const b = new LlamaCppBackend(cfg(m.url), async () => undefined);
    const err = await collect(b.streamFim(req())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
  });
});
