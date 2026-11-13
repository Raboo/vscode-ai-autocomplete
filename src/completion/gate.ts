export interface GateInput {
  enabled: boolean;
  snoozedUntil: number;
  now: number;
  scheme: string;
  languageId: string;
  disabledLanguages: string[];
  fileExcluded: boolean;
  selections: number;
  hasSelectedCompletionInfo: boolean;
  lineSuffix: string;
  skipMidWord: boolean;
  invoked: boolean;
}

const ALLOWED_SCHEMES = new Set(['file', 'untitled', 'vscode-notebook-cell', 'vscode-remote']);
const WORD_CHAR = /^[\p{L}\p{N}_]/u;

/** Decides whether a completion may be requested at all; the first failing rule names the reason. */
export function gate(i: GateInput): { ok: true } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (!i.enabled) return no('disabled');
  if (i.snoozedUntil > i.now) return no('snoozed');
  if (!ALLOWED_SCHEMES.has(i.scheme)) return no('scheme');
  if (i.disabledLanguages.includes(i.languageId)) return no('language');
  if (i.fileExcluded) return no('excluded file');
  if (i.selections > 1) return no('multi-cursor');
  if (i.hasSelectedCompletionInfo) return no('suggest widget');
  if (i.skipMidWord && !i.invoked && WORD_CHAR.test(i.lineSuffix)) return no('mid-word');
  return { ok: true };
}
