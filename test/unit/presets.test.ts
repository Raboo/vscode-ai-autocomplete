import { expect, test } from 'vitest';
import { CHAT_SAMPLING, resolvePreset } from '../../src/models/presets';
import { TEMPLATES } from '../../src/models/templates';

test.each([
  ['qwen2.5-coder-7b-instruct-q8_0', 'qwen-coder', 'qwen'], ['Qwen3-Coder-30B-A3B', 'qwen-coder', 'qwen'],
  ['codestral-latest', 'codestral', 'codestral'], ['deepseek-coder-v2-lite-base', 'deepseek-coder', 'deepseek'],
  ['starcoder2-7b', 'starcoder', 'starcoder'], ['codellama-7b', 'codellama', 'codellama'], ['codegemma-2b', 'codegemma', 'codegemma'],
  ['granite-8b-code-base', 'granite-code', 'granite-code'], ['granite-4.1-3b', 'granite4', 'granite4'],
  ['Seed-Coder-8B-Base', 'seed-coder', 'seed-coder'], ['Mellum-4b-base', 'mellum', 'mellum'],
])('%s → %s', (model, id, tpl) => { const p = resolvePreset(model, {}); expect(p.id).toBe(id); expect(p.fimTemplate).toBe(tpl); });
test.each([
  ['Qwen3.8-Flash-Next', 'qwen3', 'templateKwarg:enable_thinking', true], ['qwen3.8-flash-next-iq3_s', 'qwen3', 'templateKwarg:enable_thinking', true],
  ['Qwen3-30B-A3B-Thinking-2507', 'qwen3-thinking', 'cannotDisable', true], ['Qwen3-30B-A3B-Instruct-2507', 'qwen3-instruct-2507', 'none', true],
  ['Qwen3.8-2.4T-A95B', 'qwen3.8-2.4t', 'cannotDisable', true], ['Qwen3-Coder-30B-A3B-Instruct', 'qwen-coder', 'none', false],
  ['DeepSeek-R1-0528-Qwen3-8B', 'deepseek-r1', 'cannotDisable', true], ['deepseek-flash', 'deepseek-v4', 'templateKwarg:enable_thinking', true],
  ['DeepSeek-V3.1-Terminus', 'deepseek-v3', 'templateKwarg:thinking', true], ['GLM-5.3-Flash', 'glm-5.3', 'cannotDisable', true],
  ['glm-4.6', 'glm', 'templateKwarg:enable_thinking', true], ['moonshotai/kimi-k3', 'kimi-thinking', 'cannotDisable', true],
  ['Kimi-K2.6', 'kimi-k2.5', 'templateKwarg:thinking', true], ['Kimi-K2-Instruct-0905', 'kimi', 'none', true],
  ['MiniMax-M3', 'minimax-m3', 'templateKwarg:thinking_mode=disabled', true], ['MiniMax-M3.1-Flash', 'minimax-m3.1', 'cannotDisable', true],
  ['MiniMax-M2.5', 'minimax', 'cannotDisable', true], ['gemma-4-31B-it', 'gemma4', 'templateKwarg:enable_thinking', true],
  ['gemma-3-27b-it', 'gemma', 'none', true], ['granite-3.3-8b-instruct', 'granite3.3', 'templateKwarg:thinking', true],
  ['granite-4.2-8b', 'granite4-thinking', 'templateKwarg:enable_thinking', false], ['granite-4.1-3b', 'granite4', 'none', false],
  ['NVIDIA-Nemotron-Nano-9B-v2', 'nemotron-nano-v2', 'systemSoftSwitch:/no_think', true],
  ['NVIDIA-Nemotron-3-Nano-30B-A3B-BF16', 'nemotron', 'templateKwarg:enable_thinking', true], ['gpt-oss-20b', 'gpt-oss', 'cannotDisable', true],
  ['Mistral-Large-4-1T-A52B', 'mistral-large-4', 'cannotDisable', true], ['Mistral-Small-4-119B-2603', 'mistral-reasoning', 'reasoningEffortNone', true],
  ['Devstral-Small-2-24B-Instruct-2512', 'mistral', 'none', true], ['Seed-OSS-36B-Instruct', 'seed-oss', 'templateKwarg:thinking_budget=0', true],
  ['codestral-latest', 'codestral', 'none', false], ['my-model', 'generic', 'templateKwarg:enable_thinking', false],
])('%s → %s, %s, chat %s', (model, id, thinking, chat) => {
  const p = resolvePreset(model, {});
  expect(p.id).toBe(id); expect(p.thinking).toBe(thinking); expect(p.chat).toBe(chat);
});
test('chat families use CHAT_SAMPLING and no template; kimi and minimax omit sampling', () => {
  const q = resolvePreset('Qwen3.8-Flash-Next', {});
  expect(q.sampling).toEqual(CHAT_SAMPLING); expect(CHAT_SAMPLING).toEqual({ temperature: 0.2, topP: 0.8, topK: 20, maxTokens: 128 });
  expect(q.fimTemplate).toBeUndefined(); expect(q.samplingParams).toBe('send');
  for (const m of ['kimi-k3', 'Kimi-K2.6', 'Kimi-K2-Instruct', 'MiniMax-M3', 'MiniMax-M3.1', 'MiniMax-M2.5']) expect(resolvePreset(m, {}).samplingParams, m).toBe('omit');
  expect(resolvePreset('qwen2.5-coder', {}).samplingParams).toBe('send');
  const g = resolvePreset('granite-4.2-8b', {});
  expect(g.fimTemplate).toBe('granite4'); expect(g.sampling.temperature).toBe(0.1);
});
test('an override thinking applies and is marked overridden', () => {
  const p = resolvePreset('Qwen3.8-Flash-Next', { qwen: { thinking: 'cannotDisable' } });
  expect(p.thinking).toBe('cannotDisable'); expect(p.overridden.thinking).toBe(true);
});
test('a later override template keeps an earlier override stop', () => {
  const p = resolvePreset('qwen2.5-coder', { coder: { stop: ['X'] }, 'qwen2.5': { fimTemplate: 'codestral' } });
  expect(p.stop[p.stop.length - 1]).toBe('X');
});
test('general Qwen gets no FIM template', () => {
  const p = resolvePreset('Qwen3.8-Flash-Next', {});
  expect(p.fimTemplate).toBeUndefined();
  expect(p.id).toBe('qwen3');
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
  expect(resolvePreset('qwen2.5-coder', {}).overridden).toEqual({ fimTemplate: false, sampling: [], stop: false, extraBody: false, thinking: false });
  expect(resolvePreset('qwen2.5-coder', { coder: { sampling: { temperature: 0, maxTokens: 64 } } }).overridden.sampling).toEqual(['temperature', 'maxTokens']);
  expect(resolvePreset('starcoder2-7b', { qwen: { sampling: { maxTokens: 64 } } }).overridden.sampling).toEqual([]);
  expect(resolvePreset('qwen2.5-coder', { coder: { fimTemplate: 'mellum', stop: ['X'], extraBody: { a: 1 } } }).overridden).toEqual({ fimTemplate: true, sampling: [], stop: true, extraBody: true, thinking: false });
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
