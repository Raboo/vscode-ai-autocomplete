import { describe, expect, test } from 'vitest';
import { parseSettings, type RawSettingsSource, type Settings } from '../../src/config/settings';
import { buildPageState, dotFor, type PageInputs } from '../../src/manage/pageState';
import type { BackendForm, TestStep } from '../../src/manage/protocol';

const none: RawSettingsSource = { inspect: () => undefined };
const base = (localOnly = false): Settings => {
  const s = parseSettings(none).settings;
  return { ...s, privacy: { localOnly } };
};
const lm = { id: 'lm', kind: 'openai', hostFlavor: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', fimModel: 'randmaru/zeta-2.1-mlx' };
const cpp = { id: 'cpp', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012' };
const inputs = (over: Partial<PageInputs> = {}): PageInputs => ({
  settings: base(), rawBackends: [lm, cpp], keysStored: new Set(), local: new Map([['lm', true], ['cpp', true]]), detected: new Map(), tests: new Map(), ...over,
});
const ok: TestStep = { id: 'reach', state: 'ok', text: 'x' };
const form = (over: Partial<BackendForm> = {}): BackendForm => ({ type: 'lmstudio', id: 'lm', baseUrl: 'http://127.0.0.1:1234/v1', model: '', changed: {}, ...over });

describe('page state', () => {
  test('cards: in use, key stored, detected model, lock and template warning', () => {
    const s = buildPageState(inputs({ inUseId: 'lm', keysStored: new Set(['cpp']), detected: new Map([['cpp', 'qwen2.5-coder']]) }));
    expect(s.cards[0]).toMatchObject({ id: 'lm', typeLabel: 'LM Studio', inUse: true, keyStored: false, model: 'randmaru/zeta-2.1-mlx', modelDetected: false,
      warning: 'No completion template for this model', dot: 'yellow' });
    expect(s.cards[1]).toMatchObject({ id: 'cpp', inUse: false, keyStored: true, model: 'qwen2.5-coder', modelDetected: true, dot: 'grey' });
    expect(s.cards[1]!.warning).toBeUndefined();
    // the same template-less model on llama.cpp routes native: no warning
    const n = buildPageState(inputs({ rawBackends: [{ ...cpp, fimModel: 'randmaru/zeta-2.1-mlx' }] }));
    expect(n.cards[0]!.warning).toBeUndefined();
    // locked, and an id missing from `local` counts as not local
    const l = buildPageState(inputs({ settings: base(true), local: new Map([['lm', true]]) }));
    expect(l.cards[0]).toMatchObject({ warning: 'No completion template for this model', dot: 'yellow' });
    expect(l.cards[1]).toMatchObject({ warning: 'not used here (local only)', dot: 'lock' });
    expect(l).toMatchObject({ localOnly: true, completionsOn: true });
    expect(s.serverTypes[0]).toEqual({ id: 'llamacpp', label: 'llama.cpp' });
  });

  test('dot precedence', () => {
    const warn: TestStep = { id: 'completion', state: 'warn', text: 'w' };
    const fail: TestStep = { id: 'model', state: 'fail', text: 'f' };
    expect(dotFor([fail, warn], true, true)).toBe('lock');
    expect(dotFor([ok, fail, warn], true, false)).toBe('red');
    expect(dotFor([ok, warn], false, false)).toBe('yellow');
    expect(dotFor([ok], true, false)).toBe('yellow');
    expect(dotFor([ok], false, false)).toBe('green');
    expect(dotFor(undefined, false, false)).toBe('grey');
  });

  test('edit view: defaults for an undetected model show the generic preset and the not-detected warning', () => {
    const s = buildPageState(inputs({ edit: { cardId: 'cpp', form: form({ type: 'llamacpp', id: 'cpp', originalId: 'cpp', baseUrl: 'http://127.0.0.1:8012' }), testing: false } }));
    expect(s.edit!.warnings).toContain('model not detected yet: Test or reload the list to detect it');
    expect(s.edit!.keyMode).toBe('no');
    expect(s.edit!.errors).toEqual([]);
    expect(s.edit!.fields.find((f) => f.field === 'temperature')!.isDefault).toBe(true);
    const d = buildPageState(inputs({ detected: new Map([['cpp', 'q']]), edit: { cardId: 'cpp', form: form({ originalId: 'cpp', id: 'cpp', type: 'llamacpp', baseUrl: 'http://x' }), testing: false } }));
    expect(d.edit!.warnings).not.toContain('model not detected yet: Test or reload the list to detect it');
    // own id is not taken; another card's id is
    const t = buildPageState(inputs({ edit: { cardId: null, form: form({ id: 'cpp' }), testing: false } }));
    expect(t.edit!.errors).toEqual([{ field: 'id', message: 'another backend already uses this name' }]);
  });

  test('page state never carries an API key', () => {
    const leaky = { ...form({ originalId: 'lm' }), apiKey: 'sk-secret' } as BackendForm;
    const json = JSON.stringify(buildPageState(inputs({ keysStored: new Set(['lm']), edit: { cardId: 'lm', form: leaky, testing: false } })));
    expect(json).not.toContain('sk-secret');
    expect(json).not.toContain('apiKey');
  });

  test('cards follow raw order and skip invalid entries', () => {
    const s = buildPageState(inputs({ rawBackends: [cpp, { id: 'bad', kind: 'nope' }, 7, lm, { ...cpp }] }));
    expect(s.cards.map((c) => c.id)).toEqual(['cpp', 'lm']);
    expect(buildPageState(inputs({ rawBackends: undefined })).cards).toEqual([]);
  });
});
