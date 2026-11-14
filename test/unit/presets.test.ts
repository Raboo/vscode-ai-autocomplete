import { expect, test } from 'vitest';
import { resolvePreset } from '../../src/models/presets';
import { TEMPLATES } from '../../src/models/templates';

test.each([
  ['qwen2.5-coder-7b-instruct-q8_0', 'qwen-coder', 'qwen'], ['Qwen3-Coder-30B-A3B', 'qwen-coder', 'qwen'],
  ['codestral-latest', 'codestral', 'codestral'], ['deepseek-coder-v2-lite-base', 'deepseek-coder', 'deepseek'],
  ['starcoder2-7b', 'starcoder', 'starcoder'], ['codellama-7b', 'codellama', 'codellama'], ['codegemma-2b', 'codegemma', 'codegemma'],
  ['granite-8b-code-base', 'granite-code', 'granite-code'], ['granite-4.1-3b', 'granite4', 'granite4'],
  ['Seed-Coder-8B-Base', 'seed-coder', 'seed-coder'], ['Mellum-4b-base', 'mellum', 'mellum'],
])('%s → %s', (model, id, tpl) => { const p = resolvePreset(model, {}); expect(p.id).toBe(id); expect(p.fimTemplate).toBe(tpl); });
test('general Qwen gets no FIM template', () => {
  const p = resolvePreset('Qwen3.8-Flash-Next', {});
  expect(p.fimTemplate).toBeUndefined();
  expect(p.id).toBe('generic');
  expect(p.suffixFirst).toBe(false);
  expect(p.stop).toEqual(['\n\n\n']);
});
test('codestral sampling omits topP', () => expect(resolvePreset('codestral-latest', {}).sampling).toEqual({ temperature: 0.2, maxTokens: 128 }));
test('coder default sampling', () => expect(resolvePreset('qwen2.5-coder-3b', {}).sampling).toEqual({ temperature: 0.1, topP: 0.95, topK: 40, maxTokens: 128 }));
test('stop = triple newline first (hosted APIs keep only the first 4), then template stops; suffixFirst from template', () => {
  const p = resolvePreset('codestral-latest', {});
  expect(p.stop).toEqual(['\n\n\n', ...TEMPLATES.codestral.stop]);
  expect(p.suffixFirst).toBe(true);
});
test('overrides merge in order; stops are appended uniquely', () => {
  const p = resolvePreset('qwen2.5-coder', { 'qwen': { sampling: { temperature: 0 } }, 'coder': { stop: ['\n\n\n', '<|endoftext|>'], extraBody: { min_p: 0.05 } } });
  expect(p.sampling.temperature).toBe(0); expect(p.stop.filter(s => s === '<|endoftext|>')).toHaveLength(1);
  expect(p.stop.filter(s => s === '\n\n\n')).toHaveLength(1);
  expect(p.stop[0]).toBe('\n\n\n'); expect(p.extraBody).toEqual({ min_p: 0.05 });
});
test('override can set a template on an unknown model', () => {
  const p = resolvePreset('my-ft', { '^my-ft$': { fimTemplate: 'qwen' } });
  expect(p.fimTemplate).toBe('qwen');
  expect(p.stop).toEqual(['\n\n\n', ...TEMPLATES.qwen.stop]);
});
test('override template replaces template stops and suffixFirst', () => {
  const p = resolvePreset('qwen2.5-coder', { coder: { fimTemplate: 'codestral', stop: ['X'] } });
  expect(p.stop).toEqual(['\n\n\n', ...TEMPLATES.codestral.stop, 'X']);
  expect(p.suffixFirst).toBe(true);
});
test('overridden lists the keys matching overrides set', () => {
  expect(resolvePreset('qwen2.5-coder', {}).overridden).toEqual({ fimTemplate: false, sampling: [], stop: false, extraBody: false });
  expect(resolvePreset('qwen2.5-coder', { coder: { sampling: { temperature: 0, maxTokens: 64 } } }).overridden.sampling).toEqual(['temperature', 'maxTokens']);
  expect(resolvePreset('starcoder2-7b', { qwen: { sampling: { maxTokens: 64 } } }).overridden.sampling).toEqual([]);
  expect(resolvePreset('qwen2.5-coder', { coder: { fimTemplate: 'mellum', stop: ['X'], extraBody: { a: 1 } } }).overridden).toEqual({ fimTemplate: true, sampling: [], stop: true, extraBody: true });
});
test('forceTemplate beats preset and override templates and keeps override stops', () => {
  const p = resolvePreset('qwen2.5-coder', { coder: { fimTemplate: 'mellum', stop: ['X'] } }, 'seed-coder');
  expect(p.fimTemplate).toBe('seed-coder');
  expect(p.suffixFirst).toBe(true);
  expect(p.stop).toEqual(['\n\n\n', ...TEMPLATES['seed-coder'].stop, 'X']);
});
test('matching is case-insensitive', () => expect(resolvePreset('MY-FT', { 'my-ft': { fimTemplate: 'mellum' } }).fimTemplate).toBe('mellum'));
test('invalid override regex is skipped', () => expect(() => resolvePreset('x', { '(': {} })).not.toThrow());
test('results are copies', () => {
  const a = resolvePreset('qwen2.5-coder', {});
  a.stop.push('Z'); a.sampling.temperature = 9; a.extraBody.k = 1;
  const b = resolvePreset('qwen2.5-coder', {});
  expect(b.stop).not.toContain('Z'); expect(b.sampling.temperature).toBe(0.1); expect(b.extraBody).toEqual({});
  expect(TEMPLATES.qwen.stop).not.toContain('Z');
});
