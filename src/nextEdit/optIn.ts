import { applyEdits, modify, parse } from 'jsonc-parser';
import { join } from 'node:path';

export const EXTENSION_ID = 'raboo.ai-autocomplete';

const DIRS: Record<string, string> = {
  'Visual Studio Code': '.vscode',
  'Visual Studio Code - Insiders': '.vscode-insiders',
  VSCodium: '.vscode-oss',
  'VSCodium - Insiders': '.vscodium-insiders',
};

/** Where VS Code reads its runtime arguments for this product, or undefined for a product we do not know. */
export function argvPath(appName: string, home: string, env: { VSCODE_PORTABLE?: string }): string | undefined {
  if (env.VSCODE_PORTABLE) return join(env.VSCODE_PORTABLE, 'argv.json');
  const dir = DIRS[appName];
  return dir ? join(home, dir, 'argv.json') : undefined;
}

/** The argv.json text with `id` in "enable-proposed-api" (comments kept), or undefined when it is already listed. */
export function withProposedApiOptIn(text: string, id: string): string | undefined {
  const root = (parse(text, [], { allowTrailingComma: true }) ?? {}) as Record<string, unknown>;
  const current = root['enable-proposed-api'];
  const list = Array.isArray(current) ? current : [];
  if (list.includes(id)) return undefined;
  const base = text.trim() === '' ? '{}' : text;
  const edits = modify(base, ['enable-proposed-api'], [...list, id], { formattingOptions: { insertSpaces: true, tabSize: 2 } });
  return applyEdits(base, edits);
}
