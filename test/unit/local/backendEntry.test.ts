import { describe, expect, test } from 'vitest';
import { parseSettings, type Inspected, type RawSettingsSource, type Settings } from '../../../src/config/settings';
import { DEFAULT_PORT, LOCAL_BACKEND_ID, MANAGED_KEY, localEntryPort, localRouterEntry, parseManaged, portFor, routerWanted, selectedModels, upsertLocalEntry, type ManagedServer } from '../../../src/local/backendEntry';

function src(map: Record<string, Inspected<unknown>>): RawSettingsSource {
  return { inspect: <T>(key: string) => map[key] as Inspected<T> | undefined };
}

describe('localRouterEntry', () => {
  test('the id, the defaults', () => {
    expect(LOCAL_BACKEND_ID).toBe('local');
    expect(DEFAULT_PORT).toBe(8012);
  });
  test('one model for both uses', () => {
    const entry = localRouterEntry(8123, { model: 'sweep-next-edit-1.5b', nextEditModel: 'sweep-next-edit-1.5b' });
    expect(entry).toEqual({
      id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8123',
      use: ['completions', 'nextEdit'], model: 'sweep-next-edit-1.5b', nextEditModel: 'sweep-next-edit-1.5b',
    });
    const { settings, problems } = parseSettings(src({ backends: { globalValue: [entry] } }));
    expect(problems).toEqual([]);
    expect(settings.backends[0]).toMatchObject({ id: 'local', fimModel: 'sweep-next-edit-1.5b', nextEditModel: 'sweep-next-edit-1.5b', use: { completions: true, nextEdit: true } });
  });
  test('use lists only the uses that have a model', () => {
    expect(localRouterEntry(8012, { model: 'qwen2.5-coder-3b' })).toEqual({ id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012', use: ['completions'], model: 'qwen2.5-coder-3b' });
    expect(localRouterEntry(8012, { nextEditModel: 'sweep-next-edit-1.5b' })).toEqual({ id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012', use: ['nextEdit'], nextEditModel: 'sweep-next-edit-1.5b' });
  });
});

describe('parseManaged', () => {
  const ok: ManagedServer = { port: 8012, presetsPath: '/g/presets.ini', modelsMax: 1 };
  test('the state key', () => {
    expect(MANAGED_KEY).toBe('localRouter');
  });
  test('a valid record, with or without its pid', () => {
    expect(parseManaged(ok)).toEqual(ok);
    expect(parseManaged({ ...ok, pid: 4242 })).toEqual({ ...ok, pid: 4242 });
    expect(parseManaged({ ...ok, restarting: true })).toEqual({ ...ok, restarting: true });
    expect(parseManaged({ ...ok, restarting: 'yes' })).toEqual(ok);
    for (const pid of [undefined, 0, -1, 1.5, '4242', null]) {
      const e = parseManaged({ ...ok, pid });
      expect(e).toEqual(ok);
      expect(e && 'pid' in e).toBe(false);
    }
  });
  test('anything malformed gives undefined', () => {
    for (const raw of [undefined, null, 'x', 7, [], [ok], { ...ok, port: 0 }, { ...ok, port: 65536 }, { ...ok, port: '8012' }, { ...ok, presetsPath: 3 }, { ...ok, modelsMax: 0 }, { ...ok, modelsMax: 1.5 }]) {
      expect(parseManaged(raw)).toBeUndefined();
    }
  });
});

describe('routerWanted and selectedModels', () => {
  const local = { id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012', model: 'qwen2.5-coder-3b', nextEditModel: 'sweep-next-edit-1.5b' };
  const other = { id: 'other', kind: 'llamacpp', baseUrl: 'http://10.0.0.2:8080' };
  function settings(map: Record<string, unknown>, backends: unknown[] = [other, local]): Settings {
    const inspected: Record<string, Inspected<unknown>> = { backends: { globalValue: backends } };
    for (const [k, v] of Object.entries(map)) inspected[k] = { globalValue: v };
    return parseSettings(src(inspected)).settings;
  }
  test('wanted when local is selected for an enabled use', () => {
    expect(routerWanted(settings({ 'completions.backend': 'local' }))).toBe(true);
    expect(routerWanted(settings({ 'completions.backend': 'other', 'nextEdit.backend': 'local' }))).toBe(true);
    expect(routerWanted(settings({ 'completions.backend': 'other' }))).toBe(false);
    expect(routerWanted(settings({ 'completions.backend': 'local', 'completions.enabled': false }))).toBe(false);
    expect(routerWanted(settings({ 'completions.backend': 'local', enabled: false }))).toBe(false);
    expect(routerWanted(settings({ 'completions.backend': 'local' }, [other]))).toBe(false);
  });
  test('the selected models: completions first, distinct', () => {
    expect(selectedModels(settings({ 'completions.backend': 'local', 'nextEdit.backend': 'local' }))).toEqual(['qwen2.5-coder-3b', 'sweep-next-edit-1.5b']);
    expect(selectedModels(settings({ 'completions.backend': 'other', 'nextEdit.backend': 'local' }))).toEqual(['sweep-next-edit-1.5b']);
    expect(selectedModels(settings({ 'completions.backend': 'local', 'nextEdit.backend': 'local', 'nextEdit.enabled': false }))).toEqual(['qwen2.5-coder-3b']);
    const same = { ...local, nextEditModel: 'qwen2.5-coder-3b' };
    expect(selectedModels(settings({ 'completions.backend': 'local', 'nextEdit.backend': 'local' }, [same]))).toEqual(['qwen2.5-coder-3b']);
    expect(selectedModels(settings({ 'completions.backend': 'other' }))).toEqual([]);
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

describe('upsertLocalEntry and localEntryPort', () => {
  const other = { id: 'other', kind: 'llamacpp', baseUrl: 'http://10.0.0.2:8080' };
  test('adds local when there is none', () => {
    expect(upsertLocalEntry([other], { model: 'a' }, 8012)).toEqual([other, localRouterEntry(8012, { model: 'a' })]);
    expect(upsertLocalEntry(undefined, { nextEditModel: 'b' }, 9000)).toEqual([localRouterEntry(9000, { nextEditModel: 'b' })]);
  });
  test('keeps the other model, the other fields and the position; renames old field names; follows the port', () => {
    const local = { id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012', use: ['completions'], fimModel: 'qwen2.5-coder-3b', debounceMs: 90 };
    const out = upsertLocalEntry([local, other], { nextEditModel: 'sweep-next-edit-1.5b' }, 8013);
    expect(out).toEqual([
      { id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8013', use: ['completions', 'nextEdit'], model: 'qwen2.5-coder-3b', nextEditModel: 'sweep-next-edit-1.5b', debounceMs: 90 },
      other,
    ]);
    expect(localEntryPort(out)).toBe(8013);
    expect(localEntryPort([other])).toBeUndefined();
    expect(localEntryPort([{ id: 'local', baseUrl: 'nope' }])).toBeUndefined();
  });
});
