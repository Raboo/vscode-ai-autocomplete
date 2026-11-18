import { describe, expect, test } from 'vitest';
import { INSTALL_HINT, findRuntime, runtimeCandidates, type RuntimeEnv } from '../../../src/local/runtimes';

function env(over: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return { platform: 'darwin', home: '/Users/me', pathEnv: '/a/bin:/b/bin', exists: () => false, readFile: () => undefined, ...over };
}

describe('runtimeCandidates', () => {
  test('an override is the only candidate, even when it does not exist', () => {
    expect(runtimeCandidates('llamaServer', env(), '/opt/x/llama-server')).toEqual(['/opt/x/llama-server']);
  });
  test('llama-server: PATH entries, then the usual install places', () => {
    expect(runtimeCandidates('llamaServer', env())).toEqual([
      '/a/bin/llama-server', '/b/bin/llama-server', '/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server',
    ]);
  });
  test('llama-server on win32: ; separator, .exe, no unix places', () => {
    const c = runtimeCandidates('llamaServer', env({ platform: 'win32', pathEnv: 'C:\\a;C:\\b' }));
    expect(c).toEqual(['C:\\a/llama-server.exe', 'C:\\b/llama-server.exe']);
  });
  test('empty PATH entries are skipped', () => {
    expect(runtimeCandidates('llamaServer', env({ pathEnv: '/a::/b:' })).slice(0, 2)).toEqual(['/a/llama-server', '/b/llama-server']);
  });
});

describe('findRuntime', () => {
  test('returns the first candidate that exists', () => {
    const e = env({ exists: (p) => p === '/b/bin/llama-server' || p === '/opt/homebrew/bin/llama-server' });
    expect(findRuntime('llamaServer', e)).toBe('/b/bin/llama-server');
  });
  test('undefined when none exists', () => {
    expect(findRuntime('llamaServer', env())).toBeUndefined();
  });
  test('an override that does not exist is not replaced by a search', () => {
    expect(findRuntime('llamaServer', env({ exists: () => true }), '/nope')).toBe('/nope');
    expect(findRuntime('llamaServer', env({ exists: (p) => p === '/a/bin/llama-server' }), '/nope')).toBeUndefined();
  });
});

test('install hints', () => {
  expect(INSTALL_HINT.llamaServer).toBe('Install llama.cpp (macOS: brew install llama.cpp), or set aiAutocomplete.local.llamaServerPath.');
});
