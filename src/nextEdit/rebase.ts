// Keeps a Next Edit suggestion while the user types it: decides whether the edits made since
// the request are part of the suggestion, and if so what is left of it. Pure: no `vscode`
// import. Texts may use CRLF; lines are split on `\r?\n` as everywhere in Next Edit.
import { regionEdit, type LineEdit } from './diff';

const EOL = /\r?\n/;
/** At most this many equivalent placements of the suggested change are tried; more (long runs of one character) drop it. */
const MAX_PLACEMENTS = 256;

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * Whether `typed` is what the user made of `removed` on the way to `inserted`: the first characters of `inserted`,
 * followed by what is left of `removed` after deleting some of its first characters.
 */
function partOf(typed: string, removed: string, inserted: string): boolean {
  const most = Math.min(typed.length, inserted.length);
  for (let k = 0; k <= most; k++) {
    if (k > 0 && typed[k - 1] !== inserted[k - 1]) return false;
    if (removed.endsWith(typed.slice(k))) return true;
  }
  return false;
}

/**
 * Whether `now` lies on the way from `old` to `target`: the only change from `old` is inside the suggested change
 * (old text the suggestion replaces, at its own place) and consists of deleting the start of the replaced text and
 * typing the start of the new text. Every placement of a change that could slide over repeated characters is tried.
 */
function onTheWay(old: string, now: string, target: string): boolean {
  const head = commonPrefix(old, target);
  const tail = commonSuffix(old, target);
  // The unchanged length around the smallest change.
  const kept = Math.min(head + tail, old.length, target.length);
  const nowHead = commonPrefix(old, now);
  const nowTail = commonSuffix(old, now);
  let tries = 0;
  for (let p = Math.min(head, kept); p >= 0 && kept - p <= tail; p--) {
    if (++tries > MAX_PLACEMENTS) return false;
    const t = kept - p;
    if (p > nowHead || t > nowTail || p + t > now.length) continue;
    if (partOf(now.slice(p, now.length - t), old.slice(p, old.length - t), target.slice(p, target.length - t))) return true;
  }
  return false;
}

/**
 * Rebases a suggestion computed on `oldText` onto `newText`. Returns the remaining edit against `newText` when the user's
 * changes since `oldText` are the start of the suggestion, `'done'` when they are all of it, and `undefined` otherwise
 * (any change outside the suggestion, a character it does not suggest, a deletion it does not make).
 */
export function rebaseEdit(edit: LineEdit, oldText: string, newText: string): LineEdit | 'done' | undefined {
  const oldLines = oldText.split(EOL);
  if (edit.startLine < 0 || edit.endLine < edit.startLine || edit.endLine > oldLines.length) return undefined;
  const newLines = newText.split(EOL);
  const targetLines = [...oldLines.slice(0, edit.startLine), ...edit.newLines, ...oldLines.slice(edit.endLine)];
  const old = oldLines.join('\n');
  const now = newLines.join('\n');
  if (now !== old && !onTheWay(old, now, targetLines.join('\n'))) return undefined;
  return regionEdit(newLines, targetLines, 0) ?? 'done';
}
