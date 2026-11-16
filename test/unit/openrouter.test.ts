import { afterEach, describe, expect, test } from 'vitest';
import { createBackend } from '../../src/backends';
import { MissingApiKeyError } from '../../src/backends/mistral';
import { OpenRouterBackend } from '../../src/backends/openrouter';
import type { ChatEvent, ChatRequest } from '../../src/backends/types';
import { thinkingFields } from '../../src/models/thinking';
import type { BackendConfig } from '../../src/types';
import { startMockHttp } from './helpers/mockHttp';

type Mock = Awaited<ReturnType<typeof startMockHttp>>;
let m: Mock;
afterEach(async () => {
  await m?.close();
});

const cfg = (baseUrl: string, o: Partial<BackendConfig> = {}): BackendConfig => ({
  id: 'or',
  kind: 'openai',
  baseUrl,
  fimMode: 'auto',
  use: { completions: true, nextEdit: true },
  headers: {},
  hostFlavor: 'openrouter',
  ...o,
});
const key = (k?: string) => async () => k;
const signal = () => new AbortController().signal;

describe('OpenRouterBackend', () => {
  test('routes: chat only', () => {
    const b = new OpenRouterBackend(cfg('https://x/api/v1'), key());
    expect(b.routes()).toEqual({ native: false, template: false, chat: true, nativeChatModels: false });
  });

  test('detectModel makes no request', async () => {
    m = await startMockHttp(() => ({ json: { data: [{ id: 'only' }] } }));
    const b = new OpenRouterBackend(cfg(`${m.url}/api/v1`), key());
    expect(await b.detectModel()).toBeUndefined();
    expect(m.requests).toHaveLength(0);
  });

  test('listModels reads ids, context windows and mandatory reasoning', async () => {
    m = await startMockHttp(() => ({
      json: {
        data: [
          { id: 'a', context_length: 131072, reasoning: { mandatory: false } },
          { id: 'b', context_length: 8192, reasoning: { mandatory: true } },
          { id: 'c' },
          { nope: 1 },
        ],
      },
    }));
    const b = new OpenRouterBackend(cfg(`${m.url}/api/v1`), key('k1'));
    const info = await b.listModels(signal());
    expect(info.models).toEqual(['a', 'b', 'c']);
    expect(info.contextWindows).toEqual({ a: 131072, b: 8192 });
    expect(info.thinkingMandatory).toEqual(['b']);
    expect(m.requests[0].url).toBe('/api/v1/models');
    expect(m.requests[0].headers.authorization).toBe('Bearer k1');
  });

  test('listModels keeps inherited-looking ids as data', async () => {
    m = await startMockHttp(() => ({ json: { data: [{ id: 'constructor', context_length: 4096 }] } }));
    const b = new OpenRouterBackend(cfg(`${m.url}/api/v1`), key());
    const info = await b.listModels(signal());
    expect(Object.hasOwn(info.contextWindows, 'constructor')).toBe(true);
    expect(info.contextWindows['constructor']).toBe(4096);
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });

  test('chat goes to {baseUrl}/chat/completions with the thinking body passed through and no attribution headers', async () => {
    m = await startMockHttp(() => ({ sse: ['{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}', '[DONE]'] }));
    const b = new OpenRouterBackend(cfg(`${m.url}/api/v1`), key('k1'));
    const req: ChatRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 16,
      stop: [],
      sampling: {},
      thinking: thinkingFields('none', 'openrouter').body,
      extraBody: {},
      signal: signal(),
      timeoutMs: 5000,
    };
    const out: ChatEvent[] = [];
    for await (const e of b.streamChat(req)) out.push(e);
    expect(out).toEqual([
      { type: 'content', text: 'hi' },
      { type: 'finish', reason: 'stop' },
    ]);
    expect(m.requests[0].url).toBe('/api/v1/chat/completions');
    expect(m.requests[0].body.reasoning).toEqual(thinkingFields('none', 'openrouter').body.reasoning);
    expect(m.requests[0].body.reasoning).toEqual({ effort: 'none' });
    expect(m.requests[0].headers.authorization).toBe('Bearer k1');
    expect(m.requests[0].headers).not.toHaveProperty('http-referer');
    expect(m.requests[0].headers).not.toHaveProperty('x-title');
  });

  test('createBackend picks OpenRouterBackend for openrouter.ai and for hostFlavor openrouter', () => {
    expect(createBackend(cfg('https://openrouter.ai/api/v1', { hostFlavor: undefined }), key())).toBeInstanceOf(OpenRouterBackend);
    expect(createBackend(cfg('http://127.0.0.1:1/api/v1'), key())).toBeInstanceOf(OpenRouterBackend);
    expect(createBackend(cfg('http://127.0.0.1:1/v1', { hostFlavor: 'vllm' }), key())).not.toBeInstanceOf(OpenRouterBackend);
    // "Other OpenAI-compatible" pointed at openrouter.ai still gets OpenRouter's rules
    expect(createBackend(cfg('https://openrouter.ai/api/v1', { hostFlavor: 'generic' }), key())).toBeInstanceOf(OpenRouterBackend);
  });

  test('without a stored key no chat request is sent', async () => {
    m = await startMockHttp(() => ({ sse: ['[DONE]'] }));
    const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'code' }], maxTokens: 16, stop: [], sampling: {}, thinking: {}, extraBody: {}, signal: signal(), timeoutMs: 5000 };
    for (const k of [undefined, '']) {
      const b = new OpenRouterBackend(cfg(`${m.url}/api/v1`), key(k));
      await expect((async () => { for await (const _ of b.streamChat(req)) void _; })()).rejects.toBeInstanceOf(MissingApiKeyError);
    }
    expect(m.requests).toHaveLength(0);
  });
});
