/** Wait after the last change before asking for a Next Edit. */
export const EDIT_PAUSE_MS = 400;
/** A file's edits become one history entry after this much idle time. */
export const HISTORY_IDLE_MS = 1500;
/** Cursor moves ask for a Next Edit only this long after an edit to the same file. */
export const AFTER_EDIT_WINDOW_MS = 10_000;
/** A cursor move to the line of the last request does not ask again within this time. */
export const SAME_LINE_COOLDOWN_MS = 5_000;
/** Nothing is asked this long after the user rejected a suggestion. */
export const REJECTION_COOLDOWN_MS = 5_000;
/** Delay before the next request after an accept, so repeated Tabs walk through a change. */
export const CHAIN_DELAY_MS = 60;

/** When to ask for a Next Edit: after an edit pause, or on a cursor move shortly after an edit. Times are ms. */
export class TriggerPolicy {
  private lastEdit: { uri: string; at: number } | undefined;
  private lastRequest: { uri: string; line: number; at: number } | undefined;
  private rejectedAt = -Infinity;

  edited(uri: string, now: number): void {
    this.lastEdit = { uri, at: now };
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

  /** Whether moving the cursor to `line` may ask: the last edit was to this document, recently, and the line was not just asked about. */
  onCursorMove(uri: string, line: number, now: number): boolean {
    if (!this.afterPause(now)) return false;
    const edit = this.lastEdit;
    if (edit?.uri !== uri || now - edit.at > AFTER_EDIT_WINDOW_MS) return false;
    const last = this.lastRequest;
    return !(last && last.uri === uri && last.line === line && now - last.at < SAME_LINE_COOLDOWN_MS);
  }
}
