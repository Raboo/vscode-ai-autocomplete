import type { StatusState } from '../completion/requestStatus';

export interface LastStatus { state: StatusState; detail?: string }

/** What the status bar shows: disabled beats snoozed beats the last reported state. */
export function displayState(enabled: boolean, snoozedUntil: number, now: number, last: LastStatus): LastStatus {
  if (!enabled) return { state: 'disabled' };
  if (now < snoozedUntil) return { state: 'snoozed' };
  return last;
}

/**
 * What completions show when no backend serves them. With no backend at all that is an error; with backends that are all
 * Next Edit-only (or `fim.backend` naming one) completions are simply not configured, so the status stays idle and says so.
 */
export function noCompletionBackend(backendCount: number): { state: 'idle' | 'error'; detail: string } {
  return backendCount === 0 ? { state: 'error', detail: 'No backend configured' } : { state: 'idle', detail: 'No backend is used for completions' };
}

/** An entry of the status bar menu; `id` names the command (`aiAutocomplete.<id>`), except `resume`, which ends a snooze. */
export interface MenuEntry { label: string; id: string }

const RETRY: MenuEntry = { label: 'Retry now', id: 'retry' };
const RESUME: MenuEntry = { label: 'Resume now', id: 'resume' };
const MANAGE: MenuEntry = { label: 'Manage backends...', id: 'manageBackends' };
const NEXT_EDIT: MenuEntry = { label: 'Next Edit: off', id: 'selectNextEditBackend' };
const ENABLE_NATIVE: MenuEntry = { label: 'Enable native Next Edit UI...', id: 'enableNativeNextEdit' };
const MENU: MenuEntry[] = [
  { label: 'Toggle completions on/off', id: 'toggle' },
  { label: 'Snooze...', id: 'snooze' },
  { label: 'Select backend...', id: 'selectBackend' },
  NEXT_EDIT,
  ENABLE_NATIVE,
  MANAGE,
  { label: 'Settings...', id: 'openSettings' },
  { label: 'Set API key...', id: 'setApiKey' },
  RETRY,
  { label: 'Show log', id: 'showLog' },
  { label: 'About', id: 'about' },
];

/**
 * The status bar menu for the shown state: "Retry now" comes first while it is an error, "Resume now" while snoozed.
 * "Next Edit: <backend>" (or off) follows the backend selection, then "Enable native Next Edit UI..." unless the native UI is already on. With no backend configured, "Manage backends..." comes before both.
 */
export function menuEntries(shown: StatusState, backendCount: number, nextEditBackend: string | undefined, nativeNextEdit: boolean): MenuEntry[] {
  const menu = MENU.filter((e) => !(nativeNextEdit && e === ENABLE_NATIVE)).map((e) => (e === NEXT_EDIT ? { ...e, label: `Next Edit: ${nextEditBackend ?? 'off'}` } : e));
  let list = shown === 'error' ? [RETRY, ...menu.filter((e) => e !== RETRY)] : shown === 'snoozed' ? [RESUME, ...menu] : [...menu];
  if (backendCount === 0) list = [MANAGE, ...list.filter((e) => e !== MANAGE)];
  return list;
}
