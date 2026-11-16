import { describe, expect, it } from 'vitest';
import { formatIdFor, nextEditFormatLabel, nextEditOnlyModel, pickFormat, sweepVariant } from '../../../src/nextEdit/formats';
import { tooLong, type NextEditInput } from '../../../src/nextEdit/formats/format';
import { nextEditBudgets } from '../../../src/nextEdit/region';
import { nextEditSample } from '../../../src/manage/nextEditSample';
import { parseSettings } from '../../../src/config/settings';

describe('nextEditOnlyModel', () => {
  it('names Zeta models only; Sweep models can do completions too', () => {
    expect(nextEditOnlyModel('randmaru/zeta-2.1-mlx')).toBe('Zeta 2.1');
    expect(nextEditOnlyModel('sweep-next-edit-v2-7b')).toBeUndefined();
    expect(nextEditOnlyModel('sweep-next-edit-1.5b')).toBeUndefined();
    expect(nextEditOnlyModel('qwen2.5-coder-3b')).toBeUndefined();
    expect(nextEditOnlyModel(undefined)).toBeUndefined();
  });
});

describe('pickFormat', () => {
  it('auto picks chatXtab for other or unknown models', () => {
    expect(pickFormat('auto', 'qwen3.8-flash-next-iq3_s').id).toBe('chatXtab');
    expect(pickFormat('auto', undefined).id).toBe('chatXtab');
  });

  it('auto picks sweep for Sweep model ids, and an explicit sweep wins over the model', () => {
    expect(pickFormat('auto', 'sweep-next-edit-1.5b').id).toBe('sweep');
    expect(pickFormat('sweep', 'x').id).toBe('sweep');
  });

  it('auto picks zeta21 for Zeta model ids, and an explicit zeta21 wins over the model', () => {
    expect(pickFormat('auto', 'randmaru/zeta-2.1-mlx').id).toBe('zeta21');
    expect(pickFormat('zeta21', 'x').id).toBe('zeta21');
  });

  it('an explicit setting wins over the model id', () => {
    expect(pickFormat('chatXtab', 'zeta-2.1').id).toBe('chatXtab');
  });

  it('chatXtab runs on the chat route', () => {
    expect(pickFormat('chatXtab', undefined).transport).toBe('chat');
  });
});

describe('formatIdFor (Ruling 1)', () => {
  it('auto detects Zeta and Sweep model ids', () => {
    expect(formatIdFor('auto', 'randmaru/zeta-2.1-mlx')).toBe('zeta21');
    expect(formatIdFor('auto', 'sweep-next-edit-1.5b')).toBe('sweep');
    expect(formatIdFor('auto', 'qwen3.8-flash-next-iq3_s')).toBe('chatXtab');
    expect(formatIdFor('auto', undefined)).toBe('chatXtab');
  });

  it('an explicit setting is taken as given', () => {
    expect(formatIdFor('chatXtab', 'zeta-2.1')).toBe('chatXtab');
    expect(formatIdFor('sweep', 'qwen')).toBe('sweep');
    expect(formatIdFor('zeta21', undefined)).toBe('zeta21');
  });

  it('Sweep v2 for ids with v2 or 7b, else v1', () => {
    expect(sweepVariant('sweep-next-edit-1.5b')).toBe('v1');
    expect(sweepVariant('sweep-next-edit-v2-7B')).toBe('v2');
    expect(sweepVariant('sweep-7b')).toBe('v2');
    expect(sweepVariant(undefined)).toBe('v1');
  });
});

describe('tooLong', () => {
  const input = (lines: string[]): NextEditInput => ({
    path: 'a.ts',
    lines,
    cursor: { line: 0, character: 0 },
    region: { start: 0, end: lines.length - 1 },
    history: [],
    snippets: [],
    budgets: nextEditBudgets(1000),
  });

  it('is true when the region text is longer than twice the file budget', () => {
    const max = 2 * nextEditBudgets(1000).fileChars;
    expect(tooLong(input(['x'.repeat(max)]))).toBe(false);
    expect(tooLong(input(['x'.repeat(max + 1)]))).toBe(true);
    expect(tooLong(input(['x'.repeat(max / 2), 'x'.repeat(max / 2)]))).toBe(true);
  });
});

describe('nextEditFormatLabel', () => {
  it('names the format a setting and model id pick', () => {
    expect(nextEditFormatLabel('auto', 'zeta-2.1')).toBe('Zeta 2.1 format');
    expect(nextEditFormatLabel('auto', 'sweep-next-edit-1.5b')).toBe('Sweep v1 format');
    expect(nextEditFormatLabel('auto', 'sweep-next-edit-v2-7b')).toBe('Sweep v2 format');
    expect(nextEditFormatLabel('auto', 'qwen3.8')).toBe('chat prompt (chatXtab)');
    expect(nextEditFormatLabel('auto', undefined)).toBe('chat prompt (chatXtab)');
    expect(nextEditFormatLabel('sweep', 'qwen3.8')).toBe('Sweep v1 format');
    expect(nextEditFormatLabel('zeta21', 'qwen3.8')).toBe('Zeta 2.1 format');
    expect(nextEditFormatLabel('chatXtab', 'zeta-2.1')).toBe('chat prompt (chatXtab)');
  });
});

describe('raw-format stops', () => {
  it('contain no whitespace: LM Studio is sent only such stops, and raw Next Edit formats rely on the server to stop', () => {
    const settings = parseSettings({ inspect: () => undefined }).settings;
    for (const model of ['sweep-next-edit-1.5b', 'sweep-next-edit-v2-7b', 'zeta-2.1']) {
      const format = pickFormat('auto', model);
      if (format.transport !== 'completion') continue;
      const { stop } = format.prompt(nextEditSample(format, settings));
      expect(stop.length, model).toBeGreaterThan(0);
      for (const s of stop) expect(/\s/.test(s), `${model}: ${JSON.stringify(s)}`).toBe(false);
    }
  });
});
