import { describe, expect, test } from 'vitest';
import { parseSettings, type Settings } from '../../../src/config/settings';
import type { LocalModel } from '../../../src/local/modelList';
import { pageState, type PageStateInput } from '../../../src/local/page/state';

const GB = 1024 ** 3;
const model = (name: string, gb: number, over: Partial<LocalModel> = {}): LocalModel => ({
  name, label: name, repo: 'o/r', revision: 'a'.repeat(40), file: `${name}.gguf`, bytes: gb * GB, sha256: 'b'.repeat(64),
  uses: ['completions'], contextTokens: 8192, extraArgs: [], builtIn: true, hidden: false, ...over,
});
const settings = (over: { fim?: Partial<Settings['fim']>; nextEdit?: Partial<Settings['nextEdit']>; inMemory?: number; local?: object } = {}): Settings => {
  const s = parseSettings({ inspect: () => undefined }).settings;
  return {
    ...s,
    backends: [{ id: 'local', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012', fimMode: 'auto', headers: {}, use: { completions: true, nextEdit: true }, fimModel: 'a', nextEditModel: 'b', ...over.local }],
    fim: { ...s.fim, enabled: true, backendId: 'local', ...over.fim },
    nextEdit: { ...s.nextEdit, enabled: true, backendId: 'local', ...over.nextEdit },
    local: { ...s.local, modelsInMemory: over.inMemory ?? 1 },
  };
};
const input = (over: Partial<PageStateInput> = {}): PageStateInput => ({
  models: [model('a', 1), model('b', 1)], problems: [], downloads: {}, routerModels: undefined, settings: settings(),
  server: { state: 'stopped', log: [] }, modelsDir: '/m', tokenSet: false, totalMem: 16 * GB, updates: {}, ...over,
});

describe('local page state', () => {
  test('swapWarning when the two models differ and one stays in memory', () => {
    expect(pageState(input()).server.swapWarning).toBe(true);
    expect(pageState(input({ settings: settings({ inMemory: 2 }) })).server.swapWarning).toBe(false);
    expect(pageState(input({ settings: settings({ local: { nextEditModel: 'a' } }) })).server.swapWarning).toBe(false);
    expect(pageState(input({ settings: settings({ nextEdit: { enabled: false } }) })).server.swapWarning).toBe(false);
    expect(pageState(input({ settings: settings({ fim: { backendId: 'other' } }) })).server.swapWarning).toBe(false);
  });

  test('memoryWarning when the largest downloaded models pass 75% of memory', () => {
    const done = { a: { kind: 'done' as const }, b: { kind: 'done' as const } };
    const big = [model('a', 13), model('b', 1)];
    // one model in memory: no warning (the spec warns for more than one)
    expect(pageState(input({ models: big, downloads: done })).server.memoryWarning).toBeUndefined();
    // not downloaded: nothing to warn about
    expect(pageState(input({ models: big, settings: settings({ inMemory: 2 }) })).server.memoryWarning).toBeUndefined();
    expect(pageState(input({ models: big, downloads: done, settings: settings({ inMemory: 2 }) })).server.memoryWarning).toBeDefined();
    // 2 in memory: 13 + 1 = 14 of 16 passes, 8 + 1 does not
    expect(pageState(input({ models: [model('a', 8), model('b', 1)], downloads: done, settings: settings({ inMemory: 2 }) })).server.memoryWarning).toBeUndefined();
    expect(pageState(input({ models: [model('a', 8), model('b', 5)], downloads: done, settings: settings({ inMemory: 2 }) })).server.memoryWarning).toBeDefined();
  });

  test('a model note goes to its row', () => {
    const s = pageState(input({ models: [model('a', 1, { note: 'community quant, not official' }), model('b', 1)] }));
    expect(s.models[0].note).toBe('community quant, not official');
    expect('note' in s.models[1]).toBe(false);
  });

  test('mayNotFit above 40% of memory', () => {
    const s = pageState(input({ models: [model('a', 7), model('b', 6)] }));
    expect(s.models.map((m) => m.mayNotFit)).toEqual([true, false]);
  });

  test('usedFor follows local, load follows the router', () => {
    const s = pageState(input({ server: { state: 'running', log: [] }, routerModels: [{ id: 'a', state: 'sleeping' }, { id: 'b', state: 'loading' }] }));
    expect(s.models.map((m) => m.usedFor)).toEqual([['completions'], ['nextEdit']]);
    expect(s.models.map((m) => m.load)).toEqual(['sleeping', 'loading']);
    expect(pageState(input()).models.map((m) => m.load)).toEqual(['n/a', 'n/a']);
  });

  test('usedFor is the selection that applies in this window: a use selecting another backend (workspace settings) or turned off is not shown', () => {
    expect(pageState(input({ settings: settings({ fim: { backendId: 'codestral' } }) })).models.map((m) => m.usedFor)).toEqual([[], ['nextEdit']]);
    expect(pageState(input({ settings: settings({ nextEdit: { enabled: false } }) })).models.map((m) => m.usedFor)).toEqual([['completions'], []]);
  });

  test('workspace overrides are passed to the page', () => {
    const overrides = [{ use: 'completions' as const, value: 'codestral' }];
    expect(pageState(input({ overrides })).server.overrides).toEqual(overrides);
    expect(pageState(input()).server.overrides).toBeUndefined();
  });

  test('server fields, hint, problems and the token', () => {
    const s = pageState(input({ problems: ['p'], tokenSet: true, server: { state: 'failed', failure: 'too old', port: 8012, log: ['x'], binary: '/bin/ls', version: '1' } }));
    expect(s.server).toMatchObject({ state: 'failed', hint: 'too old', port: 8012, log: ['x'], binary: '/bin/ls', version: '1', modelsInMemory: 1 });
    expect(s.problems).toEqual(['p']);
    expect(s.settings).toEqual({ modelsDir: '/m', tokenSet: true });
    expect(JSON.stringify(s)).not.toMatch(/token":/i);
    // a token value in the environment of the input never reaches the state
    const SENTINEL = 'hf_SENTINEL_TOKEN_VALUE';
    const withToken = pageState({ ...input({ tokenSet: true }), token: SENTINEL } as PageStateInput);
    expect(JSON.stringify(withToken)).not.toContain(SENTINEL);
  });

  test('download and update pass through', () => {
    const s = pageState(input({ downloads: { a: { kind: 'running', received: 5 } }, updates: { b: 'checking' } }));
    expect(s.models[0]!.download).toEqual({ kind: 'running', received: 5 });
    expect(s.models[1]!.download).toEqual({ kind: 'none' });
    expect(s.models[1]!.update).toBe('checking');
  });

  test('the Models in memory error passes through', () => {
    expect(pageState(input({ server: { state: 'stopped', log: [], modelsInMemoryError: 'bad' } })).server.modelsInMemoryError).toBe('bad');
    expect(pageState(input()).server).not.toHaveProperty('modelsInMemoryError');
  });

  test('the default offer shows while no model is downloaded, and while its setup runs', () => {
    expect(pageState(input({ offer: { name: 'b', busy: false } })).offer).toEqual({ name: 'b', label: 'b', bytes: GB, busy: false });
    expect(pageState(input({ offer: { name: 'b', busy: false }, downloads: { a: { kind: 'done' } } })).offer).toBeUndefined();
    expect(pageState(input({ offer: { name: 'b', busy: true }, downloads: { b: { kind: 'done' } } })).offer).toEqual({ name: 'b', label: 'b', bytes: GB, busy: true });
    expect(pageState(input({ offer: { name: 'missing', busy: false } })).offer).toBeUndefined();
    expect(pageState(input()).offer).toBeUndefined();
  });
});
