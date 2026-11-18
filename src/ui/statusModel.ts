import { sessionLine, type SessionStats } from '../completion/outcomes';
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

/** What runs: the status bar shows off only when neither completions nor Next Edit does. */
export function activity(s: { enabled: boolean; fim: { enabled: boolean }; nextEdit: { enabled: boolean; backendId?: string } }): { on: boolean } {
  const nextEdit = s.nextEdit.enabled && s.nextEdit.backendId !== undefined;
  return { on: s.enabled && (s.fim.enabled || nextEdit) };
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
/** In group order: Backends, Pause, Help (see menuGroups). */
const MENU: MenuEntry[] = [
  COMPLETIONS,
  NEXT_EDIT,
  MANAGE,
  SET_UP_LOCAL,
  ENABLE_NATIVE,
  SWITCH,
  { label: 'Snooze...', id: 'snooze' },
  { label: 'Settings...', id: 'openSettings' },
  { label: 'Set API key...', id: 'setApiKey' },
  RETRY,
  { label: 'Show log', id: 'showLog' },
  { label: 'Why no suggestion?', id: 'whyNoSuggestion' },
  { label: 'About', id: 'about' },
];

const GROUP_OF: Record<string, string> = {
  selectBackend: 'Backends',
  selectNextEditBackend: 'Backends',
  manageBackends: 'Backends',
  setUpLocalModel: 'Backends',
  enableNativeNextEdit: 'Backends',
  toggleEnabled: 'Pause',
  snooze: 'Pause',
  openSettings: 'Help',
  setApiKey: 'Help',
  retry: 'Help',
  showLog: 'Help',
  whyNoSuggestion: 'Help',
  about: 'Help',
};

/** A run of menu entries, under a separator named `title`; the entries that lead the menu have none. */
export interface MenuGroup { title?: string; entries: MenuEntry[] }

/**
 * menuEntries split for the quick pick's separators: the leading entries (Manage backends and Set up local model with no
 * backend; Retry now or Resume now) stay first without a heading, then the Backends, Pause and Help groups.
 */
export function menuGroups(entries: MenuEntry[]): MenuGroup[] {
  const groups: MenuGroup[] = [];
  let i = 0;
  const lead = (ids: string[]): void => {
    const run: MenuEntry[] = [];
    while (i < entries.length && ids.includes(entries[i].id)) run.push(entries[i++]);
    if (run.length > 0) groups.push({ entries: run });
  };
  lead(['manageBackends', 'setUpLocalModel']);
  lead(['retry', 'resume']);
  for (; i < entries.length; i++) {
    const title = GROUP_OF[entries[i].id];
    const last = groups[groups.length - 1];
    if (last?.title === title && title !== undefined) last.entries.push(entries[i]);
    else groups.push({ ...(title !== undefined ? { title } : {}), entries: [entries[i]] });
  }
  return groups;
}

/**
 * The status bar menu for the shown state: "Retry now" comes first while it is an error, "Resume now" while snoozed.
 * "Completions: <backend>" and "Next Edit: <backend>" (or off) pick each one's backend; "Set up local model..." follows
 * "Manage backends...", then "Enable native Next Edit UI..." unless the native UI is already on. "Turn off/on AI Autocomplete"
 * switches completions and Next Edit together. With no backend configured, Manage backends and Set up local model come first of all.
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

const STATE_NAMES: Record<StatusState, string> = { idle: 'Ready', loading: 'Requesting…', error: 'Error', disabled: 'Turned off', snoozed: 'Snoozed' };

/** A time of day as HH:MM, in local time. */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The shown state in words; a snooze with an end time (not "until restart") names it. */
export function stateName(state: StatusState, snoozedUntil: number): string {
  if (state === 'snoozed' && snoozedUntil < Number.MAX_SAFE_INTEGER) return `Snoozed until ${hhmm(snoozedUntil)}`;
  return STATE_NAMES[state];
}

/** The status bar tooltip: the state, its detail, each feature's backend (or off), local-only and the session counts. */
export function tooltipLines(o: { shown: LastStatus; snoozedUntil: number; locked: boolean; session: SessionStats; menu: MenuInputs }): string[] {
  const lines = [`AI Autocomplete: ${stateName(o.shown.state, o.snoozedUntil)}`];
  if (o.shown.detail) lines.push(o.shown.detail);
  lines.push(`Completions: ${o.menu.completionBackend ?? 'off'}`, `Next Edit: ${o.menu.nextEditBackend ?? 'off'}`);
  if (o.locked) lines.push('Local only: requests go to loopback or private-network hosts only');
  lines.push(sessionLine(o.session));
  return lines;
}
