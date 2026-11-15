import { describe, expect, test } from 'vitest';
import { buildChatRequest, buildFimRequest, chatStops, chatThinking, EFFORT_NONE_REJECTED, explainUnsupported, noRouteText, planInsertion, planRoute, thinkingBlocked, whyNoRoute, type ChatRequestPlan, type FimRoute } from '../../src/completion/route';
import { usableRoutes } from '../../src/models/capabilities';
import type { RouteCaps } from '../../src/backends/types';
import type { HoleFillerInput } from '../../src/completion/holeFiller';
import { resolveFim, type FimValues } from '../../src/completion/effective';
import { parseSettings } from '../../src/config/settings';
import { TEMPLATES, type TemplateInput } from '../../src/models/templates';
import type { BackendConfig, BackendFimSettings, FimTemplateId, HostFlavor } from '../../src/types';

const SETTINGS = parseSettings({ inspect: () => undefined }).settings;
/** Resolved values for a backend whose template is forced (undefined = generic model without a FIM template). */
const V = (t?: FimTemplateId, fim: BackendFimSettings = {}): FimValues =>
  resolveFim({ id: 'b', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:1', fimMode: 'auto', headers: {}, fim: { ...(t ? { template: t } : {}), ...fim } }, 'unknown-model', SETTINGS).values;
const P = V;

const LLAMA: RouteCaps = { native: true, template: true, chat: true, nativeChatModels: false };
const LMSTUDIO: RouteCaps = { native: false, template: true, chat: true, nativeChatModels: false };
const OLLAMA: RouteCaps = { native: true, template: true, chat: true, nativeChatModels: false };
const DEEPSEEK: RouteCaps = { native: true, template: true, chat: true, nativeChatModels: true };
const STRATA: RouteCaps = { native: false, template: false, chat: true, nativeChatModels: false };
const MISTRAL: RouteCaps = { native: true, template: false, chat: false, nativeChatModels: false };
const CHAT = { suffixFirst: false, chat: true };
const PC = (t?: FimTemplateId, chat = false): { fimTemplate?: FimTemplateId; suffixFirst: boolean; chat: boolean } => {
  const v = P(t);
  return { ...(v.fimTemplate ? { fimTemplate: v.fimTemplate } : {}), suffixFirst: v.suffixFirst, chat };
};

describe('planRoute', () => {
  test('auto: chat families go to chat, except DeepSeek native FIM', () => {
    for (const caps of [LLAMA, LMSTUDIO, OLLAMA, STRATA]) expect(planRoute('openai', caps, CHAT, 'auto')).toBe('chat');
    expect(planRoute('openai', DEEPSEEK, CHAT, 'auto')).toBe('native');
  });
  test('auto: coder models keep native/template; unknown models chat only where completions are missing', () => {
    expect(planRoute('llamacpp', LLAMA, PC('qwen'), 'auto')).toBe('native');
    expect(planRoute('openai', LMSTUDIO, PC('qwen'), 'auto')).toBe('template');
    expect(planRoute('openai', STRATA, PC(), 'auto')).toBe('chat');
    expect(planRoute('openai', LMSTUDIO, PC(), 'auto')).toBe('unsupported');
    expect(planRoute('llamacpp', LLAMA, PC(), 'auto')).toBe('native');
    expect(planRoute('llamacpp', LLAMA, PC('mellum'), 'auto')).toBe('template');
  });
  test('llamacpp auto: every suffix-first template goes through /completion; generic models use /infill', () => {
    expect(planRoute('llamacpp', LLAMA, PC('codestral'), 'auto')).toBe('template');
    expect(planRoute('llamacpp', LLAMA, PC('seed-coder'), 'auto')).toBe('template');
    expect(planRoute('llamacpp', LLAMA, PC('deepseek'), 'auto')).toBe('native');
  });
  test('openai auto → native when supported (suffix-first does not matter), else template', () => {
    expect(planRoute('openai', OLLAMA, PC('mellum'), 'auto')).toBe('native');
    expect(planRoute('openai', LMSTUDIO, PC('mellum'), 'auto')).toBe('template');
  });
  test('mistral auto → native', () => {
    expect(planRoute('mistral', MISTRAL, PC('codestral'), 'auto')).toBe('native');
    expect(planRoute('mistral', MISTRAL, PC(), 'auto')).toBe('native');
  });
  test('mistral auto: a Mistral chat family has no route (Mistral\'s FIM endpoint serves Codestral only)', () => {
    const devstral = resolveFim({ id: 'cs', kind: 'mistral', baseUrl: 'https://codestral.mistral.ai', fimMode: 'auto', headers: {} }, 'devstral-small-2507', SETTINGS).values;
    expect(devstral.chat).toBe(true);
    expect(planRoute('mistral', MISTRAL, devstral, 'auto')).toBe('unsupported');
  });
  test('explicit modes', () => {
    expect(planRoute('llamacpp', LLAMA, PC('mellum'), 'native')).toBe('native');
    expect(planRoute('openai', LMSTUDIO, PC('qwen'), 'native')).toBe('unsupported');
    expect(planRoute('llamacpp', LLAMA, PC('qwen'), 'template')).toBe('template');
    expect(planRoute('mistral', MISTRAL, PC('codestral'), 'template')).toBe('unsupported');
    expect(planRoute('openai', STRATA, PC('qwen'), 'template')).toBe('unsupported');
    expect(planRoute('openai', LLAMA, PC(), 'template')).toBe('unsupported');
    expect(planRoute('openai', LMSTUDIO, PC(), 'chat')).toBe('chat');
    expect(planRoute('mistral', MISTRAL, PC(), 'chat')).toBe('unsupported');
  });
  test('a learned missing route is skipped', () => {
    const caps = usableRoutes(LLAMA, new Set<FimRoute>(['native']));
    expect(caps.native).toBe(false);
    expect(planRoute('llamacpp', caps, PC(), 'auto')).toBe('unsupported');
  });
  test('a route is learned only when another route remains', () => {
    expect(planRoute('llamacpp', usableRoutes(LLAMA, new Set<FimRoute>(['native'])), PC('qwen'), 'auto')).toBe('template');
    expect(planRoute('mistral', usableRoutes(MISTRAL, new Set<FimRoute>(['native'])), PC('codestral'), 'auto')).toBe('unsupported');
  });
});

describe('planInsertion', () => {
  test('planInsertion converts to CRLF', () => expect(planInsertion('a\nb', '\r\n')).toBe('a\r\nb'));
  test('keeps LF for LF documents and never doubles CR', () => {
    expect(planInsertion('a\nb\n', '\n')).toBe('a\nb\n');
    expect(planInsertion('a\r\nb', '\r\n')).toBe('a\r\nb');
    expect(planInsertion('a\r\nb', '\n')).toBe('a\nb');
    expect(planInsertion('ab', '\r\n')).toBe('ab');
  });
});

describe('buildFimRequest', () => {
  const input: TemplateInput = {
    prefix: 'function add(a, b) {\n  ',
    suffix: '\n}',
    filePath: 'src/math.ts',
    repoName: 'demo',
    extra: [{ path: 'src/util.ts', text: 'export const x = 1;' }],
  };
  const signal = new AbortController().signal;

  test('native payload, full preset stops and fixed timings', () => {
    const fim = V('qwen', { extraBody: { min_p: 0.05 } });
    const req = buildFimRequest({ route: 'native', fim, model: 'qwen2.5-coder-3b', multiline: true, input, signal });
    expect(req.payload).toEqual({ route: 'native', ...input });
    expect(req.model).toBe('qwen2.5-coder-3b');
    expect(req.stop).toEqual(fim.stop);
    expect(req.sampling).toEqual({ temperature: 0.1, topP: 0.95, topK: 40, maxTokens: 128 });
    expect(req.extraBody).toEqual({ min_p: 0.05 });
    expect(req.timeMaxPredictMs).toBe(500);
    expect(req.timeoutMs).toBe(5000);
    expect(req.signal).toBe(signal);
  });

  test('template payload renders the preset template', () => {
    const req = buildFimRequest({ route: 'template', fim: P('mellum'), model: 'Mellum-4b-base', multiline: true, input, signal });
    expect(req.payload).toEqual({ route: 'template', prompt: TEMPLATES.mellum.render(input) });
  });

  test('template route without a template is a programming error', () => {
    expect(() => buildFimRequest({ route: 'template', fim: P(), model: undefined, multiline: true, input, signal })).toThrow();
  });

  test('buildFimRequest uses the resolved timeout and the single-line cap', () => {
    const run = (multiline: boolean) => buildFimRequest({ route: 'native', fim: V('qwen', { timeoutMs: 9000, maxTokens: 200 }), model: undefined, multiline, input, signal });
    expect(run(false).timeoutMs).toBe(9000);
    expect(run(false).sampling.maxTokens).toBe(48);
    expect(run(true).sampling.maxTokens).toBe(200);
    expect(buildFimRequest({ route: 'native', fim: V('qwen', { maxTokens: 30 }), model: undefined, multiline: false, input, signal }).sampling.maxTokens).toBe(30);
  });

  test('an unknown model is left out of the request', () => {
    const req = buildFimRequest({ route: 'native', fim: P(), model: undefined, multiline: true, input, signal });
    expect('model' in req).toBe(false);
  });
});

describe('explainUnsupported', () => {
  test('a model that could not be detected is reported as such, with an error status', () => {
    expect(explainUnsupported('vllm', undefined, 'auto', 'template', false)).toEqual({
      onceKey: 'detect:vllm',
      log: 'backend "vllm": could not detect its model (server unreachable or several models listed); set fimModel',
      status: 'vllm: model not detected',
    });
  });
  test('names the chat mode only when the server can chat', () => {
    const action = { command: 'aiAutocomplete.manageBackends', args: [{ focus: 'strata' }] };
    expect(explainUnsupported('strata', 'Qwen3.8-Flash', 'auto', 'template', false)).toEqual({
      onceKey: 'route:strata:Qwen3.8-Flash',
      log: 'model "Qwen3.8-Flash" has no FIM template (not a known code-completion model): pick a coder model, or choose a template for it in AI Autocomplete: Manage Backends',
      status: 'strata: no completion template',
      action,
    });
    expect(explainUnsupported('strata', 'Qwen3.8-Flash', 'auto', 'template', true)).toEqual({
      onceKey: 'route:strata:Qwen3.8-Flash',
      log: 'model "Qwen3.8-Flash" has no FIM template (not a known code-completion model): pick a coder model, choose a template for it, or set the prompt mode to chat in AI Autocomplete: Manage Backends',
      status: 'strata: no completion template',
      action,
    });
  });
  test('on Mistral a model with no template is told to choose a Codestral model, not a template', () => {
    const action = { command: 'aiAutocomplete.manageBackends', args: [{ focus: 'mistral' }] };
    expect(explainUnsupported('mistral', 'devstral-small', 'auto', 'template', false, 'mistral')).toEqual({
      onceKey: 'route:mistral:devstral-small',
      log: 'model "devstral-small" cannot complete through Mistral\'s FIM endpoint: choose a Codestral model in AI Autocomplete: Manage Backends',
      status: 'mistral: choose a Codestral model',
      action,
    });
    expect(explainUnsupported('mistral', 'devstral-small', 'native', 'mode', false, 'mistral').status).toBe('mistral: prompt mode "native" does not work with this server');
  });
  test('a prompt mode the server cannot use names the mode, not the template', () => {
    const action = { command: 'aiAutocomplete.manageBackends', args: [{ focus: 'lm' }] };
    expect(explainUnsupported('lm', 'qwen2.5-coder-7b', 'native', 'mode', false)).toEqual({
      onceKey: 'route:lm:qwen2.5-coder-7b',
      log: 'backend "lm": prompt mode (fimMode) "native" does not work with this server: set it to auto in AI Autocomplete: Manage Backends',
      status: 'lm: prompt mode "native" does not work with this server',
      action,
    });
    expect(explainUnsupported('lm', 'codestral-latest', 'chat', 'mode', false)).toMatchObject({ status: 'lm: prompt mode "chat" does not work with this server', action });
  });
});

describe('whyNoRoute', () => {
  test('a mode whose route the server lacks is a prompt-mode problem', () => {
    expect(whyNoRoute(LMSTUDIO, 'native')).toBe('mode');
    expect(whyNoRoute(MISTRAL, 'template')).toBe('mode');
    expect(whyNoRoute(MISTRAL, 'chat')).toBe('mode');
  });
  test('anything else is a template problem', () => {
    expect(whyNoRoute(LMSTUDIO, 'auto')).toBe('template');
    expect(whyNoRoute(LLAMA, 'template')).toBe('template');
    expect(whyNoRoute(LLAMA, 'chat')).toBe('template');
  });
  test('noRouteText: the short text the page and the test show', () => {
    expect(noRouteText('mode', 'chat')).toBe('prompt mode "chat" does not work with this server');
    expect(noRouteText('template', 'auto')).toBe('no completion template');
  });
});

describe('buildChatRequest', () => {
  const signal = new AbortController().signal;
  const input = { prefix: 'a', suffix: 'b', extra: [], languageId: 'typescript', multiline: false } as unknown as HoleFillerInput;
  const plan = (id: string, over: Partial<ChatRequestPlan> = {}, flavor: HostFlavor = 'strata', backend: Partial<BackendConfig> = {}): ChatRequestPlan => ({
    fim: resolveFim({ id: 'b', kind: 'openai', baseUrl: 'http://127.0.0.1:1', fimMode: 'auto', headers: {}, ...backend }, id, SETTINGS).values,
    flavor, model: id, input, rejected: new Set(), signal, ...over,
  });
  test('buildChatRequest pins only on strata', () => {
    const long = { ...input, prefix: 'a\nb\nc\nd\ne\nf\ng\nh', suffix: '' } as HoleFillerInput;
    const strata = buildChatRequest(plan('Qwen3.8-Flash', { input: long }));
    const pin = strata.extraBody.strata_prefix as { message: number; chars: number };
    expect(pin.message).toBe(1);
    expect(pin.chars).toBeGreaterThan(0);
    expect(pin.chars).toBeLessThan(strata.messages[1]!.content.length);
    expect(buildChatRequest(plan('Qwen3.8-Flash', { input: long, rejected: new Set(['strata_prefix']) })).extraBody).not.toHaveProperty('strata_prefix');
    expect(buildChatRequest(plan('Qwen3.8-Flash')).extraBody).not.toHaveProperty('strata_prefix');
    for (const flavor of ['llamacpp', 'openrouter', 'generic'] as HostFlavor[]) {
      expect(buildChatRequest(plan('Qwen3.8-Flash', { input: long }, flavor)).extraBody).not.toHaveProperty('strata_prefix');
    }
  });
  test('Qwen3.8 on Strata', () => {
    const r = buildChatRequest(plan('Qwen3.8-Flash'));
    expect(r.maxTokens).toBe(80);
    expect(r.stop).toEqual(['</COMPLETION>']);
    expect(r.thinking).toEqual({ reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } });
    expect(r.sampling).toEqual({ temperature: 0.2, topP: 0.8, topK: 20, presencePenalty: 0 });
    expect(r.timeoutMs).toBe(5000);
    expect(r.model).toBe('Qwen3.8-Flash');
    expect(r.messages[0]!.role).toBe('system');
    expect(buildChatRequest(plan('Qwen3.8-Flash', { input: { ...input, multiline: true } })).maxTokens).toBe(160);
  });
  test('cannotDisable budget, omitted sampling, rejected fields, soft switch, backend stops', () => {
    const multi = { ...input, multiline: true };
    const g = buildChatRequest(plan('gpt-oss-20b', { input: multi }, 'llamacpp'));
    expect(g.maxTokens).toBe(160);
    expect(g.thinking).toEqual({ reasoning_effort: 'low' });
    expect(buildChatRequest(plan('kimi-k2')).sampling).toEqual({});
    const r = buildChatRequest(plan('Qwen3.8-Flash', { rejected: new Set(['chat_template_kwargs', 'top_k']) }));
    expect(r.thinking).toEqual({ reasoning_effort: 'none' });
    expect(r.sampling).toEqual({ temperature: 0.2, topP: 0.8, presencePenalty: 0 });
    expect(buildChatRequest(plan('nemotron-nano-v2')).messages[0]!.content.endsWith('/no_think')).toBe(true);
    expect(buildChatRequest(plan('Qwen3.8-Flash', {}, 'strata', { fim: { stop: ['X', '</COMPLETION>'] } })).stop).toEqual(['</COMPLETION>', 'X']);
    expect(chatStops({ backendStop: ['X'] })).toEqual(['</COMPLETION>', 'X']);
  });
  test('chat requests use the FIM deadline and no allowance', () => {
    expect(buildChatRequest(plan('Qwen3.8-Flash')).timeoutMs).toBe(5000);
    expect(buildChatRequest(plan('gpt-oss-20b', {}, 'llamacpp')).timeoutMs).toBe(5000);
    expect(buildChatRequest(plan('gpt-oss-20b', {}, 'llamacpp', { fim: { timeoutMs: 2000 } })).timeoutMs).toBe(2000);
    expect(buildChatRequest(plan('gpt-oss-20b', {}, 'llamacpp')).maxTokens).toBe(80);
    expect(buildChatRequest(plan('Qwen3.8-Flash')).maxTokens).toBe(80);
  });
  test('onRejected is passed through', () => {
    const onRejected = (): void => undefined;
    expect(buildChatRequest(plan('Qwen3.8-Flash', { onRejected })).onRejected).toBe(onRejected);
  });

  describe('OpenRouter model that must reason', () => {
    // google/gemini-2.5-pro falls to the generic preset, which can turn thinking off
    const gemini = (over: Partial<ChatRequestPlan> = {}) => buildChatRequest(plan('google/gemini-2.5-pro', over, 'openrouter'));
    test('a rejected effort "none" is learned under its own key', () => {
      const learned: string[][] = [];
      const r = gemini({ onRejected: (f) => learned.push(f) });
      expect(r.thinking).toEqual({ reasoning: { effort: 'none' } });
      r.onRejected!(['reasoning', 'top_p']);
      expect(learned).toEqual([[EFFORT_NONE_REJECTED, 'top_p']]);
    });
    test('afterwards it sends effort "low" with no allowance and the FIM deadline', () => {
      const r = gemini({ rejected: new Set([EFFORT_NONE_REJECTED]) });
      expect(r.thinking).toEqual({ reasoning: { effort: 'low' } });
      expect(r.maxTokens).toBe(80);
      expect(r.timeoutMs).toBe(5000);
      expect(chatThinking('templateKwarg:enable_thinking', 'openrouter', new Set([EFFORT_NONE_REJECTED]))).toBe('cannotDisable');
      expect(chatThinking('templateKwarg:enable_thinking', 'openrouter', new Set())).toBe('templateKwarg:enable_thinking');
      expect(chatThinking('templateKwarg:enable_thinking', 'strata', new Set([EFFORT_NONE_REJECTED]))).toBe('templateKwarg:enable_thinking');
    });
    test('if "low" is rejected too, reasoning is dropped', () => {
      const learned: string[][] = [];
      const low = gemini({ rejected: new Set([EFFORT_NONE_REJECTED]), onRejected: (f) => learned.push(f) });
      low.onRejected!(['reasoning']);
      expect(learned).toEqual([['reasoning']]);
      const r = gemini({ rejected: new Set([EFFORT_NONE_REJECTED, 'reasoning']) });
      expect(r.thinking).toEqual({});
    });
  });

  describe('thinkingBlocked', () => {
    const none = { rejected: new Set<string>(), failedRoutes: new Set<FimRoute>(), thinks: false };
    test('a cannotDisable strategy blocks', () => {
      expect(thinkingBlocked('cannotDisable', 'strata', none)).toBe('cannotDisable');
    });
    test('OpenRouter after effort "none" was rejected blocks as cannotDisable', () => {
      expect(thinkingBlocked('templateKwarg:enable_thinking', 'openrouter', { ...none, rejected: new Set([EFFORT_NONE_REJECTED]) })).toBe('cannotDisable');
    });
    test('a model learned to keep thinking blocks', () => {
      expect(thinkingBlocked('templateKwarg:enable_thinking', 'strata', { ...none, thinks: true })).toBe('keepsThinking');
    });
    test('otherwise nothing blocks', () => {
      expect(thinkingBlocked('templateKwarg:enable_thinking', 'strata', none)).toBeUndefined();
      expect(thinkingBlocked('templateKwarg:enable_thinking', 'strata', { ...none, rejected: new Set([EFFORT_NONE_REJECTED]) })).toBeUndefined();
    });
  });
});
