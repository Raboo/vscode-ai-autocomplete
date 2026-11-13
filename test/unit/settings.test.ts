import { describe, expect, test } from 'vitest';
import { parseSettings, withFolderValues, type Inspected, type RawSettingsSource } from '../../src/config/settings';

function src(map: Record<string, Inspected<unknown>>): RawSettingsSource {
  return { inspect: <T>(key: string) => map[key] as Inspected<T> | undefined };
}
function B(id: string, baseUrl = 'http://127.0.0.1:8012'): Record<string, unknown> {
  return { id, kind: 'llamacpp', baseUrl };
}

describe('parseSettings', () => {
  test('machine-scoped backends ignore workspace values', () => {
    const { settings } = parseSettings(src({ backends: { globalValue: [B('local')], workspaceValue: [B('evil', 'https://evil.example')] } }));
    expect(settings.backends.map((b) => b.id)).toEqual(['local']);
  });
  test('machine-scoped modelOverrides and debug.logPrompts ignore workspace values', () => {
    const { settings } = parseSettings(src({
      modelOverrides: { globalValue: { a: { stop: ['x'] } }, workspaceValue: { b: {} } },
      'debug.logPrompts': { globalValue: false, workspaceValue: true },
    }));
    expect(Object.keys(settings.modelOverrides)).toEqual(['a']);
    expect(settings.debug.logPrompts).toBe(false);
  });
  test('fim.backend may be chosen per workspace among configured ids', () => {
    const { settings } = parseSettings(src({ backends: { globalValue: [B('a'), B('b')] }, 'fim.backend': { globalValue: 'a', workspaceValue: 'b' } }));
    expect(settings.fim.backendId).toBe('b');
  });
  test('workspaceFolderValue wins for resource keys', () => {
    const { settings } = parseSettings(src({ 'fim.maxTokens': { globalValue: 1, workspaceValue: 2, workspaceFolderValue: 3 } }));
    expect(settings.fim.maxTokens).toBe(3);
  });
  test('unknown fim.backend falls back to first backend with a problem', () => {
    const r = parseSettings(src({ backends: { globalValue: [B('a')] }, 'fim.backend': { workspaceValue: 'nope' } }));
    expect(r.settings.fim.backendId).toBe('a');
    expect(r.problems[0]).toMatch(/nope/);
  });
  test('invalid backend entries are dropped with a problem', () => {
    const r = parseSettings(src({
      backends: {
        globalValue: [
          B('ok'),
          { id: 'nourl', kind: 'llamacpp' },
          { id: 'badkind', kind: 'bogus', baseUrl: 'http://x' },
          B('ok'),
        ],
      },
    }));
    expect(r.settings.backends.map((b) => b.id)).toEqual(['ok']);
    expect(r.problems).toHaveLength(3);
  });
  test('non-http baseUrl and bad id are dropped', () => {
    const r = parseSettings(src({ backends: { globalValue: [{ id: 'f', kind: 'openai', baseUrl: 'ftp://x' }, { id: 'Bad Id', kind: 'openai', baseUrl: 'http://x' }] } }));
    expect(r.settings.backends).toEqual([]);
    expect(r.problems).toHaveLength(2);
  });
  test('invalid override regex reported', () => {
    const r = parseSettings(src({ modelOverrides: { globalValue: { '(': {} } } }));
    expect(r.problems.some((p) => p.includes('('))).toBe(true);
  });
  describe('modelOverrides validation', () => {
    const parse = (body: unknown) => parseSettings(src({ modelOverrides: { globalValue: { coder: body } } }));
    test('a valid override is kept as is', () => {
      const body = { fimTemplate: 'qwen', stop: ['<|endoftext|>'], sampling: { temperature: 0, topP: 0.9, topK: 20, maxTokens: 64 }, extraBody: { min_p: 0.05 } };
      const r = parse(body);
      expect(r.settings.modelOverrides.coder).toEqual(body);
      expect(r.problems).toEqual([]);
    });
    test('an unknown fimTemplate is dropped with a problem', () => {
      for (const fimTemplate of ['qwen3', 'toString', 7]) {
        const r = parse({ fimTemplate, stop: ['x'] });
        expect(r.settings.modelOverrides.coder).toEqual({ stop: ['x'] });
        expect(r.problems).toHaveLength(1);
        expect(r.problems[0]).toMatch(/modelOverrides\["coder"\]\.fimTemplate/);
      }
    });
    test('stop must be a list of strings, else it is dropped with a problem', () => {
      for (const stop of ['\n', ['a', 1], { a: 'b' }]) {
        const r = parse({ stop });
        expect(r.settings.modelOverrides.coder).toEqual({});
        expect(r.problems).toHaveLength(1);
        expect(r.problems[0]).toMatch(/\.stop/);
      }
    });
    test('sampling keeps only finite-number temperature, topP, topK and maxTokens', () => {
      const r = parse({ sampling: { temperature: 0.2, topP: '0.9', topK: Number.NaN, maxTokens: 32, min_p: 0.1 } });
      expect(r.settings.modelOverrides.coder).toEqual({ sampling: { temperature: 0.2, maxTokens: 32 } });
      expect(r.problems).toHaveLength(3);
      const notObject = parse({ sampling: [1] });
      expect(notObject.settings.modelOverrides.coder).toEqual({});
      expect(notObject.problems).toHaveLength(1);
    });
    test('extraBody must be an object, else it is dropped with a problem', () => {
      for (const extraBody of ['x', [1], null]) {
        const r = parse({ extraBody });
        expect(r.settings.modelOverrides.coder).toEqual({});
        expect(r.problems).toHaveLength(1);
        expect(r.problems[0]).toMatch(/\.extraBody/);
      }
    });
  });
  test('defaults', () => {
    const { settings, problems } = parseSettings(src({ backends: { globalValue: [B('a')] } }));
    expect(problems).toEqual([]);
    expect(settings.fim).toEqual({
      enabled: true, backendId: 'a', debounceMs: null, multiline: 'auto', maxTokens: 128,
      prefixLines: 200, suffixLines: 60, extraContext: true,
      disableInLanguages: ['plaintext'],
      disableInFiles: ['**/.env', '**/.env.*', '**/*.pem', '**/*.key'],
      skipMidWord: true,
    });
    expect(settings.privacy.localOnly).toBe(false);
    expect(settings.backends[0]).toMatchObject({ fimMode: 'auto', headers: {} });
    expect(settings.modelOverrides).toEqual({});
    expect(settings.debug.logPrompts).toBe(false);
  });
  test.each([
    ['global true, workspace false', { globalValue: true, workspaceValue: false }, true],
    ['global true, folder false', { globalValue: true, workspaceFolderValue: false }, true],
    ['workspace true only', { workspaceValue: true }, true],
    ['unset', {}, false],
  ] as [string, Inspected<boolean>, boolean][])('privacy.localOnly can only be tightened by a workspace: %s', (_n, v, expected) => {
    expect(parseSettings(src({ 'privacy.localOnly': v })).settings.privacy.localOnly).toBe(expected);
  });
  test('privacy.localOnly is on when any workspace folder turns it on', () => {
    expect(parseSettings(src({ 'privacy.localOnly': { globalValue: false, folderValues: [false, true] } })).settings.privacy.localOnly).toBe(true);
    expect(parseSettings(src({ 'privacy.localOnly': { globalValue: false, folderValues: [false, false] } })).settings.privacy.localOnly).toBe(false);
  });
  test('withFolderValues reads every folder of a multi-root workspace', () => {
    // Shaped like vscode.WorkspaceConfiguration: the window-level one has no workspaceFolderValue,
    // a folder-scoped one has that folder's value.
    const cfg = (values: Record<string, Inspected<unknown>>) => ({ inspect: <T>(key: string) => values[key] as Inspected<T> | undefined });
    const root = cfg({ 'privacy.localOnly': { defaultValue: false }, 'fim.disableInFiles': { defaultValue: ['**/.env'] }, 'fim.maxTokens': { defaultValue: 128 } });
    const folderA = cfg({ 'privacy.localOnly': { defaultValue: false, workspaceFolderValue: false }, 'fim.disableInFiles': { defaultValue: ['**/.env'] } });
    const folderB = cfg({ 'privacy.localOnly': { defaultValue: false, workspaceFolderValue: true }, 'fim.disableInFiles': { defaultValue: ['**/.env'], workspaceFolderValue: ['**/secrets/**'] } });
    const { settings } = parseSettings(withFolderValues(root, [folderA, folderB]));
    expect(settings.privacy.localOnly).toBe(true);
    expect(settings.fim.disableInFiles).toEqual(['**/.env', '**/secrets/**']);
    expect(settings.fim.maxTokens).toBe(128);
    expect(withFolderValues(root, [folderA, folderB]).inspect('privacy.localOnly')).toEqual({ defaultValue: false, folderValues: [false, true] });
    expect(withFolderValues(root, []).inspect('privacy.localOnly')).toEqual({ defaultValue: false });
  });
  test('fim.disableInFiles: a workspace can add patterns but not remove the user or default ones', () => {
    const files = (v: Inspected<unknown>) => parseSettings(src({ 'fim.disableInFiles': { defaultValue: ['**/.env', '**/*.key'], ...v } })).settings.fim.disableInFiles;
    expect(files({ workspaceValue: [] })).toEqual(['**/.env', '**/*.key']);
    expect(files({ workspaceValue: ['**/secret.txt'] })).toEqual(['**/.env', '**/*.key', '**/secret.txt']);
    expect(files({ globalValue: [] })).toEqual([]);
    expect(files({ globalValue: ['**/a'], workspaceValue: ['**/b', '**/a'], workspaceFolderValue: ['**/c'], folderValues: [['**/d'], ['**/b']] })).toEqual(['**/a', '**/b', '**/c', '**/d']);
    expect(files({ globalValue: 'not a list', workspaceValue: ['**/b', 3] })).toEqual(['**/.env', '**/*.key', '**/b']);
  });
  test('no backends gives undefined backendId and no problem', () => {
    const r = parseSettings(src({}));
    expect(r.settings.backends).toEqual([]);
    expect(r.settings.fim.backendId).toBeUndefined();
    expect(r.problems).toEqual([]);
  });
});
