export const REGION_ABOVE = 5;
export const REGION_BELOW = 10;
export const REGION_MAX_LINES = 25;
export const PAGE_LINES = 10;

/** Inclusive 0-based line range. */
export interface LineSpan {
  start: number;
  end: number;
}

/** The lines the model may rewrite: a few above the cursor, more below. */
export function editableRegion(cursorLine: number, lineCount: number): LineSpan {
  const lastLine = Math.max(0, lineCount - 1);
  const cursor = Math.min(Math.max(0, cursorLine), lastLine);
  const start = Math.max(0, cursor - REGION_ABOVE);
  const end = Math.min(lastLine, cursor + REGION_BELOW, start + REGION_MAX_LINES - 1);
  return { start, end };
}

/**
 * The part of the file that goes into the prompt: the region snapped to whole
 * pages, plus whole pages above and below while they fit the budget. Each line
 * costs length + 1 chars. Unused budget above moves to below.
 */
export function clipAroundRegion(lines: string[], region: LineSpan, budgetChars: number): LineSpan {
  if (lines.length === 0) return region;
  const lastLine = lines.length - 1;
  const cost = (from: number, to: number): number => {
    let sum = 0;
    for (let i = from; i <= to; i++) sum += lines[i].length + 1;
    return sum;
  };
  let start = Math.floor(region.start / PAGE_LINES) * PAGE_LINES;
  let end = Math.min(lastLine, Math.floor(region.end / PAGE_LINES) * PAGE_LINES + PAGE_LINES - 1);
  const remaining = budgetChars - cost(start, end);
  if (remaining < 0) return region;

  const aboveBudget = remaining / 2;
  let aboveUsed = 0;
  while (start > 0) {
    const pageCost = cost(start - PAGE_LINES, start - 1);
    if (aboveUsed + pageCost > aboveBudget) break;
    aboveUsed += pageCost;
    start -= PAGE_LINES;
  }
  const belowBudget = remaining - aboveUsed;
  let belowUsed = 0;
  while (end < lastLine) {
    const pageEnd = Math.min(lastLine, end + PAGE_LINES);
    const pageCost = cost(end + 1, pageEnd);
    if (belowUsed + pageCost > belowBudget) break;
    belowUsed += pageCost;
    end = pageEnd;
  }
  return { start, end };
}
