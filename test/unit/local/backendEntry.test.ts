import { describe, expect, test } from 'vitest';
import { parseSettings, type Inspected, type RawSettingsSource, type Settings } from '../../../src/config/settings';
import { MANAGED_KEY, localBackendEntry, localBackendId, parseManaged, portFor, serversToStart, type ManagedServer } from '../../../src/local/backendEntry';
import { RECIPES, type Recipe } from '../../../src/local/recipes';

function src(map: Record<string, Inspected<unknown>>): RawSettingsSource {
  return { inspect: <T>(key: string) => map[key] as Inspected<T> | undefined };
}
const recipe = (id: string): Recipe => {
  const r = RECIPES.find((x) => x.id === id);
  if (!r) throw new Error(`no recipe ${id}`);
  return r;
};
const both = recipe('sweep-1.5b');
const completionsOnly = recipe('qwen2.5-coder-1.5b');

describe('localBackendId', () => {
  test('llama-server and LM Studio ids', () => {
    expect(localBackendId(recipe('mellum-4b'), 'llamaServer')).toBe('local-mellum-4b');
    expect(localBackendId(recipe('mellum-4b'), 'lmStudio')).toBe('local-mellum-4b-lmstudio');
  });
  test('dots in a recipe id become dashes, because backend ids do not allow dots', () => {
    expect(localBackendId(both, 'llamaServer')).toBe('local-sweep-1-5b');
    expect(localBackendId(both, 'lmStudio')).toBe('local-sweep-1-5b-lmstudio');
  });
  test('ids pass the settings id pattern for every recipe', () => {
    for (const r of RECIPES) {
      for (const rt of ['llamaServer', 'lmStudio'] as const) {
        const { settings, problems } = parseSettings(src({ backends: { globalValue: [localBackendEntry(r, rt, 8012)] } }));
        expect(problems).toEqual([]);
        expect(settings.backends.map((b) => b.id)).toEqual([localBackendId(r, rt)]);
      }
    }
  });
});

describe('localBackendEntry', () => {
  test('llama-server entry for a recipe that serves both uses', () => {
    const entry = localBackendEntry(both, 'llamaServer', 8123);
    expect(entry).toEqual({
      id: 'local-sweep-1-5b', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8123',
      use: ['completions', 'nextEdit'], fimModel: both.modelName, nextEditModel: both.modelName,
    });
    const { settings, problems } = parseSettings(src({ backends: { globalValue: [entry] } }));
    expect(problems).toEqual([]);
    expect(settings.backends[0]).toMatchObject({
      id: 'local-sweep-1-5b', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8123',
      fimModel: both.modelName, nextEditModel: both.modelName, use: { completions: true, nextEdit: true },
    });
  });
  test('LM Studio entry is an openai backend with the lmstudio flavor and a /v1 base URL', () => {
    const entry = localBackendEntry(both, 'lmStudio', 1234);
    const { settings, problems } = parseSettings(src({ backends: { globalValue: [entry] } }));
    expect(problems).toEqual([]);
    expect(settings.backends[0]).toMatchObject({
      id: 'local-sweep-1-5b-lmstudio', kind: 'openai', hostFlavor: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1',
      fimModel: both.modelName, nextEditModel: both.modelName, use: { completions: true, nextEdit: true },
    });
  });
  test('a completions-only recipe has no nextEditModel and serves completions only', () => {
    for (const rt of ['llamaServer', 'lmStudio'] as const) {
      const entry = localBackendEntry(completionsOnly, rt, 8012);
      expect(entry).not.toHaveProperty('nextEditModel');
      const { settings } = parseSettings(src({ backends: { globalValue: [entry] } }));
      expect(settings.backends[0].fimModel).toBe(completionsOnly.modelName);
      expect(settings.backends[0].nextEditModel).toBeUndefined();
      expect(settings.backends[0].use).toEqual({ completions: true, nextEdit: false });
    }
  });
  test('a Next Edit only recipe has no fimModel', () => {
    const entry = localBackendEntry({ ...both, uses: ['nextEdit'] }, 'llamaServer', 8012);
    expect(entry).not.toHaveProperty('fimModel');
    expect(entry.nextEditModel).toBe(both.modelName);
    expect(entry.use).toEqual(['nextEdit']);
  });
  test('the entry does not share the recipe uses array', () => {
    const entry = localBackendEntry(both, 'llamaServer', 8012);
    (entry.use as string[]).push('x');
    expect(both.uses).toEqual(['completions', 'nextEdit']);
  });
});

describe('parseManaged', () => {
  const ok: ManagedServer = { backendId: 'local-a', recipeId: 'a', file: '/m/a.gguf', port: 8012 };
  test('the state key', () => {
    expect(MANAGED_KEY).toBe('localServers');
  });
  test('keeps valid entries and drops malformed ones', () => {
    const raw = [
      ok,
      { ...ok, backendId: 1 },
      { ...ok, recipeId: undefined },
      { ...ok, file: null },
      { ...ok, port: 0 },
      { ...ok, port: 65536 },
      { ...ok, port: 80.5 },
      { ...ok, port: '8012' },
      'text',
      null,
      [],
      { ...ok, backendId: 'local-b', port: 65535, extra: 'dropped' },
    ];
    expect(parseManaged(raw)).toEqual([ok, { ...ok, backendId: 'local-b', port: 65535 }]);
  });
  test('anything that is not an array gives an empty list', () => {
    for (const raw of [undefined, null, 'x', 7, {}, { 0: ok }]) expect(parseManaged(raw)).toEqual([]);
  });
});

describe('serversToStart', () => {
  const m = (id: string, port: number): ManagedServer => ({ backendId: id, recipeId: id, file: `/m/${id}.gguf`, port });
  const a = m('a', 8012);
  const b = m('b', 8013);
  const c = m('c', 8014);
  function settings(map: Record<string, unknown>): Settings {
    const entries = ['a', 'b', 'c'].map((id) => ({ id, kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012' }));
    const inspected: Record<string, Inspected<unknown>> = { backends: { globalValue: entries } };
    for (const [k, v] of Object.entries(map)) inspected[k] = { globalValue: v };
    return parseSettings(src(inspected)).settings;
  }
  test('selected for completions', () => {
    expect(serversToStart([a, b, c], settings({ 'fim.backend': 'b', 'nextEdit.enabled': false }))).toEqual([b]);
  });
  test('selected for Next Edit', () => {
    expect(serversToStart([a, b, c], settings({ 'fim.enabled': false, 'nextEdit.enabled': true, 'nextEdit.backend': 'c' }))).toEqual([c]);
  });
  test('selected for both gives one entry per server, in managed order', () => {
    expect(serversToStart([a, b, c], settings({ 'fim.backend': 'c', 'nextEdit.backend': 'a' }))).toEqual([a, c]);
    expect(serversToStart([a, b], settings({ 'fim.backend': 'a', 'nextEdit.backend': 'a' }))).toEqual([a]);
  });
  test('not selected', () => {
    expect(serversToStart([b, c], settings({ 'fim.backend': 'a', 'nextEdit.backend': 'a' }))).toEqual([]);
  });
  test('a selection whose use is switched off does not count', () => {
    expect(serversToStart([a, b], settings({ 'fim.enabled': false, 'fim.backend': 'a', 'nextEdit.backend': 'b' }))).toEqual([b]);
    expect(serversToStart([a, b], settings({ 'nextEdit.enabled': false, 'fim.backend': 'a', 'nextEdit.backend': 'b' }))).toEqual([a]);
  });
  test('backend removed from the settings', () => {
    const s = parseSettings(src({ backends: { globalValue: [{ id: 'b', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8013' }] } })).settings;
    expect(serversToStart([a, b], s)).toEqual([b]);
    const none = parseSettings(src({ backends: { globalValue: [] } })).settings;
    expect(serversToStart([a, b], none)).toEqual([]);
  });
  test('the master switch off starts nothing', () => {
    expect(serversToStart([a, b, c], settings({ enabled: false, 'fim.backend': 'a', 'nextEdit.backend': 'b' }))).toEqual([]);
  });
});

describe('portFor', () => {
  test('a free saved port is kept', async () => {
    const asked: number[] = [];
    const free = (p: number): Promise<number> => (asked.push(p), Promise.resolve(p));
    expect(await portFor(8012, free)).toEqual({ port: 8012, changed: false });
    expect(asked).toEqual([8012]);
  });
  test('a taken saved port gets the new one', async () => {
    expect(await portFor(8012, () => Promise.resolve(53117))).toEqual({ port: 53117, changed: true });
  });
});
