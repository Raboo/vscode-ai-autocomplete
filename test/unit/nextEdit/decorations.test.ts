import { describe, expect, it } from 'vitest';
import { decorationPlan, displayFor } from '../../../src/nextEdit/decorations';
import type { NextEditShow } from '../../../src/nextEdit/diff';

const ghost: NextEditShow = { kind: 'ghost', insertText: 'x' };
const edit: NextEditShow = { kind: 'edit', start: { line: 1, character: 0 }, end: { line: 2, character: 0 }, text: 'y' };

describe('displayFor', () => {
  it('ghost text always uses the native item', () => {
    for (const mode of ['auto', 'native', 'decorations'] as const) {
      expect(displayFor(ghost, mode, true)).toBe('item');
      expect(displayFor(ghost, mode, false)).toBe('item');
    }
  });

  it('auto picks native when available, else decorations', () => {
    expect(displayFor(edit, 'auto', true)).toBe('item');
    expect(displayFor(edit, 'auto', false)).toBe('decorations');
  });

  it('native shows the item or drops the edit', () => {
    expect(displayFor(edit, 'native', true)).toBe('item');
    expect(displayFor(edit, 'native', false)).toBe('drop');
  });

  it('decorations always uses decorations', () => {
    expect(displayFor(edit, 'decorations', true)).toBe('decorations');
    expect(displayFor(edit, 'decorations', false)).toBe('decorations');
  });
});

describe('decorationPlan', () => {
  const far = { line: 0, character: 0 };

  it('a rename marks only the changed characters', () => {
    const docLines = ['function area(r) {', '    return 2 * r', '}'];
    const plan = decorationPlan({ startLine: 1, endLine: 2, newLines: ['    return 2 * radius'] }, docLines, { line: 1, character: 5 });
    expect(plan.removed).toEqual([{ line: 1, start: 15, end: 16 }]);
    expect(plan.added[0]).toMatchObject({ line: 1 });
    expect(plan.added[0].text.startsWith('→ return 2 * radius')).toBe(true);
    expect(plan.deletedLines).toEqual([]);
  });

  it('never lets the common prefix and suffix overlap; a pure in-line insertion marks the neighbouring character', () => {
    const plan = decorationPlan({ startLine: 0, endLine: 1, newLines: ['aaa'] }, ['aa'], { line: 0, character: 0 });
    expect(plan.removed).toEqual([{ line: 0, start: 1, end: 2 }]);
    const front = decorationPlan({ startLine: 0, endLine: 1, newLines: ['xab'] }, ['ab'], { line: 0, character: 0 });
    expect(front.removed).toEqual([{ line: 0, start: 0, end: 1 }]);
    expect(plan.added[0].text.startsWith('→ aaa')).toBe(true);
  });

  it('a pair that is identical adds nothing', () => {
    const plan = decorationPlan({ startLine: 0, endLine: 2, newLines: ['same', 'b2'] }, ['same', 'b'], { line: 0, character: 0 });
    expect(plan.added.map((a) => a.line)).toEqual([1]);
  });

  it('extra new lines are counted', () => {
    const docLines = ['a', 'b', 'c'];
    const plan = decorationPlan({ startLine: 1, endLine: 2, newLines: ['b2', 'n1', 'n2'] }, docLines, { line: 1, character: 0 });
    expect(plan.added).toHaveLength(1);
    expect(plan.added[0].text).toContain('→ b2 (+2 lines)');
  });

  it('extra new lines with no changed pair get their own entry on the last old line', () => {
    const plan = decorationPlan({ startLine: 1, endLine: 2, newLines: ['b', 'n1', 'n2'] }, ['a', 'b', 'c'], far);
    expect(plan.added).toEqual([{ line: 1, text: '+ n1 (+2 lines)' }]);
  });

  it('deleted lines', () => {
    const plan = decorationPlan({ startLine: 0, endLine: 3, newLines: ['x'] }, ['a', 'b', 'c'], { line: 0, character: 0 });
    expect(plan.deletedLines).toEqual([1, 2]);
    expect(plan.added.map((a) => a.line)).toEqual([0]);
    expect(plan.added[0].text).not.toContain('lines)');
  });

  it('pure insertion anchors above', () => {
    const docLines = ['0', '1', '2', '3', '4', '5', '6'];
    const mid = decorationPlan({ startLine: 5, endLine: 5, newLines: ['  foo()'] }, docLines, { line: 5, character: 0 });
    expect(mid.added).toEqual([{ line: 4, text: '+ foo()' }]);
    const top = decorationPlan({ startLine: 0, endLine: 0, newLines: ['a', 'b'] }, docLines, { line: 3, character: 0 });
    expect(top.added).toEqual([{ line: 0, text: '+ a (+2 lines)' }]);
    expect(top.removed).toEqual([]);
  });

  it('a pure insertion past the last line anchors on the last line', () => {
    const plan = decorationPlan({ startLine: 3, endLine: 3, newLines: ['z'] }, ['0', '1', '2'], far);
    expect(plan.added[0].line).toBe(2);
  });

  it('jump: far cursor jumps to the first non-blank of startLine', () => {
    const docLines = Array.from({ length: 30 }, (_, i) => `    line ${i}`);
    const e = { startLine: 15, endLine: 16, newLines: ['    changed'] };
    const plan = decorationPlan(e, docLines, { line: 5, character: 2 });
    expect(plan.jump).toBe(true);
    expect(plan.target).toEqual({ line: 15, character: 4 });
    expect(plan.hint.line).toBe(5);
    expect(plan.hint.text).toBe('Next edit at line 16 · Tab to jump · Esc to dismiss');
  });

  it('jump boundaries', () => {
    const docLines = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const e = { startLine: 15, endLine: 17, newLines: ['q', 'r'] };
    expect(decorationPlan(e, docLines, { line: 14, character: 0 }).jump).toBe(false);
    expect(decorationPlan(e, docLines, { line: 13, character: 0 }).jump).toBe(true);
    expect(decorationPlan(e, docLines, { line: 17, character: 0 }).jump).toBe(false);
    expect(decorationPlan(e, docLines, { line: 18, character: 0 }).jump).toBe(true);
    const ins = { startLine: 15, endLine: 15, newLines: ['q'] };
    expect(decorationPlan(ins, docLines, { line: 15, character: 0 }).jump).toBe(false);
    expect(decorationPlan(ins, docLines, { line: 16, character: 0 }).jump).toBe(true);
  });

  it('the jump target is clamped to the document', () => {
    const plan = decorationPlan({ startLine: 9, endLine: 9, newLines: ['q'] }, ['a', '  b'], { line: 0, character: 0 });
    expect(plan.target).toEqual({ line: 1, character: 2 });
  });

  it('hint on its own line when nothing is added there', () => {
    const docLines = ['a', 'b', 'c', 'd'];
    const plan = decorationPlan({ startLine: 2, endLine: 3, newLines: ['c2'] }, docLines, { line: 1, character: 0 });
    expect(plan.jump).toBe(false);
    expect(plan.hint).toEqual({ line: 1, text: 'Tab to apply · Esc to dismiss' });
  });

  it('hint merges with an added text on the cursor line', () => {
    const docLines = ['a', 'b', 'c'];
    const plan = decorationPlan({ startLine: 1, endLine: 2, newLines: ['b2'] }, docLines, { line: 1, character: 0 });
    expect(plan.hint).toEqual({ line: 1, text: '' });
    expect(plan.added).toEqual([{ line: 1, text: '→ b2  ·  Tab to apply · Esc to dismiss' }]);
  });

  it('long new lines are cut at 80 characters', () => {
    const long = 'x'.repeat(200);
    const plan = decorationPlan({ startLine: 0, endLine: 1, newLines: ['  ' + long] }, ['a'], far);
    expect(plan.added[0].text.startsWith('→ ' + 'x'.repeat(80) + '…')).toBe(true);
    const exact = decorationPlan({ startLine: 0, endLine: 1, newLines: ['y'.repeat(80)] }, ['a'], far);
    expect(exact.added[0].text).toBe('→ ' + 'y'.repeat(80) + '  ·  Tab to apply · Esc to dismiss');
  });

  it('cuts by code points, never splitting a surrogate pair', () => {
    const emoji = '😀';
    const fits = decorationPlan({ startLine: 0, endLine: 1, newLines: [emoji.repeat(80)] }, ['a'], { line: 5, character: 0 });
    expect(fits.added[0].text).toBe('→ ' + emoji.repeat(80));
    const over = decorationPlan({ startLine: 0, endLine: 1, newLines: [emoji.repeat(81)] }, ['a'], { line: 5, character: 0 });
    expect(over.added[0].text).toBe('→ ' + emoji.repeat(80) + '…');
    expect(over.added[0].text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('says "+1 line" in the singular', () => {
    const plan = decorationPlan({ startLine: 1, endLine: 2, newLines: ['b2', 'n1'] }, ['a', 'b', 'c'], { line: 9, character: 0 });
    expect(plan.added[0].text).toBe('→ b2 (+1 line)');
  });

  it('the hint names the clamped line when the edit is past the end', () => {
    const plan = decorationPlan({ startLine: 9, endLine: 9, newLines: ['q'] }, ['a', 'b'], { line: 0, character: 0 });
    expect(plan.hint.text).toBe('Next edit at line 2 · Tab to jump · Esc to dismiss');
  });

  it('a whitespace-only target line puts the target at its end', () => {
    const plan = decorationPlan({ startLine: 1, endLine: 2, newLines: ['x'] }, ['a', '    ', 'c'], { line: 0, character: 0 });
    expect(plan.target).toEqual({ line: 1, character: 4 });
  });

  it('deleting the last lines leaves only deletedLines', () => {
    const plan = decorationPlan({ startLine: 2, endLine: 4, newLines: [] }, ['a', 'b', 'c', 'd'], { line: 1, character: 0 });
    expect(plan.deletedLines).toEqual([2, 3]);
    expect(plan.added).toEqual([]);
    expect(plan.removed).toEqual([]);
    expect(plan.jump).toBe(false);
    expect(plan.hint).toEqual({ line: 1, text: 'Tab to apply · Esc to dismiss' });
  });
});
