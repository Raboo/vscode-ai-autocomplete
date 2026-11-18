import type { Settings } from '../config/settings';
import { resolvePreset, type SamplingParams } from '../models/presets';
import type { BackendConfig, FimTemplateId, Multiline, ThinkingStrategy } from '../types';

export const DEFAULT_CONTEXT_TOKENS = 4700;
export const CHARS_PER_TOKEN = 3.5;
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_NEXT_EDIT_TIMEOUT_MS = 10_000;
/** Sampling for the Next Edit chat prompt. */
export const NEXT_EDIT_SAMPLING = { temperature: 0.2, topP: 0.8, topK: 20 };

export type ValueSource = 'backend' | 'modelOverride' | 'settings' | 'preset' | 'builtin';
export type FimField = 'template' | 'temperature' | 'topP' | 'topK' | 'maxTokens' | 'multiline' | 'prefixLines' | 'suffixLines'
  | 'contextTokens' | 'extraContext' | 'debounceMs' | 'timeoutMs' | 'stop' | 'extraBody' | 'thinking';

export interface FimValues {
  presetId: string;
  fimTemplate?: FimTemplateId;
  suffixFirst: boolean;
  stop: string[];
  extraBody: Record<string, unknown>;
  sampling: { temperature?: number; topP?: number; topK?: number };
  maxTokens: number;
  multiline: Multiline;
  prefixLines: number;
  suffixLines: number;
  contextTokens: number;
  extraContext: boolean;
  /** null = adaptive. */
  debounceMs: number | null;
  timeoutMs: number;
  chat: boolean;
  thinking: ThinkingStrategy;
  samplingParams: SamplingParams;
  /** The backend's own `fim.stop`, without preset stops. */
  backendStop: string[];
}

export interface ResolvedFim {
  values: FimValues;
  sources: Record<FimField, ValueSource>;
  /** The `completions.extraContext` setting: a backend can only restrict extra context, never enable it. */
  extraContextAllowed: boolean;
}

/** Character budgets for the prefix, suffix and extra context: 50%, 15% and 35% of the context tokens. */
export function contextCaps(contextTokens: number): { maxPrefixChars: number; maxSuffixChars: number; extraChars: number } {
  const chars = contextTokens * CHARS_PER_TOKEN;
  return { maxPrefixChars: Math.round(chars * 0.5), maxSuffixChars: Math.round(chars * 0.15), extraChars: Math.round(chars * 0.35) };
}

/**
 * The values one request to `backend` uses for `model` (undefined = unknown model, generic preset).
 * Precedence, highest first: the backend's `fim`, a matching modelOverrides entry, the `fim.*` settings, the preset or built-in value.
 */
export function resolveFim(backend: BackendConfig, model: string | undefined, s: Settings): ResolvedFim {
  const b = backend.fim ?? {};
  const preset = resolvePreset(model ?? '', s.modelOverrides, b.template);
  const ov = preset.overridden;
  const fromPreset = (k: 'temperature' | 'topP' | 'topK'): ValueSource => (b[k] !== undefined ? 'backend' : ov.sampling.includes(k) ? 'modelOverride' : 'preset');
  const fromSettings = <T>(backendValue: T | undefined): ValueSource => (backendValue !== undefined ? 'backend' : 'settings');
  const layered = (backendSet: boolean, overrideSet: boolean): ValueSource => (backendSet ? 'backend' : overrideSet ? 'modelOverride' : 'preset');

  const sampling: FimValues['sampling'] = {};
  for (const k of ['temperature', 'topP', 'topK'] as const) {
    const v = b[k] ?? preset.sampling[k];
    if (v !== undefined) sampling[k] = v;
  }
  // The preset's own maxTokens (128) is never the budget: only a backend or override value replaces completions.maxTokens.
  const maxTokens = b.maxTokens ?? (ov.sampling.includes('maxTokens') ? preset.sampling.maxTokens : s.fim.maxTokens);
  const extraContext = (b.extraContext ?? true) && s.fim.extraContext;

  const values: FimValues = {
    presetId: preset.id,
    ...(preset.fimTemplate !== undefined ? { fimTemplate: preset.fimTemplate } : {}),
    suffixFirst: preset.suffixFirst,
    stop: [...new Set([...preset.stop, ...(b.stop ?? [])])],
    extraBody: { ...preset.extraBody, ...b.extraBody },
    sampling,
    maxTokens,
    multiline: b.multiline ?? s.fim.multiline,
    prefixLines: b.prefixLines ?? s.fim.prefixLines,
    suffixLines: b.suffixLines ?? s.fim.suffixLines,
    contextTokens: b.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
    extraContext,
    debounceMs: b.debounceMs ?? s.fim.debounceMs,
    timeoutMs: b.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    chat: preset.chat,
    thinking: b.thinking ?? preset.thinking,
    samplingParams: preset.samplingParams,
    backendStop: [...(b.stop ?? [])],
  };
  const sources: Record<FimField, ValueSource> = {
    template: layered(b.template !== undefined, ov.fimTemplate),
    temperature: fromPreset('temperature'),
    topP: fromPreset('topP'),
    topK: fromPreset('topK'),
    maxTokens: b.maxTokens !== undefined ? 'backend' : ov.sampling.includes('maxTokens') ? 'modelOverride' : 'settings',
    multiline: fromSettings(b.multiline),
    prefixLines: fromSettings(b.prefixLines),
    suffixLines: fromSettings(b.suffixLines),
    contextTokens: b.contextTokens !== undefined ? 'backend' : 'builtin',
    extraContext: fromSettings(b.extraContext),
    debounceMs: fromSettings(b.debounceMs),
    timeoutMs: b.timeoutMs !== undefined ? 'backend' : 'builtin',
    stop: layered(b.stop !== undefined, ov.stop),
    extraBody: layered(b.extraBody !== undefined, ov.extraBody),
    thinking: layered(b.thinking !== undefined, ov.thinking),
  };
  return { values, sources, extraContextAllowed: s.fim.extraContext };
}

/**
 * The backend's Template when the model has a different one of its own (preset or modelOverrides), else undefined.
 * The Template belongs to the backend, so it stays when the model changes: a template chosen for Zeta then sends Mellum a prompt it cannot read.
 */
export function templateMismatch(backend: BackendConfig, model: string | undefined, s: Settings): { template: FimTemplateId; own: FimTemplateId } | undefined {
  const template = backend.fim?.template;
  if (template === undefined) return undefined;
  const own = resolveFim({ ...backend, fim: undefined }, model, s).values.fimTemplate;
  return own !== undefined && own !== template ? { template, own } : undefined;
}

/** The model Next Edit requests use: the backend's `nextEditModel`, else its `fimModel` (only when it serves completions), else the detected one. */
export function nextEditModel(backend: BackendConfig, detected: string | undefined): string | undefined {
  return backend.nextEditModel ?? (backend.use.completions ? backend.fimModel : undefined) ?? detected;
}

/**
 * The values one Next Edit request uses. The backend's `fim` block belongs to the FIM model, so a separate Next Edit model
 * keeps only what belongs to the backend: its `extraBody` and its `extraContext` restriction. Sampling and the deadline are Next Edit's own.
 */
export function resolveNextEdit(backend: BackendConfig, model: string | undefined, s: Settings): FimValues {
  // On a Next Edit-only backend the page's fields describe its Next Edit model, so nothing is split off.
  const own = backend.use.completions && backend.nextEditModel !== undefined && backend.nextEditModel !== backend.fimModel;
  const b = backend.fim;
  const kept = { ...(b?.extraBody ? { extraBody: b.extraBody } : {}), ...(b?.extraContext !== undefined ? { extraContext: b.extraContext } : {}) };
  const target: BackendConfig = own ? { ...backend, fim: Object.keys(kept).length > 0 ? kept : undefined } : backend;
  const { values } = resolveFim(target, model, s);
  return { ...values, sampling: values.samplingParams === 'omit' ? values.sampling : { ...NEXT_EDIT_SAMPLING }, timeoutMs: s.nextEdit.timeoutMs };
}
