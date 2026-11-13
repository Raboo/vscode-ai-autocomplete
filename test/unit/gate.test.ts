import { expect, test } from 'vitest';
import { gate, type GateInput } from '../../src/completion/gate';

const base: GateInput = {
  enabled: true,
  snoozedUntil: 0,
  now: 1_000,
  scheme: 'file',
  languageId: 'typescript',
  disabledLanguages: ['plaintext'],
  fileExcluded: false,
  selections: 1,
  hasSelectedCompletionInfo: false,
  lineSuffix: '',
  skipMidWord: true,
  invoked: false,
};
const run = (o: Partial<GateInput>) => gate({ ...base, ...o });

test('ok', () => expect(run({})).toEqual({ ok: true }));
test('disabled', () => expect(run({ enabled: false })).toEqual({ ok: false, reason: 'disabled' }));
test('snoozed', () => {
  expect(run({ snoozedUntil: 2_000 })).toEqual({ ok: false, reason: 'snoozed' });
  expect(run({ snoozedUntil: 1_000 })).toEqual({ ok: true });
});
test('scheme', () => {
  expect(run({ scheme: 'output' })).toEqual({ ok: false, reason: 'scheme' });
  expect(run({ scheme: 'vscode-userdata' })).toEqual({ ok: false, reason: 'scheme' });
  for (const scheme of ['file', 'untitled', 'vscode-notebook-cell', 'vscode-remote']) expect(run({ scheme })).toEqual({ ok: true });
});
test('language', () => expect(run({ languageId: 'plaintext' })).toEqual({ ok: false, reason: 'language' }));
test('excluded file', () => expect(run({ fileExcluded: true })).toEqual({ ok: false, reason: 'excluded file' }));
test('multi-cursor', () => expect(run({ selections: 2 })).toEqual({ ok: false, reason: 'multi-cursor' }));
test('suggest widget', () => expect(run({ hasSelectedCompletionInfo: true })).toEqual({ ok: false, reason: 'suggest widget' }));
test('mid-word', () => {
  expect(run({ lineSuffix: 'foo)' })).toEqual({ ok: false, reason: 'mid-word' });
  expect(run({ lineSuffix: '_x' })).toEqual({ ok: false, reason: 'mid-word' });
  expect(run({ lineSuffix: '9' })).toEqual({ ok: false, reason: 'mid-word' });
  expect(run({ lineSuffix: 'é' })).toEqual({ ok: false, reason: 'mid-word' });
  // punctuation or whitespace after the cursor is not mid-word
  expect(run({ lineSuffix: ')' })).toEqual({ ok: true });
  expect(run({ lineSuffix: ' foo' })).toEqual({ ok: true });
  // explicit invocation and skipMidWord=false bypass the rule
  expect(run({ lineSuffix: 'foo', invoked: true })).toEqual({ ok: true });
  expect(run({ lineSuffix: 'foo', skipMidWord: false })).toEqual({ ok: true });
});
