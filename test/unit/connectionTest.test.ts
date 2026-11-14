import { describe, expect, test, vi } from 'vitest';
import { completionServed, explainFailure, runConnectionTest, SAMPLE, TEST_TIMEOUT_MS, type ConnectionTestInput } from '../../src/manage/connectionTest';
import type { FimBackend, FimRequest, ServerInfo } from '../../src/backends/types';
import { HttpError, StreamError } from '../../src/backends/http';
import { MissingApiKeyError } from '../../src/backends/mistral';
import { parseSettings } from '../../src/config/settings';
import { nullLog } from '../../src/log';
import type { BackendConfig } from '../../src/types';
import type { TestStep } from '../../src/manage/protocol';

const SETTINGS = parseSettings({ inspect: () => undefined }).settings;

interface FakeOpts { config?: Partial<BackendConfig>; native?: boolean; info?: ServerInfo | Error; chunks?: string[] | Error; onStream?: (r: FimRequest) => void; clock?: { t: number }; streamCost?: number }
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
    })();
  });
  const backend: FimBackend = { config, supportsNativeFim: () => o.native ?? true, detectModel: async () => undefined, listModels, streamFim };
  return { backend, listModels, streamFim, requests };
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
    expect(res.steps[1]).toMatchObject({ id: 'model', state: 'warn', text: 'zeta-2-7b has no completion template', hint: 'pick a coder model, or choose a template; seed-coder fits Zeta 2.x' });
    expect(f.streamFim).not.toHaveBeenCalled();
  });

  test('a non-zeta model without template gets the plain hint; chat mode warns about v0.2', async () => {
    const plain = await run(fake({ native: false, config: { kind: 'openai', fimModel: 'llama-3' } }));
    expect(plain.res.steps[1]).toMatchObject({ text: 'llama-3 has no completion template', hint: 'pick a coder model, or choose a template' });
    const chat = await run(fake({ config: { fimModel: 'qwen2.5-coder-7b', fimMode: 'chat' } }));
    expect(chat.res.steps[1]).toMatchObject({ state: 'warn', text: 'chat FIM arrives in v0.2' });
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
    f.backend.supportsNativeFim = () => { throw new Error('SECRET-MESSAGE'); };
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
    f.backend.supportsNativeFim = () => { throw new Error('kaput'); };
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
});
