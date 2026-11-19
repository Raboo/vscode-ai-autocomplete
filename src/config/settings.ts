import { DEFAULT_NEXT_EDIT_TIMEOUT_MS } from '../completion/effective';
import { parseLocalModels, type LocalModelEntry } from '../local/modelList';
import { TEMPLATES } from '../models/templates';
import { BACKEND_FIELD_RENAMES, COMPLETIONS_KEYS, inspectRenamed, OLD_NAME_NOTE, oldKeyProblem, renameBackendEntry, type CompletionsKey } from './rename';
import type { BackendConfig, BackendFimSettings, BackendKind, FimMode, FimTemplateId, HostFlavor, ModelOverrideBody, Multiline, Sampling, ThinkingStrategy } from '../types';

export const NEXT_EDIT_FORMATS = ['auto', 'chatXtab', 'sweep', 'zeta21'] as const;
export const NEXT_EDIT_DISPLAYS = ['auto', 'native', 'decorations'] as const;
export type NextEditFormatSetting = (typeof NEXT_EDIT_FORMATS)[number];
export type NextEditDisplay = (typeof NEXT_EDIT_DISPLAYS)[number];

export type BackendUse = 'completions' | 'nextEdit';
export const BACKEND_USES: readonly BackendUse[] = ['completions', 'nextEdit'];

/** Whether the backend serves the given use. */
export function usesFor(cfg: BackendConfig, use: BackendUse): boolean {
  return cfg.use[use];
}

export interface Settings {
  /** The switch for completions and Next Edit together; off keeps both selections. */
  enabled: boolean;
  backends: BackendConfig[];
  fim: {
    enabled: boolean; backendId?: string; debounceMs: number | null; multiline: Multiline; maxTokens: number;
    prefixLines: number; suffixLines: number; extraContext: boolean; disableInLanguages: string[]; disableInFiles: string[]; skipMidWord: boolean;
  };
  nextEdit: {
    enabled: boolean; backendId?: string; timeoutMs: number; format: NextEditFormatSetting; display: NextEditDisplay;
    regionLinesAbove: number; regionLinesBelow: number; historySize: number; contextBudget: number;
    /** Send definitions of symbols near the cursor (from the language server), with extra context only. */
    definitions: boolean;
  };
  privacy: { localOnly: boolean };
  modelOverrides: Record<string, ModelOverrideBody>;
  debug: { logPrompts: boolean };
  /** Machine-scoped `local` settings (global values only): the llama-server path (unset: PATH and usual places), the models folder (absolute; unset: the default), how many models stay loaded, and the model list. */
  local: { llamaServerPath?: string; modelsDir?: string; modelsInMemory: number; models: LocalModelEntry[] };
}

/** Files whose content is never sent by default: environment files, keys and credential stores. */
export const DEFAULT_DISABLE_IN_FILES: readonly string[] = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/.npmrc', '**/.pypirc', '**/*.tfvars', '**/*.p12', '**/*.pfx', '**/.netrc', '**/.docker/config.json', '**/id_rsa*', '**/id_ed25519*'];

/**
 * Where a choice made in the UI (a switch, a selected backend) is written: the workspace only when it already sets the
 * key (a user setting would not take effect over it), otherwise user settings, so the repo's .vscode/settings.json stays untouched.
 */
export function writesToWorkspace(i: Inspected<unknown> | undefined): boolean {
  return i?.workspaceValue !== undefined;
}

export interface Inspected<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
  /** The value set in each folder of a multi-root workspace (folders that set none are left out). */
  folderValues?: T[];
}
export interface RawSettingsSource { inspect<T>(key: string): Inspected<T> | undefined }

/**
 * Adds each workspace folder's value to the window-level configuration. In a multi-root workspace, folder
 * settings are only visible to a configuration read with that folder as its scope.
 */
export function withFolderValues(root: RawSettingsSource, folders: RawSettingsSource[]): RawSettingsSource {
  return {
    inspect: <T>(key: string) => {
      const i = root.inspect<T>(key);
      const folderValues = folders.map((f) => f.inspect<T>(key)?.workspaceFolderValue).filter((v): v is T => v !== undefined);
      return folderValues.length === 0 ? i : { ...i, folderValues };
    },
  };
}

const KINDS: readonly BackendKind[] = ['llamacpp', 'openai', 'mistral'];
export const FIM_MODES: readonly FimMode[] = ['auto', 'native', 'template', 'chat'];
export const HOST_FLAVORS: readonly HostFlavor[] = ['llamacpp', 'vllm', 'sglang', 'lmstudio', 'ollama', 'strata', 'deepseek', 'fireworks', 'together', 'openrouter', 'mistral', 'generic'];
export const MULTILINE: readonly Multiline[] = ['auto', 'always', 'never'];
export const THINKING_STRATEGIES: readonly ThinkingStrategy[] = ['none', 'templateKwarg:enable_thinking', 'templateKwarg:thinking', 'templateKwarg:thinking_mode=disabled',
  'templateKwarg:thinking_budget=0', 'reasoningEffortNone', 'systemSoftSwitch:/no_think', 'vendorThinkingDisabled', 'cannotDisable'];
const SAMPLING_KEYS: readonly (keyof Sampling)[] = ['temperature', 'topP', 'topK', 'maxTokens'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Allowed range of each numeric completion setting (global and per backend); the package.json schema and the Backends page use the same values. */
export const FIM_LIMITS: Record<'temperature' | 'topP' | 'topK' | 'maxTokens' | 'prefixLines' | 'suffixLines' | 'contextTokens' | 'debounceMs' | 'timeoutMs',
  { min: number; max?: number; integer: boolean; exclusiveMin?: boolean }> = {
  temperature: { min: 0, max: 2, integer: false },
  topP: { min: 0, max: 1, integer: false, exclusiveMin: true },
  topK: { min: 0, integer: true },
  maxTokens: { min: 1, max: 4096, integer: true },
  prefixLines: { min: 0, max: 10000, integer: true },
  suffixLines: { min: 0, max: 10000, integer: true },
  contextTokens: { min: 256, max: 131072, integer: true },
  debounceMs: { min: 0, max: 2000, integer: true },
  timeoutMs: { min: 500, max: 60000, integer: true },
};

/** Allowed range and default of the numeric Next Edit settings; package.json uses the same values. */
export const NEXT_EDIT_LIMITS = {
  regionLinesAbove: { min: 0, max: 20, integer: true, default: 5 },
  regionLinesBelow: { min: 0, max: 40, integer: true, default: 10 },
  historySize: { min: 0, max: 10, integer: true, default: 5 },
  contextBudget: { min: 1000, max: 16000, integer: true, default: 3500 },
} as const;

function limitText(l: { min: number; max?: number; integer: boolean; exclusiveMin?: boolean }): string {
  const lo = l.exclusiveMin ? `greater than ${l.min}` : `${l.min}`;
  const range = l.max === undefined ? `${lo} or more` : l.exclusiveMin ? `${lo} and at most ${l.max}` : `${lo} to ${l.max}`;
  return `${l.integer ? 'an integer ' : 'a number '}${range}`;
}

/** Keeps the valid keys of one backend's `completions` object; each dropped key adds a problem. */
function parseBackendFim(raw: unknown, at: string, problems: string[], name = 'completions'): BackendFimSettings | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) {
    problems.push(`${at}.${name}: not an object, ignored`);
    return undefined;
  }
  const out: BackendFimSettings = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    const bad = (why: string): void => void problems.push(`${at}.${name}.${k}: ${why}, ignored`);
    if (Object.hasOwn(FIM_LIMITS, k)) {
      const key = k as keyof typeof FIM_LIMITS;
      const l = FIM_LIMITS[key];
      const ok = typeof v === 'number' && Number.isFinite(v) && (!l.integer || Number.isInteger(v)) && (l.exclusiveMin ? v > l.min : v >= l.min) && (l.max === undefined || v <= l.max);
      if (ok) out[key] = v;
      else bad(`expected ${limitText(l)}`);
    } else if (k === 'template') {
      if (typeof v === 'string' && Object.hasOwn(TEMPLATES, v)) out.template = v as FimTemplateId;
      else bad(`unknown template ${JSON.stringify(v)} (use one of ${Object.keys(TEMPLATES).join(', ')})`);
    } else if (k === 'multiline') {
      if (typeof v === 'string' && MULTILINE.includes(v as Multiline)) out.multiline = v as Multiline;
      else bad(`expected one of ${MULTILINE.join(', ')}`);
    } else if (k === 'thinking') {
      if (typeof v === 'string' && THINKING_STRATEGIES.includes(v as ThinkingStrategy)) out.thinking = v as ThinkingStrategy;
      else bad(`unknown thinking switch ${JSON.stringify(v)} (use one of ${THINKING_STRATEGIES.join(', ')})`);
    } else if (k === 'extraContext') {
      if (typeof v === 'boolean') out.extraContext = v;
      else bad('expected true or false');
    } else if (k === 'stop') {
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out.stop = v;
      else bad('not a list of strings');
    } else if (k === 'extraBody') {
      if (isObj(v)) out.extraBody = v;
      else bad('not an object');
    } else bad('unknown key');
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parses a backend's `use` list. Missing means both; an empty list, a non-array or only unknown values count as both too, with a problem. */
function parseUse(raw: unknown, where: string, problems: string[]): BackendConfig['use'] {
  const both = { completions: true, nextEdit: true };
  if (raw === undefined) return both;
  if (!Array.isArray(raw)) {
    problems.push(`${where}: use is not a list (expected ${BACKEND_USES.join(', ')}), counted as both`);
    return both;
  }
  const kept = new Set<BackendUse>();
  for (const v of raw) {
    if (typeof v === 'string' && (BACKEND_USES as readonly string[]).includes(v)) kept.add(v as BackendUse);
    else problems.push(`${where}: use ${JSON.stringify(v)} is not one of ${BACKEND_USES.join(', ')}, ignored`);
  }
  if (kept.size === 0) {
    if (raw.length === 0) problems.push(`${where}: use is empty (expected ${BACKEND_USES.join(', ')}), counted as both`);
    return both;
  }
  return { completions: kept.has('completions'), nextEdit: kept.has('nextEdit') };
}

const NEW_FIELD = new Map(BACKEND_FIELD_RENAMES);

/** Parses one raw backends entry; pushes every problem; undefined when the entry is unusable. `seen` collects ids for duplicate checks. */
export function parseBackendEntry(given: unknown, i: number, seen: Set<string>, problems: string[]): BackendConfig | undefined {
  const fail = (problem: string): undefined => void problems.push(problem);
  const at = `aiAutocomplete.backends[${i}]`;
  if (!isObj(given)) return fail(`${at}: not an object, ignored`);
  // Old field names (fimModel, fimMode, fim) are read until 2.0, each with a note.
  const { entry: raw, renamed } = renameBackendEntry(given);
  const id = raw.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return fail(`${at}: invalid id ${JSON.stringify(id)} (use lowercase letters, digits and dashes), ignored`);
  if (seen.has(id)) return fail(`${at}: duplicate id "${id}", ignored`);
  if (typeof raw.kind !== 'string' || !KINDS.includes(raw.kind as BackendKind)) return fail(`${at} ("${id}"): invalid kind ${JSON.stringify(raw.kind)}, ignored`);
  const baseUrl = str(raw.baseUrl);
  if (!baseUrl) return fail(`${at} ("${id}"): missing baseUrl, ignored`);
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
  } catch {
    return fail(`${at} ("${id}"): baseUrl "${baseUrl}" is not a valid http(s) URL, ignored`);
  }
  const usedOld = (field: string): boolean => renamed.includes(field) && !Object.hasOwn(given, NEW_FIELD.get(field) as string);
  const fimMode = raw.mode === undefined ? 'auto' : raw.mode;
  if (typeof fimMode !== 'string' || !FIM_MODES.includes(fimMode as FimMode)) return fail(`${at} ("${id}"): invalid ${usedOld('fimMode') ? 'fimMode' : 'mode'} ${JSON.stringify(fimMode)}, ignored`);
  const headers: Record<string, string> = {};
  if (isObj(raw.headers)) {
    for (const [k, v] of Object.entries(raw.headers)) if (typeof v === 'string') headers[k] = v;
  }
  seen.add(id);
  const backend: BackendConfig = { id, kind: raw.kind as BackendKind, baseUrl, fimMode: fimMode as FimMode, headers, use: parseUse(raw.use, `${at} ("${id}")`, problems) };
  if (typeof raw.hostFlavor === 'string' && HOST_FLAVORS.includes(raw.hostFlavor as HostFlavor)) backend.hostFlavor = raw.hostFlavor as HostFlavor;
  const fimModel = str(raw.model);
  if (fimModel) backend.fimModel = fimModel;
  const nextEditModel = str(raw.nextEditModel);
  if (nextEditModel) backend.nextEditModel = nextEditModel;
  const fim = parseBackendFim(raw.completions, `${at} ("${id}")`, problems, usedOld('fim') ? 'fim' : 'completions');
  if (fim) backend.fim = fim;
  for (const [from, to] of BACKEND_FIELD_RENAMES) {
    if (renamed.includes(from)) problems.push(`${at} ("${id}"): ${from} is now ${to}${usedOld(from) ? '' : ` (${from} is ignored, ${to} is set)`}; ${OLD_NAME_NOTE}`);
  }
  return backend;
}

/** Keeps the valid parts of one modelOverrides entry; each dropped part adds a problem. */
function parseOverride(pattern: string, body: Record<string, unknown>, problems: string[]): ModelOverrideBody {
  const at = `aiAutocomplete.modelOverrides[${JSON.stringify(pattern)}]`;
  const out: ModelOverrideBody = {};
  const { fimTemplate, stop, sampling, extraBody, thinking } = body;
  if (fimTemplate !== undefined) {
    if (typeof fimTemplate === 'string' && Object.hasOwn(TEMPLATES, fimTemplate)) out.fimTemplate = fimTemplate as FimTemplateId;
    else problems.push(`${at}.fimTemplate: unknown template ${JSON.stringify(fimTemplate)} (use one of ${Object.keys(TEMPLATES).join(', ')}), ignored`);
  }
  if (thinking !== undefined) {
    if (typeof thinking === 'string' && THINKING_STRATEGIES.includes(thinking as ThinkingStrategy)) out.thinking = thinking as ThinkingStrategy;
    else problems.push(`${at}.thinking: unknown thinking switch ${JSON.stringify(thinking)} (use one of ${THINKING_STRATEGIES.join(', ')}), ignored`);
  }
  if (stop !== undefined) {
    if (Array.isArray(stop) && stop.every((x) => typeof x === 'string')) out.stop = stop;
    else problems.push(`${at}.stop: not a list of strings, ignored`);
  }
  if (sampling !== undefined) {
    if (isObj(sampling)) {
      const kept: Partial<Sampling> = {};
      for (const [k, v] of Object.entries(sampling)) {
        if ((SAMPLING_KEYS as readonly string[]).includes(k) && typeof v === 'number' && Number.isFinite(v)) kept[k as keyof Sampling] = v;
        else problems.push(`${at}.sampling.${k}: only finite numbers for ${SAMPLING_KEYS.join(', ')} are used, ignored`);
      }
      out.sampling = kept;
    } else problems.push(`${at}.sampling: not an object, ignored`);
  }
  if (extraBody !== undefined) {
    if (isObj(extraBody)) out.extraBody = extraBody;
    else problems.push(`${at}.extraBody: not an object, ignored`);
  }
  return out;
}

export function parseSettings(given: RawSettingsSource): { settings: Settings; problems: string[] } {
  const problems: string[] = [];
  // completions.* falls back to the old fim.* name at each level, with a note per old key read.
  const renamedKeys = new Map<string, CompletionsKey>(COMPLETIONS_KEYS.map((k) => [`completions.${k}`, k]));
  const noted = new Set<CompletionsKey>();
  const src: RawSettingsSource = {
    inspect: <T>(key: string) => {
      const k = renamedKeys.get(key);
      if (k === undefined) return given.inspect<T>(key);
      const { inspected, usedOld } = inspectRenamed<T>(given, k);
      if (usedOld && !noted.has(k)) {
        noted.add(k);
        problems.push(oldKeyProblem(k));
      }
      return inspected;
    },
  };
  // Machine-scoped: never read workspace values (a repo must not redirect code to another host).
  const machine = <T>(key: string, fallback: T): T => {
    const i = src.inspect<T>(key);
    return i?.globalValue ?? i?.defaultValue ?? fallback;
  };
  const localPath = (key: string): string | undefined => {
    const v = machine<unknown>(key, '');
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  const modelsDir = ((): string | undefined => {
    const v = localPath('local.modelsDir');
    if (v === undefined) return undefined;
    if (/^([/\\]|[A-Za-z]:[/\\])/.test(v)) return v;
    problems.push('aiAutocomplete.local.modelsDir must be an absolute folder path');
    return undefined;
  })();
  const modelsInMemory = ((): number => {
    const v = machine<unknown>('local.modelsInMemory', 1);
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) return v;
    problems.push('aiAutocomplete.local.modelsInMemory: expected a whole number of 1 or more, using 1');
    return 1;
  })();
  const localModels = parseLocalModels(machine<unknown>('local.models', []));
  problems.push(...localModels.problems);
  const resource = <T>(key: string, fallback: T): T => {
    const i = src.inspect<T>(key);
    return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue ?? i?.defaultValue ?? fallback;
  };

  // Restrict-only: any level (or any workspace folder) set to true wins, so a workspace can turn it on but never off.
  const restrictOnly = (key: string): boolean => {
    const i = src.inspect<boolean | string>(key);
    const levels = [i?.defaultValue, i?.globalValue, i?.workspaceValue, i?.workspaceFolderValue, ...(i?.folderValues ?? [])];
    if (levels.some((v) => v === 'true')) problems.push(`aiAutocomplete.${key}: expected true or false; "true" read as true`);
    return levels.some((v) => v === true || v === 'true');
  };
  // Restrict-only list: the user's list (else the default) plus whatever a workspace or folder adds; a workspace cannot remove entries.
  const unionStrs = (key: string, d: string[]): string[] => {
    const i = src.inspect<unknown>(key);
    const base = [i?.globalValue, i?.defaultValue, d].find(Array.isArray) as unknown[];
    const out = new Set<string>();
    for (const list of [base, i?.workspaceValue, i?.workspaceFolderValue, ...(i?.folderValues ?? [])]) {
      if (Array.isArray(list)) for (const x of list) if (typeof x === 'string') out.add(x);
    }
    return [...out];
  };

  const rawBackends = machine<unknown>('backends', []);
  const backends: BackendConfig[] = [];
  if (Array.isArray(rawBackends)) {
    const seen = new Set<string>();
    rawBackends.forEach((r, i) => {
      const backend = parseBackendEntry(r, i, seen, problems);
      if (backend) backends.push(backend);
    });
  } else problems.push('aiAutocomplete.backends: not an array, ignored');

  const rawOverrides = machine<unknown>('modelOverrides', {});
  const modelOverrides: Record<string, ModelOverrideBody> = {};
  if (isObj(rawOverrides)) {
    for (const [pattern, body] of Object.entries(rawOverrides)) {
      try {
        new RegExp(pattern);
      } catch {
        problems.push(`aiAutocomplete.modelOverrides: "${pattern}" is not a valid regular expression, ignored`);
        continue;
      }
      if (isObj(body)) modelOverrides[pattern] = parseOverride(pattern, body, problems);
      else problems.push(`aiAutocomplete.modelOverrides: "${pattern}" is not an object, ignored`);
    }
  }

  const requested = resource<unknown>('completions.backend', undefined);
  let backendId: string | undefined = backends.find((b) => usesFor(b, 'completions'))?.id;
  if (typeof requested === 'string' && requested !== '') {
    const found = backends.find((b) => b.id === requested);
    if (found && !usesFor(found, 'completions')) {
      backendId = undefined;
      problems.push(`aiAutocomplete.completions.backend: backend "${requested}" is not used for completions; completions have no backend`);
    } else if (found) backendId = requested;
    else problems.push(`aiAutocomplete.completions.backend: no backend with id "${requested}"${backendId ? `, using "${backendId}"` : ''}`);
  }

  // Unlike completions.backend, no fallback: Next Edit stays off until a backend is chosen.
  const nextEditRequested = resource<unknown>('nextEdit.backend', undefined);
  let nextEditBackendId: string | undefined;
  if (typeof nextEditRequested === 'string' && nextEditRequested !== '') {
    const found = backends.find((b) => b.id === nextEditRequested);
    if (found && !usesFor(found, 'nextEdit')) problems.push(`aiAutocomplete.nextEdit.backend: backend "${nextEditRequested}" is not used for Next Edit; Next Edit is off`);
    else if (found) nextEditBackendId = nextEditRequested;
    else problems.push(`aiAutocomplete.nextEdit.backend: no backend with id "${nextEditRequested}"; Next Edit is off`);
  }
  const nextEditTimeout = resource<unknown>('nextEdit.timeoutMs', DEFAULT_NEXT_EDIT_TIMEOUT_MS);
  const tl = FIM_LIMITS.timeoutMs;
  const nextEditTimeoutOk = typeof nextEditTimeout === 'number' && Number.isInteger(nextEditTimeout) && nextEditTimeout >= tl.min && nextEditTimeout <= (tl.max as number);
  if (!nextEditTimeoutOk && nextEditTimeout !== DEFAULT_NEXT_EDIT_TIMEOUT_MS) problems.push(`aiAutocomplete.nextEdit.timeoutMs: expected ${limitText(tl)}, ignored`);

  const nextEditEnum = <T extends string>(key: 'format' | 'display', allowed: readonly T[]): T => {
    const v = resource<unknown>(`nextEdit.${key}`, 'auto');
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
    if (v !== 'auto') problems.push(`aiAutocomplete.nextEdit.${key}: expected one of ${allowed.join(', ')}, ignored`);
    return 'auto' as T;
  };
  const nextEditInt = (key: keyof typeof NEXT_EDIT_LIMITS): number => {
    const l = NEXT_EDIT_LIMITS[key];
    const v = resource<unknown>(`nextEdit.${key}`, l.default);
    if (typeof v === 'number' && Number.isInteger(v) && v >= l.min && v <= l.max) return v;
    if (v !== l.default) problems.push(`aiAutocomplete.nextEdit.${key}: expected ${limitText(l)}, ignored`);
    return l.default;
  };

  const multiline = resource<string>('completions.multiline', 'auto');
  const num = (key: string, d: number): number => {
    const v = resource<unknown>(key, d);
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  const strs = (key: string, d: string[]): string[] => {
    const v = resource<unknown>(key, d);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : d;
  };
  const debounce = resource<unknown>('completions.debounceMs', null);

  const settings: Settings = {
    enabled: resource('enabled', true),
    backends,
    fim: {
      enabled: resource('completions.enabled', true),
      backendId,
      debounceMs: typeof debounce === 'number' && Number.isFinite(debounce) ? debounce : null,
      multiline: (MULTILINE as readonly string[]).includes(multiline) ? (multiline as Multiline) : 'auto',
      maxTokens: num('completions.maxTokens', 128),
      prefixLines: num('completions.prefixLines', 200),
      suffixLines: num('completions.suffixLines', 60),
      extraContext: resource('completions.extraContext', true),
      disableInLanguages: strs('completions.disableInLanguages', ['plaintext']),
      disableInFiles: unionStrs('completions.disableInFiles', [...DEFAULT_DISABLE_IN_FILES]),
      skipMidWord: resource('completions.skipMidWord', true),
    },
    nextEdit: {
      enabled: resource('nextEdit.enabled', true),
      ...(nextEditBackendId !== undefined ? { backendId: nextEditBackendId } : {}),
      timeoutMs: nextEditTimeoutOk ? nextEditTimeout : DEFAULT_NEXT_EDIT_TIMEOUT_MS,
      format: nextEditEnum('format', NEXT_EDIT_FORMATS),
      display: nextEditEnum('display', NEXT_EDIT_DISPLAYS),
      regionLinesAbove: nextEditInt('regionLinesAbove'),
      regionLinesBelow: nextEditInt('regionLinesBelow'),
      historySize: nextEditInt('historySize'),
      contextBudget: nextEditInt('contextBudget'),
      definitions: resource<unknown>('nextEdit.definitions', true) !== false,
    },
    privacy: { localOnly: restrictOnly('privacy.localOnly') },
    modelOverrides,
    debug: { logPrompts: machine('debug.logPrompts', false) },
    local: {
      ...(localPath('local.llamaServerPath') !== undefined ? { llamaServerPath: localPath('local.llamaServerPath') } : {}),
      ...(modelsDir !== undefined ? { modelsDir } : {}),
      modelsInMemory,
      models: localModels.entries,
    },
  };
  return { settings, problems };
}
