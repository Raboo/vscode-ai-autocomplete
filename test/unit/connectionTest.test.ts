import { describe, expect, test, vi } from 'vitest';
import { completionServed, invalidAnswerText, explainFailure, PROBE_TIMEOUT_MS, runConnectionTest, SAMPLE, TEST_TIMEOUT_MS, type ConnectionTestInput } from '../../src/manage/connectionTest';
import type { ChatEvent, ChatRequest, FimBackend, FimRequest, RouteCaps, ServerInfo } from '../../src/backends/types';
import { HttpError, StreamError } from '../../src/backends/http';
import { MissingApiKeyError } from '../../src/backends/mistral';
import { parseBackendEntry, parseSettings } from '../../src/config/settings';
import { nullLog } from '../../src/log';
import { THINKING_LABELS } from '../../src/models/thinking';
import type { BackendConfig } from '../../src/types';
import type { TestStep } from '../../src/manage/protocol';
import { OpenRouterBackend } from '../../src/backends/openrouter';
import { startMockHttp } from './helpers/mockHttp';
import { nextEditSample } from '../../src/manage/nextEditSample';
import { pickFormat } from '../../src/nextEdit/formats';

const SETTINGS = parseSettings({ inspect: () => undefined }).settings;

interface FakeOpts { config?: Partial<BackendConfig>; native?: boolean; info?: ServerInfo | Error; chunks?: string[] | Error; onStream?: (r: FimRequest) => void; clock?: { t: number }; streamCost?: number; caps?: Partial<RouteCaps>; chatEvents?: ChatEvent[] | Error; onChat?: (r: ChatRequest) => void; chatFor?: (r: ChatRequest) => ChatEvent[]; failAfter?: Error }
function fake(o: FakeOpts = {}) {
  const config: BackendConfig = { id: 'b', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8080', fimMode: 'auto', headers: {}, use: { completions: true, nextEdit: false }, ...o.config };
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
    const ev = o.chatFor ? o.chatFor(req) : (o.chatEvents ?? []);
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
  test('an LM Studio template completion goes through the first-space repair, as in the editor', async () => {
    const f = fake({ config: { kind: 'openai', hostFlavor: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', fimModel: 'qwen2.5-coder-7b' }, native: false });
    await run(f);
    const req = f.requests.find((r) => r.payload.route === 'template');
    expect(req?.firstSpace).toEqual({ held: 'n ' }); // the sample ends with `return `
    expect(req?.onUnrepaired).toBeTypeOf('function');
  });

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

  test('a Next Edit-only model → warn naming Zeta 2.1, no completion request', async () => {
    for (const config of [{ kind: 'openai' as const, fimModel: 'zeta-2.1' }, { kind: 'llamacpp' as const, fimModel: 'zeta-2.1' }]) {
      const f = fake({ native: config.kind === 'llamacpp', config });
      const { res } = await run(f);
      expect(res.steps.map((s) => [s.id, s.state])).toEqual([['reach', 'ok'], ['model', 'warn']]);
      expect(res.steps[1]).toMatchObject({ text: 'zeta-2.1 is a Zeta 2.1 Next Edit model; it cannot do completions', hint: 'untick Completions, or choose a completion model' });
      expect(f.streamFim).not.toHaveBeenCalled();
      expect(f.streamChat).not.toHaveBeenCalled();
    }
  });

  test('a Next Edit-only backend runs no completion step', async () => {
    const f = fake({ native: false, config: { kind: 'openai', nextEditModel: 'zeta-2-7b', use: { completions: false, nextEdit: true } }, chunks: ['<|marker_1|><|marker_1|>'] });
    const { res } = await run(f);
    expect(res.steps.map((s) => s.id)).toEqual(['reach', 'nextEdit']);
    expect(f.streamFim).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.requests[0].payload)).toContain('<[fim-suffix]>');
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

  test('backend template seed-coder makes a template-less model pass', async () => {
    const f = fake({ native: false, config: { kind: 'openai', fimModel: 'llama-3', fim: { template: 'seed-coder' } } });
    const { res } = await run(f);
    expect(res.steps[1]).toMatchObject({ state: 'ok', text: 'Model llama-3 with the seed-coder template' });
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

describe('invalidAnswerText', () => {
  test('puts each fixed reason of the formats in plain words, with a fallback', () => {
    for (const why of ['noFence', 'truncated', 'special', 'empty', 'tooLong', 'markers', 'range', 'glued']) {
      const text = invalidAnswerText(why);
      expect(text).toMatch(/^the answer could not be read \([a-z ]+\)$/);
      expect(text).not.toMatch(/\((noFence|truncated|special|empty|tooLong|markers|range|glued)\)/);
    }
    expect(invalidAnswerText('somethingNew')).toBe('the answer could not be read (it was not in the expected format)');
    expect(invalidAnswerText('constructor')).toBe('the answer could not be read (it was not in the expected format)');
  });
});

describe('the Next Edit step', () => {
  const ZETA = { kind: 'llamacpp' as const, nextEditModel: 'zeta-2.1', use: { completions: false, nextEdit: true } };
  const noNative = { native: false };
  const zetaRewrite = '<|marker_1|>def total(width, height):\n    a = width * height\n    print(a)\n    return a * 2\n<|marker_2|>';
  const stepIds = (r: { res: { steps: TestStep[] } }) => r.res.steps.map((s) => s.id);
  /** The backends here have id 'b'; selecting it as the Next Edit backend makes the step run for a backend with both uses. */
  const selected = { ...SETTINGS, nextEdit: { ...SETTINGS.nextEdit, backendId: 'b' } };

  test('a Next Edit-only backend runs reach and the Next Edit step only, through the format the editor uses', async () => {
    const f = fake({ ...noNative, config: ZETA, chunks: [zetaRewrite] });
    const r = await run(f);
    expect(r.res.steps.map((s) => [s.id, s.state])).toEqual([['reach', 'ok'], ['nextEdit', 'ok']]);
    expect(r.res.steps[1].text).toBe('Next Edit in 0 ms with zeta-2.1 (Zeta 2.1 format): suggests an edit');
    expect(f.streamFim).toHaveBeenCalledTimes(1);
    expect(f.streamChat).not.toHaveBeenCalled();
    const req = f.requests[0];
    expect(req.payload).toMatchObject({ route: 'template' });
    expect(req.timeoutMs).toBe(TEST_TIMEOUT_MS);
    expect(req.model).toBe('zeta-2.1');
    expect(req.sampling.temperature).toBe(0);
    expect(r.res.steps).toEqual(r.emitted);
  });

  test('both uses run the completion steps, then the Next Edit step', async () => {
    const f = fake({
      ...noNative, info: { models: ['qwen3-coder'], contextWindows: { 'qwen3-coder': 32768 } },
      config: { kind: 'openai', fimModel: 'qwen3-coder', nextEditModel: 'zeta-2.1', use: { completions: true, nextEdit: true } },
    });
    // The first FIM request is the completion; the second one the Next Edit.
    let n = 0;
    const answers = ['a + b;', zetaRewrite];
    f.streamFim.mockImplementation((req: FimRequest) => {
      f.requests.push(req);
      const text = answers[n++]!;
      return (async function* () { yield text; })();
    });
    const r = await run(f);
    expect(stepIds(r)).toEqual(['reach', 'model', 'completion', 'context', 'nextEdit']);
    expect(r.res.steps.map((s) => s.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(f.streamFim).toHaveBeenCalledTimes(2);
    expect(r.res.steps[4].text).toContain('zeta-2.1');
  });

  test('a chat completion model puts thinking before context, and Next Edit last', async () => {
    const f = fake({
      native: false, caps: { native: false, template: true, chat: true, nativeChatModels: false }, info: { models: ['Qwen3.8-Flash-Next'], contextWindows: { 'Qwen3.8-Flash-Next': 32768 } },
      config: { kind: 'openai', fimModel: 'Qwen3.8-Flash-Next', use: { completions: true, nextEdit: true } },
      chatFor: (req) => (req.messages.some((m) => m.content.includes('<COMPLETION>')) ? [{ type: 'content', text: '<COMPLETION>a + b;' }] : [{ type: 'content', text: '```\ndef total(width, height):\n    a = width * height\n    print(a)\n    return a * 2\n\n```\n' }]),
    });
    const r = await run(f, { settings: selected });
    expect(stepIds(r)).toEqual(['reach', 'model', 'completion', 'thinking', 'context', 'nextEdit']);
    expect(r.res.steps[5]).toMatchObject({ state: 'ok', text: 'Next Edit in 0 ms with Qwen3.8-Flash-Next (chat prompt (chatXtab)): suggests an edit' });
  });

  test('the step runs after a completion-step warning, but not after a reach failure', async () => {
    const warned = await run(fake({ ...noNative, info: { models: ['a', 'b'], contextWindows: {} }, config: { kind: 'llamacpp', use: { completions: true, nextEdit: true } } }), { settings: selected });
    expect(warned.res.steps.map((s) => [s.id, s.state])).toEqual([['reach', 'ok'], ['model', 'warn'], ['nextEdit', 'warn']]);
    expect(warned.res.steps[2].text).toBe('the server lists 2 models; choose a Next Edit model');
    const zetaOnCompletions = await run(fake({ ...noNative, chunks: [zetaRewrite], config: { kind: 'llamacpp', fimModel: 'zeta-2.1', use: { completions: true, nextEdit: true } } }), { settings: selected });
    expect(zetaOnCompletions.res.steps.map((s) => [s.id, s.state])).toEqual([['reach', 'ok'], ['model', 'warn'], ['nextEdit', 'ok']]);
    const down = await run(fake({ info: new HttpError(500, '', 'u'), config: { use: { completions: true, nextEdit: true } } }));
    expect(stepIds(down)).toEqual(['reach']);
    const local = await run(fake({ config: { use: { completions: false, nextEdit: true } } }), { localOnly: true, isLocal: async () => false });
    expect(stepIds(local)).toEqual(['reach']);
  });

  test('no Next Edit use, no Next Edit step', async () => {
    const r = await run(fake());
    expect(stepIds(r)).not.toContain('nextEdit');
  });

  describe('a backend with no `use` (both uses)', () => {
    // An old settings entry: it goes through the real parser, so `use` is both uses.
    const entry = (extra: Record<string, unknown> = {}): BackendConfig => parseBackendEntry({ id: 'b', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8080', ...extra }, 0, new Set(), []) as BackendConfig;
    test('has no Next Edit step unless it is the selected Next Edit backend or names a Next Edit model', async () => {
      expect(entry().use).toEqual({ completions: true, nextEdit: true });
      const plain = fake({ config: entry() });
      expect(stepIds(await run(plain))).toEqual(['reach', 'model', 'completion']);
      expect(plain.chatRequests).toHaveLength(0);
      const other = await run(fake({ config: entry() }), { settings: { ...SETTINGS, nextEdit: { ...SETTINGS.nextEdit, backendId: 'elsewhere' } } });
      expect(stepIds(other)).not.toContain('nextEdit');
      const named = await run(fake({ ...noNative, config: { ...entry({ nextEditModel: 'zeta-2.1' }) }, chunks: [zetaRewrite] }));
      expect(stepIds(named)).toContain('nextEdit');
    });

    test('runs the Next Edit step when it is the selected Next Edit backend', async () => {
      const r = await run(fake({ ...noNative, config: entry(), chunks: ['x'], caps: { chat: true }, chatEvents: [{ type: 'content', text: 'x' }] }), { settings: selected });
      expect(stepIds(r)).toContain('nextEdit');
    });

    test('the selected Next Edit backend with Next Edit turned off tests as completions only', async () => {
      const off = { ...selected, nextEdit: { ...selected.nextEdit, enabled: false } };
      expect(stepIds(await run(fake({ config: entry() }), { settings: off }))).toEqual(['reach', 'model', 'completion']);
    });

    test('a Next Edit-only backend always runs the step', async () => {
      const r = await run(fake({ ...noNative, config: { ...entry(), use: { completions: false, nextEdit: true } }, chunks: [zetaRewrite], info: { models: ['zeta-2.1'], contextWindows: {} } }));
      expect(stepIds(r)).toEqual(['reach', 'nextEdit']);
    });
  });

  test('a lone listed model is the Next Edit model when none is set', async () => {
    const f = fake({ ...noNative, info: { models: ['sweep-next-edit-1.5b'], contextWindows: {} }, config: { kind: 'llamacpp', use: { completions: false, nextEdit: true } }, chunks: ['x'] });
    const r = await run(f);
    expect(r.res.steps[1].text).toContain('sweep-next-edit-1.5b (Sweep v1 format)');
    expect(f.requests[0].model).toBe('sweep-next-edit-1.5b');
  });

  test('noChange is a warning, an unreadable answer a failure naming why, a truncated answer a warning', async () => {
    const same = await run(fake({ ...noNative, config: ZETA, chunks: ['<|marker_1|><|marker_1|>'] }));
    expect(same.res.steps[1]).toMatchObject({ id: 'nextEdit', state: 'warn', text: 'Next Edit in 0 ms with zeta-2.1 (Zeta 2.1 format): answered, no edit suggested' });
    const bad = await run(fake({ ...noNative, config: ZETA, chunks: ['<|marker_9|>x'] }));
    expect(bad.res.steps[1]).toMatchObject({ id: 'nextEdit', state: 'fail', text: 'the answer could not be read (it lacked the expected markers)' });
    const cut = await run(fake({ ...noNative, config: ZETA, chunks: ['<|marker_1|>def'], onStream: (r) => r.onTruncated?.() }));
    expect(cut.res.steps[1]).toMatchObject({ id: 'nextEdit', state: 'warn' });
    expect(cut.res.steps[1].text).toMatch(/cut at max tokens/);
  });

  test('a chat answer cut before its closing fence is a warning too', async () => {
    const f = fake({
      ...noNative, caps: { template: true, chat: true }, config: { kind: 'openai', nextEditModel: 'qwen3-coder', use: { completions: false, nextEdit: true } },
      chatEvents: [{ type: 'content', text: '```\ndef total(width, height):\n    a = width' }, { type: 'finish', reason: 'length' }],
    });
    const r = await run(f);
    expect(r.res.steps[1]).toMatchObject({ id: 'nextEdit', state: 'warn' });
    expect(r.res.steps[1].text).toMatch(/cut at max tokens/);
  });

  test('a Next Edit-only backend listing one model records it; an explicit Next Edit model or the Completions model is left alone', async () => {
    const only = await run(fake({ ...noNative, info: { models: ['sweep-next-edit-1.5b'], contextWindows: {} }, config: { kind: 'llamacpp', use: { completions: false, nextEdit: true } }, chunks: ['x'] }));
    expect(only.res.model).toBe('sweep-next-edit-1.5b');
    const explicit = await run(fake({ ...noNative, config: ZETA, chunks: ['x'] }));
    expect(explicit.res.model).toBeUndefined();
    const both = await run(fake({ ...noNative, info: { models: ['qwen3-coder'], contextWindows: {} }, config: { kind: 'openai', nextEditModel: 'zeta-2.1', use: { completions: true, nextEdit: true } }, chunks: ['x'] }));
    expect(both.res.model).toBe('qwen3-coder');
  });

  test('a format whose route is missing is a warning and sends nothing', async () => {
    const sweep = { kind: 'llamacpp' as const, nextEditModel: 'sweep-v2-7b', use: { completions: false, nextEdit: true } };
    const f = fake({ ...noNative, caps: { template: false, chat: true }, config: sweep });
    const r = await run(f);
    expect(r.res.steps[1]).toMatchObject({ id: 'nextEdit', state: 'warn', text: 'sweep-v2-7b: the Sweep v2 format needs a raw completions route; this server has none' });
    expect(f.streamFim).not.toHaveBeenCalled();
    expect(f.streamChat).not.toHaveBeenCalled();
    const chat = fake({ ...noNative, caps: { template: true, chat: false }, config: { kind: 'llamacpp', nextEditModel: 'qwen3-coder', use: { completions: false, nextEdit: true } } });
    const c = await run(chat);
    expect(c.res.steps[1]).toMatchObject({ state: 'warn', text: 'qwen3-coder: the chat prompt (chatXtab) needs a chat completions route; this server has none' });
    expect(chat.streamChat).not.toHaveBeenCalled();
  });

  test('a chat Next Edit model that thinks fails the step', async () => {
    const f = fake({ ...noNative, caps: { template: true, chat: true }, config: { kind: 'openai', nextEditModel: 'qwen3-coder', use: { completions: false, nextEdit: true } }, chatEvents: [{ type: 'reasoning', text: 'Let me think' }] });
    const r = await run(f);
    expect(r.res.steps[1]).toMatchObject({ id: 'nextEdit', state: 'fail' });
    expect(r.res.steps[1].text).toMatch(/keeps thinking/);
    expect(r.res.steps[1].hint).toBeTruthy();
  });

  test('a request error fails the step with the fixed text, never the server body', async () => {
    const mk = () => ({ ...nullLog, debug: vi.fn() });
    const off = mk();
    const r = await run(fake({ ...noNative, config: ZETA, chunks: new HttpError(500, 'SECRET-BODY', 'u') }), { log: off });
    expect(r.res.steps[1]).toMatchObject({ id: 'nextEdit', state: 'fail', text: 'HTTP 500' });
    expect(JSON.stringify(off.debug.mock.calls)).toContain('connection test nextEdit: fail in 0 ms: HTTP 500');
    expect(JSON.stringify(off.debug.mock.calls)).not.toContain('SECRET');
    const odd = await run(fake({ ...noNative, config: ZETA, chunks: new StreamError('SECRET memory guard') }), { log: off });
    expect(odd.res.steps[1]).toMatchObject({ state: 'fail', text: 'the server returned an error' });
    expect(JSON.stringify(off.debug.mock.calls)).not.toContain('SECRET');
  });

  test('the answer is logged only with debug.logPrompts, and never in a step text', async () => {
    const mk = () => ({ ...nullLog, debug: vi.fn() });
    const off = mk();
    const a = await run(fake({ ...noNative, config: ZETA, chunks: [zetaRewrite] }), { log: off });
    expect(JSON.stringify(off.debug.mock.calls)).not.toContain('print(a)');
    expect(JSON.stringify(a.res.steps)).not.toContain('print(a)');
    const on = mk();
    const b = await run(fake({ ...noNative, config: ZETA, chunks: [zetaRewrite] }), { log: on, settings: { ...SETTINGS, debug: { logPrompts: true } } });
    expect(JSON.stringify(on.debug.mock.calls)).toContain('print(a)');
    expect(JSON.stringify(b.res.steps)).not.toContain('print(a)');
  });

  test('the sample is sendable in every format', () => {
    for (const f of [pickFormat('chatXtab', 'm'), pickFormat('sweep', 'sweep-1.5b'), pickFormat('sweep', 'sweep-v2-7b'), pickFormat('zeta21', 'zeta')]) {
      const input = nextEditSample(f, SETTINGS);
      expect(f.problem(input)).toBeUndefined();
      expect(input.lines.length).toBeLessThan(30);
      const region = input.lines.slice(input.region.start, input.region.end + 1).join('\n');
      expect(region).toContain('a = ');
      expect(region.match(/area/g)).toHaveLength(2);
    }
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

    test('a model that keeps thinking fails the thinking step and the probe suggests a switch', async () => {
      const f = fake({ config: chatCfg, caps, chatFor: (r) => (r.thinking.reasoning_effort === 'none' ? ev('<COMPLETION>a + b;') : [{ type: 'reasoning', text: 'hmm' }, ...ev('<COMPLETION>a + b;')]) });
      const { res } = await run(f);
      expect(res.steps.map((s) => s.id)).toEqual(['reach', 'model', 'thinking']);
      expect(res.steps[2]).toEqual({
        id: 'thinking', state: 'fail', ms: 0, text: `Qwen3.8-Flash-Next keeps thinking with the "${THINKING_LABELS['templateKwarg:enable_thinking']}" switch`,
        hint: `choose "${THINKING_LABELS.reasoningEffortNone}" as the Thinking switch`,
      });
      // the first request is the real one; the probe tries the other switches in order and stops at the first success
      expect(f.chatRequests.map((r) => r.thinking)).toEqual([
        { chat_template_kwargs: { enable_thinking: false } }, { chat_template_kwargs: { thinking: false } }, { chat_template_kwargs: { thinking_mode: 'disabled' } },
        { chat_template_kwargs: { thinking_budget: 0 } }, { reasoning_effort: 'none' },
      ]);
      expect(f.chatRequests[0]!.timeoutMs).toBe(TEST_TIMEOUT_MS);
      expect(f.chatRequests.slice(1).every((r) => r.timeoutMs === PROBE_TIMEOUT_MS)).toBe(true);
    });

    test('the probe reports when no switch works', async () => {
      const f = fake({ config: chatCfg, caps, chatEvents: [{ type: 'reasoning', text: 'hmm' }, ...ev('<COMPLETION>a + b;')] });
      const { res } = await run(f);
      expect(res.steps[2]).toMatchObject({ id: 'thinking', state: 'fail', hint: 'no thinking switch turned it off; choose another model' });
      expect(f.chatRequests).toHaveLength(1 + 6); // the real request, then every probed switch but the current one
      expect(res.steps.some((s) => s.id === 'completion')).toBe(false);
    });

    test('OpenRouter probes only the switch that sends a different request', async () => {
      const config = { kind: 'openai' as const, hostFlavor: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api/v1', fimModel: 'google/gemini-2.5-pro' };
      const f = fake({ config, caps: { native: false, template: false }, info: { models: ['google/gemini-2.5-pro'], contextWindows: {} }, chatEvents: [{ type: 'reasoning', text: 'hmm' }, ...ev('<COMPLETION>a;')] });
      const { res } = await run(f);
      expect(res.steps.find((s) => s.id === 'thinking')).toMatchObject({ state: 'fail' });
      expect(res.steps.find((s) => s.id === 'thinking')!.hint).toBe('no thinking switch turned it off; choose another model');
      expectOnlySoftSwitchProbed(f);
    });

    /** The flavor decides the body, so the only distinct switch is the /no_think system suffix: the real request plus that one. */
    const expectOnlySoftSwitchProbed = (f: ReturnType<typeof fake>): void => {
      expect(f.chatRequests).toHaveLength(2);
      expect(f.chatRequests[1]!.thinking).toEqual(f.chatRequests[0]!.thinking);
      expect(f.chatRequests[0]!.messages.some((m) => m.content.includes('/no_think'))).toBe(false);
      expect(f.chatRequests[1]!.messages.some((m) => m.content.includes('/no_think'))).toBe(true);
    };

    test.each([['strata', 'http://127.0.0.1:8080/v1'], ['deepseek', 'https://api.deepseek.com/v1'], ['ollama', 'http://127.0.0.1:11434/v1']] as const)(
      '%s probes only the switch that sends a different request', async (hostFlavor, baseUrl) => {
        const f = fake({ config: { ...chatCfg, hostFlavor, baseUrl }, caps, chatEvents: [{ type: 'reasoning', text: 'hmm' }, ...ev('<COMPLETION>a;')] });
        const { res } = await run(f);
        expect(res.steps[2]).toMatchObject({ id: 'thinking', state: 'fail', hint: 'no thinking switch turned it off; choose another model' });
        expectOnlySoftSwitchProbed(f);
      });

    test('the thinking step times the real request, not the probe', async () => {
      const clock = { t: 0 };
      const f = fake({ config: chatCfg, caps, clock, streamCost: 100, chatEvents: [{ type: 'reasoning', text: 'hmm' }, ...ev('<COMPLETION>a;')] });
      const { res } = await run(f, { now: () => clock.t });
      expect(res.steps[2]!.ms).toBe(100);
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

    test('a cannotDisable model fails at the model step', async () => {
      const f = fake({ config: { ...chatCfg, fimModel: 'gpt-oss-20b' }, caps, chatEvents: ev('<COMPLETION>a + b;') });
      const { res } = await run(f);
      expect(res.steps.map((s) => [s.id, s.state])).toEqual([['reach', 'ok'], ['model', 'fail']]);
      expect(res.steps[1]).toMatchObject({ text: 'Model gpt-oss-20b cannot turn thinking off', hint: 'autocomplete needs a model that answers without thinking; choose another model' });
      expect(f.streamChat).not.toHaveBeenCalled();
    });

    test('an OpenRouter model that rejects effort "none" and then reasons cannot turn thinking off, with no probe', async () => {
      // A real OpenRouter backend: the server rejects `reasoning`, the retry without it streams reasoning.
      const m = await startMockHttp(({ url, body }) => {
        if (url.endsWith('/models')) return { json: { data: [{ id: 'google/gemini-2.5-pro', reasoning: { mandatory: false } }] } };
        if (body && 'reasoning' in body) return { status: 400, json: { error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.' } } };
        return { sse: ['{"choices":[{"delta":{"reasoning":"Let me think."}}]}', '{"choices":[{"delta":{"content":"<COMPLETION>a + b;"},"finish_reason":"stop"}]}', '[DONE]'] };
      });
      try {
        const config: BackendConfig = { id: 'or', kind: 'openai', hostFlavor: 'openrouter', baseUrl: `${m.url}/api/v1`, fimMode: 'auto', headers: {}, use: { completions: true, nextEdit: false }, fimModel: 'google/gemini-2.5-pro' };
        const backend = new OpenRouterBackend(config, async () => 'k');
        const res = await runConnectionTest({ backend, settings: SETTINGS, localOnly: false, isLocal: async () => true, signal: new AbortController().signal, log: nullLog, now: () => 0 }, () => {});
        expect(res.steps.map((s) => [s.id, s.state])).toEqual([['reach', 'ok'], ['model', 'ok'], ['thinking', 'fail']]);
        expect(res.steps[2]).toEqual({
          id: 'thinking', state: 'fail', ms: 0, text: 'Model google/gemini-2.5-pro cannot turn thinking off',
          hint: 'autocomplete needs a model that answers without thinking; choose another model',
        });
        // the rejected request and its retry; no probe, since every switch sends the same `reasoning` field on OpenRouter
        const chats = m.requests.filter((r) => r.url.endsWith('/chat/completions'));
        expect(chats.map((r) => 'reasoning' in r.body)).toEqual([true, false]);
      } finally {
        await m.close();
      }
    });

    test('a mandatory-reasoning OpenRouter model fails at the model step', async () => {
      const config = { kind: 'openai' as const, hostFlavor: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api/v1', fimModel: 'z-ai/glm-5' };
      const f = fake({ config, caps: { native: false, template: false }, info: { models: ['z-ai/glm-5'], contextWindows: {}, thinkingMandatory: ['z-ai/glm-5'] }, chatEvents: ev('<COMPLETION>a;') });
      const { res } = await run(f);
      expect(res.steps.map((s) => [s.id, s.state, s.text])).toEqual([['reach', 'ok', 'Server answered in 0 ms (1 models)'], ['model', 'fail', 'Model z-ai/glm-5 cannot turn thinking off']]);
      expect(f.streamChat).not.toHaveBeenCalled();
    });

    test('the slow warning compares against the one 5 s deadline', async () => {
      const clock = { t: 0 };
      const f = fake({ config: chatCfg, caps, clock, streamCost: 3000, chatEvents: ev('<COMPLETION>a + b;') });
      expect((await run(f, { now: () => clock.t })).res.steps[2]).toMatchObject({ state: 'ok' });
      const slow = fake({ config: chatCfg, caps, clock, streamCost: 6000, chatEvents: ev('<COMPLETION>a + b;') });
      expect((await run(slow, { now: () => clock.t })).res.steps[2]).toMatchObject({ state: 'warn' });
    });

    test('the context step counts the chat request\'s own max tokens', async () => {
      const info = { models: [chatCfg.fimModel], contextWindows: { [chatCfg.fimModel]: 4750 } };
      const f = fake({ config: chatCfg, caps, info, chatEvents: ev('<COMPLETION>a + b;') });
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
