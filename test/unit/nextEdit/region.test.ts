import { expect, test } from 'vitest';
import { clipAroundRegion, editableRegion, nextEditBudgets, regionByChars } from '../../../src/nextEdit/region';

const lines = (n: number): string[] => Array.from({ length: n }, () => '123456789');

test('region is 5 above and 10 below the cursor', () => {
  expect(editableRegion(20, 100)).toEqual({ start: 15, end: 30 });
});
test('region stays inside the file', () => {
  expect(editableRegion(0, 3)).toEqual({ start: 0, end: 2 });
  expect(editableRegion(99, 100)).toEqual({ start: 94, end: 99 });
  expect(editableRegion(0, 1)).toEqual({ start: 0, end: 0 });
});
test('editableRegion takes the configured sizes', () => {
  expect(editableRegion(10, 100, 2, 3)).toEqual({ start: 8, end: 13 });
});
test("editableRegion keeps 3a's default", () => {
  expect(editableRegion(10, 100)).toEqual({ start: 5, end: 20 });
});
test("nextEditBudgets(3500) is 3a's constants", () => {
  expect(nextEditBudgets(3500)).toEqual({ fileChars: 5250, historyChars: 3500, snippetsChars: 3500 });
});
test('region of an empty file is line 0', () => {
  expect(editableRegion(0, 0)).toEqual({ start: 0, end: 0 });
});

test('clip keeps whole 10-line pages around the region', () => {
  expect(clipAroundRegion(lines(100), { start: 42, end: 47 }, 400)).toEqual({ start: 30, end: 69 });
});
test('clip gives leftover budget from above to below', () => {
  expect(clipAroundRegion(lines(100), { start: 2, end: 7 }, 400)).toEqual({ start: 0, end: 39 });
});
test('clip never cuts the region', () => {
  expect(clipAroundRegion(lines(100), { start: 42, end: 57 }, 10)).toEqual({ start: 42, end: 57 });
});
test('clip of an empty or one-line file', () => {
  expect(clipAroundRegion([], { start: 0, end: 0 }, 400)).toEqual({ start: 0, end: 0 });
  expect(clipAroundRegion(lines(1), { start: 0, end: 0 }, 400)).toEqual({ start: 0, end: 0 });
});
test('clip with the cursor on the last line', () => {
  expect(clipAroundRegion(lines(100), editableRegion(99, 100), 400)).toEqual({ start: 80, end: 99 });
});
test('clip ends at a last page shorter than 10 lines', () => {
  // 95 lines: region 80-89 snaps to page 80-89; below only page 90-94 (5 lines) exists
  expect(clipAroundRegion(lines(95), { start: 82, end: 87 }, 1000)).toEqual({ start: 40, end: 94 });
  expect(clipAroundRegion(lines(95), { start: 88, end: 92 }, 400)).toEqual({ start: 70, end: 94 });
});

test('regionByChars grows below first, then alternates', () => {
  expect(regionByChars(lines(100), 10, 55, 40)).toEqual({ start: 8, end: 12 });
});
test('regionByChars at the first line grows only below, at the last only above', () => {
  expect(regionByChars(lines(100), 0, 55, 40)).toEqual({ start: 0, end: 4 });
  expect(regionByChars(lines(100), 99, 55, 40)).toEqual({ start: 95, end: 99 });
});
test('regionByChars returns a file under the budget whole', () => {
  expect(regionByChars(lines(5), 2, 1000, 40)).toEqual({ start: 0, end: 4 });
});
test('regionByChars never exceeds maxLines', () => {
  expect(regionByChars(lines(100), 50, 100000, 7)).toEqual({ start: 47, end: 53 });
});
test('regionByChars keeps a cursor line over the budget alone', () => {
  const ls = lines(10);
  ls[5] = 'x'.repeat(100);
  expect(regionByChars(ls, 5, 50, 40)).toEqual({ start: 5, end: 5 });
});
