import { describe, expect, test } from 'vitest';
import { parseSettings, type Inspected, type Settings } from '../../../src/config/settings';
import { LEGACY_MANAGED_KEY, legacyServers, planMigration } from '../../../src/local/migrate';

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
  test('the old state key', () => {
    expect(LEGACY_MANAGED_KEY).toBe('localServers');
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
