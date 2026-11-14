import { createBackend } from '../backends';
import { inferHostFlavor, isHostedFlavor } from '../backends/hostFlavor';
import { resolveFim, templateMismatch, type ValueSource } from '../completion/effective';
import { planRoute } from '../completion/route';
import { FIM_LIMITS, parseBackendEntry, type Settings } from '../config/settings';
import { TEMPLATES } from '../models/templates';
import type { BackendConfig, BackendKind, FimTemplateId, HostFlavor } from '../types';
import type { BackendForm, ErrorField, FieldView, FormField, ServerTypeId } from './protocol';
import { SERVER_TYPES, serverTypeOf, suggestId } from './serverTypes';

export interface FieldError { field: ErrorField; message: string }

type Limited = keyof typeof FIM_LIMITS;
const FIELDS: readonly FormField[] = ['template', 'fimMode', 'multiline', 'contextTokens', 'prefixLines', 'suffixLines', 'extraContext',
  'temperature', 'topP', 'topK', 'maxTokens', 'debounceMs', 'timeoutMs', 'stop', 'headers', 'extraBody'];
/** The fields stored under `fim`; `fimMode` and `headers` live at the top level of the entry. */
const FIM_KEYS = FIELDS.filter((f) => f !== 'fimMode' && f !== 'headers');
const NUMERIC = Object.keys(FIM_LIMITS) as Limited[];
const FIM_MODES = ['auto', 'native', 'template', 'chat'];
const MULTILINES = ['auto', 'always', 'never'];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_HOSTED_STOPS = 4;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const typeInfo = (id: ServerTypeId) => SERVER_TYPES.find((t) => t.id === id) ?? SERVER_TYPES[SERVER_TYPES.length - 1]!;
const lines = (text: string): string[] => text.split(/\r?\n/).filter((l) => l.trim() !== '');
/** Typed text of a changed field; a blank field counts as not changed. */
const typed = (f: BackendForm, k: FormField): string | undefined => {
  const t = f.changed[k];
  return t === undefined || t.trim() === '' ? undefined : t;
};

/** The typed text of the form fields in `changed`; any other key (e.g. one a page message smuggled in) is dropped. */
export function knownChanged(changed: Record<string, unknown>): BackendForm['changed'] {
  const out: BackendForm['changed'] = {};
  for (const k of FIELDS) {
    const t = Object.hasOwn(changed, k) ? changed[k] : undefined;
    if (typeof t === 'string') out[k] = t;
  }
  return out;
}

export function newForm(type: ServerTypeId, taken: readonly string[]): BackendForm {
  const t = typeInfo(type);
  return { type, id: suggestId(type, taken), baseUrl: t.defaultUrl, model: t.defaultModel ?? '', changed: {} };
}

/**
 * `next` after a server-type change from `prev`: the URL, the model and (for a new backend) the id take the new type's
 * prefills, but only while each is empty or still the old type's prefill, so typed values survive.
 */
export function retypeForm(prev: BackendForm, next: BackendForm, taken: readonly string[], isNew: boolean): BackendForm {
  if (next.type === prev.type) return next;
  const from = typeInfo(prev.type);
  const to = typeInfo(next.type);
  const out = { ...next };
  if (out.baseUrl.trim() === '' || out.baseUrl === from.defaultUrl) out.baseUrl = to.defaultUrl;
  if (isNew && out.id === suggestId(prev.type, taken)) out.id = suggestId(next.type, taken);
  if (out.model.trim() === '' || out.model === (from.defaultModel ?? '')) out.model = to.defaultModel ?? '';
  return out;
}

export function entryToForm(raw: Record<string, unknown>): BackendForm {
  const kind = (raw.kind === 'llamacpp' || raw.kind === 'openai' || raw.kind === 'mistral' ? raw.kind : 'openai') as BackendKind;
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : '';
  const id = typeof raw.id === 'string' ? raw.id : '';
  const flavor = typeof raw.hostFlavor === 'string' ? (raw.hostFlavor as HostFlavor) : undefined;
  const changed: BackendForm['changed'] = {};
  if (isObj(raw.fim)) {
    for (const k of FIM_KEYS) {
      const v = raw.fim[k];
      if (v === undefined) continue;
      changed[k] = Array.isArray(v) ? v.join('\n') : isObj(v) ? JSON.stringify(v) : String(v);
    }
  }
  if (typeof raw.fimMode === 'string') changed.fimMode = raw.fimMode;
  if (isObj(raw.headers)) {
    const hs = Object.entries(raw.headers).filter(([, v]) => typeof v === 'string').map(([k, v]) => `${k}: ${v as string}`);
    if (hs.length > 0) changed.headers = hs.join('\n');
  }
  return { ...(id ? { originalId: id } : {}), type: serverTypeOf({ kind, ...(flavor ? { hostFlavor: flavor } : {}), baseUrl }), id, baseUrl,
    model: typeof raw.fimModel === 'string' ? raw.fimModel : '', changed };
}

function parseHeaders(text: string): { headers: Record<string, string>; bad: boolean } {
  const headers: Record<string, string> = {};
  let bad = false;
  for (const line of lines(text)) {
    const i = line.indexOf(':');
    if (i <= 0 || line.slice(0, i).trim() === '') bad = true;
    else headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { headers, bad };
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function validateForm(f: BackendForm, taken: readonly string[]): FieldError[] {
  const errors: FieldError[] = [];
  const err = (field: FieldError['field'], message: string): void => void errors.push({ field, message });
  if (!ID_RE.test(f.id)) err('id', 'use lowercase letters, digits and dashes');
  else if (f.id !== f.originalId && taken.includes(f.id)) err('id', 'another backend already uses this name');
  const url = f.baseUrl.trim();
  if (url === '') {
    if (f.type !== 'other') err('baseUrl', 'the URL is required');
  } else {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
    } catch {
      err('baseUrl', 'enter an http(s) URL');
    }
  }
  for (const k of NUMERIC) {
    const t = typed(f, k);
    if (t === undefined) continue;
    const l = FIM_LIMITS[k];
    const n = Number(t);
    const lo = l.exclusiveMin ? `greater than ${l.min}` : `${l.min}`;
    const range = l.max === undefined ? `${lo} or more` : l.exclusiveMin ? `${lo} and at most ${l.max}` : `${lo} to ${l.max}`;
    const ok = Number.isFinite(n) && (!l.integer || Number.isInteger(n)) && (l.exclusiveMin ? n > l.min : n >= l.min) && (l.max === undefined || n <= l.max);
    if (!ok) err(k, `expected ${l.integer ? 'an integer' : 'a number'} ${range}`);
  }
  const template = typed(f, 'template');
  if (template !== undefined && !Object.hasOwn(TEMPLATES, template)) err('template', 'unknown template');
  const mode = typed(f, 'fimMode');
  if (mode !== undefined && !FIM_MODES.includes(mode)) err('fimMode', `use one of ${FIM_MODES.join(', ')}`);
  const multiline = typed(f, 'multiline');
  if (multiline !== undefined && !MULTILINES.includes(multiline)) err('multiline', `use one of ${MULTILINES.join(', ')}`);
  const headers = typed(f, 'headers');
  if (headers !== undefined && parseHeaders(headers).bad) err('headers', 'each line needs the form Name: value');
  const body = typed(f, 'extraBody');
  if (body !== undefined && !parseJsonObject(body)) err('extraBody', 'enter a JSON object');
  return errors;
}

/** The entry to store. Keeps every key of `original` that the form does not own, including unknown keys inside `original.fim`. */
export function formToEntry(f: BackendForm, original?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...original };
  const t = typeInfo(f.type);
  // An unlisted kind/flavor pair of the original stays as it was.
  const keepPair = f.type === 'other' && original !== undefined
    && serverTypeOf({ kind: original.kind as BackendKind, ...(typeof original.hostFlavor === 'string' ? { hostFlavor: original.hostFlavor as HostFlavor } : {}), baseUrl: String(original.baseUrl ?? '') }) === 'other'
    && typeof original.kind === 'string';
  out.id = f.id;
  if (!keepPair) {
    out.kind = t.kind;
    if (t.kind === 'openai' && t.hostFlavor) out.hostFlavor = t.hostFlavor;
    else delete out.hostFlavor;
  }
  out.baseUrl = f.baseUrl.trim();
  if (f.model.trim() !== '') out.fimModel = f.model.trim();
  else delete out.fimModel;

  const fim: Record<string, unknown> = isObj(original?.fim) ? { ...original.fim } : {};
  for (const k of FIM_KEYS) delete fim[k];
  delete out.fimMode;
  delete out.headers;
  for (const k of FIELDS) {
    const text = typed(f, k);
    if (text === undefined) continue;
    if (k === 'fimMode') out.fimMode = text;
    else if (k === 'headers') {
      const { headers } = parseHeaders(text);
      if (Object.keys(headers).length > 0) out.headers = headers;
    } else if (k === 'template' || k === 'multiline') fim[k] = text;
    else if (k === 'extraContext') fim[k] = text === 'true';
    else if (k === 'stop') fim[k] = lines(text);
    else if (k === 'extraBody') {
      const body = parseJsonObject(text);
      if (body) fim[k] = body;
    } else {
      const n = Number(text);
      if (Number.isFinite(n)) fim[k] = n;
    }
  }
  if (Object.keys(fim).length > 0) out.fim = fim;
  else delete out.fim;
  return out;
}

export function formToConfig(f: BackendForm): BackendConfig | undefined {
  return parseBackendEntry(formToEntry(f), 0, new Set(), []);
}

const SOURCE_LABEL: Record<ValueSource, string> = {
  backend: 'this backend', preset: 'built-in preset for this model', modelOverride: 'your model overrides', settings: 'your settings', builtin: 'built-in default',
};
const LABELS: Record<FormField, string> = {
  template: 'Template', fimMode: 'Prompt mode', multiline: 'Multi-line', contextTokens: 'Context size (tokens)', prefixLines: 'Lines before cursor',
  suffixLines: 'Lines after cursor', extraContext: 'Use other open files', temperature: 'Temperature', topP: 'Top P', topK: 'Top K', maxTokens: 'Max tokens',
  debounceMs: 'Wait after typing (ms)', timeoutMs: 'Timeout (ms)', stop: 'Stop sequences', headers: 'Extra HTTP headers', extraBody: 'Extra request body (JSON)',
};
const ADAPTIVE = 'adaptive, starts at 75 ms (local) or 250 ms (hosted)';

/** The backend config a form describes, with only `fimMode` kept from the typed fields; a bad id or URL falls back to placeholders. */
function baseConfig(f: BackendForm): BackendConfig {
  const base: BackendForm = { ...f, id: ID_RE.test(f.id) ? f.id : 'backend', baseUrl: f.baseUrl.trim() || typeInfo(f.type).defaultUrl || 'http://127.0.0.1',
    changed: { ...(typed(f, 'fimMode') && FIM_MODES.includes(typed(f, 'fimMode')!) ? { fimMode: typed(f, 'fimMode')! } : {}) } };
  return formToConfig(base) ?? { id: 'backend', kind: typeInfo(f.type).kind, baseUrl: 'http://127.0.0.1', fimMode: 'auto', headers: {} };
}

export function fieldViews(f: BackendForm, model: string | undefined, s: Settings, errors: FieldError[]): FieldView[] {
  const cfg = baseConfig(f);
  const tpl = typed(f, 'template');
  const template = tpl !== undefined && Object.hasOwn(TEMPLATES, tpl) ? (tpl as FimTemplateId) : undefined;
  // The Template field's own default ignores the typed template; every other default and the route apply it, as completions do.
  const own = resolveFim({ ...cfg, fim: undefined }, model, s);
  const { values, sources, extraContextAllowed } = template === undefined ? own : resolveFim({ ...cfg, fim: { template } }, model, s);
  const hosted = isHostedFlavor(inferHostFlavor(cfg));
  const native = planRoute(cfg.kind, createBackend(cfg, async () => undefined).supportsNativeFim(), values, cfg.fimMode) === 'native';
  const num = (n: number | undefined): string => (n === undefined ? '' : String(n));
  const defaults: Record<FormField, { text: string; source: ValueSource; hint?: string }> = {
    template: { text: own.values.fimTemplate ?? '', source: own.sources.template },
    fimMode: { text: 'auto', source: 'builtin' },
    multiline: { text: values.multiline, source: sources.multiline },
    contextTokens: { text: num(values.contextTokens), source: sources.contextTokens },
    prefixLines: { text: num(values.prefixLines), source: sources.prefixLines },
    suffixLines: { text: num(values.suffixLines), source: sources.suffixLines },
    extraContext: { text: String(values.extraContext), source: sources.extraContext },
    temperature: { text: num(values.sampling.temperature), source: sources.temperature },
    topP: { text: num(values.sampling.topP), source: sources.topP },
    topK: { text: num(values.sampling.topK), source: sources.topK },
    maxTokens: { text: num(values.maxTokens), source: sources.maxTokens },
    debounceMs: values.debounceMs === null ? { text: 'auto', source: sources.debounceMs, hint: ADAPTIVE } : { text: String(values.debounceMs), source: sources.debounceMs },
    timeoutMs: { text: num(values.timeoutMs), source: sources.timeoutMs },
    stop: { text: values.stop.join('\n'), source: sources.stop },
    headers: { text: '', source: 'builtin' },
    extraBody: { text: Object.keys(values.extraBody).length > 0 ? JSON.stringify(values.extraBody) : '', source: sources.extraBody },
  };
  const options: Partial<Record<FormField, string[]>> = { template: Object.keys(TEMPLATES), fimMode: FIM_MODES, multiline: MULTILINES };
  const disabled: Partial<Record<FormField, string>> = {};
  if (hosted) disabled.topK = 'not sent to hosted servers';
  if (native) disabled.template = 'the server builds the prompt';
  if (cfg.kind === 'mistral') disabled.topP = 'not sent while temperature is set';
  if (!extraContextAllowed) disabled.extraContext = 'off in your settings';

  return FIELDS.map((field): FieldView => {
    const d = defaults[field];
    const text = typed(f, field);
    const label = SOURCE_LABEL[d.source];
    const shown = (d.text === '' ? 'none' : d.text.replace(/\n/g, ', '));
    const hint = text === undefined ? (d.hint ?? `Default (${label})`) : `Default: ${d.text === 'auto' && d.hint ? `auto (${d.hint})` : shown} (${label})`;
    const error = errors.find((e) => e.field === field)?.message;
    return {
      field, label: LABELS[field], value: text ?? d.text, isDefault: text === undefined, hint,
      ...(options[field] ? { options: options[field] } : {}),
      ...(disabled[field] ? { disabledReason: disabled[field] } : {}),
      ...(error ? { error } : {}),
    };
  });
}

/** Warnings that do not block Save: a hosted flavor sends only the first 4 stop sequences; a Template differs from the model's own. */
export function formWarnings(f: BackendForm, model: string | undefined, s: Settings): string[] {
  const cfg = formToConfig(f);
  if (!cfg) return [];
  const out: string[] = [];
  const values = resolveFim(cfg, model, s).values;
  if (isHostedFlavor(inferHostFlavor(cfg)) && values.stop.length > MAX_HOSTED_STOPS) out.push(`only the first ${MAX_HOSTED_STOPS} stop sequences are sent`);
  const mismatch = templateMismatch(cfg, model, s);
  // On the native route the server builds the prompt, so the Template is not used.
  if (mismatch && model !== undefined && planRoute(cfg.kind, createBackend(cfg, async () => undefined).supportsNativeFim(), values, cfg.fimMode) !== 'native') {
    out.push(`${model}'s own template is ${mismatch.own}; reset Template unless you mean to override it`);
  }
  return out;
}

const idOf = (v: unknown): unknown => (isObj(v) ? v.id : undefined);

/** Replaces the entry `originalId ?? entry.id` in place, or appends; every other entry is kept as is. */
export function upsertBackend(raw: unknown, entry: Record<string, unknown>, originalId?: string): unknown[] {
  const list = Array.isArray(raw) ? [...(raw as unknown[])] : [];
  const at = list.findIndex((e) => idOf(e) === (originalId ?? entry.id));
  if (at >= 0) list[at] = entry;
  else list.push(entry);
  return list;
}

export function removeBackend(raw: unknown, id: string): unknown[] {
  return Array.isArray(raw) ? (raw as unknown[]).filter((e) => idOf(e) !== id) : [];
}

export function planRename(oldId: string, newId: string, userFimBackend?: string, workspaceFimBackend?: string): { moveKey: boolean; updateUserFimBackend: boolean; warnWorkspace: boolean } {
  if (oldId === newId) return { moveKey: false, updateUserFimBackend: false, warnWorkspace: false };
  return { moveKey: true, updateUserFimBackend: userFimBackend === oldId, warnWorkspace: workspaceFimBackend === oldId };
}
