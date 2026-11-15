import { describe, expect, test, vi } from 'vitest';
import { completionServed, explainFailure, runConnectionTest, SAMPLE, TEST_TIMEOUT_MS, type ConnectionTestInput } from '../../src/manage/connectionTest';
import type { ChatEvent, ChatRequest, FimBackend, FimRequest, RouteCaps, ServerInfo } from '../../src/backends/types';
import { HttpError, StreamError } from '../../src/backends/http';
import { MissingApiKeyError } from '../../src/backends/mistral';
import { parseSettings } from '../../src/config/settings';
import { nullLog } from '../../src/log';
import type { BackendConfig } from '../../src/types';
import type { TestStep } from '../../src/manage/protocol';

const SETTINGS = parseSettings({ inspect: () => undefined }).settings;

interface FakeOpts { config?: Partial<BackendConfig>; native?: boolean; info?: ServerInfo | Error; chunks?: string[] | Error; onStream?: (r: FimRequest) => void; clock?: { t: number }; streamCost?: number; caps?: Partial<RouteCaps>; chatEvents?: ChatEvent[] | Error; onChat?: (r: ChatRequest) => void; failAfter?: Error }
function fake(o: FakeOpts = {}) {
  const config: BackendConfig = { id: 'b', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8080', fimMode: 'auto', headers: {}, ...o.config };
  const listModels = vi.fn(async (): Promise<ServerInfo> => {
    const i = o.info ?? { models: ['qwen2.5-coder-7b'], contextWindows: {} };
    if (i instanceof Error) throw i;
    return i;
  });
  const requests: FimRequest[] = [];
  const streamFim = vi.fn((req: FimRequest) => {
    requests.push(req);
    o.onStream?.(req);
    const c = o.chunks ?? ['a + b;'];
    return (async function* () {
      if (o.clock) o.clock.t += o.streamCost ?? 0;
      if (c instanceof Error) throw c;
      yield* c;
      if (o.failAfter) throw o.failAfter;
    })();
  });
  const chatRequests: ChatRequest[] = [];
  const streamChat = vi.fn((req: ChatRequest) => {
    chatRequests.push(req);
    o.onChat?.(req);
    const ev = o.chatEvents ?? [];
    return (async function* () {
      if (o.clock) o.clock.t += o.streamCost ?? 0;
      if (ev instanceof Error) throw ev;
      yield* ev;
    })();
  });
  const backend: FimBackend = { config, routes: () => ({ native: o.native ?? true, template: config.kind !== 'mistral', chat: config.kind !== 'mistral', nativeChatModels: false, ...o.caps }), detectModel: async () => undefined, listModels, streamFim, streamChat };
  return { backend, listModels, streamFim, streamChat, requests, chatRequests };
}

async function run(f: ReturnType<typeof fake>, extra: Partial<ConnectionTestInput> = {}) {
  const emitted: TestStep[] = [];
  const clock = { t: 0 };
  const res = await runConnectionTest({ backend: f.backend, settings: SETTINGS, localOnly: false, isLocal: async () => true, signal: new AbortController().signal, log: nullLog, now: () => clock.t, ...extra }, (s) => emitted.push(s));
  return { res, emitted };
}

describe('runConnectionTest', () => {
  test('happy path: reach, model, completion, context all ok', async () => {
    const f = fake({ info: { models: ['qwen2.5-coder-7b'], contextWindows: { 'qwen2.5-coder-7b': 32768 } } });
    const { res, emitted } = await run(f);
    expect(res.steps).toEqual(emitted);
    expect(res.steps.map((s) => [s.id, s.state])).toEqual([['reach', 'ok'], ['model', 'ok'], ['completion', 'ok'], ['context', 'ok']]);
    expect(res.steps[0].text).toBe('Server answered in 0 ms (1 models)');
    expect(res.steps[1].text).toBe('Model qwen2.5-coder-7b (server-side prompt)');
    expect(res.steps[2].text).toBe('Test completion in 0 ms: "a + b;"');
    expect(res.steps[3].text).toBe('Server context window: 32768 tokens');
    expect(res.model).toBe('qwen2.5-coder-7b');
    expect(f.listModels).toHaveBeenCalledWith(expect.anything(), 5000);
    expect(f.requests[0].timeoutMs).toBe(TEST_TIMEOUT_MS);
  });

  test('refuses a non-local URL under localOnly without any request', async () => {
    const f = fake();
    const { res } = await run(f, { localOnly: true, isLocal: async () => false });
    expect(res.steps).toEqual([{ id: 'reach', state: 'fail', text: 'local only is on in this workspace' }]);
    expect(f.listModels).not.toHaveBeenCalled();
    expect(f.streamFim).not.toHaveBeenCalled();
  });

  test('401 → check the API key; 404 → /v1 hint; ECONNREFUSED → is the server running?', async () => {
    const http = (s: number) => new HttpError(s, 'secret body', 'http://x');
    const r401 = await run(fake({ info: http(401) }));
    expect(r401.res.steps).toEqual([{ id: 'reach', state: 'fail', text: 'HTTP 401', hint: 'check the API key', ms: 0 }]);
    const r404 = await run(fake({ info: http(404) }));
    expect(r404.res.steps[0]).toMatchObject({ text: 'HTTP 404', hint: 'check the URL; OpenAI-compatible servers usually end in /v1' });
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const rc = await run(fake({ info: refused }));
    expect(rc.res.steps[0]).toMatchObject({ text: 'connection refused', hint: 'is the server running?' });
    expect(rc.res.steps).toHaveLength(1);
  });

  test('several models and no fimModel → warn and stop', async () => {
    const f = fake({ info: { models: ['a', 'b'], contextWindows: {} } });
    const { res } = await run(f);
    expect(res.steps.map((s) => [s.id, s.state])).toEqual([['reach', 'ok'], ['model', 'warn']]);
    expect(res.steps[1].text).toBe('the server lists 2 models; choose one');
    expect(f.streamFim).not.toHaveBeenCalled();
  });

  test('zeta model without template → warn naming seed-coder, no completion request', async () => {
    const f = fake({ native: false, config: { kind: 'openai', fimModel: 'zeta-2-7b' } });
    const { res } = await run(f);
    expect(res.steps[1]).toMatchObject({ id: 'model', state: 'warn', text: 'zeta-2-7b has no completion template', hint: 'pick a coder model, choose a template for it, or set the prompt mode to chat; seed-coder fits Zeta 2.x' });
    expect(f.streamFim).not.toHaveBeenCalled();
  });

  test('a non-zeta model without template gets the plain hint', async () => {
    const plain = await run(fake({ native: false, caps: { chat: false }, config: { kind: 'openai', fimModel: 'llama-3' } }));
    expect(plain.res.steps[1]).toMatchObject({ text: 'llama-3 has no completion template', hint: 'pick a coder model, or choose a template for it' });
    // chat possible: the hint offers the chat prompt mode
    const withChat = await run(fake({ native: false, config: { kind: 'openai', fimModel: 'llama-3' } }));
    expect(withChat.res.steps[1]).toMatchObject({ text: 'llama-3 has no completion template', hint: 'pick a coder model, choose a template for it, or set the prompt mode to chat' });
    // Mistral serves Codestral only, and a template cannot help
    const mistral = await run(fake({ config: { kind: 'mistral', fimModel: 'mistral-large-4' } }));
    expect(mistral.res.steps.find((s) => s.id === 'model')).toMatchObject({ state: 'warn', text: "mistral-large-4 cannot complete through Mistral's FIM endpoint", hint: 'choose a Codestral model' });
  });

  test('a prompt mode the server cannot use names the mode, not the template', async () => {
    const hint = 'set the prompt mode to auto';
    const native = fake({ native: false, config: { kind: 'openai', fimModel: 'qwen2.5-coder-7b', fimMode: 'native' } });
    const n = await run(native);
    expect(n.res.steps[1]).toMatchObject({ id: 'model', state: 'warn', text: 'prompt mode "native" does not work with this server', hint });
    expect(native.streamFim).not.toHaveBeenCalled();
    const mistral = fake({ config: { kind: 'mistral', fimModel: 'codestral-latest', fimMode: 'template' } });
    const m = await run(mistral);
    expect(m.res.steps.map((s) => [s.id, s.state])).toEqual([['reach', 'ok'], ['model', 'warn']]);
    expect(m.res.steps[1]).toMatchObject({ text: 'prompt mode "template" does not work with this server', hint });
  });

  test('backend template seed-coder makes zeta pass', async () => {
    const f = fake({ native: false, config: { kind: 'openai', fimModel: 'zeta-2-7b', fim: { template: 'seed-coder' } } });
    const { res } = await run(f);
    expect(res.steps[1]).toMatchObject({ state: 'ok', text: 'Model zeta-2-7b with the seed-coder template' });
    expect(f.requests[0].payload.route).toBe('template');
  });

  test('a backend template that differs from the model\'s own warns, and the test goes on', async () => {
    const f = fake({ native: false, info: { models: ['mellum-4b'], contextWindows: { 'mellum-4b': 8192 } }, config: { kind: 'openai', fimModel: 'mellum-4b', fim: { template: 'seed-coder' } } });
    const { res } = await run(f);
    expect(res.steps[1]).toMatchObject({ id: 'model', state: 'warn', text: 'Model mellum-4b with the seed-coder template', hint: 'mellum-4b\'s own template is mellum; reset the Template field' });
    expect(res.steps.map((s) => s.id)).toEqual(['reach', 'model', 'completion', 'context']);
    expect(f.requests[0].payload).toMatchObject({ route: 'template' });
    expect(completionServed(res)).toBe(true);
  });

  test('slow first completion is a warning', async () => {
    const clock = { t: 0 };
    const f = fake({ clock, streamCost: 8000, config: { fim: { timeoutMs: 5000 } } });
    const { res } = await run(f, { now: () => clock.t });
    const c = res.steps.find((s) => s.id === 'completion')!;
    expect(c.state).toBe('warn');
    expect(c.ms).toBe(8000);
    expect(c.hint).toBe('slower than the 5000 ms timeout; run the test again if the model was loading');
  });

  test('empty completion warns', async () => {
    const { res } = await run(fake({ chunks: [''] }));
    expect(res.steps.find((s) => s.id === 'completion')).toMatchObject({ state: 'warn', text: 'the server answered but returned no completion' });
  });

  test('a timeout after only blank lines fails as a timeout', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const { res } = await run(fake({ chunks: ['\n\na'], failAfter: timeout }));
    expect(res.steps.find((s) => s.id === 'completion')).toMatchObject({ state: 'fail', text: 'timed out' });
    expect(completionServed(res)).toBe(false);
  });

  test('completion failure is a fail step', async () => {
    const { res } = await run(fake({ chunks: new HttpError(500, 'boom', 'u') }));
    expect(res.steps.find((s) => s.id === 'completion')).toMatchObject({ state: 'fail', text: 'HTTP 500' });
  });

  test('context overflow warns; no window → no context step', async () => {
    const over = await run(fake({ info: { models: ['m'], contextWindows: { m: 1000 } }, config: { fim: { contextTokens: 4700, maxTokens: 128 } } }));
    expect(over.res.steps.at(-1)).toMatchObject({ id: 'context', state: 'warn', text: "context size 4700 + max tokens 128 is more than the server's 1000" });
    const none = await run(fake());
    expect(none.res.steps.map((s) => s.id)).toEqual(['reach', 'model', 'completion']);
  });

  test('mistral reach uses a one-token FIM', async () => {
    const f = fake({ config: { kind: 'mistral', fimModel: 'codestral-latest' } });
    const { res } = await run(f);
    expect(f.listModels).not.toHaveBeenCalledWith(expect.anything(), 5000);
    expect(f.requests[0].sampling.maxTokens).toBe(1);
    expect(f.requests[0].timeoutMs).toBe(TEST_TIMEOUT_MS);
    expect(res.steps[0].text).toBe('Server answered in 0 ms');
    expect(res.steps.find((s) => s.id === 'completion')?.state).toBe('ok');
  });

  test('the sample text is logged only with debug.logPrompts', async () => {
    const mk = () => ({ ...nullLog, debug: vi.fn() });
    const off = mk();
    await run(fake(), { log: off });
    expect(off.debug).toHaveBeenCalled();
    expect(JSON.stringify(off.debug.mock.calls)).not.toContain('a + b;');
    const on = mk();
    await run(fake(), { log: on, settings: { ...SETTINGS, debug: { logPrompts: true } } });
    expect(JSON.stringify(on.debug.mock.calls)).toContain('a + b;');
  });

  test('a fail step logs its fixed failure text at debug level, never the error message', async () => {
    const mk = () => ({ ...nullLog, debug: vi.fn() });
    const http = mk();
    await run(fake({ chunks: new HttpError(500, 'SECRET-BODY', 'u') }), { log: http });
    expect(JSON.stringify(http.debug.mock.calls)).toContain('connection test completion: fail in 0 ms: HTTP 500');
    expect(JSON.stringify(http.debug.mock.calls)).not.toContain('SECRET');
    const odd = mk();
    const f = fake();
    f.backend.routes = () => { throw new Error('SECRET-MESSAGE'); };
    await run(f, { log: odd });
    expect(JSON.stringify(odd.debug.mock.calls)).toContain('connection test model: fail in 0 ms: request failed');
    expect(JSON.stringify(odd.debug.mock.calls)).not.toContain('SECRET');
  });

  test('an error sent inside the stream fails the completion step; its message is logged only with debug.logPrompts', async () => {
    const mk = () => ({ ...nullLog, debug: vi.fn() });
    const off = mk();
    const { res } = await run(fake({ chunks: new StreamError('SECRET memory guard') }), { log: off });
    expect(res.steps.at(-1)).toEqual({
      id: 'completion', state: 'fail', text: 'the server returned an error',
      hint: 'turn on aiAutocomplete.debug.logPrompts and test again to log its message', ms: 0,
    });
    expect(completionServed(res)).toBe(false);
    expect(JSON.stringify(off.debug.mock.calls)).not.toContain('SECRET');
    const on = mk();
    await run(fake({ chunks: new StreamError('SECRET memory guard') }), { log: on, settings: { ...SETTINGS, debug: { logPrompts: true } } });
    expect(JSON.stringify(on.debug.mock.calls)).toContain('connection test completion: server error: SECRET memory guard');
  });

  test('never throws: an unexpected exception becomes a fail step', async () => {
    const f = fake();
    f.backend.routes = () => { throw new Error('kaput'); };
    const { res } = await run(f);
    expect(res.steps.at(-1)).toMatchObject({ state: 'fail', text: 'request failed' });
  });

  test('SAMPLE', () => {
    expect(SAMPLE).toMatchObject({ prefix: 'function add(a: number, b: number): number {\n  return ', suffix: '\n}\n', filePath: 'sample.ts', repoName: 'sample', extra: [] });
  });
});

describe('completionServed', () => {
  const step = (id: TestStep['id'], state: TestStep['state']): TestStep => ({ id, state, text: '' });
  test('true once the server answered the sample completion, even slowly or with a context warning', () => {
    expect(completionServed({ steps: [step('reach', 'ok'), step('model', 'ok'), step('completion', 'ok'), step('context', 'ok')] })).toBe(true);
    expect(completionServed({ steps: [step('reach', 'ok'), step('model', 'ok'), step('completion', 'warn')] })).toBe(true);
    expect(completionServed({ steps: [step('reach', 'ok'), step('model', 'ok'), step('completion', 'ok'), step('context', 'warn')] })).toBe(true);
  });
  test('false when the completion failed or never ran', () => {
    expect(completionServed({ steps: [step('reach', 'ok'), step('model', 'ok'), step('completion', 'fail')] })).toBe(false);
    expect(completionServed({ steps: [step('reach', 'ok'), step('model', 'warn')] })).toBe(false);
    expect(completionServed({ steps: [step('reach', 'fail')] })).toBe(false);
    expect(completionServed({ steps: [] })).toBe(false);
  });
});

describe('explainFailure', () => {
  test('never includes server body text', () => {
    const e = explainFailure(new HttpError(500, 'SECRET-BODY', 'http://secret.example/path'));
    expect(JSON.stringify(e)).not.toMatch(/SECRET|example/);
    expect(explainFailure(new Error('SECRET-MESSAGE'))).toEqual({ text: 'request failed' });
  });
  test('mapping', () => {
    expect(explainFailure(new HttpError(302, '', 'u'))).toEqual({ text: 'HTTP 302', hint: 'redirects are not followed' });
    expect(explainFailure(new HttpError(403, '', 'u'))).toEqual({ text: 'HTTP 403', hint: 'check the API key' });
    expect(explainFailure(new HttpError(500, '', 'u'))).toEqual({ text: 'HTTP 500' });
    expect(explainFailure(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toEqual({ text: 'timed out' });
    expect(explainFailure(new TypeError('x', { cause: { code: 'ENOTFOUND' } }))).toEqual({ text: 'host not found' });
    expect(explainFailure(new TypeError('x', { cause: { code: 'EAI_AGAIN' } }))).toEqual({ text: 'host not found' });
    expect(explainFailure(new MissingApiKeyError('b'))).toEqual({ text: 'no API key stored', hint: 'enter the key in the API key field' });
    expect(explainFailure(new SyntaxError('bad json'))).toEqual({ text: 'request failed' });
    expect(explainFailure(new StreamError('SECRET-MESSAGE'))).toEqual({
      text: 'the server returned an error', hint: 'turn on aiAutocomplete.debug.logPrompts and test again to log its message',
    });
  });

  describe('chat route', () => {
    const chatCfg = { kind: 'openai' as const, fimModel: 'Qwen3.8-Flash-Next' };
    const caps = { native: false, template: true, chat: true, nativeChatModels: false };
    const ev = (...c: string[]): ChatEvent[] => c.map((text) => ({ type: 'content', text }));

    test('reach, model, completion and thinking ok', async () => {
      const f = fake({ config: chatCfg, caps, chatEvents: ev('<COMPLETION>a + b;') });
      const { res } = await run(f);
      expect(res.steps.map((s) => [s.id, s.state, s.text])).toEqual([
        ['reach', 'ok', 'Server answered in 0 ms (1 models)'], ['model', 'ok', 'Model Qwen3.8-Flash-Next (chat prompt)'],
        ['completion', 'ok', 'Test completion in 0 ms: "a + b;"'], ['thinking', 'ok', 'Thinking is off'],
      ]);
      expect(f.chatRequests[0]!.timeoutMs).toBe(TEST_TIMEOUT_MS);
      expect(f.streamFim).not.toHaveBeenCalled();
    });

    test('a model that thinks anyway gets a thinking warning', async () => {
      const f = fake({ config: chatCfg, caps, chatEvents: [{ type: 'reasoning', text: 'hmm' }, ...ev('<COMPLETION>a + b;')] });
      const { res } = await run(f);
      expect(res.steps[3]).toMatchObject({ id: 'thinking', state: 'warn', text: 'the model still thinks with thinking off',
        hint: 'completions take longer; choose a model that can turn thinking off, or set the Thinking switch' });
    });

    test('rejected fields are named in the thinking hint', async () => {
      const f = fake({ config: chatCfg, caps, chatEvents: ev('<COMPLETION>a + b;'), onChat: (r) => r.onRejected?.(['top_k', 'presence_penalty']) });
      const { res } = await run(f);
      expect(res.steps[3]).toMatchObject({ id: 'thinking', state: 'ok', text: 'Thinking is off', hint: 'the server rejected top_k, presence_penalty; they are left out' });
    });

    test('an OpenRouter model that rejects effort "none" is named readably in the thinking hint', async () => {
      const config = { kind: 'openai' as const, hostFlavor: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api/v1', fimModel: 'google/gemini-2.5-pro' };
      const f = fake({ config, caps: { native: false, template: false }, info: { models: ['google/gemini-2.5-pro'], contextWindows: {} },
        chatEvents: ev('<COMPLETION>a + b;'), onChat: (r) => r.onRejected?.(['reasoning']) });
      const { res } = await run(f);
      expect(res.steps.find((s) => s.id === 'thinking')).toMatchObject({ hint: 'the server rejected reasoning effort "none"; they are left out' });
    });

    test('a cannotDisable model warns at the model step and still runs the completion', async () => {
      const f = fake({ config: { ...chatCfg, fimModel: 'gpt-oss-20b' }, caps, chatEvents: [{ type: 'reasoning', text: 'x' }, ...ev('<COMPLETION>a + b;')] });
      const { res } = await run(f);
      expect(res.steps[1]).toMatchObject({ id: 'model', state: 'warn', text: 'Model gpt-oss-20b (chat prompt)', hint: 'this model cannot turn thinking off, so completions are slow' });
      expect(res.steps[2]).toMatchObject({ id: 'completion', state: 'ok' });
      const m = fake({ config: { ...chatCfg, fimModel: 'z-ai/glm-5' }, caps, info: { models: ['z-ai/glm-5'], contextWindows: {}, thinkingMandatory: ['z-ai/glm-5'] }, chatEvents: ev('<COMPLETION>a;') });
      expect((await run(m)).res.steps[1]).toMatchObject({ state: 'warn' });
    });

    test('the slow warning compares against the one 5 s deadline', async () => {
      const clock = { t: 0 };
      const f = fake({ config: chatCfg, caps, clock, streamCost: 3000, chatEvents: ev('<COMPLETION>a + b;') });
      expect((await run(f, { now: () => clock.t })).res.steps[2]).toMatchObject({ state: 'ok' });
      const slow = fake({ config: chatCfg, caps, clock, streamCost: 6000, chatEvents: ev('<COMPLETION>a + b;') });
      expect((await run(slow, { now: () => clock.t })).res.steps[2]).toMatchObject({ state: 'warn' });
    });

    test('the context step counts the chat request\'s own max tokens', async () => {
      const info = { models: ['gpt-oss-20b'], contextWindows: { 'gpt-oss-20b': 4750 } };
      const f = fake({ config: { ...chatCfg, fimModel: 'gpt-oss-20b' }, caps, info, chatEvents: ev('<COMPLETION>a + b;') });
      const { res } = await run(f);
      expect(res.steps.at(-1)).toMatchObject({ id: 'context', state: 'warn', text: "context size 4700 + max tokens 80 is more than the server's 4750" });
    });

    test('context step ignores inherited keys', async () => {
      // the native route, so the run reaches the context step: an inherited `constructor` is not a window
      const f = fake({ config: { fimModel: 'constructor' }, info: { models: ['constructor'], contextWindows: {} } });
      const ids = (await run(f)).res.steps.map((s) => s.id);
      expect(ids).toContain('completion');
      expect(ids).not.toContain('context');
    });
  });
});
