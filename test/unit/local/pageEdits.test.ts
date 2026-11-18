import { describe, expect, test } from 'vitest';
import type { LocalModel } from '../../../src/local/modelList';
import {
  addModelEdits, modelForm, otherOverridesMatch, overrideKey, removeModelEdits, saveModelEdits, unhideEdits, useEdits,
} from '../../../src/local/page/edits';
import type { ModelForm } from '../../../src/local/page/protocol';

const model = (over: Partial<LocalModel> = {}): LocalModel => ({
  name: 'qwen2.5-coder-3b', label: 'Qwen', repo: 'o/r', revision: 'a'.repeat(40), file: 'q.gguf', bytes: 1, sha256: 'b'.repeat(64),
  uses: ['completions'], contextTokens: 8192, extraArgs: [], builtIn: true, hidden: false, ...over,
});
const form = (over: Partial<ModelForm> = {}): ModelForm => ({
  name: 'qwen2.5-coder-3b', contextTokens: 8192, extraArgs: '', sampling: {}, otherOverridesMatch: false, ...over,
});
const KEY = '^qwen2\\.5-coder-3b$';

describe('overrideKey and otherOverridesMatch', () => {
  test('escapes the model name as an anchored regex', () => {
    expect(overrideKey('qwen2.5-coder-3b')).toBe(KEY);
    expect(new RegExp(overrideKey('a+b(c)')).test('a+b(c)')).toBe(true);
  });
  test('another key that matches (case-insensitively, as presets do) counts; the exact key and invalid regexes do not', () => {
    expect(otherOverridesMatch('qwen2.5-coder-3b', { [KEY]: {} })).toBe(false);
    expect(otherOverridesMatch('qwen2.5-coder-3b', { [KEY]: {}, 'QWEN': {} })).toBe(true);
    expect(otherOverridesMatch('qwen2.5-coder-3b', { '(': {}, 'mellum': {} })).toBe(false);
    expect(otherOverridesMatch('qwen2.5-coder-3b', undefined)).toBe(false);
  });
});

describe('modelForm', () => {
  test('reads context, the typed extra arguments and the exact key sampling only', () => {
    const f = modelForm({
      model: model({ contextTokens: 4096 }),
      entries: [{ name: 'qwen2.5-coder-3b', extraArgs: '--threads 8' }],
      overrides: { [KEY]: { sampling: { temperature: 0.2, maxTokens: 64 } }, 'qwen': { sampling: { topK: 5 } } },
    });
    expect(f).toEqual({ name: 'qwen2.5-coder-3b', contextTokens: 4096, extraArgs: '--threads 8', sampling: { temperature: 0.2, maxTokens: 64 }, otherOverridesMatch: true });
  });
});

describe('saveModelEdits', () => {
  test('writes only the changed fields of the local.models entry, creating one for a built-in', () => {
    const r = saveModelEdits({ model: model(), entries: [{ name: 'other', hidden: true }], overrides: {}, form: form({ contextTokens: 4096 }) });
    expect(r).toEqual({ models: [{ name: 'other', hidden: true }, { name: 'qwen2.5-coder-3b', contextTokens: 4096 }] });
  });
  test('nothing changed writes nothing', () => {
    expect(saveModelEdits({ model: model(), entries: [], overrides: {}, form: form() })).toEqual({});
  });
  test('extra arguments are kept as typed; clearing them drops the field and a bare built-in entry', () => {
    const r1 = saveModelEdits({ model: model(), entries: [], overrides: {}, form: form({ extraArgs: ' --threads 8 ' }) });
    expect(r1).toEqual({ models: [{ name: 'qwen2.5-coder-3b', extraArgs: '--threads 8' }] });
    const r2 = saveModelEdits({ model: model(), entries: [{ name: 'qwen2.5-coder-3b', extraArgs: '--threads 8' }], overrides: {}, form: form() });
    expect(r2).toEqual({ models: [] });
  });
  test('an added model keeps its entry when a field is cleared', () => {
    const entry = { name: 'mine', repo: 'o/r', revision: 'c', file: 'm.gguf', bytes: 5, sha256: 'd', extraArgs: '--threads 2' };
    const r = saveModelEdits({ model: model({ name: 'mine', builtIn: false }), entries: [entry], overrides: {}, form: form({ name: 'mine' }) });
    expect(r).toEqual({ models: [{ name: 'mine', repo: 'o/r', revision: 'c', file: 'm.gguf', bytes: 5, sha256: 'd' }] });
  });
  test('refused extra arguments and bad numbers are errors, and nothing is written', () => {
    expect(saveModelEdits({ model: model(), entries: [], overrides: {}, form: form({ extraArgs: '--port 9' }) })).toEqual({ error: 'These extra arguments are not allowed: --port' });
    expect(saveModelEdits({ model: model(), entries: [], overrides: {}, form: form({ contextTokens: 3.5 }) })).toHaveProperty('error');
    expect(saveModelEdits({ model: model(), entries: [], overrides: {}, form: form({ sampling: { temperature: 9 } }) })).toHaveProperty('error');
  });
  test('sampling goes to modelOverrides["^<escaped>$"].sampling; other keys and other fields stay', () => {
    const overrides = { 'qwen': { sampling: { topK: 5 } }, [KEY]: { stop: ['\n'], sampling: { topK: 1 } } };
    const r = saveModelEdits({ model: model(), entries: [], overrides, form: form({ sampling: { temperature: 0.1, maxTokens: 32 } }) });
    expect(r).toEqual({ overrides: { 'qwen': { sampling: { topK: 5 } }, [KEY]: { stop: ['\n'], sampling: { temperature: 0.1, maxTokens: 32 } } } });
  });
  test('a new key is added when there was none', () => {
    const r = saveModelEdits({ model: model(), entries: [], overrides: undefined, form: form({ sampling: { topP: 0.9 } }) });
    expect(r).toEqual({ overrides: { [KEY]: { sampling: { topP: 0.9 } } } });
  });
  test('an empty sampling form removes that key (or only its sampling when the key has more)', () => {
    expect(saveModelEdits({ model: model(), entries: [], overrides: { [KEY]: { sampling: { topK: 1 } }, 'x': {} }, form: form() }))
      .toEqual({ overrides: { 'x': {} } });
    expect(saveModelEdits({ model: model(), entries: [], overrides: { [KEY]: { stop: ['a'], sampling: { topK: 1 } } }, form: form() }))
      .toEqual({ overrides: { [KEY]: { stop: ['a'] } } });
  });
});

describe('useEdits', () => {
  const sel = { fim: { enabled: true }, nextEdit: { enabled: true } };
  test('creates local on the router port with the model for the uses, and selects it for each use', () => {
    const r = useEdits({ backends: [{ id: 'other' }], name: 'sweep', uses: ['completions', 'nextEdit'], port: 8100, settings: sel });
    expect(r.backends).toEqual([{ id: 'other' }, { id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8100', use: ['completions', 'nextEdit'], model: 'sweep', nextEditModel: 'sweep' }]);
    expect(r.writes).toEqual([['completions.backend', 'local'], ['nextEdit.backend', 'local']]);
  });
  test('an existing local keeps the other use\'s model and its port; a use turned off is turned on', () => {
    const r = useEdits({
      backends: [{ id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012', model: 'qwen', nextEditModel: 'sweep' }],
      name: 'mellum', uses: ['completions'], port: 9999, settings: { fim: { enabled: false }, nextEdit: { enabled: true } },
    });
    expect(r.backends).toEqual([{ id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012', use: ['completions', 'nextEdit'], model: 'mellum', nextEditModel: 'sweep' }]);
    expect(r.writes).toEqual([['completions.backend', 'local'], ['completions.enabled', true]]);
  });
});

describe('removeModelEdits', () => {
  const local = { id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012', use: ['completions', 'nextEdit'], model: 'qwen', nextEditModel: 'sweep' };
  test('hide marks the entry hidden; a model not in use leaves the backends alone', () => {
    const r = removeModelEdits({ entries: [], backends: [local], name: 'mellum', mode: 'hide', selection: {} });
    expect(r).toEqual({ models: [{ name: 'mellum', hidden: true }], writes: [] });
  });
  test('remove drops the added entry; a model in use clears that field and deselects local for that use', () => {
    const r = removeModelEdits({
      entries: [{ name: 'qwen', repo: 'o/r' }, { name: 'z' }], backends: [local], name: 'qwen', mode: 'remove',
      selection: { completions: 'local', nextEdit: 'local' },
    });
    expect(r.models).toEqual([{ name: 'z' }]);
    expect(r.backends).toEqual([{ id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012', use: ['nextEdit'], nextEditModel: 'sweep' }]);
    expect(r.writes).toEqual([['completions.backend', undefined]]);
  });
  test('the old field name fimModel is cleared too; a selection of another backend is not touched', () => {
    const old = { id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012', fimModel: 'qwen' };
    const r = removeModelEdits({ entries: [], backends: [old], name: 'qwen', mode: 'hide', selection: { completions: 'remote' } });
    expect(r.backends).toEqual([]);
    expect(r.writes).toEqual([]);
  });
  test('local without any model left is removed and deselected for both uses', () => {
    const both = { ...local, model: 'sweep' };
    const r = removeModelEdits({ entries: [], backends: [both, { id: 'x' }], name: 'sweep', mode: 'hide', selection: { completions: 'local', nextEdit: 'local' } });
    expect(r.backends).toEqual([{ id: 'x' }]);
    expect(r.writes).toEqual([['completions.backend', undefined], ['nextEdit.backend', undefined]]);
  });
});

describe('unhideEdits and addModelEdits', () => {
  test('unhide drops hidden, and a bare built-in entry', () => {
    expect(unhideEdits([{ name: 'a', hidden: true }, { name: 'b', hidden: true, contextTokens: 5 }], 'a', true)).toEqual([{ name: 'b', hidden: true, contextTokens: 5 }]);
    expect(unhideEdits([{ name: 'b', hidden: true, contextTokens: 5 }], 'b', true)).toEqual([{ name: 'b', contextTokens: 5 }]);
  });
  test('add appends an entry pinned to the commit and checksum', () => {
    const r = addModelEdits({
      entries: [{ name: 'x' }], taken: ['x', 'sweep-next-edit-1.5b'], repo: 'o/r', revision: 'c'.repeat(40),
      file: { path: 'sub/M-Q8_0.gguf', bytes: 10, sha256: 'd'.repeat(64), supported: true }, name: 'm-q8_0', uses: ['completions'], contextTokens: 4096,
    });
    expect(r).toEqual({ models: [{ name: 'x' }, { name: 'm-q8_0', repo: 'o/r', revision: 'c'.repeat(40), file: 'sub/M-Q8_0.gguf', bytes: 10, sha256: 'd'.repeat(64), uses: ['completions'], contextTokens: 4096 }] });
  });
  test('add refuses a taken or malformed name, no uses, a bad context and an unsupported file', () => {
    const base = { entries: [], taken: ['x'], repo: 'o/r', revision: 'c', file: { path: 'a.gguf', bytes: 1, sha256: 'd', supported: true }, name: 'ok', uses: ['completions' as const], contextTokens: 4096 };
    expect(addModelEdits({ ...base, name: 'x' })).toHaveProperty('error');
    expect(addModelEdits({ ...base, name: 'Bad Name' })).toHaveProperty('error');
    expect(addModelEdits({ ...base, uses: [] })).toHaveProperty('error');
    expect(addModelEdits({ ...base, contextTokens: 0 })).toHaveProperty('error');
    expect(addModelEdits({ ...base, file: { path: 'a.gguf', bytes: 1, supported: false } })).toHaveProperty('error');
  });
});
