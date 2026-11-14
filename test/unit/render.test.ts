import { describe, expect, test } from 'vitest';
import type { CardView, EditView, FieldView, FormField, PageState, TestStep } from '../../src/manage/protocol';
import { escapeHtml, renderPage, type LocalUi } from '../../src/webview/backends/render';

const FIELDS: FormField[] = ['template', 'fimMode', 'multiline', 'contextTokens', 'prefixLines', 'suffixLines', 'extraContext',
  'temperature', 'topP', 'topK', 'maxTokens', 'debounceMs', 'timeoutMs', 'stop', 'headers', 'extraBody'];
const OPTIONS: Partial<Record<FormField, string[]>> = { template: ['qwen', 'seed-coder'], fimMode: ['auto', 'native', 'template', 'chat'], multiline: ['auto', 'always', 'never'] };
const VALUES: Partial<Record<FormField, string>> = { template: 'qwen', fimMode: 'auto', multiline: 'auto', extraContext: 'true', temperature: '0.1', debounceMs: 'auto' };

const field = (f: FormField, over: Partial<FieldView> = {}): FieldView => ({
  field: f, label: `Label ${f}`, value: VALUES[f] ?? '1', isDefault: true, hint: 'Default (built-in preset for this model)',
  ...(OPTIONS[f] ? { options: OPTIONS[f] } : {}), ...over,
});
const card = (over: Partial<CardView> = {}): CardView => ({
  id: 'local', typeLabel: 'llama.cpp', baseUrl: 'http://127.0.0.1:8012', modelDetected: false, inUse: false, keyStored: false, dot: 'grey', ...over,
});
const edit = (over: Partial<EditView> = {}): EditView => ({
  cardId: 'lm', form: { originalId: 'lm', type: 'lmstudio', id: 'lm', baseUrl: 'http://127.0.0.1:1234/v1', model: '', changed: {} },
  keyMode: 'optional', keyStored: false, fields: FIELDS.map((f) => field(f)), errors: [], warnings: [], testing: false, ...over,
});
const state = (over: Partial<PageState> = {}): PageState => ({
  completionsOn: true, localOnly: false, cards: [card(), card({ id: 'lm', typeLabel: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' })],
  serverTypes: [{ id: 'llamacpp', label: 'llama.cpp' }, { id: 'lmstudio', label: 'LM Studio' }], ...over,
});
const ui = (over: Partial<LocalUi> = {}): LocalUi => ({ typedKey: '', advancedOpen: false, ...over });
const count = (html: string, needle: string): number => html.split(needle).length - 1;
/** The markup of one field, from its wrapper to the next field wrapper. */
const fieldHtml = (html: string, f: string): string => {
  const start = html.indexOf(`data-field="${f}"`);
  expect(start, f).toBeGreaterThanOrEqual(0);
  const next = html.indexOf('data-field="', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
};

describe('backends page render', () => {
  test('escapeHtml escapes & < > " and \'', () => {
    expect(escapeHtml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&#39;f');
  });

  test('render escapes server-supplied text', () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const step: TestStep = { id: 'reach', state: 'fail', text: evil, hint: evil, ms: 3 };
    const html = renderPage(state({
      cards: [card({ model: evil, test: [step], warning: evil }), card({ id: 'lm', typeLabel: evil, baseUrl: evil })],
      edit: edit({ form: { originalId: 'lm', type: 'lmstudio', id: 'lm', baseUrl: evil, model: evil, changed: { temperature: evil } },
        models: [{ id: evil, ready: true }, { id: `${evil}2`, ready: false }], modelsError: evil, test: [step], warnings: [evil],
        errors: [{ field: 'id', message: evil }],
        fields: FIELDS.map((f) => field(f, f === 'temperature' ? { value: evil, isDefault: false, hint: evil, error: evil } : f === 'template' ? { options: [evil] } : {})) }),
    }), ui({ typedKey: evil }));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('alert(1)>');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    // the datalist option value, an attribute, is escaped too
    expect(html).toContain('value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
  });

  test('every form control has a stable id', () => {
    const html = renderPage(state({ edit: edit() }), ui());
    for (const id of [...FIELDS.map((f) => `f-${f}`), 'f-id', 'f-type', 'f-url', 'f-model', 'f-key']) {
      expect(count(html, `id="${id}"`), id).toBe(1);
    }
    // the Advanced fields stay in the DOM while the section is collapsed
    expect(html).toMatch(/<details[^>]*id="advanced"(?![^>]*\sopen)[^>]*>/);
    expect(renderPage(state({ edit: edit() }), ui({ advancedOpen: true }))).toMatch(/<details[^>]*id="advanced"[^>]*\sopen/);
  });

  test('changed field shows reset, default field shows default', () => {
    const html = renderPage(state({ edit: edit({ fields: FIELDS.map((f) => field(f, f === 'temperature' ? { value: '0.05', isDefault: false, hint: 'Default: 0.1 (built-in preset for this model)' } : {})) }) }), ui());
    const temp = fieldHtml(html, 'temperature');
    expect(temp).toContain('changed · reset');
    expect(temp).toMatch(/<button[^>]*data-action="formChanged"[^>]*data-reset="temperature"/);
    expect(temp).not.toContain('>default<');
    expect(temp).toContain('value="0.05"');
    const topP = fieldHtml(html, 'topP');
    expect(topP).toContain('>default<');
    expect(topP).not.toContain('changed · reset');
    expect(count(html, 'data-reset="')).toBe(1);
    expect(count(html, '>default<')).toBe(FIELDS.length - 1);
  });

  test('disabled field shows its reason', () => {
    const html = renderPage(state({ edit: edit({ fields: FIELDS.map((f) => field(f, f === 'topK' ? { disabledReason: 'not sent to hosted servers' } : {})) }) }), ui());
    const topK = fieldHtml(html, 'topK');
    expect(topK).toContain('not sent to hosted servers');
    expect(topK).toMatch(/<input[^>]*id="f-topK"[^>]*\sdisabled/);
    expect(fieldHtml(html, 'topP')).not.toMatch(/\sdisabled/);
  });

  test('collapsed card shows Test, Edit, Use for completions (not on the in-use card) and Remove', () => {
    const html = renderPage(state({ cards: [card({ inUse: true }), card({ id: 'lm' })] }), ui());
    for (const id of ['local', 'lm']) {
      for (const action of ['test', 'edit', 'remove']) expect(html, `${action} ${id}`).toMatch(new RegExp(`<button[^>]*data-action="${action}"[^>]*data-id="${id}"`));
    }
    expect(html).toMatch(/<button[^>]*data-action="use"[^>]*data-id="lm"[^>]*>Use for completions</);
    expect(html).not.toMatch(/data-action="use"[^>]*data-id="local"/);
    expect(html).toContain('in use');
    expect(count(html, '>Test<')).toBe(2);
    expect(count(html, '>Edit<')).toBe(2);
    expect(count(html, '>Remove<')).toBe(2);
  });

  test('header shows completions on/off, local only, the General settings link and Add backend', () => {
    const on = renderPage(state(), ui());
    expect(on).toContain('Completions on');
    expect(on).toContain('Local only: off in this workspace');
    expect(on).toMatch(/<button[^>]*data-action="openSettings"[^>]*>General settings…</);
    expect(on).toMatch(/<button[^>]*data-action="add"[^>]*>\+ Add backend</);
    const off = renderPage(state({ completionsOn: false, localOnly: true }), ui());
    expect(off).toContain('Completions off');
    expect(off).toContain('Local only: on in this workspace');
  });

  test('API key field: stored placeholder, Remove key, typed key and the re-enter note', () => {
    const stored = renderPage(state({ edit: edit({ keyStored: true }) }), ui());
    expect(stored).toMatch(/<input[^>]*id="f-key"[^>]*placeholder="stored"/);
    expect(stored).toMatch(/<button[^>]*data-action="removeKey"[^>]*data-id="lm"[^>]*>Remove key</);
    expect(stored).not.toContain('Re-enter the key if you switched tabs');
    const empty = renderPage(state({ edit: edit() }), ui());
    expect(empty).not.toContain('data-action="removeKey"');
    expect(empty).toContain('Re-enter the key if you switched tabs');
    const typed = renderPage(state({ edit: edit() }), ui({ typedKey: 'sk-typed' }));
    expect(typed).toMatch(/<input[^>]*id="f-key"[^>]*value="sk-typed"/);
    expect(typed).not.toContain('Re-enter the key if you switched tabs');
    // a server type that needs no key: the field is disabled and never shows a typed key
    const none = renderPage(state({ edit: edit({ keyMode: 'no' }) }), ui({ typedKey: 'sk-typed' }));
    expect(none).toMatch(/<input[^>]*id="f-key"[^>]*\sdisabled/);
    expect(none).not.toContain('sk-typed');
  });

  test('test results list each step with its mark, hint and time; testing disables Test and Save', () => {
    const steps: TestStep[] = [
      { id: 'reach', state: 'ok', text: 'Server answered', ms: 38 },
      { id: 'model', state: 'warn', text: 'No template', hint: 'Choose a template' },
      { id: 'completion', state: 'fail', text: 'Request failed', ms: 412 },
    ];
    const html = renderPage(state({ cards: [card({ test: steps, dot: 'red' })], edit: edit({ test: steps }) }), ui());
    expect(count(html, '✓')).toBe(2);
    expect(count(html, '✗')).toBe(2);
    expect(html).toContain('Choose a template');
    expect(html).toContain('38 ms');
    expect(html).toContain('412 ms');
    expect(html).toMatch(/<button[^>]*data-action="testForm"(?![^>]*disabled)/);
    const testing = renderPage(state({ edit: edit({ testing: true }) }), ui());
    expect(testing).toContain('Testing…');
    expect(testing).toMatch(/<button[^>]*data-action="testForm"[^>]*\sdisabled/);
    expect(testing).toMatch(/<button[^>]*data-action="save"[^>]*\sdisabled/);
  });

  test('model combo box lists the server models with ready or no completion template', () => {
    const html = renderPage(state({ edit: edit({ models: [{ id: 'qwen2.5-coder', ready: true }, { id: 'zeta', ready: false }] }) }), ui());
    expect(html).toMatch(/<input[^>]*id="f-model"[^>]*list="f-model-list"/);
    expect(html).toContain('<option value="qwen2.5-coder" label="ready">');
    expect(html).toContain('<option value="zeta" label="no completion template">');
    expect(html).toMatch(/<button[^>]*data-action="reloadModels"/);
  });

  test('markup has no inline styles or event handlers (the page CSP forbids them)', () => {
    const html = renderPage(state({ cards: [card({ inUse: true, keyStored: true, warning: 'w', dot: 'lock', test: [{ id: 'reach', state: 'ok', text: 'ok' }] })],
      edit: edit({ cardId: null, form: { type: 'lmstudio', id: 'lmstudio', baseUrl: '', model: '', changed: {} }, warnings: ['w'] }) }), ui());
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toContain('<script');
  });

  test('a new backend renders its form on a new card', () => {
    const html = renderPage(state({ edit: edit({ cardId: null, form: { type: 'lmstudio', id: 'lmstudio', baseUrl: '', model: '', changed: {} } }) }), ui());
    expect(count(html, 'id="f-id"')).toBe(1);
    expect(html).toContain('value="lmstudio"');
    // both saved cards stay collapsed, and a new card offers no Remove
    expect(count(html, '>Edit<')).toBe(2);
    expect(count(html, 'data-action="remove"')).toBe(2);
  });
});
