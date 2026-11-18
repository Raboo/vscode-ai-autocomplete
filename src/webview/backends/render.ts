// Markup of the Backends page. Pure string building: no DOM types, so vitest runs it under node.
// Every string taken from the state goes through escapeHtml, in text and in (always double-quoted) attributes.
// The page CSP allows no inline styles or handlers: the markup uses classes, and main.ts delegates on data-action.
import type { CardView, Dot, EditView, ErrorField, FieldView, FormField, PageState, TestStep } from '../../manage/protocol';

export interface LocalUi { typedKey: string; advancedOpen: boolean }

const SECTIONS: readonly { title: string; fields: readonly FormField[] }[] = [
  { title: 'Prompt', fields: ['template', 'fimMode', 'thinking', 'multiline'] },
  { title: 'Context', fields: ['contextTokens', 'prefixLines', 'suffixLines', 'extraContext'] },
  { title: 'Generation', fields: ['temperature', 'topP', 'topK', 'maxTokens', 'debounceMs', 'timeoutMs'] },
];
const ADVANCED: readonly FormField[] = ['stop', 'headers', 'extraBody'];
/** Every form field, in page order. */
export const FORM_FIELDS: readonly FormField[] = [...SECTIONS.flatMap((s) => s.fields), ...ADVANCED];
const DECIMAL: ReadonlySet<FormField> = new Set(['temperature', 'topP']);

const DOT_LABEL: Record<Dot, string> = {
  grey: 'not tested this session', green: 'last test passed', yellow: 'warning', red: 'last test failed', lock: 'blocked here by local only',
};
const MARK: Record<TestStep['state'], { glyph: string; label: string }> = {
  ok: { glyph: '✓', label: 'passed' }, warn: { glyph: '!', label: 'warning' }, fail: { glyph: '✗', label: 'failed' },
};

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

const e = escapeHtml;

interface ButtonOpts { id?: string; dataId?: string; cls?: string; disabled?: boolean; extra?: string }
function button(action: string, label: string, o: ButtonOpts = {}): string {
  return `<button type="button" class="${o.cls ?? 'btn secondary'}"${o.id ? ` id="${e(o.id)}"` : ''} data-action="${e(action)}"`
    + `${o.dataId !== undefined ? ` data-id="${e(o.dataId)}"` : ''}${o.extra ?? ''}${o.disabled ? ' disabled' : ''}>${e(label)}</button>`;
}

function dot(d: Dot): string {
  const label = DOT_LABEL[d] ?? d;
  return `<span class="dot ${e(d)}" role="img" aria-label="${e(label)}" title="${e(label)}"></span>`;
}

function steps(list: TestStep[], note?: string): string {
  const items = list.map((s) => {
    const m = MARK[s.state] ?? MARK.fail;
    return `<li class="step ${e(s.state)}"><span class="mark" role="img" aria-label="${m.label}">${m.glyph}</span>`
      + `<span class="step-text">${e(s.text)}</span>${s.ms !== undefined ? `<span class="ms">${e(String(s.ms))} ms</span>` : ''}`
      + `${s.hint ? `<span class="step-hint">${e(s.hint)}</span>` : ''}</li>`;
  }).join('');
  return `<div class="result"><ul class="steps">${items}</ul>${note ? `<p class="hint">${e(note)}</p>` : ''}</div>`;
}

/** What is out of the ordinary in this workspace: local only on, completions off. Nothing when all is normal. */
function notesLine(s: PageState): string {
  const notes = [...(s.localOnly ? ['🔒 Local only'] : []), ...(s.completionsOn ? [] : ['Completions are off'])];
  return notes.length > 0 ? `<span class="muted">${notes.map(e).join(' · ')}</span>` : '';
}

function header(s: PageState): string {
  return '<header class="page-head"><h1>Backends</h1>'
    + notesLine(s)
    + button('openSettings', 'General settings…', { id: 'a-openSettings', cls: 'link' })
    + button('setUpLocal', 'Set up local model', { id: 'a-setUpLocal', cls: 'btn secondary push' })
    + button('add', '+ Add backend', { id: 'a-add', cls: 'btn primary' })
    + '</header>';
}

/** The in-use badges of a card: "Completions" and "Next Edit", for what the backend is selected for. */
function badges(c: CardView): string {
  return `${c.inUse ? '<span class="badge">Completions</span>' : ''}${c.nextEditInUse ? '<span class="badge">Next Edit</span>' : ''}`;
}

/** The Use for buttons of a saved backend: one per use it has and is not already selected for. */
function useButtons(c: CardView): string {
  return (c.uses.completions && !c.inUse ? button('use', 'Use for completions', { id: `a-use-${c.id}`, dataId: c.id }) : '')
    + (c.uses.nextEdit && !c.nextEditInUse ? button('useNextEdit', 'Use for Next Edit', { id: `a-useNextEdit-${c.id}`, dataId: c.id }) : '');
}

function collapsedCard(c: CardView): string {
  const model = c.model === undefined ? 'model: auto-detect' : c.modelDetected ? `${c.model} (detected)` : c.model;
  // The Next Edit model is named when it differs from the completion model (always, for a Next Edit-only backend).
  const nextEdit = c.uses.nextEdit && (!c.uses.completions || (c.nextEditModel !== undefined && c.nextEditModel !== c.model))
    ? [`Next Edit model: ${c.nextEditModel ?? 'auto-detect'}`] : [];
  const uses = c.uses.completions && c.uses.nextEdit ? 'Completions · Next Edit' : c.uses.completions ? 'Completions only' : 'Next Edit only';
  // A long URL is cut with an ellipsis by the stylesheet; the title shows all of it.
  const url = `<span class="url" title="${e(c.baseUrl)}">${e(c.baseUrl)}</span>`;
  const meta = [e(c.typeLabel), url, ...[uses, ...(c.uses.completions ? [model] : []), ...nextEdit, ...(c.keyStored ? ['API key set'] : [])].map(e)].join(' · ');
  const actions = button('test', 'Test', { id: `a-test-${c.id}`, dataId: c.id })
    + button('edit', 'Edit', { id: `a-edit-${c.id}`, dataId: c.id })
    + useButtons(c)
    + button('remove', 'Remove', { id: `a-remove-${c.id}`, dataId: c.id });
  return `<section class="card" id="card-${e(c.id)}"><div class="card-head">${dot(c.dot)}<h2 class="card-title">${e(c.id)}</h2>`
    + `${badges(c)}<span class="muted meta">${meta}</span>`
    + `<div class="actions push">${actions}</div></div>`
    + `${c.warning ? `<p class="card-warning ${c.dot === 'lock' ? 'locked' : 'warn'}">${c.dot === 'lock' ? '🔒' : '⚠'} ${e(c.warning)}</p>` : ''}`
    + `${c.test && c.test.length > 0 ? steps(c.test, 'Uses a built-in sample snippet, never your code.') : ''}</section>`;
}

type NoteKind = 'hint' | 'reason' | 'error';
const NOTE_CLASS: Record<NoteKind, string> = { hint: 'hint', reason: 'hint reason', error: 'error' };

/** The hint, reason and error lines under a control, and the aria-describedby that points at them. */
function notes(id: string, lines: { kind: NoteKind; text?: string | undefined }[]): { html: string; describedBy: string } {
  const shown = lines.filter((l): l is { kind: NoteKind; text: string } => !!l.text);
  const noteId = (i: number): string => `${e(id)}-note${i}`;
  return {
    html: shown.map((l, i) => `<div class="${NOTE_CLASS[l.kind]}" id="${noteId(i)}">${e(l.text)}</div>`).join(''),
    describedBy: shown.length > 0 ? ` aria-describedby="${shown.map((_, i) => noteId(i)).join(' ')}"` : '',
  };
}

function textInput(id: string, value: string, attrs = ''): string {
  return `<input type="text" id="${e(id)}" value="${e(value)}" spellcheck="false" autocomplete="off"${attrs}>`;
}

function select(id: string, value: string, options: readonly { value: string; label: string }[], attrs = ''): string {
  const all = options.some((o) => o.value === value) ? options : [{ value, label: value === '' ? 'none' : value }, ...options];
  const opts = all.map((o) => `<option value="${e(o.value)}"${o.value === value ? ' selected' : ''}>${e(o.label)}</option>`).join('');
  return `<select id="${e(id)}"${attrs}>${opts}</select>`;
}

function formField(v: FieldView): string {
  const name = e(v.field);
  const id = `f-${v.field}`;
  const n = notes(id, [{ kind: 'hint', text: v.hint }, { kind: 'reason', text: v.disabledReason }, { kind: 'error', text: v.error }]);
  const cls = [...(v.isDefault ? [] : ['changed']), ...(v.error ? ['invalid'] : [])].join(' ');
  const attrs = `${cls ? ` class="${cls}"` : ''}${n.describedBy}${v.error ? ' aria-invalid="true"' : ''}${v.disabledReason ? ' disabled' : ''}`;
  let control: string;
  if (v.field === 'extraContext') control = `<input type="checkbox" id="f-${name}"${v.value === 'true' ? ' checked' : ''}${attrs}>`;
  else if (v.options) control = select(id, v.value, v.options.map((o) => ({ value: o, label: v.optionLabels?.[o] ?? o })), attrs);
  // The parser drops one newline right after <textarea>, so a value that starts with a newline survives.
  else if (ADVANCED.includes(v.field)) control = `<textarea id="f-${name}" rows="3" spellcheck="false"${attrs}>\n${e(v.value)}</textarea>`;
  else control = textInput(id, v.value, ` inputmode="${DECIMAL.has(v.field) ? 'decimal' : 'numeric'}"${attrs}`);
  const marker = v.isDefault ? '<span class="marker default">default</span>'
    : button('formChanged', 'changed · reset', { id: `a-reset-${v.field}`, cls: 'marker changed', extra: ` data-reset="${name}" title="Reset to the default"` });
  return `<div class="field" data-field="${name}"><div class="label-row"><label for="f-${name}">${e(v.label)}</label>${marker}</div>${control}${n.html}</div>`;
}

function connection(s: PageState, ed: EditView, ui: LocalUi): string {
  const f = ed.form;
  const err = (field: ErrorField): string | undefined => ed.errors.find((x) => x.field === field)?.message;
  const invalid = (msg: string | undefined): string => (msg ? ' class="invalid" aria-invalid="true"' : '');

  const type = select('f-type', f.type, s.serverTypes.map((t) => ({ value: t.id, label: t.label })));

  const idErr = err('id');
  const idNotes = notes('f-id', [{ kind: 'hint', text: 'Lowercase letters, digits and dashes' }, { kind: 'error', text: idErr }]);
  const urlErr = err('baseUrl');
  const urlNotes = notes('f-url', [{ kind: 'error', text: urlErr }]);

  const models = ed.models ?? [];
  const usesCompletions = f.use.completions;
  const modelHint = models.length > 0 ? `Leave empty to auto-detect. The server lists ${models.length} model${models.length === 1 ? '' : 's'}.`
    : 'Leave empty to auto-detect. Reload the list to see what the server offers.';
  const modelNotes = notes('f-model', [{ kind: 'hint', text: modelHint }, { kind: 'error', text: ed.modelsError }]);
  // With Completions unticked the Next Edit field carries the list's hint, error and reload button.
  const neNotes = notes('f-nextEditModel', [{ kind: 'hint', text: ed.nextEditFormat }, ...(usesCompletions ? [] : [{ kind: 'hint' as const, text: modelHint }, { kind: 'error' as const, text: ed.modelsError }])]);
  const datalist = `<datalist id="f-model-list">${models.map((m) => `<option value="${e(m.id)}" label="${e(m.tag)}"></option>`).join('')}</datalist>`;
  const reload = button('reloadModels', '↻ reload list', { id: 'a-reloadModels', cls: 'link' });
  const nePlaceholder = !usesCompletions ? 'auto-detect' : f.model === '' ? 'same as the completion model' : `same as the completion model (${e(f.model)})`;

  const useErr = err('use');
  const useNotes = notes('f-use', [{ kind: 'error', text: useErr }]);
  const useAttrs = `${useNotes.describedBy}${useErr ? ' aria-invalid="true"' : ''}`;
  const check = (use: 'completions' | 'nextEdit', label: string): string =>
    `<span class="check"><input type="checkbox" id="f-use-${use}"${f.use[use] ? ' checked' : ''}${useAttrs}><label for="f-use-${use}">${label}</label></span>`;

  const keyId = f.originalId ?? ed.cardId ?? undefined;
  let key: string;
  if (ed.keyMode === 'no') {
    key = '<input type="password" id="f-key" placeholder="not needed for local servers" autocomplete="off" disabled>';
  } else {
    const placeholder = ed.keyStored ? 'stored' : ed.keyMode === 'yes' ? 'required' : 'optional';
    key = `<input type="password" id="f-key" value="${e(ui.typedKey)}" placeholder="${placeholder}" autocomplete="off" spellcheck="false">`;
  }
  const keyNotes = ed.keyMode === 'no' ? ''
    : `${ed.keyStored ? '<div class="hint">Leave empty to keep the stored key.</div>' : ''}`
      + `${!ed.keyStored && ui.typedKey === '' ? '<div class="hint note">Re-enter the key if you switched tabs</div>' : ''}`;
  const removeKey = ed.keyStored && keyId !== undefined ? button('removeKey', 'Remove key', { id: 'a-removeKey', dataId: keyId, cls: 'link' }) : '';

  return '<h3 class="section">Connection</h3><div class="grid">'
    + `<div class="field" data-field="type"><div class="label-row"><label for="f-type">Server type</label></div>${type}</div>`
    + `<div class="field" data-field="id"><div class="label-row"><label for="f-id">Name</label></div>${textInput('f-id', f.id, `${invalid(idErr)}${idNotes.describedBy}`)}${idNotes.html}</div>`
    + `<div class="field" data-field="url"><div class="label-row"><label for="f-url">URL</label></div>${textInput('f-url', f.baseUrl, ` inputmode="url"${invalid(urlErr)}${urlNotes.describedBy}`)}${urlNotes.html}</div>`
    + `<div class="field wide" data-field="use"><div class="label-row"><span class="label" id="f-use-label">Use for</span></div>`
    + `<div class="checks" role="group" aria-labelledby="f-use-label">${check('completions', 'Completions')}${check('nextEdit', 'Next Edit')}</div>${useNotes.html}</div>`
    + (usesCompletions
      ? `<div class="field wide" data-field="model"><div class="label-row"><label for="f-model">Model</label>${reload}</div>`
        + `${textInput('f-model', f.model, ` list="f-model-list" placeholder="auto-detect"${invalid(ed.modelsError)}${modelNotes.describedBy}`)}${modelNotes.html}</div>`
      : '')
    + (f.use.nextEdit
      ? `<div class="field wide" data-field="nextEditModel"><div class="label-row"><label for="f-nextEditModel">Next Edit model</label>${usesCompletions ? '' : reload}</div>`
        + `${textInput('f-nextEditModel', f.nextEditModel, ` list="f-model-list" placeholder="${nePlaceholder}"${usesCompletions ? '' : invalid(ed.modelsError)}${neNotes.describedBy}`)}${neNotes.html}</div>`
      : '')
    + datalist
    + `<div class="field" data-field="key"><div class="label-row"><label for="f-key">API key</label>${removeKey}</div>${key}${keyNotes}</div>`
    + '</div>';
}

function editCard(s: PageState, ed: EditView, ui: LocalUi): string {
  const saved = ed.cardId !== null ? s.cards.find((c) => c.id === ed.cardId) : undefined;
  const byField = new Map(ed.fields.map((v) => [v.field, v]));
  const fields = (list: readonly FormField[]): string => list.map((f) => byField.get(f)).filter((v): v is FieldView => v !== undefined).map(formField).join('');
  const sections = SECTIONS.map((sec) => `<h3 class="section">${sec.title}</h3><div class="grid">${fields(sec.fields)}</div>`).join('');
  const advancedOpen = ui.advancedOpen || ADVANCED.some((f) => byField.get(f)?.error !== undefined);
  const advanced = `<details class="advanced" id="advanced"${advancedOpen ? ' open' : ''}>`
    + '<summary>Advanced: stop sequences, extra HTTP headers, extra request body (JSON)</summary>'
    + `<div class="grid">${fields(ADVANCED)}</div></details>`;
  const warnings = ed.warnings.length > 0 ? `<ul class="warnings">${ed.warnings.map((w) => `<li>⚠ ${e(w)}</li>`).join('')}</ul>` : '';
  const actions = button('testForm', ed.testing ? 'Testing…' : 'Test connection', { id: 'a-testForm', cls: 'btn primary', disabled: ed.testing })
    + button('save', 'Save', { id: 'a-save', disabled: ed.testing })
    + button('cancel', 'Cancel', { id: 'a-cancel' })
    + (ed.cardId !== null && saved ? useButtons(saved) : '')
    + (ed.cardId !== null ? button('remove', 'Remove backend', { id: `a-remove-${ed.cardId}`, dataId: ed.cardId, cls: 'link danger push' }) : '');
  const result = ed.test && ed.test.length > 0
    ? steps(ed.test, 'Tested with the form\'s unsaved values. Uses a built-in sample snippet, never your code.') : '';
  const title = ed.cardId ?? (ed.form.id || 'new backend');
  return `<section class="card editing" id="${ed.cardId !== null ? `card-${e(ed.cardId)}` : 'card-new'}" aria-label="${e(`Edit ${title}`)}">`
    + `<div class="card-head">${dot(saved?.dot ?? 'grey')}<h2 class="card-title">${e(title)}</h2>`
    + `${saved ? badges(saved) : ''}<span class="muted">${ed.cardId === null ? 'new backend, not saved yet' : 'editing'}</span></div>`
    + connection(s, ed, ui) + sections + advanced + warnings
    + `<div class="actions form-actions">${actions}</div>${result}</section>`;
}

export function renderPage(state: PageState, ui: LocalUi): string {
  const ed = state.edit;
  let editShown = false;
  const cards = state.cards.map((c) => {
    if (ed && ed.cardId === c.id) {
      editShown = true;
      return editCard(state, ed, ui);
    }
    return collapsedCard(c);
  });
  // A new backend, or a draft whose card has gone from settings, gets its own card at the end.
  if (ed && !editShown) cards.push(editCard(state, ed, ui));
  const empty = cards.length === 0
    ? '<div class="empty muted"><p>No backends yet. <strong>Set up local model</strong> downloads a small model and runs it for you, '
      + 'or <strong>+ Add backend</strong> connects a server you already run.</p><div class="actions">'
      + button('setUpLocal', 'Set up local model', { id: 'a-empty-setUpLocal', cls: 'btn primary' })
      + button('add', '+ Add backend', { id: 'a-empty-add' })
      + '</div></div>'
    : '';
  return `${header(state)}${empty}<div class="cards">${cards.join('')}</div>`;
}
