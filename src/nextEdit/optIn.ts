import { applyEdits, modify, parse, ParseErrorCode, type ParseError } from 'jsonc-parser';
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

/** Whether argv.json text already lists `id` in "enable-proposed-api"; false for empty, malformed or non-object text. */
export function hasProposedApiOptIn(text: string, id: string): boolean {
  const parsed: unknown = parse(text, [], { allowTrailingComma: true });
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const list = (parsed as Record<string, unknown>)['enable-proposed-api'];
  return Array.isArray(list) && list.includes(id);
}

/** The argv.json text with `id` in "enable-proposed-api" (comments kept), or undefined when it is already listed. Throws when the text is not a JSONC object, so a damaged file is never rewritten. */
export function withProposedApiOptIn(text: string, id: string): string | undefined {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.some((e) => e.error !== ParseErrorCode.ValueExpected || parsed !== undefined)) throw new Error('argv.json does not parse');
  if (parsed !== undefined && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) throw new Error('argv.json is not an object');
  const root = (parsed ?? {}) as Record<string, unknown>;
  const current = root['enable-proposed-api'];
  const list = Array.isArray(current) ? current : [];
  if (list.includes(id)) return undefined;
  const base = text.trim() === '' ? '{}' : text;
  const edits = modify(base, ['enable-proposed-api'], [...list, id], { formattingOptions: { insertSpaces: true, tabSize: 2 } });
  return applyEdits(base, edits);
}
