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
const lm = { id: 'lm', kind: 'openai', hostFlavor: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', fimModel: 'llama-3' };
const cpp = { id: 'cpp', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012' };
const inputs = (over: Partial<PageInputs> = {}): PageInputs => ({
  settings: base(), rawBackends: [lm, cpp], keysStored: new Set(), local: new Map([['lm', true], ['cpp', true]]), detected: new Map(), tests: new Map(), ...over,
});
const ok: TestStep = { id: 'reach', state: 'ok', text: 'x' };
const form = (over: Partial<BackendForm> = {}): BackendForm => ({ type: 'lmstudio', id: 'lm', baseUrl: 'http://127.0.0.1:1234/v1', model: '', nextEditModel: '', use: { completions: true, nextEdit: true }, changed: {}, ...over });

describe('page state', () => {
  test('cards: in use, key stored, detected model, lock and template warning', () => {
    const s = buildPageState(inputs({ inUseId: 'lm', keysStored: new Set(['cpp']), detected: new Map([['cpp', 'qwen2.5-coder']]) }));
    expect(s.cards[0]).toMatchObject({ id: 'lm', typeLabel: 'LM Studio', inUse: true, keyStored: false, model: 'llama-3', modelDetected: false,
      warning: 'No completion template for this model', dot: 'yellow' });
    expect(s.cards[1]).toMatchObject({ id: 'cpp', inUse: false, keyStored: true, model: 'qwen2.5-coder', modelDetected: true, dot: 'grey' });
    expect(s.cards[1]!.warning).toBeUndefined();
    // the same template-less model on llama.cpp routes native: no warning
    const n = buildPageState(inputs({ rawBackends: [{ ...cpp, fimModel: 'llama-3' }] }));
    expect(n.cards[0]!.warning).toBeUndefined();
    // locked, and an id missing from `local` counts as not local
    const l = buildPageState(inputs({ settings: base(true), local: new Map([['lm', true]]) }));
    expect(l.cards[0]).toMatchObject({ warning: 'No completion template for this model', dot: 'yellow' });
    expect(l.cards[1]).toMatchObject({ warning: 'not used here (local only)', dot: 'lock' });
    expect(l).toMatchObject({ localOnly: true, completionsOn: true });
    expect(s.serverTypes[0]).toEqual({ id: 'llamacpp', label: 'llama.cpp' });
  });

  test('the card warning names the prompt mode when the mode, not the model, is the problem', () => {
    const native = buildPageState(inputs({ rawBackends: [{ ...lm, fimModel: 'qwen2.5-coder-7b', fimMode: 'native' }] }));
    expect(native.cards[0]).toMatchObject({ warning: 'prompt mode "native" does not work with this server', dot: 'yellow' });
    const mistral = buildPageState(inputs({ rawBackends: [{ id: 'cs', kind: 'mistral', baseUrl: 'https://codestral.mistral.ai', fimModel: 'codestral-latest', fimMode: 'template' }] }));
    expect(mistral.cards[0]!.warning).toBe('prompt mode "template" does not work with this server');
  });

  test('a card whose completion model is a Next Edit-only model has a warning naming it', () => {
    const sweep = { ...lm, fimModel: 'sweep-next-edit-v2-7b' };
    const s = buildPageState(inputs({ rawBackends: [sweep, { ...sweep, id: 'ne', use: ['nextEdit'] }] }));
    expect(s.cards[0]!.warning).toBe('sweep-next-edit-v2-7b is a Sweep Next Edit model; it cannot do completions; untick Completions, or choose a completion model');
    expect(s.cards[0]!.dot).toBe('yellow');
    // not used for completions: the Next Edit-only warning does not apply
    expect(s.cards[1]!.warning ?? '').not.toContain('Next Edit model');
  });

  test('modelTag: ready, chat prompt, cannot turn thinking off, or no route', () => {
    const cfg = (o: Partial<BackendConfig> = {}): BackendConfig => ({ id: 'lm', kind: 'openai', hostFlavor: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', fimMode: 'auto', headers: {}, use: { completions: true, nextEdit: true }, ...o });
    expect(modelTag(cfg(), 'qwen2.5-coder-7b', base())).toBe('ready');
    expect(modelTag(cfg(), 'zeta-2.1', base())).toBe('no completion template');
    expect(modelTag(cfg({ fim: { template: 'seed-coder' } }), 'zeta-2.1', base())).toBe('ready');
    expect(modelTag(cfg(), 'Qwen3.8-Flash-Next', base())).toBe('chat prompt');
    expect(modelTag(cfg(), 'gpt-oss-20b', base())).toBe('chat prompt, cannot turn thinking off');
    expect(modelTag(cfg(), 'z-ai/glm-5', base(), true)).toBe('chat prompt, cannot turn thinking off');
    expect(modelTag(cfg({ fimMode: 'chat' }), 'qwen2.5-coder-7b', base())).toBe('chat prompt');
    expect(modelTag(cfg({ fimMode: 'native' }), 'qwen2.5-coder-7b', base())).toBe('prompt mode "native" does not work with this server');
  });

  test('a Mistral chat-family model on kind mistral: the tag and the card say to choose a Codestral model', () => {
    const cs = { id: 'cs', kind: 'mistral', baseUrl: 'https://codestral.mistral.ai', fimMode: 'auto', headers: {}, use: { completions: true, nextEdit: true } } as const;
    expect(modelTag(cs, 'devstral-small-2507', base())).toBe('choose a Codestral model');
    expect(modelTag(cs, 'codestral-latest', base())).toBe('ready');
    const card = buildPageState(inputs({ rawBackends: [{ ...cs, fimModel: 'devstral-small-2507' }] })).cards[0]!;
    expect(card.warning).toBe("This model cannot complete through Mistral's FIM endpoint; choose a Codestral model");
  });

  test('card warnings: chat mode works on LM Studio; Mistral chat mode does not; cannotDisable warns', () => {
    const chat = buildPageState(inputs({ rawBackends: [{ ...lm, fimMode: 'chat' }] }));
    expect(chat.cards[0]!.warning).toBeUndefined();
    const mistral = buildPageState(inputs({ rawBackends: [{ id: 'cs', kind: 'mistral', baseUrl: 'https://codestral.mistral.ai', fimModel: 'codestral-latest', fimMode: 'chat' }] }));
    expect(mistral.cards[0]).toMatchObject({ warning: 'prompt mode "chat" does not work with this server', dot: 'yellow' });
    const thinks = buildPageState(inputs({ rawBackends: [{ ...lm, fimModel: 'gpt-oss-20b' }] }));
    expect(thinks.cards[0]).toMatchObject({ warning: 'This model cannot turn thinking off; completions are disabled', dot: 'yellow' });
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

describe('uses on the page', () => {
  const neOnly = { ...lm, id: 'ne', use: ['nextEdit'] };
  test('cards carry uses and the Next Edit in-use flag', () => {
    const s = buildPageState(inputs({ rawBackends: [lm, { ...neOnly, nextEditModel: 'zeta-2.1' }], nextEditInUseId: 'ne', inUseId: 'lm', local: new Map([['lm', true], ['ne', true]]) }));
    expect(s.cards[0]).toMatchObject({ uses: { completions: true, nextEdit: true }, nextEditInUse: false, inUse: true, model: 'llama-3' });
    expect(s.cards[1]).toMatchObject({ uses: { completions: false, nextEdit: true }, nextEditInUse: true, inUse: false, nextEditModel: 'zeta-2.1' });
    expect(s.cards[1]!.model).toBeUndefined();
    expect(s.cards[1]!.warning).toBeUndefined();
  });
  test('a Next Edit-only card has no completion-route warning at all', () => {
    for (const model of ['zeta-2.1', 'sweep-next-edit-v2-7b', 'llama-3']) {
      const s = buildPageState(inputs({ rawBackends: [{ ...neOnly, fimModel: model, nextEditModel: model }] }));
      expect(s.cards[0]!.warning).toBeUndefined();
    }
    const detected = buildPageState(inputs({ rawBackends: [{ id: 'ne', kind: 'openai', hostFlavor: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', use: ['nextEdit'] }], detected: new Map([['ne', 'zeta-2.1']]) }));
    expect(detected.cards[0]).toMatchObject({ nextEditModel: 'zeta-2.1', modelDetected: false });
    expect(detected.cards[0]!.warning).toBeUndefined();
    expect(detected.cards[0]!.model).toBeUndefined();
  });
  test('the Next Edit model of a card is the configured one, else the completion model, else the detected one', () => {
    const both = buildPageState(inputs({ rawBackends: [{ ...lm, nextEditModel: 'mercury' }, { ...lm, id: 'lm2' }, cpp, { ...cpp, id: 'c2', use: ['completions'] }], detected: new Map([['cpp', 'qwen3.8']]) }));
    expect(both.cards.map((c) => c.nextEditModel)).toEqual(['mercury', 'llama-3', 'qwen3.8', undefined]);
  });
  test('an entry without use builds the same card as before; uses is both', () => {
    const s = buildPageState(inputs({ inUseId: 'lm' }));
    expect(s.cards[0]).toEqual({ id: 'lm', typeLabel: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'llama-3', nextEditModel: 'llama-3', modelDetected: false, inUse: true, keyStored: false,
      warning: 'No completion template for this model', dot: 'yellow', uses: { completions: true, nextEdit: true }, nextEditInUse: false });
  });
  test('the edit view carries the form use and copies it as booleans only', () => {
    const e = buildPageState(inputs({ edit: { cardId: null, form: form({ use: { completions: false, nextEdit: true, extra: 1 } as never }), testing: false } })).edit!;
    expect(e.form.use).toEqual({ completions: false, nextEdit: true });
    const bad = buildPageState(inputs({ edit: { cardId: null, form: { ...form(), use: { completions: 'no', nextEdit: 0 } as never }, testing: false } })).edit!;
    expect(bad.form.use).toEqual({ completions: true, nextEdit: true });
    const missing = buildPageState(inputs({ edit: { cardId: null, form: { ...form(), use: undefined } as never, testing: false } })).edit!;
    expect(missing.form.use).toEqual({ completions: true, nextEdit: true });
    const none = buildPageState(inputs({ edit: { cardId: null, form: form({ use: { completions: false, nextEdit: false } }), testing: false } })).edit!;
    expect(none.errors.map((x) => x.field)).toContain('use');
  });
  test('the edit view names the Next Edit format', () => {
    const fmt = (f: Partial<BackendForm>, setting?: 'sweep', detected?: string): string | undefined => {
      const s = setting ? { ...base(), nextEdit: { ...base().nextEdit, format: setting } } : base();
      return buildPageState(inputs({ settings: s, ...(detected ? { detected: new Map([['lm', detected]]) } : {}), edit: { cardId: 'lm', form: form({ originalId: 'lm', ...f }), testing: false } })).edit!.nextEditFormat;
    };
    expect(fmt({ nextEditModel: 'zeta-2.1' })).toBe('Zeta 2.1 format');
    expect(fmt({ nextEditModel: 'sweep-next-edit-1.5b' })).toBe('Sweep v1 format');
    expect(fmt({ nextEditModel: 'sweep-next-edit-v2-7b' })).toBe('Sweep v2 format');
    expect(fmt({ model: 'qwen3.8' })).toBe('chat prompt (chatXtab)');
    expect(fmt({ model: 'qwen3.8' }, 'sweep')).toBe('Sweep v1 format');
    // both ticked, empty Next Edit model: the completion model decides
    expect(fmt({ model: 'zeta-2.1' })).toBe('Zeta 2.1 format');
    // Next Edit alone, empty Next Edit model: the detected model; the completion model is not used
    expect(fmt({ model: 'zeta-2.1', use: { completions: false, nextEdit: true } }, undefined, 'sweep-next-edit-1.5b')).toBe('Sweep v1 format');
    // Next Edit not used: no format
    expect(fmt({ nextEditModel: 'zeta-2.1', use: { completions: true, nextEdit: false } })).toBeUndefined();
  });
  test('the edit view of a Next Edit-only form has no completion warnings', () => {
    const e = buildPageState(inputs({ edit: { cardId: null, form: form({ nextEditModel: 'zeta-2.1', use: { completions: false, nextEdit: true } }), testing: false } })).edit!;
    expect(e.warnings).toEqual([]);
    const c = buildPageState(inputs({ edit: { cardId: null, form: form({ model: 'zeta-2.1' }), testing: false } })).edit!;
    expect(c.warnings.join()).toContain('Next Edit model');
  });
});
