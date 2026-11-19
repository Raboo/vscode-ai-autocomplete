// The settings edits behind the Local Models page's actions, as pure functions over the raw user settings values
// (`aiAutocomplete.local.models`, `aiAutocomplete.modelOverrides`, `aiAutocomplete.backends`). The host writes the results.
import { renameBackendEntry } from '../../config/rename';
import { FIM_LIMITS, type BackendUse } from '../../config/settings';
import { LOCAL_BACKEND_ID, localRouterEntry } from '../backendEntry';
import { parseExtraArgs } from '../extraArgs';
import type { HfFile } from '../huggingFace';
import type { LocalModel } from '../modelList';
import type { ModelForm } from './protocol';

type Entry = Record<string, unknown>;
type SamplingForm = ModelForm['sampling'];
/** A setting to write in user settings: `[key under aiAutocomplete, value]`; undefined removes it. */
export type SettingWrite = [key: string, value: unknown];

const isEntry = (e: unknown): e is Entry => typeof e === 'object' && e !== null && !Array.isArray(e);
const listOf = (raw: unknown): unknown[] => (Array.isArray(raw) ? [...(raw as unknown[])] : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SAMPLING_KEYS = ['temperature', 'topP', 'topK', 'maxTokens'] as const;
const CONTEXT = FIM_LIMITS.contextTokens;

/** The `modelOverrides` key the page owns for a model: its name, escaped, anchored. */
export function overrideKey(name: string): string {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

/** Whether a `modelOverrides` key other than the page's own matches the name (as the presets match: case-insensitive). */
export function otherOverridesMatch(name: string, overrides: unknown): boolean {
  if (!isEntry(overrides)) return false;
  const own = overrideKey(name);
  return Object.keys(overrides).some((key) => {
    if (key === own) return false;
    try {
      return new RegExp(key, 'i').test(name);
    } catch {
      return false;
    }
  });
}

function samplingOf(body: unknown): SamplingForm {
  const s = isEntry(body) && isEntry(body.sampling) ? body.sampling : {};
  const out: SamplingForm = {};
  for (const k of SAMPLING_KEYS) if (typeof s[k] === 'number' && Number.isFinite(s[k])) out[k] = s[k] as number;
  return out;
}

const entryOf = (entries: unknown, name: string): Entry | undefined => listOf(entries).find((e): e is Entry => isEntry(e) && e.name === name);

/** The Edit form of a model: context, the extra arguments as typed, and the sampling of the page's own override key only. */
export function modelForm(o: { model: LocalModel; entries: unknown; overrides: unknown }): ModelForm {
  const entry = entryOf(o.entries, o.model.name);
  const body = isEntry(o.overrides) ? o.overrides[overrideKey(o.model.name)] : undefined;
  return {
    name: o.model.name,
    contextTokens: o.model.contextTokens,
    extraArgs: typeof entry?.extraArgs === 'string' ? entry.extraArgs : '',
    sampling: samplingOf(body),
    otherOverridesMatch: otherOverridesMatch(o.model.name, o.overrides),
  };
}

function inLimits(v: number, lim: { min: number; max?: number; integer: boolean; exclusiveMin?: boolean }): boolean {
  if (!Number.isFinite(v) || (lim.integer && !Number.isInteger(v))) return false;
  if (lim.exclusiveMin ? v <= lim.min : v < lim.min) return false;
  return lim.max === undefined || v <= lim.max;
}

const contextError = `Context size must be a whole number from ${CONTEXT.min} to ${CONTEXT.max}.`;

/**
 * What saving the Edit form writes: only the changed fields of the model's `local.models` entry (a built-in model's
 * entry is made when needed and dropped when nothing is left in it), and `modelOverrides["^<escaped name>$"].sampling`
 * (an empty form removes it, and the key when nothing else is in it). Absent results mean "unchanged".
 */
export function saveModelEdits(o: { model: LocalModel; entries: unknown; overrides: unknown; form: ModelForm }):
  { error: string } | { models?: unknown[]; overrides?: Record<string, unknown> } {
  const { model, form } = o;
  if (!inLimits(form.contextTokens, CONTEXT)) return { error: contextError };
  const extra = form.extraArgs.trim();
  if (extra !== '') {
    const parsed = parseExtraArgs(extra);
    if (parsed.refused !== undefined) return { error: `These extra arguments are not allowed: ${parsed.refused}` };
  }
  const sampling: SamplingForm = {};
  for (const k of SAMPLING_KEYS) {
    const v = form.sampling[k];
    if (v === undefined) continue;
    if (!inLimits(v, FIM_LIMITS[k])) return { error: `${k} is out of range.` };
    sampling[k] = v;
  }

  const out: { models?: unknown[]; overrides?: Record<string, unknown> } = {};

  const list = listOf(o.entries);
  const at = list.findIndex((e) => isEntry(e) && e.name === model.name);
  const old: Entry = at >= 0 ? (list[at] as Entry) : { name: model.name };
  const next: Entry = { ...old };
  if (form.contextTokens !== model.contextTokens) next.contextTokens = form.contextTokens;
  const oldExtra = typeof old.extraArgs === 'string' ? old.extraArgs.trim() : '';
  if (extra !== oldExtra) {
    if (extra === '') delete next.extraArgs;
    else next.extraArgs = extra;
  }
  if (JSON.stringify(next) !== JSON.stringify(old)) {
    const bare = model.builtIn && Object.keys(next).length === 1;
    if (at >= 0) {
      if (bare) list.splice(at, 1);
      else list[at] = next;
    } else if (!bare) list.push(next);
    out.models = list;
  }

  const overrides: Record<string, unknown> = isEntry(o.overrides) ? { ...o.overrides } : {};
  const key = overrideKey(model.name);
  const body: Entry = isEntry(overrides[key]) ? { ...(overrides[key] as Entry) } : {};
  if (JSON.stringify(samplingOf(body)) !== JSON.stringify(sampling) || (Object.keys(sampling).length === 0 && 'sampling' in body)) {
    if (Object.keys(sampling).length === 0) delete body.sampling;
    else body.sampling = sampling;
    if (Object.keys(body).length === 0) delete overrides[key];
    else overrides[key] = body;
    out.overrides = overrides;
  }
  return out;
}

/** The selection writes for `uses`: `<use>.backend` = local, and the feature turned on when it is off. */
function selectWrites(uses: BackendUse[], s: { fim: { enabled: boolean }; nextEdit: { enabled: boolean } }): SettingWrite[] {
  const out: SettingWrite[] = [];
  if (uses.includes('completions')) {
    out.push(['completions.backend', LOCAL_BACKEND_ID]);
    if (!s.fim.enabled) out.push(['completions.enabled', true]);
  }
  if (uses.includes('nextEdit')) {
    out.push(['nextEdit.backend', LOCAL_BACKEND_ID]);
    if (!s.nextEdit.enabled) out.push(['nextEdit.enabled', true]);
  }
  return out;
}

/**
 * Use for…: `local` gets the model as its `model` (completions) and/or `nextEditModel`, keeping the other use's model
 * and its port (a new `local` goes on `port`), and is selected for each use.
 */
export function useEdits(o: { backends: unknown; name: string; uses: BackendUse[]; port: number; settings: { fim: { enabled: boolean }; nextEdit: { enabled: boolean } } }):
  { backends: unknown[]; writes: SettingWrite[] } {
  const list = listOf(o.backends);
  const at = list.findIndex((e) => isEntry(e) && e.id === LOCAL_BACKEND_ID);
  const old = at >= 0 ? renameBackendEntry(list[at] as Entry).entry : undefined;
  let port = o.port;
  if (old && typeof old.baseUrl === 'string') {
    try {
      const p = Number(new URL(old.baseUrl).port);
      if (Number.isInteger(p) && p > 0) port = p;
    } catch {
      // not a URL: the router's port
    }
  }
  const model = o.uses.includes('completions') ? o.name : str(old?.model);
  const nextEditModel = o.uses.includes('nextEdit') ? o.name : str(old?.nextEditModel);
  const fresh = localRouterEntry(port, { ...(model !== undefined ? { model } : {}), ...(nextEditModel !== undefined ? { nextEditModel } : {}) });
  const entry = old ? { ...old, ...fresh, baseUrl: old.baseUrl ?? fresh.baseUrl } : fresh;
  if (at >= 0) list[at] = entry;
  else list.push(entry);
  return { backends: list, writes: selectWrites(o.uses, o.settings) };
}

/**
 * Hide (built-in) or Remove from list (added). A model `local` uses is cleared from it; a use left without a model is
 * deselected (the user-settings selection naming `local` is removed), and `local` without any model is removed.
 * `selection` is the user-settings value of `completions.backend` and `nextEdit.backend`.
 */
export function removeModelEdits(o: { entries: unknown; backends: unknown; name: string; mode: 'hide' | 'remove'; selection: { completions?: unknown; nextEdit?: unknown } }):
  { models: unknown[]; backends?: unknown[]; writes: SettingWrite[] } {
  let models = listOf(o.entries);
  const at = models.findIndex((e) => isEntry(e) && e.name === o.name);
  if (o.mode === 'remove') models = models.filter((_, i) => i !== at);
  else if (at >= 0) models[at] = { ...(models[at] as Entry), hidden: true };
  else models.push({ name: o.name, hidden: true });

  const list = listOf(o.backends);
  const li = list.findIndex((e) => isEntry(e) && e.id === LOCAL_BACKEND_ID);
  if (li < 0) return { models, writes: [] };
  const local = renameBackendEntry(list[li] as Entry).entry;
  const model = str(local.model);
  const nextEdit = str(local.nextEditModel);
  if (model !== o.name && nextEdit !== o.name) return { models, writes: [] };

  const keep = { model: model === o.name ? undefined : model, nextEditModel: nextEdit === o.name ? undefined : nextEdit };
  const lost: BackendUse[] = [...(model === o.name ? ['completions' as const] : []), ...(nextEdit === o.name ? ['nextEdit' as const] : [])];
  const backends = [...list];
  if (keep.model === undefined && keep.nextEditModel === undefined) backends.splice(li, 1);
  else {
    const next: Entry = { ...local };
    delete next.model;
    delete next.nextEditModel;
    const use = [...(keep.model !== undefined ? ['completions'] : []), ...(keep.nextEditModel !== undefined ? ['nextEdit'] : [])];
    backends[li] = { ...next, use, ...(keep.model !== undefined ? { model: keep.model } : {}), ...(keep.nextEditModel !== undefined ? { nextEditModel: keep.nextEditModel } : {}) };
  }
  const gone = new Set<BackendUse>(keep.model === undefined && keep.nextEditModel === undefined ? ['completions', 'nextEdit'] : lost);
  const writes: SettingWrite[] = [];
  if (gone.has('completions') && o.selection.completions === LOCAL_BACKEND_ID) writes.push(['completions.backend', undefined]);
  if (gone.has('nextEdit') && o.selection.nextEdit === LOCAL_BACKEND_ID) writes.push(['nextEdit.backend', undefined]);
  return { models, backends, writes };
}

/** Unhide: drops `hidden`; a built-in model's entry left with only its name is removed. */
export function unhideEdits(entries: unknown, name: string, builtIn: boolean): unknown[] {
  const out: unknown[] = [];
  for (const e of listOf(entries)) {
    if (!isEntry(e) || e.name !== name) {
      out.push(e);
      continue;
    }
    const next = { ...e };
    delete next.hidden;
    if (!(builtIn && Object.keys(next).length === 1)) out.push(next);
  }
  return out;
}

/** Add model: an entry pinned to the commit and checksum of the picked file. */
export function addModelEdits(o: {
  entries: unknown; taken: string[]; repo: string; revision: string; file: HfFile; name: string; uses: BackendUse[]; contextTokens: number;
}): { error: string } | { models: unknown[] } {
  if (!o.file.supported || o.file.sha256 === undefined) return { error: 'This file cannot be added.' };
  if (!NAME_RE.test(o.name)) return { error: 'The name may use a-z, 0-9, ".", "_" and "-", starting with a letter or digit.' };
  if (o.taken.includes(o.name)) return { error: 'A model with this name is already in the list.' };
  if (o.uses.length === 0) return { error: 'Pick at least one use.' };
  if (!inLimits(o.contextTokens, CONTEXT)) return { error: contextError };
  const entry = {
    name: o.name, repo: o.repo, revision: o.revision, file: o.file.path, bytes: o.file.bytes, sha256: o.file.sha256,
    uses: [...o.uses], contextTokens: o.contextTokens,
  };
  return { models: [...listOf(o.entries), entry] };
}

/** A setting's values per level, as `inspect()` gives them. */
export interface SettingLevels { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }
/** A use whose backend workspace or folder settings select, so a user-settings selection does not apply in this window. */
export interface WorkspaceOverride {
  use: BackendUse;
  /** The backend id the workspace selects (any value, as text). */
  value: string;
  level: 'workspace' | 'workspaceFolder';
  /** The key to write `local` to at that level. */
  key: string;
  /** The old name of the key, set at that level: removed when `local` is written. */
  oldKey?: string;
}

const SELECT_KEYS: readonly { use: BackendUse; key: string; oldKey?: string }[] = [
  { use: 'completions', key: 'completions.backend', oldKey: 'fim.backend' },
  { use: 'nextEdit', key: 'nextEdit.backend' },
];

/**
 * The uses whose selection workspace or folder settings decide (folder over workspace; the new key name over the old one
 * at a level) with a backend other than `local`. Use for… writes user settings, which do not apply to these.
 */
export function workspaceOverrides(inspect: (key: string) => SettingLevels | undefined): WorkspaceOverride[] {
  const out: WorkspaceOverride[] = [];
  for (const k of SELECT_KEYS) {
    for (const level of ['workspaceFolder', 'workspace'] as const) {
      const field = `${level}Value` as const;
      const n = inspect(k.key)?.[field];
      const o = k.oldKey !== undefined ? inspect(k.oldKey)?.[field] : undefined;
      const v = n ?? o;
      if (v === undefined) continue;
      if (v !== LOCAL_BACKEND_ID) {
        out.push({ use: k.use, value: typeof v === 'string' ? v : JSON.stringify(v), level, key: k.key, ...(o !== undefined && k.oldKey ? { oldKey: k.oldKey } : {}) });
      }
      break;
    }
  }
  return out;
}
