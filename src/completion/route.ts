import type { FimRequest } from '../backends/types';
import type { ResolvedPreset } from '../models/presets';
import { TEMPLATES, type TemplateInput } from '../models/templates';
import type { BackendKind, FimMode } from '../types';

export type FimRoute = 'native' | 'template';

const SINGLE_LINE_MAX_TOKENS = 48;
const TIME_MAX_PREDICT_MS = 500;
export const REQUEST_TIMEOUT_MS = 5000;

/**
 * Picks how a FIM prompt is sent:
 * - native: the server builds the prompt (llama.cpp /infill, Mistral /v1/fim/completions, /v1/completions with `suffix`);
 * - template: the prompt is rendered client-side from the preset's FIM template.
 * llama.cpp /infill lays tokens out prefix-first, so suffix-first models go through a template on /completion.
 * The chat hole-filler route arrives in v0.2.
 */
export function planRoute(kind: BackendKind, supportsNative: boolean, preset: ResolvedPreset, mode: FimMode): FimRoute | 'unsupported' {
  const templateOk = preset.fimTemplate !== undefined && kind !== 'mistral';
  switch (mode) {
    case 'chat':
      return 'unsupported';
    case 'native':
      return supportsNative ? 'native' : 'unsupported';
    case 'template':
      return templateOk ? 'template' : 'unsupported';
    case 'auto':
      if (supportsNative && !(kind === 'llamacpp' && preset.suffixFirst)) return 'native';
      return templateOk ? 'template' : 'unsupported';
  }
}

/** Converts line breaks to the document's EOL. */
export function planInsertion(text: string, eol: '\n' | '\r\n'): string {
  return text.replace(/\r?\n/g, eol);
}

export interface FimRequestPlan {
  route: FimRoute;
  preset: ResolvedPreset;
  model: string | undefined;
  multiline: boolean;
  /** `fim.maxTokens` from settings; overrides the preset's value. */
  maxTokens: number;
  input: TemplateInput;
  signal: AbortSignal;
}

export function buildFimRequest(p: FimRequestPlan): FimRequest {
  const { preset, input } = p;
  let payload: FimRequest['payload'];
  if (p.route === 'native') {
    payload = { route: 'native', ...input };
  } else {
    if (!preset.fimTemplate) throw new Error(`preset "${preset.id}" has no FIM template`);
    payload = { route: 'template', prompt: TEMPLATES[preset.fimTemplate].render(input) };
  }
  return {
    ...(p.model !== undefined ? { model: p.model } : {}),
    payload,
    stop: preset.stop,
    sampling: { ...preset.sampling, maxTokens: p.multiline ? p.maxTokens : Math.min(p.maxTokens, SINGLE_LINE_MAX_TOKENS) },
    timeMaxPredictMs: TIME_MAX_PREDICT_MS,
    extraBody: preset.extraBody,
    signal: p.signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
  };
}
