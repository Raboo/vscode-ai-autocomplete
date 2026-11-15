import { describe, expect, test } from 'vitest';
import { COMPLETION_CLOSE, COMPLETION_OPEN, CURSOR_MARKER, HOLE_FILLER_SYSTEM, HoleFillerAnswer, holeFillerMessages, type HoleFillerInput } from '../../src/completion/holeFiller';

const input: HoleFillerInput = {
  prefix: 'function add(a: number, b: number): number {\n  return ',
  suffix: '\n}\n',
  filePath: 'src/math.ts',
  repoName: 'r',
  extra: [{ path: 'src/util.ts', text: 'export const x = 1;' }],
  languageId: 'typescript',
  multiline: true,
};

describe('holeFillerMessages', () => {
  test('the prompt is our own wording', () => {
    expect(HOLE_FILLER_SYSTEM).toContain(CURSOR_MARKER);
    expect(HOLE_FILLER_SYSTEM).toContain(COMPLETION_OPEN);
    expect(COMPLETION_CLOSE).toBe('</COMPLETION>');
    const texts = [HOLE_FILLER_SYSTEM, ...holeFillerMessages({ ...input, extra: [] }).map(m => m.content)];
    for (const t of texts) {
      for (const banned of ['HOLE FILLER', '{{FILL_HERE}}', '<QUERY>', 'TASK:']) expect(t).not.toContain(banned);
    }
  });

  test('messages: system, then user with extra files first and the current file last', () => {
    const m = holeFillerMessages(input);
    expect(m.map(x => x.role)).toEqual(['system', 'user']);
    expect(m[0]!.content).toBe(HOLE_FILLER_SYSTEM);
    expect(m[1]!.content).toBe(
      '<file path="src/util.ts">\nexport const x = 1;\n</file>\n' +
      '<file path="src/math.ts" language="typescript">\n' +
      'function add(a: number, b: number): number {\n  return <|cursor|>\n}\n\n' +
      '</file>\n' +
      'Insert the code that belongs at <|cursor|>.',
    );
  });

  test('single-line asks for the cursor line only', () => {
    const m = holeFillerMessages({ ...input, extra: [], multiline: false });
    expect(m[1]!.content.endsWith('Insert the code that belongs at <|cursor|>, on the cursor line only.')).toBe(true);
    expect(m[1]!.content.startsWith('<file path="src/math.ts"')).toBe(true);
  });

  test('systemSuffix is appended to the system message', () => {
    const m = holeFillerMessages(input, '/no_think');
    expect(m[0]!.content).toBe(`${HOLE_FILLER_SYSTEM}\n/no_think`);
    expect(m[0]!.content.endsWith('\n/no_think')).toBe(true);
  });
});

describe('HoleFillerAnswer', () => {
  test('the answer is the text between the tags', () => {
    expect(new HoleFillerAnswer('').update('<COMPLETION>a + b;</COMPLETION>', true)).toBe('a + b;');
  });

  test('text after the closing tag is ignored', () => {
    expect(new HoleFillerAnswer('').update('<COMPLETION>a</COMPLETION>\nextra', false)).toBe('a');
  });

  test('text before <COMPLETION> never reaches the answer', () => {
    const a = new HoleFillerAnswer('');
    expect(a.update('I think x', false)).toBe('');
    expect(a.update('I think x<COMPLETION>a', false)).toBe('a');
  });

  test('without the wrapper the whole text counts only at the end', () => {
    const a = new HoleFillerAnswer('');
    expect(a.update('a + b;', false)).toBe('');
    expect(a.update('a + b;', true)).toBe('a + b;');
  });

  test('without the opening tag a trailing closing tag is removed at the end', () => {
    expect(new HoleFillerAnswer('').update('a + b;</COMPLETION>', true)).toBe('a + b;');
  });

  test('drops a re-typed line prefix', () => {
    const a = new HoleFillerAnswer('  return ');
    expect(a.update('<COMPLETION>return a + b;', true)).toBe('a + b;');
    expect(a.update('<COMPLETION>ret', false)).toBe('');
    expect(a.update('<COMPLETION>return a', false)).toBe('a');
    expect(a.update('<COMPLETION>a + b;', true)).toBe('a + b;');
    expect(a.update('<COMPLETION>  return a + b;', true)).toBe('a + b;');
    expect(new HoleFillerAnswer('   ').update('<COMPLETION>  x', true)).toBe('  x');
  });

  test('a held prefix is released once the answer ends', () => {
    expect(new HoleFillerAnswer('  return ').update('<COMPLETION>ret</COMPLETION>', false)).toBe('ret');
    expect(new HoleFillerAnswer('  return ').update('<COMPLETION>ret', true)).toBe('ret');
  });

  test('an empty completion is empty', () => {
    expect(new HoleFillerAnswer('x = ').update('<COMPLETION></COMPLETION>', true)).toBe('');
  });
});
