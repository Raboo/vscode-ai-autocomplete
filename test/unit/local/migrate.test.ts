import { describe, expect, test } from 'vitest';
import { parseSettings, type Inspected, type Settings } from '../../../src/config/settings';
import type { Log } from '../../../src/log';
import { LEGACY_MANAGED_KEY, MIGRATED_KEY, applyMigration, legacyServers, planMigration, type LegacyServer, type MigrationIo } from '../../../src/local/migrate';

const sweep = { id: 'local-sweep-1-5b', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012', use: ['completions', 'nextEdit'], model: 'sweep-next-edit-1.5b', nextEditModel: 'sweep-next-edit-1.5b' };
const qwen = { id: 'local-qwen2-5-coder-3b', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8013', use: ['completions'], model: 'qwen2.5-coder-3b' };
const lmstudio = { id: 'local-sweep-1-5b-lmstudio', kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1234', model: 'sweep-next-edit-1.5b' };
const lmstudioLlama = { ...lmstudio, kind: 'llamacpp' };
const other = { id: 'strata', kind: 'llamacpp', baseUrl: 'http://10.0.0.2:8080' };

function settings(backends: unknown[], map: Record<string, unknown> = {}): Settings {
  const inspected: Record<string, Inspected<unknown>> = { backends: { globalValue: backends } };
  for (const [k, v] of Object.entries(map)) inspected[k] = { globalValue: v };
  return parseSettings({ inspect: <T>(key: string) => inspected[key] as Inspected<T> | undefined }).settings;
}

const EMPTY = { removeIds: [], select: {}, stopPids: [], log: '' };

describe('planMigration', () => {
  test('the state keys', () => {
    expect(LEGACY_MANAGED_KEY).toBe('localServers');
    expect(MIGRATED_KEY).toBe('localRouterMigrated');
  });

  test('a backend the user made with a local- id (another host, no record) is kept with its selection', () => {
    const gpu = { id: 'local-gpu', kind: 'llamacpp', baseUrl: 'http://10.0.0.5:8080', model: 'big' };
    const backends = [gpu, sweep];
    const plan = planMigration({ backends, managed: undefined, settings: settings(backends, { 'completions.backend': gpu.id, 'nextEdit.backend': gpu.id }) });
    expect(plan.removeIds).toEqual([sweep.id]);
    expect(plan.local).toBeUndefined();
    expect(plan.select).toEqual({});
  });

  test('a recipe id pointing at another machine is kept; any id named by an old record is the helper\'s', () => {
    const remote = { ...sweep, baseUrl: 'http://10.0.0.5:8012' };
    expect(planMigration({ backends: [remote], managed: undefined, settings: settings([remote]) }).removeIds).toEqual([]);
    const custom = { id: 'local-test', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012', model: 'test-coder' };
    const managed = [{ backendId: 'local-test', recipeId: 'test', file: '/m/t.gguf', port: 8012 }];
    const plan = planMigration({ backends: [custom], managed, settings: settings([custom]) });
    expect(plan.removeIds).toEqual(['local-test']);
    expect(plan.local).toEqual({ model: 'test-coder' });
    expect(planMigration({ backends: [custom], managed: undefined, settings: settings([custom]) }).removeIds).toEqual([]);
  });

  test('one recipe selected for both: both old entries go, local gets its model for both and is selected for both', () => {
    const backends = [sweep, qwen];
    const plan = planMigration({ backends, managed: undefined, settings: settings(backends, { 'completions.backend': sweep.id, 'nextEdit.backend': sweep.id }) });
    expect(plan.removeIds).toEqual([sweep.id, qwen.id]);
    expect(plan.local).toEqual({ model: 'sweep-next-edit-1.5b', nextEditModel: 'sweep-next-edit-1.5b' });
    expect(plan.select).toEqual({ completions: true, nextEdit: true });
    expect(plan.stopPids).toEqual([]);
    expect(plan.log).toContain(sweep.id);
    expect(plan.log).toContain(qwen.id);
  });

  test('completions and Next Edit on two recipes: local gets both models', () => {
    const backends = [sweep, qwen];
    const plan = planMigration({ backends, managed: undefined, settings: settings(backends, { 'completions.backend': qwen.id, 'nextEdit.backend': sweep.id }) });
    expect(plan.local).toEqual({ model: 'qwen2.5-coder-3b', nextEditModel: 'sweep-next-edit-1.5b' });
    expect(plan.select).toEqual({ completions: true, nextEdit: true });
  });

  test('old entries no use selects: removed, no local, nothing selected', () => {
    const backends = [other, qwen];
    const plan = planMigration({ backends, managed: undefined, settings: settings(backends, { 'completions.backend': other.id }) });
    expect(plan.removeIds).toEqual([qwen.id]);
    expect(plan.local).toBeUndefined();
    expect(plan.select).toEqual({});
  });

  test('an old field name (fimModel) still gives the model', () => {
    const old = { id: 'local-mellum-4b', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8014', use: ['completions'], fimModel: 'mellum-4b-base' };
    const plan = planMigration({ backends: [old], managed: undefined, settings: settings([old]) });
    expect(plan.local).toEqual({ model: 'mellum-4b-base' });
    expect(plan.select).toEqual({ completions: true });
  });

  test('entries ending in -lmstudio and other backends are never removed', () => {
    const backends = [lmstudio, lmstudioLlama, other];
    const plan = planMigration({ backends, managed: undefined, settings: settings(backends, { 'completions.backend': lmstudio.id }) });
    expect(plan).toEqual(EMPTY);
  });

  test('the local entry itself is not an old entry', () => {
    const local = { id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012', model: 'x' };
    expect(planMigration({ backends: [local], managed: undefined, settings: settings([local]) })).toEqual(EMPTY);
  });

  test('old managed records with pids are stopped; LM Studio records and pid-less ones are not', () => {
    const managed = [
      { backendId: sweep.id, recipeId: 'sweep-1.5b', file: '/m/s.gguf', port: 8012, pid: 501 },
      { backendId: qwen.id, recipeId: 'qwen2.5-coder-3b', file: '/m/q.gguf', port: 8013 },
      { backendId: lmstudio.id, recipeId: 'sweep-1.5b', file: '/m/s.gguf', port: 1234, pid: 502 },
      'junk',
    ];
    const backends = [sweep, qwen];
    const plan = planMigration({ backends, managed, settings: settings(backends) });
    expect(plan.stopPids).toEqual([501]);
    expect(legacyServers(managed).map((m) => m.backendId)).toEqual([sweep.id, qwen.id, lmstudio.id]);
  });

  test('nothing to migrate gives an empty plan', () => {
    expect(planMigration({ backends: [], managed: undefined, settings: settings([]) })).toEqual(EMPTY);
    expect(planMigration({ backends: [other], managed: [], settings: settings([other]) })).toEqual(EMPTY);
  });
});

describe('applyMigration', () => {
  function io(o: { alive?: (pid: number) => boolean; serving?: (rec: LegacyServer) => boolean } = {}) {
    const calls: string[] = [];
    const lists: unknown[][] = [];
    const logs: string[] = [];
    const log: Log = { debug() {}, info: (m) => void logs.push(m), warn() {}, error() {} };
    const x: MigrationIo = {
      writeBackends: async (list) => void (calls.push('backends'), lists.push(list)),
      select: async (use) => void calls.push(`select ${use}`),
      alive: o.alive ?? (() => true),
      serving: async (rec) => o.serving?.(rec) ?? true,
      terminate: (pid) => void calls.push(`kill ${pid}`),
      finish: async () => void calls.push('finish'),
      log,
    };
    return { x, calls, lists, logs };
  }

  test('stops live old servers, adds local, selects it, then removes the old entries, and finishes', async () => {
    const backends = [other, sweep, qwen];
    const managed = [
      { backendId: sweep.id, recipeId: 'sweep-1.5b', file: '/m/s.gguf', port: 8012, pid: 501 },
      { backendId: qwen.id, recipeId: 'qwen2.5-coder-3b', file: '/m/q.gguf', port: 8013, pid: 502 },
      { backendId: 'local-x', recipeId: 'x', file: '/m/x.gguf', port: 8014, pid: 503 },
    ];
    // 502: its pid is gone; 503: alive, but its port serves something else now.
    const t = io({ alive: (pid) => pid !== 502, serving: (rec) => rec.pid !== 503 });
    const plan = await applyMigration({ backends, managed, settings: settings(backends, { 'completions.backend': qwen.id, 'nextEdit.backend': sweep.id }), routerPort: 9000 }, t.x);
    expect(t.calls).toEqual(['kill 501', 'backends', 'select completions', 'select nextEdit', 'backends', 'finish']);
    expect(t.lists[0]).toEqual([other, sweep, qwen, { id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:9000', use: ['completions', 'nextEdit'], model: 'qwen2.5-coder-3b', nextEditModel: 'sweep-next-edit-1.5b' }]);
    expect(t.lists[1]).toEqual([other, t.lists[0][3]]);
    expect(t.logs).toEqual([plan.log]);
  });

  test('an existing local entry keeps its port and fields', async () => {
    const local = { id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8100', debounceMs: 90 };
    const backends = [local, sweep];
    const t = io();
    await applyMigration({ backends, managed: undefined, settings: settings(backends, { 'completions.backend': sweep.id }) }, t.x);
    expect(t.lists[0][0]).toMatchObject({ id: 'local', baseUrl: 'http://127.0.0.1:8100', debounceMs: 90, model: 'sweep-next-edit-1.5b' });
  });

  test('a migration another window already ran (the old entries are gone when re-read) writes nothing, logs no move, and finishes', async () => {
    const backends = [other, sweep];
    const t = io();
    const plan = await applyMigration(
      { backends, managed: undefined, settings: settings(backends, { 'completions.backend': sweep.id }) },
      { ...t.x, backendsNow: () => [other, { id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012', model: 'sweep-next-edit-1.5b' }] },
    );
    expect(plan.removeIds).toEqual([sweep.id]);
    expect(t.calls).toEqual(['finish']);
    expect(t.logs).toEqual([]);
  });

  test('old entries still there when re-read: the migration runs on the backends as re-read', async () => {
    const backends = [other, sweep];
    const added = { id: 'added-meanwhile', kind: 'openai', baseUrl: 'http://h' };
    const t = io();
    await applyMigration({ backends, managed: undefined, settings: settings(backends, { 'completions.backend': sweep.id }) }, { ...t.x, backendsNow: () => [...backends, added] });
    expect(t.calls).toEqual(['backends', 'select completions', 'backends', 'finish']);
    expect(t.lists[1]).toEqual([other, added, expect.objectContaining({ id: 'local' })]);
  });

  test('nothing to migrate writes nothing but still finishes (once)', async () => {
    const t = io();
    await applyMigration({ backends: [other], managed: undefined, settings: settings([other]) }, t.x);
    expect(t.calls).toEqual(['finish']);
    expect(t.logs).toEqual([]);
  });
});
