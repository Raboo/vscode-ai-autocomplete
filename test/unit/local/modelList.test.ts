import { describe, expect, test } from 'vitest';
import { isSplitOrProjector, mergeModels, modelNameFromFile, parseLocalModels } from '../../../src/local/modelList';
import { RECIPES } from '../../../src/local/recipes';

const added = { name: 'mine', repo: 'o/r', revision: 'abc', file: 'm.gguf', bytes: 10, sha256: 'ff' };

describe('mergeModels', () => {
  test('no entries: the built-ins in recipe order', () => {
    const { models, problems } = mergeModels(RECIPES, []);
    expect(problems).toEqual([]);
    expect(models.map((m) => m.name)).toEqual(RECIPES.map((r) => r.modelName));
    expect(models[0]).toMatchObject({ label: RECIPES[0].label, builtIn: true, hidden: false, extraArgs: [], license: RECIPES[0].license });
  });
  test('an entry for a built-in changes only uses, contextTokens, extraArgs and hidden', () => {
    const { models } = mergeModels(RECIPES, [{ name: 'sweep-next-edit-1.5b', contextTokens: 4096, hidden: true, extraArgs: '--threads 4', repo: 'x/y', sha256: 'no' }]);
    const m = models.find((x) => x.name === 'sweep-next-edit-1.5b')!;
    const r = RECIPES.find((x) => x.modelName === 'sweep-next-edit-1.5b')!;
    expect(m).toMatchObject({ contextTokens: 4096, hidden: true, extraArgs: ['--threads', '4'], repo: r.repo, sha256: r.sha256 });
  });
  test('added models follow the built-ins in setting order, with defaults', () => {
    const { models } = mergeModels(RECIPES, [{ ...added, name: 'b' }, { ...added, name: 'a', uses: ['nextEdit'], contextTokens: 2048 }]);
    expect(models.slice(RECIPES.length).map((m) => m.name)).toEqual(['b', 'a']);
    expect(models[RECIPES.length]).toMatchObject({ label: 'b', uses: ['completions'], contextTokens: 8192, builtIn: false, hidden: false, extraArgs: [] });
    expect(models[RECIPES.length].license).toBeUndefined();
    expect(models[RECIPES.length + 1]).toMatchObject({ uses: ['nextEdit'], contextTokens: 2048 });
  });
  test('an added entry missing sha256 is dropped with a problem', () => {
    const { models, problems } = mergeModels(RECIPES, [{ name: 'mine', repo: 'o/r', revision: 'a', file: 'f', bytes: 1 }]);
    expect(models).toHaveLength(RECIPES.length);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/mine.*sha256/);
  });
  test('the same name twice keeps the first, with a problem', () => {
    const { models, problems } = mergeModels(RECIPES, [{ ...added, file: 'one.gguf' }, { ...added, file: 'two.gguf' }]);
    expect(models.filter((m) => m.name === 'mine').map((m) => m.file)).toEqual(['one.gguf']);
    expect(problems).toHaveLength(1);
  });
  test('refused extra arguments become a problem and []', () => {
    const { models, problems } = mergeModels(RECIPES, [{ ...added, extraArgs: '--port 9' }]);
    expect(models.at(-1)!.extraArgs).toEqual([]);
    expect(problems[0]).toMatch(/--port/);
  });
});

describe('parseLocalModels', () => {
  test('keeps valid entries, drops bad ones with problems', () => {
    const r = parseLocalModels([added, 5, { repo: 'x' }, { name: 'Bad Name' }, { name: 'ok', contextTokens: 'x', uses: ['nextEdit', 'zzz'] }]);
    expect(r.entries.map((e) => e.name)).toEqual(['mine', 'ok']);
    expect(r.entries[1]).toEqual({ name: 'ok', uses: ['nextEdit'] });
    expect(r.problems).toHaveLength(4);
  });
  test('not a list', () => {
    expect(parseLocalModels({}).entries).toEqual([]);
    expect(parseLocalModels({}).problems).toHaveLength(1);
    expect(parseLocalModels(undefined)).toEqual({ entries: [], problems: [] });
  });
});

test('modelNameFromFile', () => {
  expect(modelNameFromFile('Qwen2.5-Coder-3B-Q8_0.gguf')).toBe('qwen2.5-coder-3b-q8_0');
  expect(modelNameFromFile('sub/My Model+1.gguf')).toBe('my-model-1');
});

test('isSplitOrProjector', () => {
  expect(isSplitOrProjector('x-00001-of-00003.gguf')).toBe(true);
  expect(isSplitOrProjector('mmproj-F16.gguf')).toBe(true);
  expect(isSplitOrProjector('sub/mmproj-F16.gguf')).toBe(true);
  expect(isSplitOrProjector('model.gguf')).toBe(false);
});
