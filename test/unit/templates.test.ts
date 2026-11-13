import { describe, expect, test } from 'vitest';
import { TEMPLATES, type TemplateInput } from '../../src/models/templates';
import type { FimTemplateId } from '../../src/types';

const input: TemplateInput = { prefix: 'P', suffix: 'S', filePath: 'a.ts', repoName: 'r', extra: [] };
const withExtra: TemplateInput = { ...input, extra: [{ path: 'b.ts', text: 'B' }] };

const table: Array<[FimTemplateId, string, string[], boolean]> = [
  ['qwen', '<|fim_prefix|>P<|fim_suffix|>S<|fim_middle|>',
    ['<|endoftext|>', '<|fim_prefix|>', '<|fim_middle|>', '<|fim_suffix|>', '<|fim_pad|>', '<|repo_name|>', '<|file_sep|>', '<|im_start|>', '<|im_end|>'], false],
  ['codestral', '[SUFFIX]S[PREFIX]P', ['[PREFIX]', '[SUFFIX]', '</s>', '\n+++++ '], true],
  ['deepseek', '<｜fim▁begin｜>P<｜fim▁hole｜>S<｜fim▁end｜>',
    ['<｜fim▁begin｜>', '<｜fim▁hole｜>', '<｜fim▁end｜>', '<｜end▁of▁sentence｜>'], false],
  ['starcoder', '<fim_prefix>P<fim_suffix>S<fim_middle>',
    ['<fim_prefix>', '<fim_suffix>', '<fim_middle>', '<file_sep>', '<|endoftext|>'], false],
  ['codellama', '<PRE> P <SUF>S <MID>', ['<PRE>', '<SUF>', '<MID>', '<EOT>'], false],
  ['codegemma', '<|fim_prefix|>P<|fim_suffix|>S<|fim_middle|>',
    ['<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<|file_separator|>', '<end_of_turn>', '<eos>'], false],
  ['granite-code', '<fim_prefix>P<fim_suffix>S<fim_middle>',
    ['<|endoftext|>', '<fim_prefix>', '<fim_suffix>', '<fim_middle>'], false],
  ['granite4', '<|fim_prefix|>P<|fim_suffix|>S<|fim_middle|>',
    ['<|end_of_text|>', '<|fim_prefix|>', '<|fim_middle|>', '<|fim_suffix|>', '<|fim_pad|>'], false],
  ['seed-coder', '<[fim-suffix]>S<[fim-prefix]>P<[fim-middle]>',
    ['<[end▁of▁sentence]>', '<[fim-suffix]>', '<[fim-prefix]>', '<[fim-middle]>', '<[PAD▁TOKEN]>', '<[SEP▁TOKEN]>', '<[begin▁of▁sentence]>'], true],
  ['mellum', '<fim_suffix>S<fim_prefix>P<fim_middle>',
    ['<|endoftext|>', '<filename>', '<fim_prefix>', '<fim_suffix>', '<fim_middle>', '<fim_pad>'], true],
];

describe('templates', () => {
  test.each(table)('%s render/stop/suffixFirst', (id, rendered, stop, suffixFirst) => {
    const t = TEMPLATES[id];
    expect(t.id).toBe(id);
    expect(t.render(input)).toBe(rendered);
    expect(t.stop).toEqual(stop);
    expect(t.suffixFirst).toBe(suffixFirst);
  });

  test('qwen repo-level context', () => {
    expect(TEMPLATES.qwen.render(withExtra)).toBe(
      '<|repo_name|>r\n<|file_sep|>b.ts\nB\n<|file_sep|>a.ts\n<|fim_prefix|>P<|fim_suffix|>S<|fim_middle|>');
  });

  test('codestral repo-level context', () => {
    expect(TEMPLATES.codestral.render(withExtra)).toBe('[SUFFIX]S[PREFIX]+++++ b.ts\nB\n\n+++++ a.ts\nP');
  });

  test('mellum repo-level context follows the model card', () => {
    expect(TEMPLATES.mellum.render(withExtra)).toBe(
      '<filename>b.ts\nB\n<filename>a.ts\n<fim_suffix>S<fim_prefix>P<fim_middle>');
  });

  test('other templates ignore extra', () => {
    for (const id of ['deepseek', 'starcoder', 'codellama', 'codegemma', 'granite-code', 'granite4', 'seed-coder'] as const) {
      expect(TEMPLATES[id].render(withExtra)).toBe(TEMPLATES[id].render(input));
    }
  });
});
