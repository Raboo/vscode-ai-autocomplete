import { describe, expect, test } from 'vitest';
import { parseSettings, type Inspected, type RawSettingsSource, type Settings } from '../../../src/config/settings';
import { MANAGED_KEY, localBackendEntry, localBackendId, parseManaged, portFor, selectionChange, serversToStart, type ManagedServer } from '../../../src/local/backendEntry';
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
  test('llama-server id', () => {
    expect(localBackendId(recipe('mellum-4b'))).toBe('local-mellum-4b');
  });
  test('dots in a recipe id become dashes, because backend ids do not allow dots', () => {
    expect(localBackendId(both)).toBe('local-sweep-1-5b');
  });
  test('ids pass the settings id pattern for every recipe', () => {
    for (const r of RECIPES) {
      const { settings, problems } = parseSettings(src({ backends: { globalValue: [localBackendEntry(r, 8012)] } }));
      expect(problems).toEqual([]);
      expect(settings.backends.map((b) => b.id)).toEqual([localBackendId(r)]);
    }
  });
});

describe('localBackendEntry', () => {
  test('llama-server entry for a recipe that serves both uses', () => {
    const entry = localBackendEntry(both, 8123);
    expect(entry).toEqual({
      id: 'local-sweep-1-5b', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8123',
      use: ['completions', 'nextEdit'], model: both.modelName, nextEditModel: both.modelName,
    });
    const { settings, problems } = parseSettings(src({ backends: { globalValue: [entry] } }));
    expect(problems).toEqual([]);
    expect(settings.backends[0]).toMatchObject({
      id: 'local-sweep-1-5b', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8123',
      fimModel: both.modelName, nextEditModel: both.modelName, use: { completions: true, nextEdit: true },
    });
  });
  test('a completions-only recipe has no nextEditModel and serves completions only', () => {
    const entry = localBackendEntry(completionsOnly, 8012);
    expect(entry).not.toHaveProperty('nextEditModel');
    const { settings } = parseSettings(src({ backends: { globalValue: [entry] } }));
    expect(settings.backends[0].fimModel).toBe(completionsOnly.modelName);
    expect(settings.backends[0].nextEditModel).toBeUndefined();
    expect(settings.backends[0].use).toEqual({ completions: true, nextEdit: false });
  });
  test('a Next Edit only recipe has no model', () => {
    const entry = localBackendEntry({ ...both, uses: ['nextEdit'] }, 8012);
    expect(entry).not.toHaveProperty('model');
    expect(entry.nextEditModel).toBe(both.modelName);
    expect(entry.use).toEqual(['nextEdit']);
  });
  test('the entry does not share the recipe uses array', () => {
    const entry = localBackendEntry(both, 8012);
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
  test('keeps a valid pid; a missing or invalid pid leaves the field out but keeps the entry', () => {
    expect(parseManaged([{ ...ok, pid: 4242 }])).toEqual([{ ...ok, pid: 4242 }]);
    for (const pid of [undefined, 0, -1, 1.5, '4242', null]) {
      const [e] = parseManaged([{ ...ok, pid }]);
      expect(e).toEqual(ok);
      expect('pid' in e).toBe(false);
    }
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
    expect(serversToStart([a, b, c], settings({ 'completions.backend': 'b', 'nextEdit.enabled': false }))).toEqual([b]);
  });
  test('selected for Next Edit', () => {
    expect(serversToStart([a, b, c], settings({ 'completions.enabled': false, 'nextEdit.enabled': true, 'nextEdit.backend': 'c' }))).toEqual([c]);
  });
  test('selected for both gives one entry per server, in managed order', () => {
    expect(serversToStart([a, b, c], settings({ 'completions.backend': 'c', 'nextEdit.backend': 'a' }))).toEqual([a, c]);
    expect(serversToStart([a, b], settings({ 'completions.backend': 'a', 'nextEdit.backend': 'a' }))).toEqual([a]);
  });
  test('not selected', () => {
    expect(serversToStart([b, c], settings({ 'completions.backend': 'a', 'nextEdit.backend': 'a' }))).toEqual([]);
  });
  test('a selection whose use is switched off does not count', () => {
    expect(serversToStart([a, b], settings({ 'completions.enabled': false, 'completions.backend': 'a', 'nextEdit.backend': 'b' }))).toEqual([b]);
    expect(serversToStart([a, b], settings({ 'nextEdit.enabled': false, 'completions.backend': 'a', 'nextEdit.backend': 'b' }))).toEqual([a]);
  });
  test('backend removed from the settings', () => {
    const s = parseSettings(src({ backends: { globalValue: [{ id: 'b', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8013' }] } })).settings;
    expect(serversToStart([a, b], s)).toEqual([b]);
    const none = parseSettings(src({ backends: { globalValue: [] } })).settings;
    expect(serversToStart([a, b], none)).toEqual([]);
  });
  test('the master switch off starts nothing', () => {
    expect(serversToStart([a, b, c], settings({ enabled: false, 'completions.backend': 'a', 'nextEdit.backend': 'b' }))).toEqual([]);
  });
});

describe('selectionChange', () => {
  const m = (id: string): ManagedServer => ({ backendId: id, recipeId: id, file: `/m/${id}.gguf`, port: 8012 });
  const a = m('a');
  const b = m('b');
  function settings(map: Record<string, unknown>, ids = ['a', 'b'], port = 8012): Settings {
    const entries = ids.map((id) => ({ id, kind: 'llamacpp', baseUrl: `http://127.0.0.1:${port}` }));
    const inspected: Record<string, Inspected<unknown>> = { backends: { globalValue: entries } };
    for (const [k, v] of Object.entries(map)) inspected[k] = { globalValue: v };
    return parseSettings(src(inspected)).settings;
  }
  const none = { start: [], stop: [] };

  test('a backend that became selected starts', () => {
    expect(selectionChange([a, b], settings({ 'completions.backend': 'b' }), settings({ 'completions.backend': 'a' }), [])).toEqual({ start: [a], stop: [] });
  });
  test('a backend no longer selected, or removed, or with completions switched off, stops when this window runs it', () => {
    const before = settings({ 'completions.backend': 'a' });
    expect(selectionChange([a, b], before, settings({ 'completions.backend': 'b' }), ['a'])).toEqual({ start: [b], stop: ['a'] });
    // With "a" gone the selection falls back to the remaining backend.
    expect(selectionChange([a, b], before, settings({ 'completions.backend': 'a' }, ['b']), ['a'])).toEqual({ start: [b], stop: ['a'] });
    expect(selectionChange([a, b], before, settings({ 'completions.backend': 'a', 'completions.enabled': false }), ['a'])).toEqual({ start: [], stop: ['a'] });
    expect(selectionChange([a, b], before, settings({ 'completions.backend': 'a', enabled: false }), ['a'])).toEqual({ start: [], stop: ['a'] });
    expect(selectionChange([a, b], before, settings({ 'completions.backend': 'b' }), [])).toEqual({ start: [b], stop: [] });
  });
  test('an unrelated change (a moved port, another setting) starts and stops nothing: a server stopped with Stop Local Models stays stopped', () => {
    const before = settings({ 'completions.backend': 'a' });
    expect(selectionChange([a, b], before, settings({ 'completions.backend': 'a' }, ['a', 'b'], 9001), [])).toEqual(none);
    expect(selectionChange([a, b], before, settings({ 'completions.backend': 'a', 'completions.debounceMs': 100 }), ['a'])).toEqual(none);
  });
  test("setup's server: the backends write and the selection write neither stop nor start it again", () => {
    // Setup starts the server first, then writes the backend (not selected yet), records it, then selects it.
    const noEntry = settings({ 'completions.backend': 'b' }, ['b']);
    const written = settings({ 'completions.backend': 'b' });
    const selected = settings({ 'completions.backend': 'a' });
    expect(selectionChange([b], noEntry, written, ['a'])).toEqual(none);
    expect(selectionChange([a, b], written, selected, ['a'])).toEqual(none);
  });
  test('a selected backend without a record has nothing to start', () => {
    expect(selectionChange([b], settings({ 'completions.backend': 'b' }), settings({ 'completions.backend': 'a' }), [])).toEqual(none);
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
