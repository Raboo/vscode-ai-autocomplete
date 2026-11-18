import { describe, expect, test } from 'vitest';
import { FIM_LIMITS, THINKING_STRATEGIES, parseBackendEntry, parseSettings, withFolderValues, writesToWorkspace, type Inspected, type RawSettingsSource } from '../../src/config/settings';
import { isOldNameProblem } from '../../src/config/rename';

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
    expect(settings.enabled).toBe(true);
  });
  test('local runtime paths are machine-scoped: workspace values are ignored, "" is unset', () => {
    const a = parseSettings(src({ 'local.llamaServerPath': { workspaceValue: '/evil/llama-server' }, 'local.lmsPath': { workspaceValue: '/evil/lms' } }));
    expect(a.settings.local).toEqual({});
    const b = parseSettings(src({ 'local.llamaServerPath': { globalValue: '/opt/llama-server', workspaceValue: '/evil' }, 'local.lmsPath': { globalValue: '/opt/lms' } }));
    expect(b.settings.local).toEqual({ llamaServerPath: '/opt/llama-server', lmsPath: '/opt/lms' });
    const c = parseSettings(src({ 'local.llamaServerPath': { globalValue: '', defaultValue: '' }, 'local.lmsPath': { defaultValue: '' } }));
    expect(c.settings.local).toEqual({});
  });
  test('enabled: the switch for completions and Next Edit, readable from a workspace', () => {
    const r = parseSettings(src({ backends: { globalValue: [B('a')] }, enabled: { workspaceValue: false } }));
    expect(r.settings.enabled).toBe(false);
    expect(r.settings.fim.enabled).toBe(true);
    expect(r.settings.fim.backendId).toBe('a');
  });
  test('completions.backend may be chosen per workspace among configured ids', () => {
    const { settings } = parseSettings(src({ backends: { globalValue: [B('a'), B('b')] }, 'completions.backend': { globalValue: 'a', workspaceValue: 'b' } }));
    expect(settings.fim.backendId).toBe('b');
  });
  test('workspaceFolderValue wins for resource keys', () => {
    const { settings } = parseSettings(src({ 'completions.maxTokens': { globalValue: 1, workspaceValue: 2, workspaceFolderValue: 3 } }));
    expect(settings.fim.maxTokens).toBe(3);
  });
  test('completions.backend default "" means the first completion backend, without a problem', () => {
    const { settings, problems } = parseSettings(src({ backends: { globalValue: [B('a'), B('b')] }, 'completions.backend': { defaultValue: '' } }));
    expect(settings.fim.backendId).toBe('a');
    expect(problems).toEqual([]);
  });
  test('unknown completions.backend falls back to first backend with a problem', () => {
    const r = parseSettings(src({ backends: { globalValue: [B('a')] }, 'completions.backend': { workspaceValue: 'nope' } }));
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
      disableInFiles: ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/.npmrc', '**/.pypirc', '**/*.tfvars', '**/*.p12', '**/*.pfx', '**/.netrc', '**/.docker/config.json', '**/id_rsa*', '**/id_ed25519*'],
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
    const root = cfg({ 'privacy.localOnly': { defaultValue: false }, 'completions.disableInFiles': { defaultValue: ['**/.env'] }, 'completions.maxTokens': { defaultValue: 128 } });
    const folderA = cfg({ 'privacy.localOnly': { defaultValue: false, workspaceFolderValue: false }, 'completions.disableInFiles': { defaultValue: ['**/.env'] } });
    const folderB = cfg({ 'privacy.localOnly': { defaultValue: false, workspaceFolderValue: true }, 'completions.disableInFiles': { defaultValue: ['**/.env'], workspaceFolderValue: ['**/secrets/**'] } });
    const { settings } = parseSettings(withFolderValues(root, [folderA, folderB]));
    expect(settings.privacy.localOnly).toBe(true);
    expect(settings.fim.disableInFiles).toEqual(['**/.env', '**/secrets/**']);
    expect(settings.fim.maxTokens).toBe(128);
    expect(withFolderValues(root, [folderA, folderB]).inspect('privacy.localOnly')).toEqual({ defaultValue: false, folderValues: [false, true] });
    expect(withFolderValues(root, []).inspect('privacy.localOnly')).toEqual({ defaultValue: false });
  });
  test('completions.disableInFiles: a workspace can add patterns but not remove the user or default ones', () => {
    const files = (v: Inspected<unknown>) => parseSettings(src({ 'completions.disableInFiles': { defaultValue: ['**/.env', '**/*.key'], ...v } })).settings.fim.disableInFiles;
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

describe('backend completions', () => {
  const withFim = (fim: unknown) => parseSettings(src({ backends: { globalValue: [{ ...B('lm'), completions: fim }] } }));
  test('backend completions keeps valid keys', () => {
    const fim = { template: 'seed-coder', temperature: 0.05, prefixLines: 300, extraContext: false, multiline: 'never', stop: ['</s>'], extraBody: { a: 1 }, debounceMs: 120, timeoutMs: 9000, contextTokens: 8000 };
    const { settings, problems } = withFim(fim);
    expect(settings.backends[0].fim).toEqual(fim);
    expect(problems).toEqual([]);
  });
  test('backend completions drops invalid keys and reports each', () => {
    const { settings, problems } = withFim({ temperature: '0.2', topP: 0, topK: 1.5, maxTokens: 5000, template: 'nope', multiline: 'x', stop: [1], extraBody: [], bogus: 1 });
    expect(settings.backends).toHaveLength(1);
    expect(settings.backends[0].fim).toBeUndefined();
    expect(problems).toHaveLength(9);
    for (const k of ['temperature', 'topP', 'topK', 'maxTokens', 'template', 'multiline', 'stop', 'extraBody', 'bogus']) {
      expect(problems.filter((p) => p.startsWith(`aiAutocomplete.backends[0] ("lm").completions.${k}: `) && p.endsWith(', ignored'))).toHaveLength(1);
    }
  });
  test('a non-object completions is one problem', () => {
    const { settings, problems } = withFim('x');
    expect(settings.backends[0].fim).toBeUndefined();
    expect(problems).toEqual(['aiAutocomplete.backends[0] ("lm").completions: not an object, ignored']);
  });
  test('range edges', () => {
    const { settings, problems } = withFim({ temperature: 2.01, topP: 0, contextTokens: 255, timeoutMs: 499 });
    expect(settings.backends[0].fim).toBeUndefined();
    expect(problems).toHaveLength(4);
    expect(withFim({ temperature: 0 }).settings.backends[0].fim).toEqual({ temperature: 0 });
    expect(withFim({ temperature: 2 }).settings.backends[0].fim).toEqual({ temperature: 2 });
    expect(withFim({ topP: 1 }).settings.backends[0].fim).toEqual({ topP: 1 });
    expect(withFim({ contextTokens: 256 }).settings.backends[0].fim).toEqual({ contextTokens: 256 });
    expect(withFim({ timeoutMs: 500 }).settings.backends[0].fim).toEqual({ timeoutMs: 500 });
    expect(FIM_LIMITS.topP).toEqual({ min: 0, max: 1, integer: false, exclusiveMin: true });
  });
  test('parseBackendEntry is the parser parseSettings uses', () => {
    const problems: string[] = [];
    expect(parseBackendEntry({ id: 'x', kind: 'openai', baseUrl: 'http://h/v1', completions: { topK: 20 } }, 0, new Set(), problems)?.fim).toEqual({ topK: 20 });
    expect(problems).toEqual([]);
    expect(parseBackendEntry(5, 1, new Set(), problems)).toBeUndefined();
    expect(problems).toEqual(['aiAutocomplete.backends[1]: not an object, ignored']);
  });
});

describe('thinking and localOnly strings', () => {
  test('backend completions.thinking keeps a known strategy and reports an unknown one', () => {
    const ok: string[] = [];
    expect(parseBackendEntry({ ...B('lm'), completions: { thinking: 'cannotDisable' } }, 0, new Set(), ok)?.fim?.thinking).toBe('cannotDisable');
    expect(ok).toEqual([]);
    const problems: string[] = [];
    const b = parseBackendEntry({ ...B('lm'), completions: { thinking: 'off' } }, 0, new Set(), problems);
    expect(b?.fim).toBeUndefined();
    expect(problems).toEqual([`aiAutocomplete.backends[0] ("lm").completions.thinking: unknown thinking switch "off" (use one of ${THINKING_STRATEGIES.join(', ')}), ignored`]);
  });
  test('modelOverrides thinking is parsed like fimTemplate', () => {
    const r = parseSettings(src({ modelOverrides: { globalValue: { a: { thinking: 'none' }, b: { thinking: 'off' } } } }));
    expect(r.settings.modelOverrides.a.thinking).toBe('none');
    expect(r.settings.modelOverrides.b.thinking).toBeUndefined();
    expect(r.problems).toEqual([`aiAutocomplete.modelOverrides["b"].thinking: unknown thinking switch "off" (use one of ${THINKING_STRATEGIES.join(', ')}), ignored`]);
  });
  test('a "true" string for privacy.localOnly counts as on and is reported', () => {
    const r = parseSettings(src({ 'privacy.localOnly': { globalValue: 'true' as unknown as boolean } }));
    expect(r.settings.privacy.localOnly).toBe(true);
    expect(r.problems).toContain('aiAutocomplete.privacy.localOnly: expected true or false; "true" read as true');
  });
});

describe('nextEdit settings', () => {
  test('nextEdit defaults: enabled, no backend, 10 s', () => {
    const { settings } = parseSettings(src({}));
    expect(settings.nextEdit).toMatchObject({ enabled: true, timeoutMs: 10000 });
    expect(settings.nextEdit.backendId).toBeUndefined();
  });
  test('nextEdit.backend chooses among configured ids', () => {
    const backends = { globalValue: [B('a'), B('b')] };
    expect(parseSettings(src({ backends, 'nextEdit.backend': { workspaceValue: 'b' } })).settings.nextEdit.backendId).toBe('b');
    const r = parseSettings(src({ backends, 'nextEdit.backend': { workspaceValue: 'c' } }));
    expect(r.settings.nextEdit.backendId).toBeUndefined();
    expect(r.problems).toContain('aiAutocomplete.nextEdit.backend: no backend with id "c"; Next Edit is off');
  });
  test('nextEdit.timeoutMs out of range is ignored', () => {
    const r = parseSettings(src({ 'nextEdit.timeoutMs': { globalValue: 100 } }));
    expect(r.settings.nextEdit.timeoutMs).toBe(10000);
    expect(r.problems.some((p) => p.includes('aiAutocomplete.nextEdit.timeoutMs'))).toBe(true);
  });
  test('nextEdit 3b defaults', () => {
    const { settings } = parseSettings(src({}));
    expect(settings.nextEdit).toMatchObject({ format: 'auto', display: 'auto', regionLinesAbove: 5, regionLinesBelow: 10, historySize: 5, contextBudget: 3500 });
  });
  test('nextEdit 3b values are read', () => {
    const { settings, problems } = parseSettings(src({
      'nextEdit.format': { globalValue: 'zeta21' }, 'nextEdit.display': { globalValue: 'decorations' },
      'nextEdit.regionLinesAbove': { globalValue: 3 }, 'nextEdit.regionLinesBelow': { globalValue: 20 },
      'nextEdit.historySize': { globalValue: 2 }, 'nextEdit.contextBudget': { globalValue: 6000 },
    }));
    expect(settings.nextEdit).toMatchObject({ format: 'zeta21', display: 'decorations', regionLinesAbove: 3, regionLinesBelow: 20, historySize: 2, contextBudget: 6000 });
    expect(problems).toEqual([]);
  });
  test('nextEdit 3b invalid values fall back with a problem', () => {
    const cases: [string, unknown, string, unknown][] = [
      ['format', 'instinct', 'format', 'auto'], ['display', 'popup', 'display', 'auto'],
      ['regionLinesAbove', 21, 'regionLinesAbove', 5], ['regionLinesBelow', -1, 'regionLinesBelow', 10],
      ['historySize', 11, 'historySize', 5], ['contextBudget', 500, 'contextBudget', 3500],
      ['historySize', 2.5, 'historySize', 5],
    ];
    for (const [key, value, field, dflt] of cases) {
      const r = parseSettings(src({ [`nextEdit.${key}`]: { globalValue: value } }));
      expect((r.settings.nextEdit as unknown as Record<string, unknown>)[field], key).toBe(dflt);
      expect(r.problems.some((p) => p.startsWith(`aiAutocomplete.nextEdit.${key}: expected`) && p.endsWith(', ignored')), key).toBe(true);
    }
  });
});

describe('backend use', () => {
  test('a backend without use serves both', () => {
    const b = parseBackendEntry(B('a'), 0, new Set(), []);
    expect(b?.use).toEqual({ completions: true, nextEdit: true });
  });
  test('use lists the uses', () => {
    const b = parseBackendEntry({ ...B('z'), use: ['nextEdit'] }, 0, new Set(), []);
    expect(b?.use).toEqual({ completions: false, nextEdit: true });
  });
  test('bad use values are problems; an empty or non-array use counts as both', () => {
    for (const use of [[], 'nextEdit', 5]) {
      const problems: string[] = [];
      expect(parseBackendEntry({ ...B('a'), use }, 0, new Set(), problems)?.use).toEqual({ completions: true, nextEdit: true });
      expect(problems.join()).toMatch(/aiAutocomplete\.backends\[0\] \("a"\): use/);
    }
    const problems: string[] = [];
    expect(parseBackendEntry({ ...B('a'), use: ['nextEdit', 'chat'] }, 0, new Set(), problems)?.use).toEqual({ completions: false, nextEdit: true });
    expect(problems.join()).toMatch(/"chat"/);
  });
  test('completions.backend unset falls back to the first backend with completions', () => {
    const { settings } = parseSettings(src({ backends: { globalValue: [{ ...B('z'), use: ['nextEdit'] }, B('c')] } }));
    expect(settings.fim.backendId).toBe('c');
  });
  test('completions.backend naming a Next Edit-only backend gives completions no backend', () => {
    const { settings, problems } = parseSettings(src({ backends: { globalValue: [{ ...B('z'), use: ['nextEdit'] }, B('c')] }, 'completions.backend': { globalValue: 'z' } }));
    expect(settings.fim.backendId).toBeUndefined();
    expect(problems.join()).toMatch(/completions\.backend: backend "z" is not used for completions/);
  });
  test('an unknown completions.backend falls back to the first completions backend', () => {
    const { settings, problems } = parseSettings(src({ backends: { globalValue: [{ ...B('z'), use: ['nextEdit'] }, B('c')] }, 'completions.backend': { globalValue: 'nope' } }));
    expect(settings.fim.backendId).toBe('c');
    expect(problems.join()).toMatch(/no backend with id "nope", using "c"/);
  });
  test('nextEdit.backend naming a completions-only backend leaves Next Edit off', () => {
    const { settings, problems } = parseSettings(src({ backends: { globalValue: [{ ...B('c'), use: ['completions'] }] }, 'nextEdit.backend': { globalValue: 'c' } }));
    expect(settings.nextEdit.backendId).toBeUndefined();
    expect(problems.join()).toMatch(/nextEdit\.backend: backend "c" is not used for Next Edit/);
  });
});

describe('writesToWorkspace', () => {
  test('a choice goes to user settings unless the workspace already sets the key', () => {
    expect(writesToWorkspace(undefined)).toBe(false);
    expect(writesToWorkspace({ defaultValue: '', globalValue: 'a' })).toBe(false);
    expect(writesToWorkspace({ workspaceFolderValue: 'a' })).toBe(false);
    expect(writesToWorkspace({ globalValue: 'a', workspaceValue: 'b' })).toBe(true);
    expect(writesToWorkspace({ workspaceValue: false })).toBe(true);
  });
});

describe('old names (fim.*, fimModel, fimMode, fim) until 1.0', () => {
  test('an old key set alone is read, with one note', () => {
    const r = parseSettings(src({ backends: { globalValue: [B('a'), B('b')] }, 'fim.backend': { globalValue: 'b' }, 'fim.maxTokens': { workspaceValue: 64 } }));
    expect(r.settings.fim.backendId).toBe('b');
    expect(r.settings.fim.maxTokens).toBe(64);
    expect(r.problems).toEqual([
      'aiAutocomplete.fim.backend is now aiAutocomplete.completions.backend; the old name still works until 1.0',
      'aiAutocomplete.fim.maxTokens is now aiAutocomplete.completions.maxTokens; the old name still works until 1.0',
    ]);
    expect(r.problems.every(isOldNameProblem)).toBe(true);
  });
  test('at each level the new key wins over the old one; an old value at a closer level still wins', () => {
    const same = parseSettings(src({ 'completions.maxTokens': { defaultValue: 128, globalValue: 32 }, 'fim.maxTokens': { globalValue: 16 } }));
    expect(same.settings.fim.maxTokens).toBe(32);
    expect(same.problems).toEqual([]);
    const closer = parseSettings(src({ 'completions.maxTokens': { defaultValue: 128, globalValue: 32 }, 'fim.maxTokens': { workspaceFolderValue: 16 } }));
    expect(closer.settings.fim.maxTokens).toBe(16);
    expect(closer.problems).toEqual(['aiAutocomplete.fim.maxTokens is now aiAutocomplete.completions.maxTokens; the old name still works until 1.0']);
  });
  test('old folder lists of disableInFiles are added like new ones', () => {
    const r = parseSettings(src({ 'completions.disableInFiles': { defaultValue: ['**/.env'] }, 'fim.disableInFiles': { folderValues: [['**/old/**']] } }));
    expect(r.settings.fim.disableInFiles).toEqual(['**/.env', '**/old/**']);
    expect(r.problems).toHaveLength(1);
  });
  test('disableInFiles under both names: the lists are joined at each level, not replaced by the new one', () => {
    const r = parseSettings(src({
      'completions.disableInFiles': { defaultValue: ['**/.env'], globalValue: ['**/u-new'], workspaceValue: ['**/w-new'] },
      'fim.disableInFiles': { globalValue: ['**/u-old'], workspaceValue: ['**/w-old'], workspaceFolderValue: ['**/f-old'] },
    }));
    expect(r.settings.fim.disableInFiles).toEqual(['**/u-new', '**/u-old', '**/w-new', '**/w-old', '**/f-old']);
    expect(r.problems).toEqual(['aiAutocomplete.fim.disableInFiles is now aiAutocomplete.completions.disableInFiles; the old name still works until 1.0']);
  });
  test('old backend fields are read, each with a note naming the backend', () => {
    const r = parseSettings(src({ backends: { globalValue: [{ ...B('lm'), fimModel: 'coder', fimMode: 'native', fim: { temperature: 0.1 } }] } }));
    expect(r.settings.backends[0]).toMatchObject({ fimModel: 'coder', fimMode: 'native', fim: { temperature: 0.1 } });
    expect(r.problems).toEqual([
      'aiAutocomplete.backends[0] ("lm"): fimModel is now model; the old name still works until 1.0',
      'aiAutocomplete.backends[0] ("lm"): fimMode is now mode; the old name still works until 1.0',
      'aiAutocomplete.backends[0] ("lm"): fim is now completions; the old name still works until 1.0',
    ]);
  });
  test('an old backend field next to its new one is ignored, with a note', () => {
    const r = parseSettings(src({ backends: { globalValue: [{ ...B('lm'), model: 'new', fimModel: 'old' }] } }));
    expect(r.settings.backends[0].fimModel).toBe('new');
    expect(r.problems).toEqual(['aiAutocomplete.backends[0] ("lm"): fimModel is now model (fimModel is ignored, model is set); the old name still works until 1.0']);
  });
  test('problems inside an old fim object name the old field', () => {
    const problems: string[] = [];
    parseBackendEntry({ ...B('lm'), fim: { topK: -1 } }, 0, new Set(), problems);
    expect(problems[0]).toMatch(/^aiAutocomplete\.backends\[0\] \("lm"\)\.fim\.topK: /);
    expect(isOldNameProblem(problems[0])).toBe(false);
  });
});
