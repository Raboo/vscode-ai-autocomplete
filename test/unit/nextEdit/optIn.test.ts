import { expect, test } from 'vitest';
import { EXTENSION_ID, argvPath, hasProposedApiOptIn, withProposedApiOptIn } from '../../../src/nextEdit/optIn';

test('argvPath per product', () => {
  expect(argvPath('Visual Studio Code', '/h', {})).toBe('/h/.vscode/argv.json');
  expect(argvPath('Visual Studio Code - Insiders', '/h', {})).toBe('/h/.vscode-insiders/argv.json');
  expect(argvPath('VSCodium', '/h', {})).toBe('/h/.vscode-oss/argv.json');
  expect(argvPath('VSCodium - Insiders', '/h', {})).toBe('/h/.vscodium-insiders/argv.json');
  expect(argvPath('Cursor', '/h', {})).toBeUndefined();
  expect(argvPath('Anything', '/h', { VSCODE_PORTABLE: '/p' })).toBe('/p/argv.json');
});

test('the opt-in keeps comments', () => {
  const out = withProposedApiOptIn('{\n  // keep me\n  "locale": "en"\n}\n', EXTENSION_ID)!;
  expect(out).toContain('// keep me');
  expect(out).toContain('"locale": "en"');
  expect(out).toContain('"enable-proposed-api": [\n    "raboo.ai-autocomplete"\n  ]');
});

test('the opt-in appends to an existing list and leaves an existing entry alone', () => {
  const out = withProposedApiOptIn('{ "enable-proposed-api": ["other.ext"] }', EXTENSION_ID)!;
  expect(out.replace(/\s+/g, '')).toBe('{"enable-proposed-api":["other.ext","raboo.ai-autocomplete"]}');
  expect(withProposedApiOptIn('{ "enable-proposed-api": ["x.y", "raboo.ai-autocomplete"] }', EXTENSION_ID)).toBeUndefined();
});

test('a non-array value is replaced by a list', () => {
  const out = withProposedApiOptIn('{ "enable-proposed-api": "x" }', EXTENSION_ID)!;
  expect(out.replace(/\s+/g, '')).toBe('{"enable-proposed-api":["raboo.ai-autocomplete"]}');
});

test('an empty file gets an object', () => {
  const out = withProposedApiOptIn('', EXTENSION_ID)!;
  expect(JSON.parse(out)).toEqual({ 'enable-proposed-api': ['raboo.ai-autocomplete'] });
});

test('malformed text throws instead of being edited', () => {
  expect(() => withProposedApiOptIn('{ "a": 1, "b": ', EXTENSION_ID)).toThrow();
  expect(() => withProposedApiOptIn('{ "a": 1 "b": 2 }', EXTENSION_ID)).toThrow();
  expect(() => withProposedApiOptIn('[1, 2]', EXTENSION_ID)).toThrow();
});

test('trailing commas and comments-only files are accepted', () => {
  const out = withProposedApiOptIn('{\n  // keep\n  "a": 1,\n}\n', EXTENSION_ID)!;
  expect(out).toContain('// keep');
  expect(out).toContain(EXTENSION_ID);
  const only = withProposedApiOptIn('// just a comment\n', EXTENSION_ID)!;
  expect(only).toContain('// just a comment');
  expect(only).toContain(EXTENSION_ID);
});

test('hasProposedApiOptIn', () => {
  expect(hasProposedApiOptIn('{"enable-proposed-api":["raboo.ai-autocomplete"]}', EXTENSION_ID)).toBe(true);
  expect(hasProposedApiOptIn('{\n // c\n "enable-proposed-api": ["raboo.ai-autocomplete",],\n}', EXTENSION_ID)).toBe(true);
  expect(hasProposedApiOptIn('{"enable-proposed-api":["other.ext"]}', EXTENSION_ID)).toBe(false);
  for (const t of ['', '{', '[]']) expect(hasProposedApiOptIn(t, EXTENSION_ID)).toBe(false);
});
