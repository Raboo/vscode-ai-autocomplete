// The Backends page script. The extension host owns all state: each `state` message replaces the page, and the page
// posts the user's intents back. The typed API key lives only here (ui.typedKey) and is sent only in save, testForm
// and reloadModels.
import type { BackendForm, FormField, HostMessage, PageMessage, PageState, ServerTypeId } from '../../manage/protocol';
import { FORM_FIELDS, renderPage, type LocalUi } from './render';

interface VsCodeApi { postMessage(message: PageMessage): void }
declare function acquireVsCodeApi(): VsCodeApi;

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type Caret = { start: number; end: number; direction: 'forward' | 'backward' | 'none' };

const FIELDS: ReadonlySet<string> = new Set(FORM_FIELDS);
/** Releases a held render even if the pointerup never arrives. */
const HOLD_LIMIT_MS = 1000;

const vscode = acquireVsCodeApi();
const post = (message: PageMessage): void => vscode.postMessage(message);

let root: HTMLElement;
let state: PageState | undefined;
/** The edit form as last received or sent; each change builds on it. */
let form: BackendForm | undefined;
const ui: LocalUi = { typedKey: '', advancedOpen: false };
/** Text typed into a control since its last change event, carried over when a state arrives mid-typing. */
const uncommitted = new Map<string, string>();
/** Which edit the DOM shows: '' none, '+' a new backend, 'card:<id>' a saved one. */
let renderedEdit = '';
let renderedEditIds: string[] = [];
let rendering = false;
// A state that arrives between pointerdown and click would replace the button under the pointer and swallow the click.
let holding = false;
let heldRender = false;
let holdTimer: ReturnType<typeof setTimeout> | undefined;

const isControl = (el: unknown): el is Control =>
  el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
const isTextual = (el: unknown): el is HTMLInputElement | HTMLTextAreaElement =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'password'));
const editKeyOf = (s: PageState | undefined): string => (!s?.edit ? '' : s.edit.cardId === null ? '+' : `card:${s.edit.cardId}`);
const copyForm = (f: BackendForm): BackendForm => ({ ...f, changed: { ...f.changed } });

function selectionOf(el: Element | null): Caret | undefined {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return undefined;
  try {
    if (el.selectionStart === null || el.selectionEnd === null) return undefined;
    return { start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection ?? 'none' };
  } catch {
    return undefined;
  }
}

function focusById(id: string, sel?: Caret, preventScroll = true): boolean {
  const el = id ? document.getElementById(id) : null;
  if (!(el instanceof HTMLElement) || !root.contains(el) || el.hasAttribute('disabled')) return false;
  el.focus({ preventScroll });
  if (sel && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    try {
      el.setSelectionRange(sel.start, sel.end, sel.direction);
    } catch {
      // not a text control
    }
  }
  return true;
}

function render(): void {
  if (!state) return;
  if (holding) {
    heldRender = true;
    return;
  }
  const key = editKeyOf(state);
  const editChanged = key !== renderedEdit;
  const active = document.activeElement;
  const focusId = active instanceof HTMLElement && root.contains(active) ? active.id : '';
  const sel = selectionOf(active);
  if (editChanged) {
    // A different form: nothing typed for the previous one may follow it, least of all the key.
    ui.typedKey = '';
    ui.advancedOpen = false;
    uncommitted.clear();
  } else {
    const adv = document.getElementById('advanced');
    if (adv instanceof HTMLDetailsElement) ui.advancedOpen = adv.open;
  }
  const closedIds = renderedEditIds;

  rendering = true;
  try {
    root.innerHTML = renderPage(state, ui);
  } finally {
    rendering = false;
  }
  for (const [id, value] of uncommitted) {
    const el = document.getElementById(id);
    if (isTextual(el)) el.value = value;
    else uncommitted.delete(id);
  }
  renderedEdit = key;
  renderedEditIds = state.edit ? [state.edit.form.id, ...(state.edit.cardId !== null ? [state.edit.cardId] : [])] : [];

  if (editChanged && state.edit) {
    focusById('f-type', undefined, false);
  } else if (!focusById(focusId, sel) && editChanged) {
    // The form closed: return to the card it belonged to.
    for (const id of closedIds) if (focusById(`a-edit-${id}`, undefined, false)) break;
  }
}

function hold(): void {
  holding = true;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(release, HOLD_LIMIT_MS);
}

function release(): void {
  clearTimeout(holdTimer);
  if (!holding) return;
  holding = false;
  if (heldRender) {
    heldRender = false;
    render();
  }
}

function send(next: BackendForm): void {
  if (form && JSON.stringify(next) === JSON.stringify(form)) return;
  form = next;
  post({ type: 'formChanged', form: next });
}

/** Puts a control's value into the form and posts formChanged. A blank field counts as not changed. */
function commit(el: Control): void {
  if (!form || el.id === 'f-key') return;
  uncommitted.delete(el.id);
  const next = copyForm(form);
  const text = el instanceof HTMLInputElement && el.type === 'checkbox' ? String(el.checked) : el.value;
  if (el.id === 'f-type') next.type = text as ServerTypeId;
  else if (el.id === 'f-id') next.id = text;
  else if (el.id === 'f-url') next.baseUrl = text;
  else if (el.id === 'f-model') next.model = text;
  else if (el.id.startsWith('f-') && FIELDS.has(el.id.slice(2))) {
    const field = el.id.slice(2) as FormField;
    if (text.trim() === '') delete next.changed[field];
    else next.changed[field] = text;
  } else return;
  send(next);
}

function commitUncommitted(): void {
  for (const id of [...uncommitted.keys()]) {
    const el = document.getElementById(id);
    if (isControl(el)) commit(el);
    else uncommitted.delete(id);
  }
}

function withKey<T extends 'save' | 'testForm' | 'reloadModels'>(type: T, f: BackendForm): { type: T; form: BackendForm; apiKey?: string } {
  const key = state?.edit && state.edit.keyMode !== 'no' && ui.typedKey.trim() !== '' ? ui.typedKey : undefined;
  return { type, form: f, ...(key !== undefined ? { apiKey: key } : {}) };
}

function onClick(ev: MouseEvent): void {
  const target = ev.target instanceof Element ? ev.target.closest('button[data-action]') : null;
  if (!(target instanceof HTMLButtonElement) || target.disabled || !root.contains(target)) return;
  const id = target.dataset.id ?? '';
  const action = target.dataset.action;
  switch (action) {
    case 'add':
    case 'cancel':
    case 'openSettings':
      post({ type: action });
      break;
    case 'edit':
    case 'remove':
    case 'use':
    case 'test':
    case 'removeKey':
      if (id) post({ type: action, id });
      break;
    case 'save':
    case 'testForm':
    case 'reloadModels':
      commitUncommitted();
      if (form) post(withKey(action, form));
      break;
    case 'formChanged': {
      const field = target.dataset.reset ?? '';
      if (!form || !FIELDS.has(field)) break;
      uncommitted.delete(`f-${field}`);
      const next = copyForm(form);
      delete next.changed[field as FormField];
      send(next);
      break;
    }
  }
}

function onInput(ev: Event): void {
  const el = ev.target;
  if (el instanceof HTMLInputElement && el.id === 'f-key') ui.typedKey = el.value;
  else if (isTextual(el) && el.id) uncommitted.set(el.id, el.value);
}

function onChange(ev: Event): void {
  if (!rendering && isControl(ev.target)) commit(ev.target);
}

/** A value restored after a re-render may not fire change on blur; commit it on the way out instead. */
function onFocusOut(ev: FocusEvent): void {
  const el = ev.target;
  if (rendering || !isTextual(el) || !uncommitted.has(el.id)) return;
  if (el.value === el.defaultValue) uncommitted.delete(el.id);
  else commit(el);
}

function onMessage(ev: MessageEvent): void {
  const msg = ev.data as Partial<HostMessage> | null;
  if (typeof msg !== 'object' || msg === null || msg.type !== 'state' || typeof msg.state !== 'object' || msg.state === null) return;
  state = msg.state;
  form = state.edit ? copyForm(state.edit.form) : undefined;
  render();
}

function start(): void {
  root = document.createElement('main');
  root.id = 'app';
  document.body.append(root);
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('focusout', onFocusOut);
  document.addEventListener('pointerdown', (ev) => {
    if (!(ev.target instanceof Element && ev.target.closest('select'))) hold();
  }, true);
  const releaseAfterClick = (): void => void setTimeout(release, 0);
  window.addEventListener('pointerup', releaseAfterClick, true);
  window.addEventListener('pointercancel', releaseAfterClick, true);
  window.addEventListener('message', onMessage);
  post({ type: 'ready' });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
