import type { BackendKind } from '../types';

/** Wait after the last change before asking for a Next Edit. */
export const EDIT_PAUSE_MS = 400;
/** The edit pause when completions are off: Next Edit then has nothing to wait for. */
export const NEXT_EDIT_ONLY_PAUSE_MS = 150;
/** A file's edits become one history entry after this much idle time. */
export const HISTORY_IDLE_MS = 1500;
/** Cursor moves ask for a Next Edit only this long after an edit to the same file. */
export const AFTER_EDIT_WINDOW_MS = 10_000;
/**
 * A cursor report this soon after an edit to the same file is the edit's own, not a move: a command that makes several
 * edits (typing several characters at once) gets its cursor reported again in a version the controller has seen.
 */
export const EDIT_ECHO_MS = 100;
/** A cursor move to the line of the last request does not ask again within this time. */
export const SAME_LINE_COOLDOWN_MS = 5_000;
/** Nothing is asked this long after the user rejected a suggestion. */
export const REJECTION_COOLDOWN_MS = 5_000;
/** Delay before the next request after an accept, so repeated Tabs walk through a change. */
export const CHAIN_DELAY_MS = 60;

/** The edit pause: shorter with completions off, disabled or without a backend (Next Edit alone), else EDIT_PAUSE_MS. */
export function nextEditPauseMs(s: { enabled: boolean; fim: { enabled: boolean; backendId?: string | undefined } }): number {
  return !s.enabled || !s.fim.enabled || s.fim.backendId === undefined ? NEXT_EDIT_ONLY_PAUSE_MS : EDIT_PAUSE_MS;
}

/**
 * Whether a running Next Edit request keeps running while the user types inside its region (its answer is rebased when it
 * comes). Only when it does not hold up completions: Next Edit has its own backend (or completions are off), or the shared
 * backend is a llama.cpp server with 2 or more slots, so both can run at once. Otherwise each keystroke aborts it.
 */
export function keepRequestWhileTyping(o: {
  nextEditBackendId: string;
  completionsBackendId: string | undefined;
  completionsActive: boolean;
  kind: BackendKind | undefined;
  slots: number | undefined;
}): boolean {
  if (!o.completionsActive || o.completionsBackendId === undefined || o.completionsBackendId !== o.nextEditBackendId) return true;
  return o.kind === 'llamacpp' && o.slots !== undefined && o.slots >= 2;
}

/** When to ask for a Next Edit: after an edit pause, or on a cursor move shortly after an edit. Times are ms. */
export class TriggerPolicy {
  private lastEdit: { uri: string; at: number } | undefined;
  private lastRequest: { uri: string; line: number; at: number } | undefined;
  private rejectedAt = -Infinity;

  edited(uri: string, now: number): void {
    this.lastEdit = { uri, at: now };
  }

  /** A closed document's edit and request are forgotten: an untitled document opened later may get the same URI. */
  closed(uri: string): void {
    if (this.lastEdit?.uri === uri) this.lastEdit = undefined;
    if (this.lastRequest?.uri === uri) this.lastRequest = undefined;
  }

  rejected(now: number): void {
    this.rejectedAt = now;
  }

  requested(uri: string, line: number, now: number): void {
    this.lastRequest = { uri, line, at: now };
  }

  /** Whether an edit pause may ask: true outside a rejection cooldown. */
  afterPause(now: number): boolean {
    return now - this.rejectedAt >= REJECTION_COOLDOWN_MS;
  }

  /** Whether moving the cursor to `line` may ask: the last edit was to this document, recently but not just now, and the line was not just asked about. */
  onCursorMove(uri: string, line: number, now: number): boolean {
    if (!this.afterPause(now)) return false;
    const edit = this.lastEdit;
    if (edit?.uri !== uri || now - edit.at > AFTER_EDIT_WINDOW_MS || now - edit.at < EDIT_ECHO_MS) return false;
    const last = this.lastRequest;
    return !(last && last.uri === uri && last.line === line && now - last.at < SAME_LINE_COOLDOWN_MS);
  }
}
