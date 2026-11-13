import { TEMPLATES } from '../models/templates';
import type { BackendConfig, BackendKind, FimMode, FimTemplateId, HostFlavor, ModelOverrideBody, Sampling } from '../types';

export interface Settings {
  backends: BackendConfig[];
  fim: {
    enabled: boolean; backendId?: string; debounceMs: number | null; multiline: 'auto' | 'always' | 'never'; maxTokens: number;
    prefixLines: number; suffixLines: number; extraContext: boolean; disableInLanguages: string[]; disableInFiles: string[]; skipMidWord: boolean;
  };
  privacy: { localOnly: boolean };
  modelOverrides: Record<string, ModelOverrideBody>;
  debug: { logPrompts: boolean };
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
const FIM_MODES: readonly FimMode[] = ['auto', 'native', 'template', 'chat'];
const FLAVORS: readonly HostFlavor[] = ['llamacpp', 'vllm', 'sglang', 'lmstudio', 'ollama', 'strata', 'deepseek', 'fireworks', 'together', 'openrouter', 'mistral', 'generic'];
const MULTILINE = ['auto', 'always', 'never'] as const;
const SAMPLING_KEYS: readonly (keyof Sampling)[] = ['temperature', 'topP', 'topK', 'maxTokens'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function parseBackend(raw: unknown, i: number, seen: Set<string>): { backend?: BackendConfig; problem?: string } {
  const at = `aiAutocomplete.backends[${i}]`;
  if (!isObj(raw)) return { problem: `${at}: not an object, ignored` };
  const id = raw.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return { problem: `${at}: invalid id ${JSON.stringify(id)} (use lowercase letters, digits and dashes), ignored` };
  if (seen.has(id)) return { problem: `${at}: duplicate id "${id}", ignored` };
  if (typeof raw.kind !== 'string' || !KINDS.includes(raw.kind as BackendKind)) return { problem: `${at} ("${id}"): invalid kind ${JSON.stringify(raw.kind)}, ignored` };
  const baseUrl = str(raw.baseUrl);
  if (!baseUrl) return { problem: `${at} ("${id}"): missing baseUrl, ignored` };
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
  } catch {
    return { problem: `${at} ("${id}"): baseUrl "${baseUrl}" is not a valid http(s) URL, ignored` };
  }
  const fimMode = raw.fimMode === undefined ? 'auto' : raw.fimMode;
  if (typeof fimMode !== 'string' || !FIM_MODES.includes(fimMode as FimMode)) return { problem: `${at} ("${id}"): invalid fimMode ${JSON.stringify(fimMode)}, ignored` };
  const headers: Record<string, string> = {};
  if (isObj(raw.headers)) {
    for (const [k, v] of Object.entries(raw.headers)) if (typeof v === 'string') headers[k] = v;
  }
  seen.add(id);
  const backend: BackendConfig = { id, kind: raw.kind as BackendKind, baseUrl, fimMode: fimMode as FimMode, headers };
  if (typeof raw.hostFlavor === 'string' && FLAVORS.includes(raw.hostFlavor as HostFlavor)) backend.hostFlavor = raw.hostFlavor as HostFlavor;
  const fimModel = str(raw.fimModel);
  if (fimModel) backend.fimModel = fimModel;
  const nextEditModel = str(raw.nextEditModel);
  if (nextEditModel) backend.nextEditModel = nextEditModel;
  return { backend };
}

/** Keeps the valid parts of one modelOverrides entry; each dropped part adds a problem. */
function parseOverride(pattern: string, body: Record<string, unknown>, problems: string[]): ModelOverrideBody {
  const at = `aiAutocomplete.modelOverrides[${JSON.stringify(pattern)}]`;
  const out: ModelOverrideBody = {};
  const { fimTemplate, stop, sampling, extraBody } = body;
  if (fimTemplate !== undefined) {
    if (typeof fimTemplate === 'string' && Object.hasOwn(TEMPLATES, fimTemplate)) out.fimTemplate = fimTemplate as FimTemplateId;
    else problems.push(`${at}.fimTemplate: unknown template ${JSON.stringify(fimTemplate)} (use one of ${Object.keys(TEMPLATES).join(', ')}), ignored`);
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

export function parseSettings(src: RawSettingsSource): { settings: Settings; problems: string[] } {
  const problems: string[] = [];
  // Machine-scoped: never read workspace values (a repo must not redirect code to another host).
  const machine = <T>(key: string, fallback: T): T => {
    const i = src.inspect<T>(key);
    return i?.globalValue ?? i?.defaultValue ?? fallback;
  };
  const resource = <T>(key: string, fallback: T): T => {
    const i = src.inspect<T>(key);
    return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue ?? i?.defaultValue ?? fallback;
  };

  // Restrict-only: any level (or any workspace folder) set to true wins, so a workspace can turn it on but never off.
  const restrictOnly = (key: string): boolean => {
    const i = src.inspect<boolean>(key);
    return [i?.defaultValue, i?.globalValue, i?.workspaceValue, i?.workspaceFolderValue, ...(i?.folderValues ?? [])].some((v) => v === true);
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
      const { backend, problem } = parseBackend(r, i, seen);
      if (backend) backends.push(backend);
      if (problem) problems.push(problem);
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

  const requested = resource<unknown>('fim.backend', undefined);
  let backendId: string | undefined = backends[0]?.id;
  if (typeof requested === 'string' && requested !== '') {
    if (backends.some((b) => b.id === requested)) backendId = requested;
    else problems.push(`aiAutocomplete.fim.backend: no backend with id "${requested}"${backendId ? `, using "${backendId}"` : ''}`);
  }

  const multiline = resource<string>('fim.multiline', 'auto');
  const num = (key: string, d: number): number => {
    const v = resource<unknown>(key, d);
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  const strs = (key: string, d: string[]): string[] => {
    const v = resource<unknown>(key, d);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : d;
  };
  const debounce = resource<unknown>('fim.debounceMs', null);

  const settings: Settings = {
    backends,
    fim: {
      enabled: resource('fim.enabled', true),
      backendId,
      debounceMs: typeof debounce === 'number' && Number.isFinite(debounce) ? debounce : null,
      multiline: (MULTILINE as readonly string[]).includes(multiline) ? (multiline as Settings['fim']['multiline']) : 'auto',
      maxTokens: num('fim.maxTokens', 128),
      prefixLines: num('fim.prefixLines', 200),
      suffixLines: num('fim.suffixLines', 60),
      extraContext: resource('fim.extraContext', true),
      disableInLanguages: strs('fim.disableInLanguages', ['plaintext']),
      disableInFiles: unionStrs('fim.disableInFiles', ['**/.env', '**/.env.*', '**/*.pem', '**/*.key']),
      skipMidWord: resource('fim.skipMidWord', true),
    },
    privacy: { localOnly: restrictOnly('privacy.localOnly') },
    modelOverrides,
    debug: { logPrompts: machine('debug.logPrompts', false) },
  };
  return { settings, problems };
}
