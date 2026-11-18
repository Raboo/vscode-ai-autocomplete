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
    expect(planRenameMigration(src({ 'completions.enabled': { defaultValue: true, globalValue: false }, backends: { globalValue: [{ id: 'a', model: 'm' }] } })))
      .toEqual({ writes: [], moved: [], workspaceOld: [] });
  });
  test('covers all 11 completion keys', () => {
    expect([...COMPLETIONS_KEYS].sort()).toEqual(['backend', 'debounceMs', 'disableInFiles', 'disableInLanguages', 'enabled', 'extraContext', 'maxTokens', 'multiline',
      'prefixLines', 'skipMidWord', 'suffixLines']);
  });
  test('an old user key is copied to the new key and removed', () => {
    const { writes, moved } = planRenameMigration(src({ 'fim.enabled': { globalValue: false } }));
    expect(writes).toEqual([{ key: 'completions.enabled', value: false }, { key: 'fim.enabled', value: undefined }]);
    expect(moved).toEqual(['fim.enabled → completions.enabled']);
  });
  test('both set: the new one is kept, the old one dropped', () => {
    const { writes, moved } = planRenameMigration(src({ 'fim.maxTokens': { globalValue: 16 }, 'completions.maxTokens': { defaultValue: 128, globalValue: 32 } }));
    expect(writes).toEqual([{ key: 'fim.maxTokens', value: undefined }]);
    expect(moved).toEqual(['fim.maxTokens dropped, completions.maxTokens already set']);
  });
  test('disableInFiles set under both names: the old patterns are added to the new list before the old key is removed', () => {
    const { writes, moved } = planRenameMigration(src({ 'fim.disableInFiles': { globalValue: ['**/a', '**/b'] }, 'completions.disableInFiles': { defaultValue: ['**/.env'], globalValue: ['**/b', '**/c'] } }));
    expect(writes).toEqual([{ key: 'completions.disableInFiles', value: ['**/b', '**/c', '**/a'] }, { key: 'fim.disableInFiles', value: undefined }]);
    expect(moved).toEqual(['fim.disableInFiles added to completions.disableInFiles']);
  });
  test('disableInFiles: old patterns already in the new list only remove the old key', () => {
    const { writes } = planRenameMigration(src({ 'fim.disableInFiles': { globalValue: ['**/a'] }, 'completions.disableInFiles': { globalValue: ['**/a'] } }));
    expect(writes).toEqual([{ key: 'fim.disableInFiles', value: undefined }]);
  });
  test('workspace and folder levels are never written; old names there are listed for the log', () => {
    const r = planRenameMigration(src({ 'fim.backend': { workspaceValue: 'w', workspaceFolderValue: 'f' }, 'fim.maxTokens': { folderValues: [16] }, 'completions.backend': { defaultValue: '', globalValue: 'u' } }));
    expect(r.writes).toEqual([]);
    expect(r.workspaceOld).toEqual(['fim.backend', 'fim.maxTokens']);
  });
  test('backend entries are never rewritten (a settings write would replace the whole list and drop comments)', () => {
    const { writes } = planRenameMigration(src({ backends: { globalValue: [{ id: 'a', kind: 'llamacpp', fimModel: 'm', baseUrl: 'http://h' }] } }));
    expect(writes).toEqual([]);
  });
});
