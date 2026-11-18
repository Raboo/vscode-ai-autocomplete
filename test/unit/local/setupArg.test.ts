import { describe, expect, test } from 'vitest';
import { RECIPES } from '../../../src/local/recipes';
import { setupArgument } from '../../../src/local/setupArg';

const sweep = RECIPES.find((r) => r.id === 'sweep-1.5b')!;

describe('setupArgument', () => {
  test('outside test mode an argument is ignored, so the page opens', () => {
    expect(setupArgument({ recipe: 'sweep-1.5b' }, RECIPES, false)).toBe('none');
    expect(setupArgument({ recipe: 'nope' }, RECIPES, false)).toBe('none');
  });
  test('no argument means the page opens, in test mode too', () => {
    expect(setupArgument(undefined, RECIPES, true)).toBe('none');
  });
  test('in test mode the argument picks the recipe', () => {
    expect(setupArgument({ recipe: 'sweep-1.5b' }, RECIPES, true)).toEqual({ recipe: sweep });
  });
  test('in test mode an unknown recipe, or a non-object, is invalid', () => {
    expect(setupArgument({ recipe: 'nope' }, RECIPES, true)).toBe('invalid');
    expect(setupArgument('sweep-1.5b', RECIPES, true)).toBe('invalid');
    expect(setupArgument(null, RECIPES, true)).toBe('invalid');
  });
});
