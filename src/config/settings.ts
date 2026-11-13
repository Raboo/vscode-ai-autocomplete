import type { BackendConfig, BackendKind, FimMode, HostFlavor, ModelOverrideBody } from '../types';

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

export interface Inspected<T> { defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T }
export interface RawSettingsSource { inspect<T>(key: string): Inspected<T> | undefined }

const KINDS: readonly BackendKind[] = ['llamacpp', 'openai', 'mistral'];
const FIM_MODES: readonly FimMode[] = ['auto', 'native', 'template', 'chat'];
const FLAVORS: readonly HostFlavor[] = ['llamacpp', 'vllm', 'sglang', 'lmstudio', 'ollama', 'strata', 'deepseek', 'fireworks', 'together', 'openrouter', 'mistral', 'generic'];
const MULTILINE = ['auto', 'always', 'never'] as const;

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
      if (isObj(body)) modelOverrides[pattern] = body as ModelOverrideBody;
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
      disableInFiles: strs('fim.disableInFiles', ['**/.env', '**/.env.*', '**/*.pem', '**/*.key']),
      skipMidWord: resource('fim.skipMidWord', true),
    },
    privacy: { localOnly: resource('privacy.localOnly', false) },
    modelOverrides,
    debug: { logPrompts: machine('debug.logPrompts', false) },
  };
  return { settings, problems };
}
