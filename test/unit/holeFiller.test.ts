import { describe, expect, test } from 'vitest';
import { COMPLETION_CLOSE, COMPLETION_OPEN, CURSOR_MARKER, HOLE_FILLER_SYSTEM, HoleFillerAnswer, holeFillerMessages, PIN_BACK_LINES, stableUserChars, type HoleFillerInput } from '../../src/completion/holeFiller';

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

  test('drops re-typed indentation after a whitespace-only line prefix', () => {
    // Observed on Strata (Qwen3.8): the cursor after only indentation, and the model types the indentation again.
    expect(new HoleFillerAnswer('  ').update('<COMPLETION>  return s\n    .toLowerCase()\n    .trim();</COMPLETION>', true))
      .toBe('return s\n    .toLowerCase()\n    .trim();');
    expect(new HoleFillerAnswer('      ').update('<COMPLETION>      ansible.builtin.service:\n        name: nginx\n\n        state: started</COMPLETION>', true))
      .toBe('ansible.builtin.service:\n        name: nginx\n\n        state: started');
    // the line's full indentation re-typed: the rest still lines up
    expect(new HoleFillerAnswer('  ').update('<COMPLETION>    x = 1;', true)).toBe('  x = 1;');
    expect(new HoleFillerAnswer('\t').update('<COMPLETION>\treturn x;', true)).toBe('return x;');
  });

  test('keeps the indentation when a later line is indented less, or the first line does not start with the prefix', () => {
    expect(new HoleFillerAnswer('  ').update('<COMPLETION>  x = 1;\n}', true)).toBe('  x = 1;\n}');
    expect(new HoleFillerAnswer('  ').update('<COMPLETION> x = 1;', true)).toBe(' x = 1;');
    expect(new HoleFillerAnswer('  ').update('<COMPLETION>\tx = 1;', true)).toBe('\tx = 1;');
    expect(new HoleFillerAnswer('').update('<COMPLETION>  x = 1;', true)).toBe('  x = 1;');
  });

  test('while streaming, the indentation drop holds until a later line breaks it', () => {
    const a = new HoleFillerAnswer('  ');
    expect(a.update('<COMPLETION>  ', false)).toBe('');
    expect(a.update('<COMPLETION>  x = 1;', false)).toBe('x = 1;');
    expect(a.update('<COMPLETION>  x = 1;\n ', false)).toBe('x = 1;\n ');
    expect(a.update('<COMPLETION>  x = 1;\n  y', false)).toBe('x = 1;\n  y');
    expect(a.update('<COMPLETION>  x = 1;\n  y\n}', false)).toBe('  x = 1;\n  y\n}');
  });

  test('a held prefix is released once the answer ends', () => {
    expect(new HoleFillerAnswer('  return ').update('<COMPLETION>ret</COMPLETION>', false)).toBe('ret');
    expect(new HoleFillerAnswer('  return ').update('<COMPLETION>ret', true)).toBe('ret');
  });

  test('a partial closing tag is held back while streaming, never shown and retracted', () => {
    const a = new HoleFillerAnswer('');
    expect(a.update('<COMPLETION>a<', false)).toBe('a');
    expect(a.update('<COMPLETION>a</COMPL', false)).toBe('a');
    expect(a.update('<COMPLETION>a</COMPLETION', false)).toBe('a');
    expect(a.update('<COMPLETION>a</COMPLETION>', false)).toBe('a');
    expect(a.update('<COMPLETION>a</COMPL', true)).toBe('a</COMPL');
    expect(a.update('<COMPLETION>a </b', false)).toBe('a </b');
  });

  test('a partial opening tag is never shown', () => {
    const a = new HoleFillerAnswer('');
    for (const v of ['<', '<COMP', '<COMPLETION', 'x <COMPLETIO']) expect(a.update(v, false)).toBe('');
    expect(a.update('<COMPLETION>', false)).toBe('');
    expect(a.update('<COMPLETION>a', false)).toBe('a');
  });

  test('an empty completion is empty', () => {
    expect(new HoleFillerAnswer('x = ').update('<COMPLETION></COMPLETION>', true)).toBe('');
  });
});

describe('stableUserChars', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}\n`).join('');
  test('stops PIN_BACK_LINES above the cursor line', () => {
    const prefix = `${lines(10)}  const x = `;
    const m = holeFillerMessages({ ...input, extra: [], prefix, suffix: ';' });
    const chars = stableUserChars(m);
    const user = m[1]!.content;
    const kept = user.slice(0, chars);
    expect(PIN_BACK_LINES).toBe(4);
    // The kept text ends right after a line break, and the next 4 lines plus the cursor line follow.
    expect(kept.endsWith('line 5\n')).toBe(true);
    expect(user.slice(chars)).toBe(`line 6\nline 7\nline 8\nline 9\n  const x = ${CURSOR_MARKER};\n</file>\n${user.split('\n').pop()}`);
  });
  test('is 0 near the top of the file', () => {
    const m = holeFillerMessages({ ...input, extra: [], prefix: 'one\ntwo\nth', suffix: '' });
    expect(stableUserChars(m)).toBe(0);
    expect(stableUserChars([])).toBe(0);
  });
});
