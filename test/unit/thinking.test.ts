import { describe, expect, test } from 'vitest';
import { HOST_FLAVORS, THINKING_STRATEGIES } from '../../src/config/settings';
import { ReasoningFilter, stripThinking, thinkingFields, type ThinkingFields } from '../../src/models/thinking';
import fixture from './fixtures/thinking-fields.json';

const golden = fixture as Record<string, Record<string, ThinkingFields>>;

const PAIRS: [string, string][] = [
  ['<think>', '</think>'], ['<seed:think>', '</seed:think>'], ['<mm:think>', '</mm:think>'], ['<|channel>thought', '<channel|>'],
  ['[THINK]', '[/THINK]'], ['<|open|>think<|sep|>', '<|close|>think<|sep|>'], ['<|channel|>analysis<|message|>', '<|end|>'],
];

describe('thinkingFields', () => {
  test('matches the golden file for every flavor × strategy', () => {
    expect(new Set(Object.keys(golden))).toEqual(new Set(HOST_FLAVORS));
    for (const flavor of HOST_FLAVORS) {
      expect(new Set(Object.keys(golden[flavor]))).toEqual(new Set(THINKING_STRATEGIES));
      for (const strategy of THINKING_STRATEGIES) expect(thinkingFields(strategy, flavor), `${flavor} / ${strategy}`).toEqual(golden[flavor][strategy]);
    }
  });
});

describe('stripThinking', () => {
  test.each(PAIRS)('paired tags %s are removed and flagged', (open, close) => {
    expect(stripThinking(`${open}Let me see.${close}a + b;`)).toEqual({ text: 'a + b;', thinking: true });
  });
  test('empty blocks are not thinking', () => {
    expect(stripThinking('<think>\n\n</think>\n\na + b;')).toEqual({ text: 'a + b;', thinking: false });
    expect(stripThinking('<|channel>thought\n<channel|>a + b;')).toEqual({ text: 'a + b;', thinking: false });
  });
  test('a bare closing tag drops everything before it', () => {
    expect(stripThinking('I should add them.</think>a + b;')).toEqual({ text: 'a + b;', thinking: true });
    expect(stripThinking('x</think>y</think>z').text).toBe('z');
  });
  test('unclosed reasoning at length is discarded', () => {
    expect(stripThinking('a<think>more', 'length').text).toBe('');
    expect(stripThinking('a<think>more', 'stop').text).toBe('a');
  });
  test('answer markers are removed', () => {
    expect(stripThinking('<|open|>think<|sep|>hm<|close|>think<|sep|><|open|>response<|sep|>a + b;<|close|>response<|sep|>').text).toBe('a + b;');
    expect(stripThinking('<|start|>assistant<|channel|>final<|message|>a + b;<|return|>').text).toBe('a + b;');
  });
  test('plain text passes through', () => {
    expect(stripThinking('a + b;')).toEqual({ text: 'a + b;', thinking: false });
    expect(stripThinking('if (a < b) {}')).toEqual({ text: 'if (a < b) {}', thinking: false });
  });
});

describe('ReasoningFilter', () => {
  test('tags split across pushes', () => {
    const f = new ReasoningFilter();
    f.push('<thi');
    expect(f.visible).toBe('');
    f.push('nk>x</th');
    expect(f.visible).toBe('');
    f.push('ink>a + b;');
    f.end();
    expect(f.visible).toBe('a + b;');
    expect(f.thinking).toBe(true);
  });
  test('a partial tag is released at end', () => {
    const f = new ReasoningFilter();
    f.push('a <');
    expect(f.visible).toBe('a ');
    f.end();
    expect(f.visible).toBe('a <');
  });
  test('visible shrinks on a bare closing tag', () => {
    const f = new ReasoningFilter();
    f.push('I think');
    expect(f.visible).toBe('I think');
    f.push('</think>a');
    expect(f.visible).toBe('a');
  });
  test('reasoning deltas count only when not blank', () => {
    const f = new ReasoningFilter();
    f.push('a');
    f.reasoning('  ');
    expect(f.thinking).toBe(false);
    f.reasoning('hm');
    expect(f.thinking).toBe(true);
    expect(f.visible).toBe('a');
  });
});
