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
    expect(pageState(input({ models: big, downloads: done })).server.memoryWarning).toBeDefined();
    // not downloaded: nothing to warn about
    expect(pageState(input({ models: big })).server.memoryWarning).toBeUndefined();
    // 2 in memory: 13 + 1 = 14 of 16 passes, 8 + 1 does not
    expect(pageState(input({ models: [model('a', 8), model('b', 1)], downloads: done, settings: settings({ inMemory: 2 }) })).server.memoryWarning).toBeUndefined();
    expect(pageState(input({ models: [model('a', 8), model('b', 5)], downloads: done, settings: settings({ inMemory: 2 }) })).server.memoryWarning).toBeDefined();
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

  test('server fields, hint, problems and the token', () => {
    const s = pageState(input({ problems: ['p'], tokenSet: true, server: { state: 'failed', failure: 'too old', port: 8012, log: ['x'], binary: '/bin/ls', version: '1' } }));
    expect(s.server).toMatchObject({ state: 'failed', hint: 'too old', port: 8012, log: ['x'], binary: '/bin/ls', version: '1', modelsInMemory: 1 });
    expect(s.problems).toEqual(['p']);
    expect(s.settings).toEqual({ modelsDir: '/m', tokenSet: true });
    expect(JSON.stringify(s)).not.toMatch(/token":/i);
  });

  test('download and update pass through', () => {
    const s = pageState(input({ downloads: { a: { kind: 'running', received: 5 } }, updates: { b: 'checking' } }));
    expect(s.models[0]!.download).toEqual({ kind: 'running', received: 5 });
    expect(s.models[1]!.download).toEqual({ kind: 'none' });
    expect(s.models[1]!.update).toBe('checking');
  });
});
