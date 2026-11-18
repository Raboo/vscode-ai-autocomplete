import { describe, expect, test } from 'vitest';
import { COMPLETIONS_KEYS, planRenameMigration, renameBackendEntry } from '../../src/config/rename';
import type { Inspected, RawSettingsSource } from '../../src/config/settings';

function src(map: Record<string, Inspected<unknown>>): RawSettingsSource {
  return { inspect: <T>(key: string) => map[key] as Inspected<T> | undefined };
}

describe('renameBackendEntry', () => {
  test('renames the old fields in place, keeping every other field and the order', () => {
    const { entry, renamed } = renameBackendEntry({ id: 'a', fimModel: 'm', kind: 'llamacpp', fimMode: 'native', baseUrl: 'http://h', fim: { topK: 1 }, nextEditModel: 'n', future: 1 });
    expect(renamed).toEqual(['fimModel', 'fimMode', 'fim']);
    expect(Object.entries(entry)).toEqual([['id', 'a'], ['model', 'm'], ['kind', 'llamacpp'], ['mode', 'native'], ['baseUrl', 'http://h'], ['completions', { topK: 1 }], ['nextEditModel', 'n'], ['future', 1]]);
  });
  test('keeps the new field when both are set', () => {
    expect(renameBackendEntry({ model: 'new', fimModel: 'old' })).toEqual({ entry: { model: 'new' }, renamed: ['fimModel'] });
  });
  test('an entry without old fields comes back as it is', () => {
    const e = { id: 'a', model: 'm' };
    expect(renameBackendEntry(e)).toEqual({ entry: e, renamed: [] });
  });
});

describe('planRenameMigration', () => {
  test('nothing old set: nothing to write', () => {
    expect(planRenameMigration(src({ 'completions.enabled': { defaultValue: true, globalValue: false }, backends: { globalValue: [{ id: 'a', model: 'm' }] } }), true))
      .toEqual({ writes: [], moved: [] });
  });
  test('covers all 11 completion keys', () => {
    expect([...COMPLETIONS_KEYS].sort()).toEqual(['backend', 'debounceMs', 'disableInFiles', 'disableInLanguages', 'enabled', 'extraContext', 'maxTokens', 'multiline',
      'prefixLines', 'skipMidWord', 'suffixLines']);
  });
  test('an old user key is copied to the new key and removed', () => {
    const { writes, moved } = planRenameMigration(src({ 'fim.enabled': { globalValue: false } }), false);
    expect(writes).toEqual([{ key: 'completions.enabled', level: 'user', value: false }, { key: 'fim.enabled', level: 'user', value: undefined }]);
    expect(moved).toEqual(['fim.enabled → completions.enabled (user)']);
  });
  test('both set at a level: the new one is kept, the old one dropped', () => {
    const { writes, moved } = planRenameMigration(src({ 'fim.maxTokens': { globalValue: 16 }, 'completions.maxTokens': { defaultValue: 128, globalValue: 32 } }), false);
    expect(writes).toEqual([{ key: 'fim.maxTokens', level: 'user', value: undefined }]);
    expect(moved).toEqual(['fim.maxTokens dropped, completions.maxTokens already set (user)']);
  });
  test('levels are separate: a new user value does not stop an old workspace value from moving', () => {
    const { writes } = planRenameMigration(src({ 'fim.backend': { workspaceValue: 'w' }, 'completions.backend': { defaultValue: '', globalValue: 'u' } }), true);
    expect(writes).toEqual([{ key: 'completions.backend', level: 'workspace', value: 'w' }, { key: 'fim.backend', level: 'workspace', value: undefined }]);
  });
  test('the workspace level moves only in a trusted workspace; folder levels never', () => {
    const map = { 'fim.backend': { workspaceValue: 'w', workspaceFolderValue: 'f' } };
    expect(planRenameMigration(src(map), false).writes).toEqual([]);
    expect(planRenameMigration(src(map), true).writes.map((w) => w.level)).toEqual(['workspace', 'workspace']);
  });
  test('backend entries in user settings are rewritten; workspace backends are never touched', () => {
    const user = [{ id: 'a', kind: 'llamacpp', fimModel: 'm', baseUrl: 'http://h' }, 'junk', { id: 'b', model: 'x' }];
    const { writes, moved } = planRenameMigration(src({ backends: { globalValue: user, workspaceValue: [{ id: 'w', fimModel: 'evil' }] } }), true);
    expect(writes).toEqual([{ key: 'backends', level: 'user', value: [{ id: 'a', kind: 'llamacpp', model: 'm', baseUrl: 'http://h' }, 'junk', { id: 'b', model: 'x' }] }]);
    expect(moved).toEqual(['backend "a": fimModel → model']);
  });
});
