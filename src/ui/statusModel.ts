import type { StatusState } from '../completion/requestStatus';

export interface LastStatus { state: StatusState; detail?: string }

/** What the status bar shows: disabled beats snoozed beats the last reported state. */
export function displayState(enabled: boolean, snoozedUntil: number, now: number, last: LastStatus): LastStatus {
  if (!enabled) return { state: 'disabled' };
  if (now < snoozedUntil) return { state: 'snoozed' };
  return last;
}
