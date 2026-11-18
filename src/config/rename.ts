import type { Inspected, RawSettingsSource } from './settings';

/**
 * The `aiAutocomplete.fim.*` settings were renamed to `aiAutocomplete.completions.*`, and the backend fields `fimModel`,
 * `fimMode` and `fim` to `model`, `mode` and `completions`. The extension moves old keys in user settings on start; it
 * never writes workspace or folder settings, and never rewrites `backends` (a backend entry gets the new field names when
 * it is saved from the Backends page or by the local model helper). Old names are read until 1.0; each old name read adds
 * a problem ending in OLD_NAME_NOTE.
 */
export const COMPLETIONS_KEYS = ['enabled', 'backend', 'multiline', 'disableInLanguages', 'disableInFiles', 'skipMidWord', 'extraContext', 'debounceMs',
  'maxTokens', 'prefixLines', 'suffixLines'] as const;
export type CompletionsKey = (typeof COMPLETIONS_KEYS)[number];

export const OLD_NAME_NOTE = 'the old name still works until 1.0';

/** Old backend field → new backend field. */
export const BACKEND_FIELD_RENAMES: readonly (readonly [string, string])[] = [['fimModel', 'model'], ['fimMode', 'mode'], ['fim', 'completions']];

/** Restrict-only lists (a security exclusion): old and new values are joined, never replaced by one another. */
const UNION_KEYS: ReadonlySet<CompletionsKey> = new Set<CompletionsKey>(['disableInFiles']);

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** The new list with the old list's missing strings added at the end; non-strings of the new list are kept. */
const joinLists = (n: unknown, o: unknown): unknown[] => {
  const base = Array.isArray(n) ? [...(n as unknown[])] : [];
  for (const x of strList(o)) if (!base.includes(x)) base.push(x);
  return base;
};

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
 * The value of a renamed setting, level by level: at each level the new key wins, else the old one; for UNION_KEYS the
 * two lists are joined at each level instead. Folder values of both are kept (they only feed lists that are joined).
 * `usedOld` says whether any old value was taken.
 */
export function inspectRenamed<T>(src: RawSettingsSource, k: CompletionsKey): { inspected: Inspected<T> | undefined; usedOld: boolean } {
  const n = src.inspect<T>(newKey(k));
  const o = src.inspect<T>(oldKey(k));
  if (!o) return { inspected: n, usedOld: false };
  let usedOld = false;
  const pick = (level: 'globalValue' | 'workspaceValue' | 'workspaceFolderValue'): T | undefined => {
    if (o[level] !== undefined && (n?.[level] === undefined || UNION_KEYS.has(k))) usedOld = true;
    if (n?.[level] === undefined) return o[level];
    if (UNION_KEYS.has(k) && o[level] !== undefined) return joinLists(n[level], o[level]) as T;
    return n[level];
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

export interface MigrationWrite {
  /** Key below `aiAutocomplete.`, in user settings. */
  key: string;
  /** undefined removes the key. */
  value: unknown;
}

/**
 * What to write to move old names in user settings: each old key set there is copied to its new key when that is unset,
 * then removed; for UNION_KEYS the old list is added to the new one. Workspace and folder settings are never written:
 * `workspaceOld` lists the old keys still set there (the reader keeps reading them until 1.0). Backend entries are left
 * alone. Empty when nothing old is set.
 */
export function planRenameMigration(src: RawSettingsSource): { writes: MigrationWrite[]; moved: string[]; workspaceOld: string[] } {
  const writes: MigrationWrite[] = [];
  const moved: string[] = [];
  const workspaceOld: string[] = [];
  for (const k of COMPLETIONS_KEYS) {
    const o = src.inspect<unknown>(oldKey(k));
    const n = src.inspect<unknown>(newKey(k));
    if (o?.workspaceValue !== undefined || o?.workspaceFolderValue !== undefined || (o?.folderValues ?? []).length > 0) workspaceOld.push(oldKey(k));
    const v = o?.globalValue;
    if (v === undefined) continue;
    const current = n?.globalValue;
    if (current === undefined) {
      writes.push({ key: newKey(k), value: v });
      moved.push(`${oldKey(k)} → ${newKey(k)}`);
    } else if (UNION_KEYS.has(k)) {
      const joined = joinLists(current, v);
      if (!Array.isArray(current) || joined.length !== current.length) {
        writes.push({ key: newKey(k), value: joined });
        moved.push(`${oldKey(k)} added to ${newKey(k)}`);
      } else moved.push(`${oldKey(k)} dropped, already in ${newKey(k)}`);
    } else moved.push(`${oldKey(k)} dropped, ${newKey(k)} already set`);
    writes.push({ key: oldKey(k), value: undefined });
  }
  return { writes, moved, workspaceOld };
}
