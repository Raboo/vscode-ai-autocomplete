import { describe, expect, test } from 'vitest';
import { AFTER_EDIT_WINDOW_MS, EDIT_ECHO_MS, EDIT_PAUSE_MS, NEXT_EDIT_ONLY_PAUSE_MS, REJECTION_COOLDOWN_MS, SAME_LINE_COOLDOWN_MS, TriggerPolicy, keepRequestWhileTyping, nextEditPauseMs } from '../../../src/nextEdit/trigger';

test('a cursor move within 10 s of an edit triggers; after 10 s it does not', () => {
  const p = new TriggerPolicy();
  expect(p.onCursorMove('a', 3, 1_000)).toBe(false);
  p.edited('a', 1_000);
  expect(p.onCursorMove('a', 3, 10_000)).toBe(true);
  expect(p.onCursorMove('a', 3, 12_000)).toBe(false);
  expect(AFTER_EDIT_WINDOW_MS).toBe(10_000);
});

test("a cursor report within 100 ms of an edit is the edit's own, not a move", () => {
  // A command that types several characters makes several edits, and VS Code reports the cursor again after the last
  // one, in a document version the controller has already seen.
  const p = new TriggerPolicy();
  p.edited('a', 1_000);
  expect(p.onCursorMove('a', 3, 1_003)).toBe(false);
  expect(p.onCursorMove('a', 3, 1_099)).toBe(false);
  expect(p.onCursorMove('a', 3, 1_100)).toBe(true);
  expect(EDIT_ECHO_MS).toBe(100);
});

test('the edit window belongs to the edited document', () => {
  const p = new TriggerPolicy();
  p.edited('a', 1_000);
  expect(p.onCursorMove('b', 3, 2_000)).toBe(false);
});

test('the same line does not trigger again within 5 s, another line does', () => {
  const p = new TriggerPolicy();
  p.edited('a', 1_000);
  p.requested('a', 3, 2_000);
  expect(p.onCursorMove('a', 3, 4_000)).toBe(false);
  expect(p.onCursorMove('a', 4, 4_000)).toBe(true);
  expect(p.onCursorMove('a', 3, 8_000)).toBe(true);
  expect(SAME_LINE_COOLDOWN_MS).toBe(5_000);
});

test('the same line of another document is not cooling down', () => {
  const p = new TriggerPolicy();
  p.requested('b', 3, 1_000);
  p.edited('a', 1_500);
  expect(p.onCursorMove('a', 3, 2_000)).toBe(true);
});

test('nothing triggers within 5 s of a rejection, edit pause included', () => {
  const p = new TriggerPolicy();
  p.edited('a', 1_000);
  p.rejected(2_000);
  expect(p.onCursorMove('a', 3, 4_000)).toBe(false);
  expect(p.afterPause(4_000)).toBe(false);
  p.edited('a', 5_000);
  expect(p.onCursorMove('a', 3, 6_000)).toBe(false);
  expect(p.afterPause(6_000)).toBe(false);
  expect(p.onCursorMove('a', 3, 8_000)).toBe(true);
  expect(REJECTION_COOLDOWN_MS).toBe(5_000);
});

test('afterPause is true outside a rejection cooldown', () => {
  const p = new TriggerPolicy();
  expect(p.afterPause(0)).toBe(true);
  expect(p.afterPause(1_000)).toBe(true);
  p.rejected(10_000);
  expect(p.afterPause(12_000)).toBe(false);
  expect(p.afterPause(16_000)).toBe(true);
});

test('a closed document forgets its edit, so a new document reusing its URI does not ask on a cursor move', () => {
  const p = new TriggerPolicy();
  p.edited('untitled:Untitled-1', 1_000);
  p.closed('untitled:Untitled-1');
  expect(p.onCursorMove('untitled:Untitled-1', 0, 2_000)).toBe(false);
  // Closing another document changes nothing.
  p.edited('a', 3_000);
  p.closed('b');
  expect(p.onCursorMove('a', 0, 4_000)).toBe(true);
});

describe('keepRequestWhileTyping', () => {
  const base = { nextEditBackendId: 'ne', completionsBackendId: 'ne', completionsActive: true, kind: 'llamacpp' as const, slots: undefined };
  test('a Next Edit backend other than the completions one: kept', () => {
    expect(keepRequestWhileTyping({ ...base, completionsBackendId: 'fim' })).toBe(true);
  });
  test('completions off or without a backend: nothing competes, kept', () => {
    expect(keepRequestWhileTyping({ ...base, completionsActive: false })).toBe(true);
    expect(keepRequestWhileTyping({ ...base, completionsBackendId: undefined })).toBe(true);
  });
  test('the same backend: kept only on llama.cpp reporting 2 or more slots', () => {
    expect(keepRequestWhileTyping({ ...base, slots: 2 })).toBe(true);
    expect(keepRequestWhileTyping({ ...base, slots: 4 })).toBe(true);
    expect(keepRequestWhileTyping({ ...base, slots: 1 })).toBe(false);
    expect(keepRequestWhileTyping(base)).toBe(false);
    expect(keepRequestWhileTyping({ ...base, kind: 'openai', slots: 2 })).toBe(false);
  });
});

describe('nextEditPauseMs', () => {
  const s = (enabled: boolean, fimEnabled: boolean, backendId: string | undefined) => ({ enabled, fim: { enabled: fimEnabled, backendId } });
  test('completions on: 400 ms', () => {
    expect(nextEditPauseMs(s(true, true, 'a'))).toBe(EDIT_PAUSE_MS);
    expect(EDIT_PAUSE_MS).toBe(400);
  });
  test('completions off, the extension disabled or no completion backend: 150 ms', () => {
    expect(NEXT_EDIT_ONLY_PAUSE_MS).toBe(150);
    expect(nextEditPauseMs(s(true, false, 'a'))).toBe(150);
    expect(nextEditPauseMs(s(false, true, 'a'))).toBe(150);
    expect(nextEditPauseMs(s(true, true, undefined))).toBe(150);
  });
});
