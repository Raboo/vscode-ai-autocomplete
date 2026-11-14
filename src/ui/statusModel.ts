import type { StatusState } from '../completion/requestStatus';

export interface LastStatus { state: StatusState; detail?: string }

/** What the status bar shows: disabled beats snoozed beats the last reported state. */
export function displayState(enabled: boolean, snoozedUntil: number, now: number, last: LastStatus): LastStatus {
  if (!enabled) return { state: 'disabled' };
  if (now < snoozedUntil) return { state: 'snoozed' };
  return last;
}

/** An entry of the status bar menu; `id` names the command (`aiAutocomplete.<id>`), except `resume`, which ends a snooze. */
export interface MenuEntry { label: string; id: string }

const RETRY: MenuEntry = { label: 'Retry now', id: 'retry' };
const RESUME: MenuEntry = { label: 'Resume now', id: 'resume' };
const MANAGE: MenuEntry = { label: 'Manage backends...', id: 'manageBackends' };
const MENU: MenuEntry[] = [
  { label: 'Toggle completions on/off', id: 'toggle' },
  { label: 'Snooze...', id: 'snooze' },
  { label: 'Select backend...', id: 'selectBackend' },
  MANAGE,
  { label: 'Set API key...', id: 'setApiKey' },
  RETRY,
  { label: 'Show log', id: 'showLog' },
  { label: 'About', id: 'about' },
];

/**
 * The status bar menu for the shown state: "Retry now" comes first while it is an error, "Resume now" while snoozed.
 * With no backend configured, "Manage backends..." comes before both.
 */
export function menuEntries(shown: StatusState, backendCount: number): MenuEntry[] {
  let list = shown === 'error' ? [RETRY, ...MENU.filter((e) => e !== RETRY)] : shown === 'snoozed' ? [RESUME, ...MENU] : [...MENU];
  if (backendCount === 0) list = [MANAGE, ...list.filter((e) => e !== MANAGE)];
  return list;
}
