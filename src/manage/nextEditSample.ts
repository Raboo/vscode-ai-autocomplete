import type { Settings } from '../config/settings';
import type { NextEditFormat, NextEditInput } from '../nextEdit/formats/format';
import { renderDiff } from '../nextEdit/history';
import { nextEditBudgets } from '../nextEdit/region';

const PATH = 'sample.py';
const BEFORE = ['def total(width, height):', '    area = width * height', '    print(area)', '    return area * 2', ''];
const RENAMED = '    a = width * height';
const HUNKS = [{ oldStart: 1, newStart: 1, oldLines: [BEFORE[1]], newLines: [RENAMED] }];

/**
 * Our own small Python file for the Backends page's Next Edit check: `area` was just renamed to `a` on line 2, the cursor
 * sits after the rename, and two more uses of `area` follow. A model that does Next Edit renames them. The text has no
 * reserved string of any format, and the whole file is inside every format's editable region while `regionLinesBelow` is at least 3 (and `regionLinesAbove` at least 1).
 */
export function nextEditSample(format: NextEditFormat, settings: Settings): NextEditInput {
  const lines = BEFORE.map((l, n) => (n === 1 ? RENAMED : l));
  const cursorLine = 1;
  const text = renderDiff(PATH, BEFORE.join('\n'), lines.join('\n')) ?? '';
  return {
    path: PATH,
    lines,
    cursor: { line: cursorLine, character: RENAMED.length },
    region: format.region(cursorLine, lines.length, { above: settings.nextEdit.regionLinesAbove, below: settings.nextEdit.regionLinesBelow }),
    history: [{ path: PATH, text, hunks: HUNKS }],
    snippets: [],
    budgets: nextEditBudgets(settings.nextEdit.contextBudget),
    previous: { lines: BEFORE, hunks: HUNKS },
  };
}
