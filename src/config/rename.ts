import type { Inspected, RawSettingsSource } from './settings';

/**
 * The `aiAutocomplete.fim.*` settings were renamed to `aiAutocomplete.completions.*`, and the backend fields `fimModel`,
 * `fimMode` and `fim` to `model`, `mode` and `completions`. The extension moves old names on start and still reads them
 * until 1.0; each old name read adds a problem ending in OLD_NAME_NOTE.
 */
export const COMPLETIONS_KEYS = ['enabled', 'backend', 'multiline', 'disableInLanguages', 'disableInFiles', 'skipMidWord', 'extraContext', 'debounceMs',
  'maxTokens', 'prefixLines', 'suffixLines'] as const;
export type CompletionsKey = (typeof COMPLETIONS_KEYS)[number];

export const OLD_NAME_NOTE = 'the old name still works until 1.0';

/** Old backend field → new backend field. */
export const BACKEND_FIELD_RENAMES: readonly (readonly [string, string])[] = [['fimModel', 'model'], ['fimMode', 'mode'], ['fim', 'completions']];

/** Settings read from user settings only (machine scope): never moved at the workspace level. */
const MACHINE_KEYS: ReadonlySet<string> = new Set(['backends', 'modelOverrides', 'debug.logPrompts', 'local.llamaServerPath', 'local.lmsPath']);

export const oldKey = (k: CompletionsKey): string => `fim.${k}`;
export const newKey = (k: CompletionsKey): string => `completions.${k}`;

/** Whether a settings problem is only an old-name note: it is logged, not shown in a popup. */
export function isOldNameProblem(problem: string): boolean {
  return problem.endsWith(OLD_NAME_NOTE);
}

export function oldKeyProblem(k: CompletionsKey): string {
  return `aiAutocomplete.${oldKey(k)} is now aiAutocomplete.${newKey(k)}; ${OLD_NAME_NOTE}`;
}

/**
 * The value of a renamed setting, level by level: at each level the new key wins, else the old one. Folder values of
 * both are kept (they only feed lists that are joined). `usedOld` says whether any old value was taken.
 */
export function inspectRenamed<T>(src: RawSettingsSource, k: CompletionsKey): { inspected: Inspected<T> | undefined; usedOld: boolean } {
  const n = src.inspect<T>(newKey(k));
  const o = src.inspect<T>(oldKey(k));
  if (!o) return { inspected: n, usedOld: false };
  let usedOld = false;
  const pick = (level: 'globalValue' | 'workspaceValue' | 'workspaceFolderValue'): T | undefined => {
    if (n?.[level] !== undefined) return n[level];
    if (o[level] !== undefined) usedOld = true;
    return o[level];
  };
  const inspected: Inspected<T> = { ...(n?.defaultValue !== undefined ? { defaultValue: n.defaultValue } : {}) };
  for (const level of ['globalValue', 'workspaceValue', 'workspaceFolderValue'] as const) {
    const v = pick(level);
    if (v !== undefined) inspected[level] = v;
  }
  const folderValues = [...(n?.folderValues ?? []), ...(o.folderValues ?? [])];
  if ((o.folderValues ?? []).length > 0) usedOld = true;
  if (folderValues.length > 0) inspected.folderValues = folderValues;
  return { inspected, usedOld };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * One backend entry with its old field names replaced in place (same position, every other field kept). When both
 * names are set, the new one is kept and the old one dropped. `renamed` lists the old names found.
 */
export function renameBackendEntry(raw: Record<string, unknown>): { entry: Record<string, unknown>; renamed: string[] } {
  const renamed = BACKEND_FIELD_RENAMES.filter(([from]) => Object.hasOwn(raw, from)).map(([from]) => from);
  if (renamed.length === 0) return { entry: raw, renamed };
  const to = new Map(BACKEND_FIELD_RENAMES);
  const entry: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const target = to.get(k);
    if (target === undefined) entry[k] = v;
    else if (!Object.hasOwn(raw, target)) entry[target] = v;
  }
  return { entry, renamed };
}

export type MigrationLevel = 'user' | 'workspace';
export interface MigrationWrite {
  /** Key below `aiAutocomplete.`. */
  key: string;
  level: MigrationLevel;
  /** undefined removes the key at that level. */
  value: unknown;
}

/**
 * What to write to move old names: each old key set in user settings (and in the workspace, when it is trusted and the key
 * is not machine-scoped) is copied to its new key when that is unset at the same level, then removed. Backend entries in
 * user settings get their fields renamed. Folder levels are left to the reader. Empty when nothing old is set.
 */
export function planRenameMigration(src: RawSettingsSource, trusted: boolean): { writes: MigrationWrite[]; moved: string[] } {
  const writes: MigrationWrite[] = [];
  const moved: string[] = [];
  const levels: [MigrationLevel, 'globalValue' | 'workspaceValue'][] = trusted ? [['user', 'globalValue'], ['workspace', 'workspaceValue']] : [['user', 'globalValue']];
  for (const k of COMPLETIONS_KEYS) {
    const o = src.inspect<unknown>(oldKey(k));
    const n = src.inspect<unknown>(newKey(k));
    for (const [level, field] of levels) {
      if (level === 'workspace' && MACHINE_KEYS.has(newKey(k))) continue;
      const v = o?.[field];
      if (v === undefined) continue;
      if (n?.[field] === undefined) {
        writes.push({ key: newKey(k), level, value: v });
        moved.push(`${oldKey(k)} → ${newKey(k)} (${level})`);
      } else moved.push(`${oldKey(k)} dropped, ${newKey(k)} already set (${level})`);
      writes.push({ key: oldKey(k), level, value: undefined });
    }
  }
  const list = src.inspect<unknown>('backends')?.globalValue;
  if (Array.isArray(list)) {
    let changed = false;
    const next = list.map((e) => {
      if (!isObj(e)) return e;
      const { entry, renamed } = renameBackendEntry(e);
      if (renamed.length === 0) return e;
      changed = true;
      moved.push(`backend "${typeof e.id === 'string' ? e.id : '?'}": ${renamed.join(', ')} → ${renamed.map((f) => new Map(BACKEND_FIELD_RENAMES).get(f)).join(', ')}`);
      return entry;
    });
    if (changed) writes.push({ key: 'backends', level: 'user', value: next });
  }
  return { writes, moved };
}
