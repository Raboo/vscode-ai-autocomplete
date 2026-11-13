import type { FimRequest } from '../backends/types';
import type { FimValues } from './effective';
import { TEMPLATES, type TemplateInput } from '../models/templates';
import type { BackendKind, FimMode, FimTemplateId } from '../types';

export type FimRoute = 'native' | 'template';

const SINGLE_LINE_MAX_TOKENS = 48;
const TIME_MAX_PREDICT_MS = 500;

/**
 * Picks how a FIM prompt is sent:
 * - native: the server builds the prompt (llama.cpp /infill, Mistral /v1/fim/completions, /v1/completions with `suffix`);
 * - template: the prompt is rendered client-side from the preset's FIM template.
 * llama.cpp /infill lays tokens out prefix-first, so suffix-first models go through a template on /completion.
 * The chat hole-filler route arrives in v0.2.
 */
export function planRoute(kind: BackendKind, supportsNative: boolean, fim: { fimTemplate?: FimTemplateId; suffixFirst: boolean }, mode: FimMode): FimRoute | 'unsupported' {
  const templateOk = fim.fimTemplate !== undefined && kind !== 'mistral';
  switch (mode) {
    case 'chat':
      return 'unsupported';
    case 'native':
      return supportsNative ? 'native' : 'unsupported';
    case 'template':
      return templateOk ? 'template' : 'unsupported';
    case 'auto':
      if (supportsNative && !(kind === 'llamacpp' && fim.suffixFirst)) return 'native';
      return templateOk ? 'template' : 'unsupported';
  }
}

/**
 * What to log (once per `onceKey`) and show when a model has no route. An undetected model is a detection
 * problem, not a model problem, so it gets its own message and an error status.
 */
export function explainUnsupported(backendId: string, model: string | undefined): { onceKey: string; log: string; status?: string } {
  if (model === undefined) {
    return {
      onceKey: `detect:${backendId}`,
      log: `backend "${backendId}": could not detect its model (server unreachable or several models listed); set fimModel`,
      status: `${backendId}: model not detected`,
    };
  }
  return { onceKey: `route:${backendId}:${model}`, log: `model ${model} has no FIM route; chat FIM arrives in v0.2` };
}

/** Converts line breaks to the document's EOL. */
export function planInsertion(text: string, eol: '\n' | '\r\n'): string {
  return text.replace(/\r?\n/g, eol);
}

export interface FimRequestPlan {
  route: FimRoute;
  fim: FimValues;
  model: string | undefined;
  multiline: boolean;
  input: TemplateInput;
  signal: AbortSignal;
}

export function buildFimRequest(p: FimRequestPlan): FimRequest {
  const { fim, input } = p;
  let payload: FimRequest['payload'];
  if (p.route === 'native') {
    payload = { route: 'native', ...input };
  } else {
    if (!fim.fimTemplate) throw new Error(`preset "${fim.presetId}" has no FIM template`);
    payload = { route: 'template', prompt: TEMPLATES[fim.fimTemplate].render(input) };
  }
  return {
    ...(p.model !== undefined ? { model: p.model } : {}),
    payload,
    stop: fim.stop,
    sampling: { ...fim.sampling, maxTokens: p.multiline ? fim.maxTokens : Math.min(fim.maxTokens, SINGLE_LINE_MAX_TOKENS) },
    timeMaxPredictMs: TIME_MAX_PREDICT_MS,
    extraBody: fim.extraBody,
    signal: p.signal,
    timeoutMs: fim.timeoutMs,
  };
}
