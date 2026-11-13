import type { StatusState } from '../completion/requestStatus';

export interface LastStatus { state: StatusState; detail?: string }

/** What the status bar shows: disabled beats snoozed beats the last reported state. */
export function displayState(enabled: boolean, snoozedUntil: number, now: number, last: LastStatus): LastStatus {
  if (!enabled) return { state: 'disabled' };
  if (now < snoozedUntil) return { state: 'snoozed' };
  return last;
}

/** An entry of the status bar menu; `id` names the command (`aiAutocomplete.<id>`). */
export interface MenuEntry { label: string; id: string }

const RETRY: MenuEntry = { label: 'Retry now', id: 'retry' };
const MENU: MenuEntry[] = [
  { label: 'Toggle completions on/off', id: 'toggle' },
  { label: 'Snooze...', id: 'snooze' },
  { label: 'Select backend...', id: 'selectBackend' },
  { label: 'Set API key...', id: 'setApiKey' },
  RETRY,
  { label: 'Show log', id: 'showLog' },
  { label: 'About', id: 'about' },
];

/** The status bar menu for the shown state: while it is an error, "Retry now" comes first. */
export function menuEntries(shown: StatusState): MenuEntry[] {
  return shown === 'error' ? [RETRY, ...MENU.filter((e) => e !== RETRY)] : [...MENU];
}
