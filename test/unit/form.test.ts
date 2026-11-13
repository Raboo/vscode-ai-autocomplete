import { describe, expect, test } from 'vitest';
import { fieldViews, entryToForm, formToConfig, formToEntry, formWarnings, newForm, planRename, removeBackend, upsertBackend, validateForm } from '../../src/manage/form';
import type { BackendForm } from '../../src/manage/protocol';
import { parseSettings, type RawSettingsSource, type Settings } from '../../src/config/settings';

const none: RawSettingsSource = { inspect: () => undefined };
const settings = (extraContext?: boolean): Settings => {
  const s = parseSettings(none).settings;
  return extraContext === undefined ? s : { ...s, fim: { ...s.fim, extraContext } };
};
const form = (over: Partial<BackendForm> = {}): BackendForm => ({ type: 'lmstudio', id: 'lm', baseUrl: 'http://127.0.0.1:1234/v1', model: '', changed: {}, ...over });
const view = (vs: ReturnType<typeof fieldViews>, f: string) => vs.find((v) => v.field === f)!;

describe('form model', () => {
  test('newForm prefills from the type', () => {
    expect(newForm('lmstudio', ['lmstudio'])).toEqual({ type: 'lmstudio', id: 'lmstudio-2', baseUrl: 'http://127.0.0.1:1234/v1', model: '', changed: {} });
    expect(newForm('mistral', [])).toMatchObject({ id: 'codestral', model: 'codestral-latest' });
  });

  test('entryToForm → formToEntry round-trips a full entry', () => {
    const entry = {
      id: 'lm', kind: 'openai', hostFlavor: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', fimModel: 'zeta', fimMode: 'template', headers: { 'X-A': 'b' },
      fim: { template: 'seed-coder', contextTokens: 8000, prefixLines: 100, suffixLines: 20, extraContext: false, multiline: 'never', maxTokens: 64, temperature: 0.05,
        topP: 0.9, topK: 20, debounceMs: 100, timeoutMs: 9000, stop: ['a', 'b'], extraBody: { x: 1 } },
    };
    const f = entryToForm(entry);
    expect(f).toMatchObject({ originalId: 'lm', type: 'lmstudio', id: 'lm', model: 'zeta' });
    expect(f.changed).toMatchObject({ temperature: '0.05', stop: 'a\nb', extraContext: 'false', headers: 'X-A: b', fimMode: 'template' });
    expect(formToEntry(f, entry)).toEqual(entry);
    expect(formToEntry(f)).toEqual(entry);
  });

  test('formToEntry keeps unknown fields of the original', () => {
    const original = { id: 'lm', kind: 'openai', hostFlavor: 'lmstudio', baseUrl: 'http://x/v1', nextEditModel: 'zeta', custom: 1, fim: { temperature: 0.1, future: true } };
    const out = formToEntry(form({ baseUrl: 'http://x/v1', originalId: 'lm', changed: { temperature: '0.05' } }), original);
    expect(out).toMatchObject({ nextEditModel: 'zeta', custom: 1, fim: { temperature: 0.05, future: true } });
  });

  test('formToEntry drops a reset field but keeps unknown fim keys', () => {
    const original = { id: 'lm', kind: 'openai', baseUrl: 'http://x/v1', fim: { temperature: 0.1, future: true }, headers: { A: 'b' }, fimMode: 'native' };
    const out = formToEntry(form({ changed: {} }), original);
    expect(out.fim).toEqual({ future: true });
    expect(out).not.toHaveProperty('headers');
    expect(out).not.toHaveProperty('fimMode');
  });

  test('formToEntry writes only changed fields', () => {
    const out = formToEntry(form());
    expect(out).toEqual({ id: 'lm', kind: 'openai', hostFlavor: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' });
    expect(out).not.toHaveProperty('fim');
  });

  test('formToEntry omits hostFlavor for llama.cpp and Mistral, and an empty model', () => {
    expect(formToEntry(form({ type: 'llamacpp' }))).toEqual({ id: 'lm', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:1234/v1' });
    expect(formToEntry(form({ type: 'mistral', model: 'codestral-latest' }))).toMatchObject({ kind: 'mistral', fimModel: 'codestral-latest' });
    expect(formToEntry(form({ type: 'mistral' }))).not.toHaveProperty('hostFlavor');
  });

  test('formToEntry keeps an unlisted kind/flavor pair under type other', () => {
    const original = { id: 'or', kind: 'openai', hostFlavor: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' };
    const f = entryToForm(original);
    expect(f.type).toBe('other');
    expect(formToEntry(f, original)).toEqual(original);
  });

  test('formToEntry converts text to types; blank values are not written', () => {
    const out = formToEntry(form({ changed: { stop: 'a\n\nb', headers: 'X-K: v: w\nY:z', extraBody: '{"a":1}', topK: '', extraContext: 'true', maxTokens: '32' } }));
    expect(out).toMatchObject({ headers: { 'X-K': 'v: w', Y: 'z' }, fim: { stop: ['a', 'b'], extraBody: { a: 1 }, extraContext: true, maxTokens: 32 } });
    expect(out.fim).not.toHaveProperty('topK');
  });

  test('formToConfig parses through the settings parser', () => {
    expect(formToConfig(form({ changed: { temperature: '0.3' } }))).toMatchObject({ id: 'lm', kind: 'openai', fim: { temperature: 0.3 } });
    expect(formToConfig(form({ baseUrl: '' }))).toBeUndefined();
  });

  test('validateForm reports range, id, duplicate id, URL and JSON errors', () => {
    const errs = validateForm(form({ id: 'Bad Id', baseUrl: 'ftp://x', changed: { temperature: '3', topP: '0', topK: '1.5', maxTokens: '5000', contextTokens: '10', extraBody: '[1]', headers: 'nocolon', debounceMs: 'abc' } }), []);
    const fields = errs.map((e) => e.field).sort();
    expect(fields).toEqual(['baseUrl', 'contextTokens', 'debounceMs', 'extraBody', 'headers', 'id', 'maxTokens', 'temperature', 'topK', 'topP'].sort());
    expect(validateForm(form({ id: 'a' }), ['a'])).toEqual([{ field: 'id', message: expect.any(String) }]);
    expect(validateForm(form({ id: 'a', originalId: 'a' }), ['a'])).toEqual([]);
    expect(validateForm(form({ changed: { extraBody: '{bad' } }), []).map((e) => e.field)).toEqual(['extraBody']);
    expect(validateForm(form({ changed: { temperature: '2', topP: '1', topK: '0', maxTokens: '4096', timeoutMs: '500' } }), [])).toEqual([]);
  });

  test('validateForm requires a URL except for other with nothing typed', () => {
    expect(validateForm(form({ baseUrl: '' }), []).map((e) => e.field)).toEqual(['baseUrl']);
    expect(validateForm(form({ type: 'other', baseUrl: '' }), [])).toEqual([]);
  });

  test('fieldViews prefill defaults with sources', () => {
    const vs = fieldViews(form({ type: 'llamacpp', baseUrl: 'http://127.0.0.1:8012' }), 'qwen2.5-coder-1.5b', settings(), []);
    expect(vs.map((v) => v.field)).toEqual(['template', 'fimMode', 'multiline', 'contextTokens', 'prefixLines', 'suffixLines', 'extraContext', 'temperature', 'topP', 'topK', 'maxTokens', 'debounceMs', 'timeoutMs', 'stop', 'headers', 'extraBody']);
    expect(view(vs, 'temperature')).toMatchObject({ label: 'Temperature', value: '0.1', isDefault: true, hint: 'Default (built-in preset for this model)' });
    expect(view(vs, 'prefixLines')).toMatchObject({ value: '200', hint: 'Default (your settings)' });
    expect(view(vs, 'contextTokens')).toMatchObject({ value: '4700', hint: 'Default (built-in default)' });
    expect(view(vs, 'debounceMs')).toMatchObject({ value: 'auto', isDefault: true, hint: 'adaptive, starts at 75 ms (local) or 250 ms (hosted)' });
    expect(view(vs, 'template').options).toContain('qwen');
    expect(view(vs, 'fimMode').options).toEqual(['auto', 'native', 'template', 'chat']);
  });

  test('fieldViews shows a changed field with its default in the hint', () => {
    const vs = fieldViews(form({ changed: { temperature: '0.5' } }), 'qwen2.5-coder-1.5b', settings(), [{ field: 'temperature', message: 'bad' }]);
    expect(view(vs, 'temperature')).toMatchObject({ value: '0.5', isDefault: false, hint: 'Default: 0.1 (built-in preset for this model)', error: 'bad' });
  });

  test('fieldViews disables topK for hosted, template for native, topP for mistral', () => {
    const q = 'qwen2.5-coder-1.5b';
    expect(view(fieldViews(form({ type: 'deepseek' }), q, settings(), []), 'topK').disabledReason).toBe('not sent to hosted servers');
    expect(view(fieldViews(form({ type: 'lmstudio' }), q, settings(), []), 'topK').disabledReason).toBeUndefined();
    expect(view(fieldViews(form({ type: 'llamacpp' }), q, settings(), []), 'template').disabledReason).toBe('the server builds the prompt');
    expect(view(fieldViews(form({ type: 'lmstudio' }), q, settings(), []), 'template').disabledReason).toBeUndefined();
    expect(view(fieldViews(form({ type: 'mistral' }), 'codestral-latest', settings(), []), 'topP').disabledReason).toBe('not sent while temperature is set');
    expect(view(fieldViews(form({ type: 'lmstudio' }), q, settings(false), []), 'extraContext').disabledReason).toBe('off in your settings');
  });

  test('formWarnings flags more than 4 stop sequences on a hosted type', () => {
    const f = form({ type: 'deepseek', baseUrl: 'https://api.deepseek.com/beta', changed: { stop: '1\n2\n3\n4\n5\n6' } });
    expect(formWarnings(f, undefined, settings())).toEqual(['only the first 4 stop sequences are sent']);
    expect(formWarnings(form({ changed: { stop: '1\n2\n3\n4\n5\n6' } }), undefined, settings())).toEqual([]);
  });

  test('upsert keeps other entries and unknown fields', () => {
    const raw = [{ id: 'a', x: 1 }, { id: 'b' }];
    const out = upsertBackend(raw, { id: 'b', kind: 'llamacpp' });
    expect(out).toEqual([{ id: 'a', x: 1 }, { id: 'b', kind: 'llamacpp' }]);
    expect(out[0]).toBe(raw[0]);
    expect(upsertBackend(raw, { id: 'c' })).toEqual([...raw, { id: 'c' }]);
    expect(upsertBackend(raw, { id: 'z', k: 1 }, 'a')).toEqual([{ id: 'z', k: 1 }, { id: 'b' }]);
    expect(raw).toEqual([{ id: 'a', x: 1 }, { id: 'b' }]);
  });

  test('upsert on a non-array setting starts a new list', () => {
    expect(upsertBackend(undefined, { id: 'a' })).toEqual([{ id: 'a' }]);
    expect(upsertBackend('junk', { id: 'a' })).toEqual([{ id: 'a' }]);
  });

  test('removeBackend drops one entry', () => {
    expect(removeBackend([{ id: 'a' }, { id: 'b', y: 2 }], 'a')).toEqual([{ id: 'b', y: 2 }]);
    expect(removeBackend(undefined, 'a')).toEqual([]);
  });

  test('planRename moves the key and the user fim.backend, warns for a workspace one', () => {
    expect(planRename('a', 'b', 'a', 'a')).toEqual({ moveKey: true, updateUserFimBackend: true, warnWorkspace: true });
    expect(planRename('a', 'b', 'x', undefined)).toEqual({ moveKey: true, updateUserFimBackend: false, warnWorkspace: false });
    expect(planRename('a', 'a', 'a', 'a')).toEqual({ moveKey: false, updateUserFimBackend: false, warnWorkspace: false });
  });
});
