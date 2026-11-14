import { describe, expect, test } from 'vitest';
import { parseSettings, type RawSettingsSource, type Settings } from '../../src/config/settings';
import { buildPageState, dotFor, modelTag, type PageInputs } from '../../src/manage/pageState';
import type { BackendConfig } from '../../src/types';
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

  test('the card warning names the prompt mode when the mode, not the model, is the problem', () => {
    const chat = buildPageState(inputs({ rawBackends: [{ ...lm, fimMode: 'chat' }] }));
    expect(chat.cards[0]).toMatchObject({ warning: 'chat FIM arrives in v0.2', dot: 'yellow' });
    const native = buildPageState(inputs({ rawBackends: [{ ...lm, fimModel: 'qwen2.5-coder-7b', fimMode: 'native' }] }));
    expect(native.cards[0]).toMatchObject({ warning: 'prompt mode "native" does not work with this server', dot: 'yellow' });
    const mistral = buildPageState(inputs({ rawBackends: [{ id: 'cs', kind: 'mistral', baseUrl: 'https://codestral.mistral.ai', fimModel: 'codestral-latest', fimMode: 'template' }] }));
    expect(mistral.cards[0]!.warning).toBe('prompt mode "template" does not work with this server');
  });

  test('modelTag: ready, or why the backend has no route for the model', () => {
    const cfg = (o: Partial<BackendConfig> = {}): BackendConfig => ({ id: 'lm', kind: 'openai', hostFlavor: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', fimMode: 'auto', headers: {}, ...o });
    expect(modelTag(cfg(), 'qwen2.5-coder-7b', base())).toBe('ready');
    expect(modelTag(cfg(), 'zeta-2.1', base())).toBe('no completion template');
    expect(modelTag(cfg({ fim: { template: 'seed-coder' } }), 'zeta-2.1', base())).toBe('ready');
    expect(modelTag(cfg({ fimMode: 'chat' }), 'qwen2.5-coder-7b', base())).toBe('chat FIM arrives in v0.2');
    expect(modelTag(cfg({ fimMode: 'native' }), 'qwen2.5-coder-7b', base())).toBe('prompt mode "native" does not work with this server');
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
    expect(s.edit!.keyMode).toBe('optional');
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

  test('only the form fields of `changed` reach the page', () => {
    const odd = form({ originalId: 'lm', changed: { temperature: '0.5', apiKey: 'sk-secret', constructor: 'x' } as BackendForm['changed'] });
    const s = buildPageState(inputs({ edit: { cardId: 'lm', form: odd, testing: false } }));
    expect(s.edit!.form.changed).toEqual({ temperature: '0.5' });
    expect(JSON.stringify(s)).not.toContain('sk-secret');
  });

  test('cards follow raw order and skip invalid entries', () => {
    const s = buildPageState(inputs({ rawBackends: [cpp, { id: 'bad', kind: 'nope' }, 7, lm, { ...cpp }] }));
    expect(s.cards.map((c) => c.id)).toEqual(['cpp', 'lm']);
    expect(buildPageState(inputs({ rawBackends: undefined })).cards).toEqual([]);
  });
});
