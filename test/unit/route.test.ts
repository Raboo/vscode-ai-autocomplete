import { describe, expect, test } from 'vitest';
import { buildFimRequest, explainUnsupported, planInsertion, planRoute } from '../../src/completion/route';
import type { ResolvedPreset } from '../../src/models/presets';
import { TEMPLATES, type TemplateInput } from '../../src/models/templates';
import type { BackendKind, FimTemplateId } from '../../src/types';

/** A preset built straight from a template id (undefined = generic model without a FIM template). */
const P = (t?: FimTemplateId): ResolvedPreset => ({
  id: t ?? 'generic',
  fimTemplate: t,
  suffixFirst: t ? TEMPLATES[t].suffixFirst : false,
  stop: t ? ['\n\n\n', ...TEMPLATES[t].stop] : ['\n\n\n'],
  sampling: { temperature: 0.1, topP: 0.95, topK: 40, maxTokens: 128 },
  extraBody: {},
});
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
    const preset = { ...P('qwen'), extraBody: { min_p: 0.05 } };
    const req = buildFimRequest({ route: 'native', preset, model: 'qwen2.5-coder-3b', multiline: true, maxTokens: 128, input, signal });
    expect(req.payload).toEqual({ route: 'native', ...input });
    expect(req.model).toBe('qwen2.5-coder-3b');
    expect(req.stop).toEqual(preset.stop);
    expect(req.sampling).toEqual({ temperature: 0.1, topP: 0.95, topK: 40, maxTokens: 128 });
    expect(req.extraBody).toEqual({ min_p: 0.05 });
    expect(req.timeMaxPredictMs).toBe(500);
    expect(req.timeoutMs).toBe(5000);
    expect(req.signal).toBe(signal);
  });

  test('template payload renders the preset template', () => {
    const req = buildFimRequest({ route: 'template', preset: P('mellum'), model: 'Mellum-4b-base', multiline: true, maxTokens: 128, input, signal });
    expect(req.payload).toEqual({ route: 'template', prompt: TEMPLATES.mellum.render(input) });
  });

  test('template route without a template is a programming error', () => {
    expect(() => buildFimRequest({ route: 'template', preset: P(), model: undefined, multiline: true, maxTokens: 128, input, signal })).toThrow();
  });

  test('fim.maxTokens overrides the preset; single-line caps it at 48', () => {
    const tokens = (multiline: boolean, maxTokens: number) =>
      buildFimRequest({ route: 'native', preset: P('qwen'), model: undefined, multiline, maxTokens, input, signal }).sampling.maxTokens;
    expect(tokens(true, 256)).toBe(256);
    expect(tokens(false, 256)).toBe(48);
    expect(tokens(false, 30)).toBe(30);
  });

  test('an unknown model is left out of the request', () => {
    const req = buildFimRequest({ route: 'native', preset: P(), model: undefined, multiline: true, maxTokens: 128, input, signal });
    expect('model' in req).toBe(false);
  });
});

describe('explainUnsupported', () => {
  test('a model that could not be detected is reported as such, with an error status', () => {
    expect(explainUnsupported('vllm', undefined)).toEqual({
      onceKey: 'detect:vllm',
      log: 'backend "vllm": could not detect its model (server unreachable or several models listed); set fimModel',
      status: 'vllm: model not detected',
    });
  });
  test('a detected model without a route keeps the v0.2 message and sets no status', () => {
    expect(explainUnsupported('strata', 'Qwen3.8-Flash')).toEqual({
      onceKey: 'route:strata:Qwen3.8-Flash',
      log: 'model Qwen3.8-Flash has no FIM route; chat FIM arrives in v0.2',
    });
  });
});
