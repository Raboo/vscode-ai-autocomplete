import type { BackendUse } from '../config/settings';
import { parseExtraArgs } from './extraArgs';
import type { Recipe } from './recipes';

/** One element of `aiAutocomplete.local.models`: changes to a built-in model or an added model. */
export interface LocalModelEntry {
  name: string;
  repo?: string;
  revision?: string;
  file?: string;
  bytes?: number;
  sha256?: string;
  uses?: BackendUse[];
  contextTokens?: number;
  /** The command-line string the user typed. */
  extraArgs?: string;
  hidden?: boolean;
}

export interface LocalModel {
  name: string;
  label: string;
  repo: string;
  revision: string;
  file: string;
  bytes: number;
  sha256: string;
  license?: string;
  uses: BackendUse[];
  contextTokens: number;
  extraArgs: string[];
  builtIn: boolean;
  hidden: boolean;
}

// Not imported from settings.ts, which imports this file.
const BACKEND_USES: readonly BackendUse[] = ['completions', 'nextEdit'];
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function modelNameFromFile(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  return base
    .replace(/\.gguf$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
}

export function isSplitOrProjector(file: string): boolean {
  const base = (file.split(/[\\/]/).pop() ?? file).toLowerCase();
  return /-\d{5}-of-\d{5}\.gguf$/.test(base) || base.startsWith('mmproj');
}

export function parseLocalModels(raw: unknown): { entries: LocalModelEntry[]; problems: string[] } {
  const problems: string[] = [];
  const entries: LocalModelEntry[] = [];
  if (raw === undefined || raw === null) return { entries, problems };
  if (!Array.isArray(raw)) return { entries, problems: ['aiAutocomplete.local.models: not a list, ignored'] };
  raw.forEach((item, i) => {
    const at = `aiAutocomplete.local.models[${i}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return void problems.push(`${at}: not an object, dropped`);
    const o = item as Record<string, unknown>;
    if (typeof o.name !== 'string') return void problems.push(`${at}: missing name, dropped`);
    if (!NAME_RE.test(o.name)) return void problems.push(`${at}: name "${o.name}" must match [a-z0-9][a-z0-9._-]*, dropped`);
    const e: LocalModelEntry = { name: o.name };
    const bad = (k: string, want: string): void => void problems.push(`${at} ("${o.name}").${k}: expected ${want}, ignored`);
    for (const k of ['repo', 'revision', 'file', 'sha256', 'extraArgs'] as const) {
      if (o[k] === undefined) continue;
      if (typeof o[k] === 'string') e[k] = o[k] as string;
      else bad(k, 'a string');
    }
    if (o.bytes !== undefined) {
      if (typeof o.bytes === 'number' && Number.isInteger(o.bytes) && o.bytes > 0) e.bytes = o.bytes;
      else bad('bytes', 'a positive integer');
    }
    if (o.contextTokens !== undefined) {
      if (typeof o.contextTokens === 'number' && Number.isInteger(o.contextTokens) && o.contextTokens > 0) e.contextTokens = o.contextTokens;
      else bad('contextTokens', 'a positive integer');
    }
    if (o.hidden !== undefined) {
      if (typeof o.hidden === 'boolean') e.hidden = o.hidden;
      else bad('hidden', 'true or false');
    }
    if (o.uses !== undefined) {
      const uses = Array.isArray(o.uses) ? BACKEND_USES.filter((u) => (o.uses as unknown[]).includes(u)) : [];
      if (Array.isArray(o.uses) && uses.length > 0) e.uses = uses;
      else bad('uses', `a non-empty list of ${BACKEND_USES.join(', ')}`);
    }
    entries.push(e);
  });
  return { entries, problems };
}

export function mergeModels(recipes: readonly Recipe[], entries: LocalModelEntry[]): { models: LocalModel[]; problems: string[] } {
  const problems: string[] = [];
  const args = (e: LocalModelEntry): string[] => {
    if (e.extraArgs === undefined || e.extraArgs.trim() === '') return [];
    const r = parseExtraArgs(e.extraArgs);
    if (r.refused !== undefined) {
      problems.push(`local model "${e.name}": extra arguments refused (${r.refused}), ignored`);
      return [];
    }
    return r.args;
  };
  const builtIns: LocalModel[] = recipes.map((r) => ({
    name: r.modelName, label: r.label, repo: r.repo, revision: r.revision, file: r.file, bytes: r.bytes, sha256: r.sha256,
    license: r.license, uses: [...r.uses], contextTokens: r.contextTokens, extraArgs: [], builtIn: true, hidden: false,
  }));
  const byName = new Map(builtIns.map((m) => [m.name, m]));
  const seen = new Set<string>();
  const added: LocalModel[] = [];
  for (const e of entries) {
    if (seen.has(e.name)) {
      problems.push(`local model "${e.name}": listed twice, the first one is used`);
      continue;
    }
    seen.add(e.name);
    const built = byName.get(e.name);
    if (built) {
      if (e.uses) built.uses = [...e.uses];
      if (e.contextTokens !== undefined) built.contextTokens = e.contextTokens;
      if (e.hidden !== undefined) built.hidden = e.hidden;
      built.extraArgs = args(e);
      continue;
    }
    const missing = (['repo', 'revision', 'file', 'bytes', 'sha256'] as const).filter((k) => e[k] === undefined || e[k] === '');
    if (missing.length > 0) {
      problems.push(`local model "${e.name}": missing ${missing.join(', ')}, dropped`);
      continue;
    }
    added.push({
      name: e.name, label: e.name, repo: e.repo!, revision: e.revision!, file: e.file!, bytes: e.bytes!, sha256: e.sha256!,
      uses: e.uses ? [...e.uses] : ['completions'], contextTokens: e.contextTokens ?? 8192, extraArgs: args(e),
      builtIn: false, hidden: e.hidden ?? false,
    });
  }
  return { models: [...builtIns, ...added], problems };
}
