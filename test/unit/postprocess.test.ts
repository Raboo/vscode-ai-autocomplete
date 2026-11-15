import { describe, expect, test } from 'vitest';
import { postprocess, toInsertion, type PostCtx } from '../../src/completion/postprocess';

const ctx = (o: Partial<PostCtx> = {}): PostCtx => ({
  linePrefix: '',
  lineSuffix: '',
  prevLine: '',
  suffix: '',
  chat: false,
  ...o,
});

describe('postprocess', () => {
  test('blank → undefined', () => expect(postprocess('  \n ', ctx())).toBeUndefined());
  test('strips code fences', () => expect(postprocess('```ts\nfoo()\n```', ctx())).toBe('foo()'));
  test('trims trailing whitespace lines, keeps leading indentation', () =>
    expect(postprocess('  x\n\n', ctx())).toBe('  x'));
  test('drops a repeat of the previous line', () =>
    expect(postprocess('const a = 1;', ctx({ prevLine: 'const a = 1;' }))).toBeUndefined());
  test('drops text that just retypes the suffix', () =>
    expect(postprocess('return x;', ctx({ suffix: '\n  return x;\n}' }))).toBeUndefined());
  test('keeps short text that prefixes the suffix (< 4 chars)', () =>
    expect(postprocess('ret', ctx({ suffix: '\n  return x;' }))).toBe('ret'));
  test('drops degenerate repetition (last 30 chars appear ≥3 times)', () => {
    const unit = 'abcdefghij0123456789ABCDEFGHIJ';
    expect(postprocess(`x${unit}${unit}${unit}`, ctx())).toBeUndefined();
    expect(postprocess(`x${unit}${unit}`, ctx())).toBe(`x${unit}${unit}`);
  });
  test('drops a multi-line retype of a CRLF suffix', () =>
    expect(
      postprocess('return x;\r\n}', ctx({ suffix: '\r\n  return x;\r\n}' })),
    ).toBeUndefined());
  test('drops a CRLF repeat of the previous line', () =>
    expect(postprocess('const a = 1;\r\n', ctx({ prevLine: 'const a = 1;\r\n' }))).toBeUndefined());
  test('returns \\n line breaks for CRLF input', () =>
    expect(postprocess('a\r\nb\r\n', ctx())).toBe('a\nb'));
  test('passes normal text through', () => expect(postprocess('foo(a, b)', ctx())).toBe('foo(a, b)'));
});

describe('toInsertion', () => {
  test('replaces rest of line when completion ends with it', () =>
    expect(toInsertion('foo(a, b))', ')')).toEqual({ insertText: 'foo(a, b))', replaceToEndOfLine: true }));
  test('keeps rest of line otherwise', () =>
    expect(toInsertion('foo', ' bar')).toEqual({ insertText: 'foo', replaceToEndOfLine: false }));
  test('closing-chars rest of line', () =>
    expect(toInsertion('x[0])', ');')).toEqual({ insertText: 'x[0])', replaceToEndOfLine: false }));
  test('empty rest of line', () =>
    expect(toInsertion('foo', '')).toEqual({ insertText: 'foo', replaceToEndOfLine: false }));
});

describe('postprocess reasoning', () => {
  test('a leading reasoning block is stripped before the other rules', () => {
    expect(postprocess('<think>x</think>a + b;', ctx())).toBe('a + b;');
    expect(postprocess('<think>x</think>', ctx())).toBeUndefined();
  });
  test('on FIM routes, reasoning tags inside code are code', () => {
    expect(postprocess("const CLOSE = '</think>';", ctx())).toBe("const CLOSE = '</think>';");
    expect(postprocess("text.indexOf('<think>')", ctx())).toBe("text.indexOf('<think>')");
  });
  test('the chat route is already free of reasoning: nothing is stripped', () => {
    expect(postprocess("x = '</think>' + y;", ctx({ chat: true }))).toBe("x = '</think>' + y;");
    expect(postprocess('<think>a</think>b', ctx({ chat: true }))).toBe('<think>a</think>b');
  });
});
