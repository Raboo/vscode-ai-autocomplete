// The Local Models page script. The extension host owns all state: each `state` message replaces the page, and the page
// posts the user's intents back. Text typed into a control survives a re-render (the page is polled while it is open).
import type { BackendUse } from '../../config/settings';
import type { HostMessage, LocalPageState, PageMessage } from '../../local/page/protocol';
import { renderPage } from './render';

interface VsCodeApi { postMessage(message: PageMessage): void }
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const post = (message: PageMessage): void => vscode.postMessage(message);

let root: HTMLElement;
let state: LocalPageState | undefined;
const typed = new Map<string, string>();

type Control = HTMLInputElement | HTMLTextAreaElement;
const isText = (el: unknown): el is Control =>
  (el instanceof HTMLInputElement && el.type !== 'checkbox' && el.type !== 'radio') || el instanceof HTMLTextAreaElement;
const byId = (id: string): HTMLInputElement | null => {
  const el = document.getElementById(id);
  return el instanceof HTMLInputElement ? el : null;
};
const value = (id: string): string => byId(id)?.value ?? '';
const optionalNumber = (id: string): number | undefined => {
  const v = value(id).trim();
  const n = Number(v);
  return v === '' || !Number.isFinite(n) ? undefined : n;
};

function render(): void {
  if (!state) return;
  const active = document.activeElement;
  const focusId = active instanceof HTMLElement && root.contains(active) ? active.id : '';
  const caret = isText(active) ? { start: active.selectionStart, end: active.selectionEnd } : undefined;
  root.innerHTML = renderPage(state);
  for (const [id, v] of typed) {
    const el = byId(id);
    if (el && el.value !== v) el.value = v;
  }
  const el = focusId ? document.getElementById(focusId) : null;
  if (el instanceof HTMLElement) {
    el.focus({ preventScroll: true });
    if (caret && isText(el) && caret.start !== null && caret.end !== null) {
      try { el.setSelectionRange(caret.start, caret.end); } catch { /* not a text control */ }
    }
  }
}

function pickedUses(): BackendUse[] {
  return [...document.querySelectorAll<HTMLInputElement>('.add-use')].filter((c) => c.checked).map((c) => c.value as BackendUse);
}

function onClick(ev: MouseEvent): void {
  const target = ev.target instanceof Element ? ev.target.closest<HTMLElement>('button[data-action]') : null;
  if (!target || (target as HTMLButtonElement).disabled) return;
  const name = target.dataset.name ?? '';
  switch (target.dataset.action) {
    case 'start': case 'stop': case 'restart': case 'changeModelsDir': case 'setToken': case 'removeToken': case 'openLog':
      return post({ type: target.dataset.action });
    case 'cancel': typed.clear(); return post({ type: 'cancel' });
    case 'setModelsInMemory': {
      const n = Math.floor(Number(value('models-in-memory')));
      return Number.isFinite(n) && n >= 1 ? post({ type: 'setModelsInMemory', n }) : undefined;
    }
    case 'download': case 'cancelDownload': case 'removeFile': case 'load': case 'unload': case 'edit': case 'hide': case 'unhide':
    case 'removeModel': case 'checkUpdate': case 'update':
      return post({ type: target.dataset.action, name });
    case 'use': return post({ type: 'use', name, uses: (target.dataset.uses ?? '').split(',').filter((u): u is BackendUse => u === 'completions' || u === 'nextEdit') });
    case 'saveModel': {
      if (!state?.form) return;
      const sampling = { temperature: optionalNumber('f-temperature'), topP: optionalNumber('f-topP'), topK: optionalNumber('f-topK'), maxTokens: optionalNumber('f-maxTokens') };
      typed.clear();
      return post({ type: 'saveModel', form: {
        name: state.form.name, contextTokens: Math.floor(optionalNumber('f-context') ?? state.form.contextTokens), extraArgs: value('f-extra'),
        sampling: Object.fromEntries(Object.entries(sampling).filter(([, v]) => v !== undefined)), otherOverridesMatch: state.form.otherOverridesMatch,
      } });
    }
    case 'addRepo': return post({ type: 'addRepo', repo: value('add-repo').trim() });
    case 'addFile': {
      const picked = document.querySelector<HTMLInputElement>('input[name="add-file"]:checked');
      const repo = state?.add?.repo ?? value('add-repo').trim();
      if (!picked) return;
      typed.clear();
      return post({ type: 'addFile', repo, path: picked.value, name: value('add-name').trim(), uses: pickedUses(), contextTokens: Math.floor(optionalNumber('add-context') ?? 8192) });
    }
  }
}

function onInput(ev: Event): void {
  const el = ev.target;
  if (isText(el) && el.id) typed.set(el.id, el.value);
}

// Picking a file suggests its name from the file name unless the user typed one.
function onChange(ev: Event): void {
  const el = ev.target;
  if (!(el instanceof HTMLInputElement) || el.name !== 'add-file') return;
  const name = byId('add-name');
  if (name && !typed.has('add-name')) {
    name.value = (el.value.split('/').pop() ?? el.value).replace(/\.gguf$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/-+$/, '');
  }
}

function onMessage(ev: MessageEvent<HostMessage>): void {
  if (ev.data?.type !== 'state') return;
  const hadForm = state?.form?.name;
  state = ev.data.state;
  if (hadForm !== state.form?.name) for (const id of [...typed.keys()]) if (id.startsWith('f-')) typed.delete(id);
  render();
}

function start(): void {
  root = document.createElement('div');
  document.body.append(root);
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  window.addEventListener('message', onMessage);
  post({ type: 'ready' });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
