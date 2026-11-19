import type { Recipe } from './recipes';

/** The Set Up Local Model argument tests pass: the recipe to download and register. */
export interface SetupArg {
  recipe: string;
}

const isEntry = (e: unknown): e is Record<string, unknown> => typeof e === 'object' && e !== null && !Array.isArray(e);

/**
 * What the command argument asks for. It skips the Local Models page and goes straight to the download, so only tests may
 * pass one: any other caller (a workspace tasks.json `command` input can run a command with any argument) gets `none`,
 * and the page opens. `invalid`: a test argument naming an unknown recipe.
 */
export function setupArgument(
  arg: unknown,
  recipes: readonly Recipe[],
  testMode: boolean,
): { recipe: Recipe } | 'none' | 'invalid' {
  if (arg === undefined || !testMode) return 'none';
  const o = isEntry(arg) ? arg : {};
  const recipe = recipes.find((r) => r.id === o.recipe);
  if (!recipe) return 'invalid';
  return { recipe };
}
