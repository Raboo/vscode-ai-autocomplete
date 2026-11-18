import type { LocalRuntime } from './backendEntry';
import type { Recipe } from './recipes';

/** The Set Up Local Model argument tests pass; `replace: true` skips the "Replace the backend?" question. */
export interface SetupArg {
  recipe: string;
  runtime: LocalRuntime;
  replace?: boolean;
}

export const LOCAL_RUNTIMES: readonly LocalRuntime[] = ['llamaServer', 'lmStudio'];

const isEntry = (e: unknown): e is Record<string, unknown> => typeof e === 'object' && e !== null && !Array.isArray(e);

/**
 * What the command argument asks for. It skips the pickers, the memory hint and the replace question, so only tests may
 * pass one: any other caller (a workspace tasks.json `command` input can run a command with any argument) gets `none`,
 * and the pickers show. `invalid`: a test argument naming an unknown recipe or runtime.
 */
export function setupArgument(
  arg: unknown,
  recipes: readonly Recipe[],
  testMode: boolean,
): { recipe: Recipe; runtime: LocalRuntime; replace: boolean } | 'none' | 'invalid' {
  if (arg === undefined || !testMode) return 'none';
  const o = isEntry(arg) ? arg : {};
  const recipe = recipes.find((r) => r.id === o.recipe);
  const runtime = LOCAL_RUNTIMES.find((r) => r === o.runtime);
  if (!recipe || !runtime) return 'invalid';
  return { recipe, runtime, replace: o.replace === true };
}
