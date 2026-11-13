import { describe, expect, test } from 'vitest';
import { contextCaps, resolveFim } from '../../src/completion/effective';
import { parseSettings, type RawSettingsSource, type Settings } from '../../src/config/settings';
import { TEMPLATES } from '../../src/models/templates';
import type { BackendConfig, BackendFimSettings, ModelOverrideBody } from '../../src/types';

const none: RawSettingsSource = { inspect: () => undefined };
const settings = (patch: { overrides?: Record<string, ModelOverrideBody>; extraContext?: boolean } = {}): Settings => {
  const s = parseSettings(none).settings;
  return { ...s, modelOverrides: patch.overrides ?? {}, fim: { ...s.fim, ...(patch.extraContext !== undefined ? { extraContext: patch.extraContext } : {}) } };
};
const backend = (fim?: BackendFimSettings): BackendConfig => ({ id: 'b', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012', fimMode: 'auto', headers: {}, ...(fim ? { fim } : {}) });
const QWEN = 'qwen2.5-coder-1.5b';

describe('resolveFim', () => {
  test('defaults for a qwen coder model', () => {
    const r = resolveFim(backend(), QWEN, settings());
    expect(r.values).toMatchObject({
      fimTemplate: 'qwen', sampling: { temperature: 0.1, topP: 0.95, topK: 40 }, maxTokens: 128, prefixLines: 200, suffixLines: 60,
      contextTokens: 4700, timeoutMs: 5000, debounceMs: null, extraContext: true, multiline: 'auto', extraBody: {},
    });
    expect(r.sources).toMatchObject({ template: 'preset', temperature: 'preset', maxTokens: 'settings', prefixLines: 'settings', contextTokens: 'builtin', timeoutMs: 'builtin', stop: 'preset', extraBody: 'preset', extraContext: 'settings' });
    expect(r.extraContextAllowed).toBe(true);
  });

  test('backend beats model override beats preset', () => {
    const s = settings({ overrides: { qwen: { sampling: { temperature: 0.3 } } } });
    const o = resolveFim(backend(), QWEN, s);
    expect(o.values.sampling.temperature).toBe(0.3);
    expect(o.sources.temperature).toBe('modelOverride');
    const b = resolveFim(backend({ temperature: 0.05 }), QWEN, s);
    expect(b.values.sampling.temperature).toBe(0.05);
    expect(b.sources.temperature).toBe('backend');
    expect(b.sources.topK).toBe('preset');
  });

  test('backend maxTokens replaces fim.maxTokens and the override', () => {
    const s = settings({ overrides: { qwen: { sampling: { maxTokens: 64 } } } });
    expect(resolveFim(backend(), QWEN, s).values.maxTokens).toBe(64);
    expect(resolveFim(backend(), QWEN, s).sources.maxTokens).toBe('modelOverride');
    const r = resolveFim(backend({ maxTokens: 200 }), QWEN, s);
    expect(r.values.maxTokens).toBe(200);
    expect(r.sources.maxTokens).toBe('backend');
  });

  test('backend template switches suffixFirst and stops', () => {
    const model = 'randmaru/zeta-2.1-mlx';
    const plain = resolveFim(backend(), model, settings());
    expect(plain.values.fimTemplate).toBeUndefined();
    expect(plain.values.presetId).toBe('generic');
    const r = resolveFim(backend({ template: 'seed-coder' }), model, settings());
    expect(r.values.fimTemplate).toBe('seed-coder');
    expect(r.values.suffixFirst).toBe(true);
    expect(r.values.stop[0]).toBe('\n\n\n');
    expect(r.values.stop).toEqual(expect.arrayContaining(TEMPLATES['seed-coder'].stop));
    expect(r.sources.template).toBe('backend');
  });

  test('stop merge order and dedupe', () => {
    const s = settings({ overrides: { qwen: { stop: ['O', 'B'] } } });
    const r = resolveFim(backend({ stop: ['B', 'X'] }), QWEN, s);
    expect(r.values.stop).toEqual(['\n\n\n', ...TEMPLATES.qwen.stop, 'O', 'B', 'X'].filter((v, i, a) => a.indexOf(v) === i));
    expect(r.sources.stop).toBe('backend');
    expect(resolveFim(backend(), QWEN, s).sources.stop).toBe('modelOverride');
  });

  test('extraBody merges override then backend', () => {
    const s = settings({ overrides: { qwen: { extraBody: { a: 1, b: 1 } } } });
    const r = resolveFim(backend({ extraBody: { b: 2 } }), QWEN, s);
    expect(r.values.extraBody).toEqual({ a: 1, b: 2 });
    expect(r.sources.extraBody).toBe('backend');
  });

  test('extraContext is restrict-only', () => {
    const a = resolveFim(backend({ extraContext: true }), QWEN, settings({ extraContext: false }));
    expect(a.values.extraContext).toBe(false);
    expect(a.extraContextAllowed).toBe(false);
    const b = resolveFim(backend({ extraContext: false }), QWEN, settings({ extraContext: true }));
    expect(b.values.extraContext).toBe(false);
    expect(b.extraContextAllowed).toBe(true);
    expect(b.sources.extraContext).toBe('backend');
  });

  test('backend values for window, timing and multiline', () => {
    const r = resolveFim(backend({ contextTokens: 2000, prefixLines: 5, suffixLines: 6, debounceMs: 0, timeoutMs: 9000, multiline: 'never' }), QWEN, settings());
    expect(r.values).toMatchObject({ contextTokens: 2000, prefixLines: 5, suffixLines: 6, debounceMs: 0, timeoutMs: 9000, multiline: 'never' });
    expect(r.sources).toMatchObject({ contextTokens: 'backend', prefixLines: 'backend', suffixLines: 'backend', debounceMs: 'backend', timeoutMs: 'backend', multiline: 'backend' });
  });
});

test('contextCaps(4700)', () => expect(contextCaps(4700)).toEqual({ maxPrefixChars: 8225, maxSuffixChars: 2468, extraChars: 5758 }));
