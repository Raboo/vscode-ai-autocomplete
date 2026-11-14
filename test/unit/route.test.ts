import { describe, expect, test } from 'vitest';
import { buildFimRequest, explainUnsupported, noRouteText, planInsertion, planRoute, whyNoRoute } from '../../src/completion/route';
import { resolveFim, type FimValues } from '../../src/completion/effective';
import { parseSettings } from '../../src/config/settings';
import { TEMPLATES, type TemplateInput } from '../../src/models/templates';
import type { BackendFimSettings, BackendKind, FimTemplateId } from '../../src/types';

const SETTINGS = parseSettings({ inspect: () => undefined }).settings;
/** Resolved values for a backend whose template is forced (undefined = generic model without a FIM template). */
const V = (t?: FimTemplateId, fim: BackendFimSettings = {}): FimValues =>
  resolveFim({ id: 'b', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:1', fimMode: 'auto', headers: {}, fim: { ...(t ? { template: t } : {}), ...fim } }, 'unknown-model', SETTINGS).values;
const P = V;
const KINDS: BackendKind[] = ['llamacpp', 'openai', 'mistral'];

describe('planRoute', () => {
  test('llamacpp auto → native /infill for prefix-first models', () => expect(planRoute('llamacpp', true, P('qwen'), 'auto')).toBe('native'));
  test('llamacpp auto → template for suffix-first models', () => expect(planRoute('llamacpp', true, P('mellum'), 'auto')).toBe('template'));
  test('llamacpp auto: every suffix-first template goes through /completion; generic models use /infill', () => {
    expect(planRoute('llamacpp', true, P('codestral'), 'auto')).toBe('template');
    expect(planRoute('llamacpp', true, P('seed-coder'), 'auto')).toBe('template');
    expect(planRoute('llamacpp', true, P('deepseek'), 'auto')).toBe('native');
    expect(planRoute('llamacpp', true, P(), 'auto')).toBe('native');
  });
  test('openai auto → native when supported, else template, else unsupported', () => {
    expect(planRoute('openai', true, P('qwen'), 'auto')).toBe('native');
    // the server applies the model's FIM layout itself, so suffix-first does not matter here
    expect(planRoute('openai', true, P('mellum'), 'auto')).toBe('native');
    expect(planRoute('openai', true, P(), 'auto')).toBe('native');
    expect(planRoute('openai', false, P('qwen'), 'auto')).toBe('template');
    expect(planRoute('openai', false, P('mellum'), 'auto')).toBe('template');
    expect(planRoute('openai', false, P(), 'auto')).toBe('unsupported');
  });
  test('mistral auto → native', () => {
    expect(planRoute('mistral', true, P('codestral'), 'auto')).toBe('native');
    expect(planRoute('mistral', true, P(), 'auto')).toBe('native');
  });
  test('mode native → native when the backend supports it, else unsupported', () => {
    expect(planRoute('llamacpp', true, P('mellum'), 'native')).toBe('native');
    expect(planRoute('openai', true, P(), 'native')).toBe('native');
    expect(planRoute('openai', false, P('qwen'), 'native')).toBe('unsupported');
  });
  test('mode template with a preset template → template (Mistral is native only)', () => {
    expect(planRoute('llamacpp', true, P('qwen'), 'template')).toBe('template');
    expect(planRoute('openai', true, P('qwen'), 'template')).toBe('template');
    expect(planRoute('mistral', true, P('codestral'), 'template')).toBe('unsupported');
  });
  test('mode template without preset template → unsupported', () => {
    for (const kind of KINDS) expect(planRoute(kind, true, P(), 'template')).toBe('unsupported');
  });
  test('mode chat → unsupported in v0.1', () => {
    for (const kind of KINDS) {
      expect(planRoute(kind, true, P('qwen'), 'chat')).toBe('unsupported');
      expect(planRoute(kind, false, P(), 'chat')).toBe('unsupported');
    }
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
    expect(explainUnsupported('vllm', undefined, 'auto', 'template')).toEqual({
      onceKey: 'detect:vllm',
      log: 'backend "vllm": could not detect its model (server unreachable or several models listed); set fimModel',
      status: 'vllm: model not detected',
    });
  });
  test('explainUnsupported: unknown template → reworded log, status and action', () => {
    expect(explainUnsupported('strata', 'Qwen3.8-Flash', 'auto', 'template')).toEqual({
      onceKey: 'route:strata:Qwen3.8-Flash',
      log: 'model "Qwen3.8-Flash" has no FIM template (not a known code-completion model): pick a coder model, or choose a template for it in AI Autocomplete: Manage Backends',
      status: 'strata: no completion template',
      action: { command: 'aiAutocomplete.manageBackends', args: [{ focus: 'strata' }] },
    });
  });
  test('explainUnsupported: chat mode keeps the v0.2 message', () => {
    expect(explainUnsupported('strata', 'Qwen3.8-Flash', 'chat', 'chat')).toEqual({
      onceKey: 'route:strata:Qwen3.8-Flash',
      log: 'backend "strata": fimMode "chat" arrives in v0.2',
    });
  });
  test('explainUnsupported: a prompt mode the server cannot use names the mode, not the template', () => {
    const action = { command: 'aiAutocomplete.manageBackends', args: [{ focus: 'lm' }] };
    expect(explainUnsupported('lm', 'qwen2.5-coder-7b', 'native', 'mode')).toEqual({
      onceKey: 'route:lm:qwen2.5-coder-7b',
      log: 'backend "lm": prompt mode (fimMode) "native" does not work with this server: set it to auto in AI Autocomplete: Manage Backends',
      status: 'lm: prompt mode "native" does not work with this server',
      action,
    });
    expect(explainUnsupported('lm', 'codestral-latest', 'template', 'mode')).toMatchObject({ status: 'lm: prompt mode "template" does not work with this server', action });
  });
});

describe('whyNoRoute', () => {
  test('native mode on a server without native FIM, and template mode on Mistral, are prompt-mode problems', () => {
    expect(whyNoRoute('openai', false, 'native')).toBe('mode');
    expect(whyNoRoute('mistral', true, 'template')).toBe('mode');
  });
  test('chat mode is chat; a missing template in auto or template mode is a template problem', () => {
    for (const kind of KINDS) expect(whyNoRoute(kind, true, 'chat')).toBe('chat');
    expect(whyNoRoute('openai', false, 'auto')).toBe('template');
    expect(whyNoRoute('openai', true, 'template')).toBe('template');
    expect(whyNoRoute('llamacpp', true, 'template')).toBe('template');
  });
  test('noRouteText: the short text the page and the test show', () => {
    expect(noRouteText('chat', 'chat')).toBe('chat FIM arrives in v0.2');
    expect(noRouteText('mode', 'native')).toBe('prompt mode "native" does not work with this server');
    expect(noRouteText('template', 'auto')).toBe('no completion template');
  });
});
