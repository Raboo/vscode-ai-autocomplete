import { describe, expect, test } from 'vitest';
import { parseSettings, type Inspected, type RawSettingsSource } from '../../src/config/settings';

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
  test('no backends gives undefined backendId and no problem', () => {
    const r = parseSettings(src({}));
    expect(r.settings.backends).toEqual([]);
    expect(r.settings.fim.backendId).toBeUndefined();
    expect(r.problems).toEqual([]);
  });
});
