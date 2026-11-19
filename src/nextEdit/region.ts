import { CHARS_PER_TOKEN } from '../completion/effective';

export const REGION_ABOVE = 5;
export const REGION_BELOW = 10;
export const PAGE_LINES = 10;

/** Inclusive 0-based line range. */
export interface LineSpan {
  start: number;
  end: number;
}

/** The lines the model may rewrite: a few above the cursor, more below. */
export function editableRegion(cursorLine: number, lineCount: number, above = REGION_ABOVE, below = REGION_BELOW): LineSpan {
  const lastLine = Math.max(0, lineCount - 1);
  const cursor = Math.min(Math.max(0, cursorLine), lastLine);
  const start = Math.max(0, cursor - above);
  const end = Math.min(lastLine, cursor + below);
  return { start, end };
}

/**
 * A region sized by length: the cursor line, then lines alternately below and
 * above (below first) while the total stays within `maxChars` (each line costs
 * length + 1) and `maxLines`. A side that does not fit stops; at a file edge the
 * other side keeps growing. A cursor line over the budget is the region alone.
 */
export function regionByChars(lines: string[], cursorLine: number, maxChars: number, maxLines: number): LineSpan {
  if (lines.length === 0) return { start: 0, end: 0 };
  const lastLine = lines.length - 1;
  const cursor = Math.min(Math.max(0, cursorLine), lastLine);
  let start = cursor;
  let end = cursor;
  let used = lines[cursor].length + 1;
  let belowOpen = true;
  let aboveOpen = true;
  let turnBelow = true;
  while ((belowOpen || aboveOpen) && end - start + 1 < maxLines) {
    const below = turnBelow;
    turnBelow = !turnBelow;
    if (below ? !belowOpen : !aboveOpen) continue;
    const next = below ? end + 1 : start - 1;
    if (next < 0 || next > lastLine) {
      if (below) belowOpen = false;
      else aboveOpen = false;
      continue;
    }
    const cost = lines[next].length + 1;
    if (used + cost > maxChars) {
      if (below) belowOpen = false;
      else aboveOpen = false;
      continue;
    }
    used += cost;
    if (below) end = next;
    else start = next;
  }
  return { start, end };
}

/** Prompt budgets in chars for the file, the edit history and the viewed snippets. */
export interface NextEditBudgets { fileChars: number; historyChars: number; snippetsChars: number }

/** Splits `contextTokens` worth of chars 3/7 file, 2/7 history, 2/7 snippets, each rounded. */
export function nextEditBudgets(contextTokens: number): NextEditBudgets {
  const chars = contextTokens * CHARS_PER_TOKEN;
  return { fileChars: Math.round((chars * 3) / 7), historyChars: Math.round((chars * 2) / 7), snippetsChars: Math.round((chars * 2) / 7) };
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

/**
 * The part of the file around the region that goes into the prompt, in whole lines: the region plus lines above
 * (up to half of `budgetChars`) and below (the rest, so unused budget above moves below). Each outside line costs
 * length + 1 chars; the region itself is free. When no outside line fits, the region is returned.
 */
export function clipLinesAroundRegion(lines: string[], region: LineSpan, budgetChars: number): LineSpan {
  if (lines.length === 0) return region;
  let start = region.start;
  let end = region.end;
  let used = 0;
  const aboveBudget = budgetChars / 2;
  while (start > 0 && used + lines[start - 1].length + 1 <= aboveBudget) {
    used += lines[start - 1].length + 1;
    start--;
  }
  while (end < lines.length - 1 && used + lines[end + 1].length + 1 <= budgetChars) {
    used += lines[end + 1].length + 1;
    end++;
  }
  return { start, end };
}
