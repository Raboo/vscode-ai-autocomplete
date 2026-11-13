import type { Settings } from '../config/settings';
import { resolvePreset } from '../models/presets';
import type { BackendConfig, FimTemplateId, Multiline } from '../types';

export const DEFAULT_CONTEXT_TOKENS = 4700;
export const CHARS_PER_TOKEN = 3.5;
export const DEFAULT_TIMEOUT_MS = 5000;

export type ValueSource = 'backend' | 'modelOverride' | 'settings' | 'preset' | 'builtin';
export type FimField = 'template' | 'temperature' | 'topP' | 'topK' | 'maxTokens' | 'multiline' | 'prefixLines' | 'suffixLines'
  | 'contextTokens' | 'extraContext' | 'debounceMs' | 'timeoutMs' | 'stop' | 'extraBody';

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
}

export interface ResolvedFim {
  values: FimValues;
  sources: Record<FimField, ValueSource>;
  /** The `fim.extraContext` setting: a backend can only restrict extra context, never enable it. */
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
  // The preset's own maxTokens (128) is never the budget: only a backend or override value replaces fim.maxTokens.
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
  };
  return { values, sources, extraContextAllowed: s.fim.extraContext };
}
