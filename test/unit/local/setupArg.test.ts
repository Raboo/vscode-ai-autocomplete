import { describe, expect, test } from 'vitest';
import { RECIPES } from '../../../src/local/recipes';
import { setupArgument } from '../../../src/local/setupArg';

const sweep = RECIPES.find((r) => r.id === 'sweep-1.5b')!;

describe('setupArgument', () => {
  test('outside test mode an argument is ignored, so the pickers and the replace question show', () => {
    expect(setupArgument({ recipe: 'sweep-1.5b', replace: true }, RECIPES, false)).toBe('none');
    expect(setupArgument({ recipe: 'nope' }, RECIPES, false)).toBe('none');
  });
  test('no argument means the pickers, in test mode too', () => {
    expect(setupArgument(undefined, RECIPES, true)).toBe('none');
  });
  test('in test mode the argument picks the recipe and whether to replace without asking', () => {
    expect(setupArgument({ recipe: 'sweep-1.5b' }, RECIPES, true)).toEqual({ recipe: sweep, replace: false });
    expect(setupArgument({ recipe: 'sweep-1.5b', replace: true }, RECIPES, true)).toEqual({ recipe: sweep, replace: true });
    expect(setupArgument({ recipe: 'sweep-1.5b', replace: 'yes' }, RECIPES, true)).toMatchObject({ replace: false });
  });
  test('in test mode an unknown recipe, or a non-object, is invalid', () => {
    expect(setupArgument({ recipe: 'nope' }, RECIPES, true)).toBe('invalid');
    expect(setupArgument('sweep-1.5b', RECIPES, true)).toBe('invalid');
    expect(setupArgument(null, RECIPES, true)).toBe('invalid');
  });
});
