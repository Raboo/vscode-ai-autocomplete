import { afterEach, describe, expect, test } from 'vitest';
import { createBackend } from '../../src/backends/index';
import { LlamaCppBackend } from '../../src/backends/llamacpp';
import { HttpError } from '../../src/backends/http';
import { MissingApiKeyError, MistralBackend } from '../../src/backends/mistral';
import { OpenAiCompatBackend } from '../../src/backends/openaiCompat';
import type { FimRequest } from '../../src/backends/types';
import type { BackendConfig } from '../../src/types';
import { startMockHttp } from './helpers/mockHttp';

type Mock = Awaited<ReturnType<typeof startMockHttp>>;
const mocks: Mock[] = [];
async function mock(h: Parameters<typeof startMockHttp>[0]): Promise<Mock> {
  const m = await startMockHttp(h);
  mocks.push(m);
  return m;
}
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

const cfg = (baseUrl: string, o: Partial<BackendConfig> = {}): BackendConfig => ({
  id: 'mistral',
  kind: 'mistral',
  baseUrl,
  fimMode: 'auto',
  headers: {},
  ...o,
});

const req = (o: Partial<FimRequest> = {}): FimRequest => ({
  payload: { route: 'native', prefix: 'P', suffix: 'S', extra: [], filePath: 'a.ts', repoName: 'r' },
  stop: [],
  sampling: { maxTokens: 128, temperature: 0.2 },
  extraBody: {},
  signal: new AbortController().signal,
  timeoutMs: 5000,
  ...o,
});

const key = async () => 'k';

async function collect(it: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const s of it) {
    out += s;
  }
  return out;
}

const ok = (s: string) => ({ sse: [JSON.stringify({ choices: [{ delta: { content: s } }] }), '[DONE]'] });

describe('MistralBackend request', () => {
  test('posts /v1/fim/completions without top_p, with codestral multi-file prefix', async () => {
    const m = await mock(() => ok('x'));
    const b = new MistralBackend(cfg(m.url), key);
    const payload = {
      route: 'native' as const,
      prefix: 'P',
      suffix: 'S',
      extra: [{ path: 'b.ts', text: 'B' }],
      filePath: 'a.ts',
      repoName: 'r',
    };
    await collect(b.streamFim(req({ payload, sampling: { maxTokens: 128, temperature: 0.2, topP: 0.9, topK: 40 } })));
    expect(m.requests[0].url).toBe('/v1/fim/completions');
    expect(m.requests[0].headers.authorization).toBe('Bearer k');
    expect(m.requests[0].body).toMatchObject({
      model: 'codestral-latest',
      prompt: '+++++ b.ts\nB\n\n+++++ a.ts\nP',
      suffix: 'S',
      max_tokens: 128,
      temperature: 0.2,
      stream: true,
    });
    expect(m.requests[0].body.top_p).toBeUndefined();
    expect(m.requests[0].body.top_k).toBeUndefined();
    expect(m.requests[0].body.stop).toBeUndefined();
  });

  test('plain prefix without extra files; sends top_p when temperature is unset; stop and model', async () => {
    const m = await mock(() => ok('x'));
    const b = new MistralBackend(cfg(m.url, { fimModel: 'cfg-model' }), key);
    await collect(b.streamFim(req({ sampling: { maxTokens: 9, topP: 0.5 }, stop: ['\n\n'], extraBody: { foo: 1 } })));
    await collect(b.streamFim(req({ model: 'req-model' })));
    expect(m.requests[0].body).toMatchObject({ model: 'cfg-model', prompt: 'P', top_p: 0.5, stop: ['\n\n'], foo: 1 });
    expect(m.requests[0].body.temperature).toBeUndefined();
    expect(m.requests[1].body.model).toBe('req-model');
  });

  test('parses delta.content, message.content or text defensively', async () => {
    const m = await mock(() => ({
      sse: [
        '',
        JSON.stringify({ choices: [{ delta: { content: 'a' } }] }),
        JSON.stringify({ choices: [{ message: { content: 'b' } }] }),
        JSON.stringify({ choices: [{ text: 'c' }] }),
        JSON.stringify({ choices: [{ delta: { content: '' } }] }),
        JSON.stringify({ choices: [] }),
        '[DONE]',
      ],
    }));
    const b = new MistralBackend(cfg(m.url), key);
    expect(await collect(b.streamFim(req()))).toBe('abc');
  });

  test('malformed JSON throws', async () => {
    const m = await mock(() => ({ sse: ['{nope'] }));
    const b = new MistralBackend(cfg(m.url), key);
    await expect(collect(b.streamFim(req()))).rejects.toThrow();
  });

  test('template route is rejected', async () => {
    const m = await mock(() => ok('x'));
    const b = new MistralBackend(cfg(m.url), key);
    await expect(collect(b.streamFim(req({ payload: { route: 'template', prompt: 't' } })))).rejects.toThrow(
      /native only/,
    );
    expect(m.requests).toHaveLength(0);
  });

  test('supportsNativeFim and detectModel', async () => {
    const ac = new AbortController();
    expect(new MistralBackend(cfg(''), key).supportsNativeFim()).toBe(true);
    expect(await new MistralBackend(cfg(''), key).detectModel(ac.signal)).toBe('codestral-latest');
    expect(await new MistralBackend(cfg('', { fimModel: 'x' }), key).detectModel(ac.signal)).toBe('x');
  });
});

describe('MistralBackend key', () => {
  test.each([undefined, ''])('no key (%j) -> MissingApiKeyError and no request', async (k) => {
    const m = await mock(() => ok('x'));
    const b = new MistralBackend(cfg(m.url), async () => k);
    const err = await collect(b.streamFim(req())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingApiKeyError);
    expect((err as MissingApiKeyError).backendId).toBe('mistral');
    expect(m.requests).toHaveLength(0);
  });
});

describe('MistralBackend endpoint fallback', () => {
  const setup = async (a: number, b: number) => {
    const mockA = await mock(() => (a === 200 ? ok('A') : { status: a }));
    const mockB = await mock(() => (b === 200 ? ok('B') : { status: b }));
    const map: Record<string, string> = {
      'https://codestral.mistral.ai': mockA.url,
      'https://api.mistral.ai': mockB.url,
    };
    const be = new MistralBackend(cfg('https://codestral.mistral.ai'), key, { resolveBase: (u) => map[u] ?? u });
    return { mockA, mockB, be };
  };

  test('empty baseUrl defaults to the codestral host', async () => {
    const mockA = await mock(() => ok('A'));
    const be = new MistralBackend(cfg(''), key, {
      resolveBase: (u) => (u === 'https://codestral.mistral.ai' ? mockA.url : u),
    });
    expect(await collect(be.streamFim(req()))).toBe('A');
  });

  test('401 on codestral host retries api host once and remembers it', async () => {
    const { mockA, mockB, be } = await setup(401, 200);
    expect(await collect(be.streamFim(req()))).toBe('B');
    expect(mockA.requests).toHaveLength(1);
    expect(mockB.requests).toHaveLength(1);
    expect(await collect(be.streamFim(req()))).toBe('B');
    expect(mockA.requests).toHaveLength(1);
    expect(mockB.requests).toHaveLength(2);
  });

  test('403 also falls back', async () => {
    const { be } = await setup(403, 200);
    expect(await collect(be.streamFim(req()))).toBe('B');
  });

  test('401 on both hosts throws the second HttpError', async () => {
    const { mockA, mockB, be } = await setup(401, 401);
    const err = await collect(be.streamFim(req())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).url).toContain(new URL(mockB.url).host);
    expect(mockA.requests).toHaveLength(1);
    expect(mockB.requests).toHaveLength(1);
  });

  test('non-auth errors never fall back', async () => {
    const { mockA, mockB, be } = await setup(500, 200);
    await expect(collect(be.streamFim(req()))).rejects.toMatchObject({ status: 500 });
    expect(mockA.requests).toHaveLength(1);
    expect(mockB.requests).toHaveLength(0);
  });

  test('custom host never falls back', async () => {
    const m = await mock(() => ({ status: 401 }));
    const be = new MistralBackend(cfg(m.url), key);
    await expect(collect(be.streamFim(req()))).rejects.toMatchObject({ status: 401 });
    expect(m.requests).toHaveLength(1);
  });
});

describe('createBackend', () => {
  test.each([
    ['llamacpp', LlamaCppBackend],
    ['openai', OpenAiCompatBackend],
    ['mistral', MistralBackend],
  ] as const)('%s', (kind, cls) => {
    const c = cfg('http://x', { kind });
    const b = createBackend(c, key);
    expect(b).toBeInstanceOf(cls);
    expect(b.config).toBe(c);
  });
});
