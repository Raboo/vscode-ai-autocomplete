import { describe, expect, test } from 'vitest';
import { RECIPES, downloadUrl, fitsMemory, modelPathSegments, type Recipe } from '../../../src/local/recipes';
import { resolvePreset } from '../../../src/models/presets';
import { pickFormat, sweepVariant } from '../../../src/nextEdit/formats/index';

const GIB = 2 ** 30;
const byId = (id: string): Recipe => {
  const r = RECIPES.find((x) => x.id === id);
  if (!r) throw new Error(`no recipe ${id}`);
  return r;
};

describe('RECIPES', () => {
  test('ids are unique and the default comes first', () => {
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(RECIPES.length);
    expect(RECIPES.map((r) => r.id)).toEqual(['sweep-1.5b', 'qwen2.5-coder-1.5b', 'qwen2.5-coder-3b', 'qwen2.5-coder-7b', 'mellum-4b']);
    expect(RECIPES[0].id).toBe('sweep-1.5b');
  });

  test.each(RECIPES.map((r) => [r.id, r] as const))('%s has pinned values', (_id, r) => {
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(r.bytes).toBeGreaterThan(0);
    expect(r.contextTokens).toBe(8192);
    expect(r.license).toBe('Apache-2.0');
    expect(r.uses.length).toBeGreaterThan(0);
    expect(r.modelName).not.toMatch(/v2/i);
  });

  test('uses', () => {
    expect(byId('sweep-1.5b').uses).toEqual(['completions', 'nextEdit']);
    for (const id of ['qwen2.5-coder-1.5b', 'qwen2.5-coder-3b', 'qwen2.5-coder-7b', 'mellum-4b']) expect(byId(id).uses).toEqual(['completions']);
  });

  test('labels', () => {
    expect(RECIPES.map((r) => r.label)).toEqual(['Sweep Next Edit 1.5B', 'Qwen2.5-Coder 1.5B', 'Qwen2.5-Coder 3B', 'Qwen2.5-Coder 7B', 'Mellum 4B']);
  });

  test('model names work with the existing model rules', () => {
    for (const id of ['sweep-1.5b', 'qwen2.5-coder-1.5b', 'qwen2.5-coder-3b', 'qwen2.5-coder-7b']) {
      expect(resolvePreset(byId(id).modelName, {}).fimTemplate).toBe('qwen');
    }
    expect(resolvePreset(byId('mellum-4b').modelName, {}).fimTemplate).toBe('mellum');
    const sweep = byId('sweep-1.5b').modelName;
    expect(sweepVariant(sweep)).toBe('v1');
    expect(pickFormat('auto', sweep).id).toBe('sweep');
  });
});

describe('downloadUrl', () => {
  test('builds the Hugging Face resolve URL', () => {
    expect(downloadUrl(byId('sweep-1.5b'))).toBe(
      'https://huggingface.co/sweepai/sweep-next-edit-1.5B/resolve/409016591c6c1a94f545f22328a85a3516118f34/sweep-next-edit-1.5b.q8_0.v2.gguf',
    );
  });

  test('url overrides it', () => {
    expect(downloadUrl({ ...byId('sweep-1.5b'), url: 'http://127.0.0.1:9/x.gguf' })).toBe('http://127.0.0.1:9/x.gguf');
  });
});

describe('fitsMemory', () => {
  test('18 GiB machine: 3B fits, 7B does not', () => {
    expect(fitsMemory(byId('qwen2.5-coder-3b'), 18 * GIB)).toBe(true);
    expect(fitsMemory(byId('qwen2.5-coder-7b'), 18 * GIB)).toBe(false);
  });

  test('boundary is inclusive', () => {
    const r = { ...byId('mellum-4b'), bytes: 400 };
    expect(fitsMemory(r, 1000)).toBe(true);
    expect(fitsMemory({ ...r, bytes: 401 }, 1000)).toBe(false);
  });
});

describe('modelPathSegments', () => {
  const r = (repo: string, file: string): Recipe => ({ ...RECIPES[0], repo, file });
  test('owner, name and file for every shipped recipe', () => {
    for (const x of RECIPES) expect(modelPathSegments(x)).toEqual([...x.repo.split('/'), x.file]);
    expect(modelPathSegments(r('test/test-model', 'test-model.gguf'))).toEqual(['test', 'test-model', 'test-model.gguf']);
  });
  test('rejects a path that could leave the models folder', () => {
    for (const [repo, file] of [
      ['../x', 'a.gguf'], ['x/..', 'a.gguf'], ['./x', 'a.gguf'], ['x', 'a.gguf'], ['x/y/z', 'a.gguf'], ['/x', 'a.gguf'], ['x/', 'a.gguf'],
      ['x\\..', 'a.gguf'], ['x/y', '..'], ['x/y', '.'], ['x/y', ''], ['x/y', 'sub/a.gguf'], ['x/y', '..\\a.gguf'], ['C:/y', 'a.gguf'],
    ]) expect(modelPathSegments(r(repo, file)), `${repo} ${file}`).toBeUndefined();
  });
});
