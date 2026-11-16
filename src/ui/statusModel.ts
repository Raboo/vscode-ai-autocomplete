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

/** What runs: the status bar shows off only when neither completions nor Next Edit does, and says so when completions alone are off. */
export function activity(s: { enabled: boolean; fim: { enabled: boolean }; nextEdit: { enabled: boolean; backendId?: string } }): { on: boolean; note?: string } {
  const nextEdit = s.nextEdit.enabled && s.nextEdit.backendId !== undefined;
  if (!s.enabled || (!s.fim.enabled && !nextEdit)) return { on: false };
  return s.fim.enabled ? { on: true } : { on: true, note: 'Completions off' };
}

/** An entry of the status bar menu; `id` names the command (`aiAutocomplete.<id>`), except `resume`, which ends a snooze. */
export interface MenuEntry { label: string; id: string }

/** What the menu shows besides the status; a backend is undefined when that feature is off. */
export interface MenuInputs { backendCount: number; enabled: boolean; completionBackend?: string; nextEditBackend?: string; nativeNextEdit: boolean }

type MenuSettings = { enabled: boolean; backends: unknown[]; fim: { enabled: boolean; backendId?: string }; nextEdit: { enabled: boolean; backendId?: string } };

/**
 * The menu's inputs from the settings. The entries name their backends while the switch is off: that is what "Turn on" brings back.
 * Completions on without a backend serving them read "none"; Next Edit without a backend is simply off.
 */
export function menuInputs(s: MenuSettings, nativeNextEdit: boolean): MenuInputs {
  return {
    backendCount: s.backends.length,
    enabled: s.enabled,
    ...(s.fim.enabled ? { completionBackend: s.fim.backendId ?? 'none' } : {}),
    ...(s.nextEdit.enabled && s.nextEdit.backendId !== undefined ? { nextEditBackend: s.nextEdit.backendId } : {}),
    nativeNextEdit,
  };
}

const RETRY: MenuEntry = { label: 'Retry now', id: 'retry' };
const RESUME: MenuEntry = { label: 'Resume now', id: 'resume' };
const MANAGE: MenuEntry = { label: 'Manage backends...', id: 'manageBackends' };
const SET_UP_LOCAL: MenuEntry = { label: 'Set up local model...', id: 'setUpLocalModel' };
const SWITCH: MenuEntry = { label: 'Turn off AI Autocomplete', id: 'toggleEnabled' };
const COMPLETIONS: MenuEntry = { label: 'Completions: off', id: 'selectBackend' };
const NEXT_EDIT: MenuEntry = { label: 'Next Edit: off', id: 'selectNextEditBackend' };
const ENABLE_NATIVE: MenuEntry = { label: 'Enable native Next Edit UI...', id: 'enableNativeNextEdit' };
const MENU: MenuEntry[] = [
  SWITCH,
  { label: 'Snooze...', id: 'snooze' },
  COMPLETIONS,
  NEXT_EDIT,
  ENABLE_NATIVE,
  MANAGE,
  SET_UP_LOCAL,
  { label: 'Settings...', id: 'openSettings' },
  { label: 'Set API key...', id: 'setApiKey' },
  RETRY,
  { label: 'Show log', id: 'showLog' },
  { label: 'About', id: 'about' },
];

/**
 * The status bar menu for the shown state: "Retry now" comes first while it is an error, "Resume now" while snoozed.
 * "Turn off/on AI Autocomplete" switches completions and Next Edit together; "Completions: <backend>" and "Next Edit: <backend>" (or off) pick each one's backend,
 * then "Enable native Next Edit UI..." unless the native UI is already on. "Set up local model..." follows "Manage backends...";
 * with no backend configured, both come first of all.
 */
export function menuEntries(shown: StatusState, m: MenuInputs): MenuEntry[] {
  const label = (e: MenuEntry): MenuEntry => {
    if (e === SWITCH) return m.enabled ? e : { ...e, label: 'Turn on AI Autocomplete' };
    if (e === COMPLETIONS) return { ...e, label: `Completions: ${m.completionBackend ?? 'off'}` };
    if (e === NEXT_EDIT) return { ...e, label: `Next Edit: ${m.nextEditBackend ?? 'off'}` };
    return e;
  };
  const menu = MENU.filter((e) => !(m.nativeNextEdit && e === ENABLE_NATIVE)).map(label);
  let list = shown === 'error' ? [RETRY, ...menu.filter((e) => e !== RETRY)] : shown === 'snoozed' ? [RESUME, ...menu] : [...menu];
  if (m.backendCount === 0) list = [MANAGE, SET_UP_LOCAL, ...list.filter((e) => e !== MANAGE && e !== SET_UP_LOCAL)];
  return list;
}
