import { expect, test } from 'vitest';
import { RejectedEdits } from '../../../src/nextEdit/rejected';

const doc = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const edit = { startLine: 3, endLine: 4, newLines: ['D'] };

test('the identical edit after a rejection is dropped', () => {
  const r = new RejectedEdits();
  r.remember('u', edit, doc);
  expect(r.isRejected('u', { ...edit, newLines: ['D'] }, doc)).toBe(true);
  expect(r.isRejected('other', edit, doc)).toBe(false);
});

test('a different edit shows', () => {
  const r = new RejectedEdits();
  r.remember('u', edit, doc);
  expect(r.isRejected('u', { ...edit, newLines: ['X'] }, doc)).toBe(false);
  expect(r.isRejected('u', { startLine: 2, endLine: 4, newLines: ['D'] }, doc)).toBe(false);
});

test('after the text near the range changes it can show, and prune forgets it', () => {
  const r = new RejectedEdits();
  r.remember('u', edit, doc);
  const changed = [...doc];
  changed[1] = 'B';
  expect(r.isRejected('u', edit, changed)).toBe(false);
  r.prune('u', changed);
  expect(r.isRejected('u', edit, doc)).toBe(false);
});

test('a change far from the range keeps it', () => {
  const r = new RejectedEdits();
  r.remember('u', edit, doc);
  const far = [...doc, 'h'];
  far[0] = 'A';
  r.prune('u', far);
  expect(r.isRejected('u', edit, far)).toBe(true);
});

test('keeps at most 5 entries per document', () => {
  const r = new RejectedEdits();
  for (let i = 0; i < 7; i++) r.remember('u', { startLine: 3, endLine: 4, newLines: [`n${i}`] }, doc);
  expect(r.isRejected('u', { startLine: 3, endLine: 4, newLines: ['n0'] }, doc)).toBe(false);
  expect(r.isRejected('u', { startLine: 3, endLine: 4, newLines: ['n6'] }, doc)).toBe(true);
});

test('a line inserted above the range: the identical, shifted edit is still rejected and prune keeps it', () => {
  const r = new RejectedEdits();
  r.remember('u', edit, doc);
  const shifted = ['new', ...doc];
  const shiftedEdit = { startLine: 4, endLine: 5, newLines: ['D'] };
  r.prune('u', shifted);
  expect(r.isRejected('u', shiftedEdit, shifted)).toBe(true);
});

test('a line inside the context changed: the edit can show', () => {
  const r = new RejectedEdits();
  r.remember('u', edit, doc);
  const changed = [...doc];
  changed[4] = 'E!';
  expect(r.isRejected('u', edit, changed)).toBe(false);
});
