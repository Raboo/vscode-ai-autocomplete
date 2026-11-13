import type { FimTemplateId, ModelOverrideBody, Sampling } from '../types';
import { TEMPLATES } from './templates';

export interface ResolvedPreset {
  id: string;
  fimTemplate?: FimTemplateId;
  suffixFirst: boolean;
  stop: string[];
  sampling: Sampling;
  extraBody: Record<string, unknown>;
  /** What matching modelOverrides entries set, so callers can tell override values from preset ones. */
  overridden: { fimTemplate: boolean; sampling: (keyof Sampling)[]; stop: boolean; extraBody: boolean };
}

interface Preset { id: string; re: RegExp; fimTemplate?: FimTemplateId; sampling: Sampling }

const CODER_SAMPLING: Sampling = { temperature: 0.1, topP: 0.95, topK: 40, maxTokens: 128 };
const CODESTRAL_SAMPLING: Sampling = { temperature: 0.2, maxTokens: 128 };

// Order matters: the first match wins.
const PRESETS: Preset[] = [
  { id: 'qwen-coder', re: /qwen[\d.]*[-_ ]?coder|codeqwen/i, fimTemplate: 'qwen', sampling: CODER_SAMPLING },
  { id: 'codestral', re: /codestral/i, fimTemplate: 'codestral', sampling: CODESTRAL_SAMPLING },
  { id: 'deepseek-coder', re: /deepseek[-_ ]?coder/i, fimTemplate: 'deepseek', sampling: CODER_SAMPLING },
  { id: 'starcoder', re: /starcoder/i, fimTemplate: 'starcoder', sampling: CODER_SAMPLING },
  { id: 'codellama', re: /code[-_ ]?llama/i, fimTemplate: 'codellama', sampling: CODER_SAMPLING },
  { id: 'codegemma', re: /codegemma/i, fimTemplate: 'codegemma', sampling: CODER_SAMPLING },
  { id: 'granite-code', re: /granite.*code/i, fimTemplate: 'granite-code', sampling: CODER_SAMPLING },
  { id: 'granite4', re: /granite[-_ ]?4/i, fimTemplate: 'granite4', sampling: CODER_SAMPLING },
  { id: 'seed-coder', re: /seed[-_ ]?coder/i, fimTemplate: 'seed-coder', sampling: CODER_SAMPLING },
  { id: 'mellum', re: /mellum/i, fimTemplate: 'mellum', sampling: CODER_SAMPLING },
  { id: 'generic', re: /.*/, sampling: CODER_SAMPLING },
];

const GLOBAL_STOP = '\n\n\n';

/** The global stop comes first: hosted OpenAI-compatible APIs accept only the first 4 stops. */
function templateStops(t: FimTemplateId | undefined): string[] {
  return t ? [GLOBAL_STOP, ...TEMPLATES[t].stop] : [GLOBAL_STOP];
}

/** `forceTemplate` (a backend's own template) wins over the preset and any override template; override stops are kept. */
export function resolvePreset(modelId: string, overrides: Record<string, ModelOverrideBody>, forceTemplate?: FimTemplateId): ResolvedPreset {
  const preset = PRESETS.find(p => p.re.test(modelId)) ?? PRESETS[PRESETS.length - 1];
  const out: ResolvedPreset = {
    id: preset.id,
    fimTemplate: preset.fimTemplate,
    suffixFirst: preset.fimTemplate ? TEMPLATES[preset.fimTemplate].suffixFirst : false,
    stop: templateStops(preset.fimTemplate),
    sampling: { ...preset.sampling },
    extraBody: {},
    overridden: { fimTemplate: false, sampling: [], stop: false, extraBody: false },
  };
  const overrideStops: string[] = [];
  for (const [key, body] of Object.entries(overrides)) {
    let re: RegExp;
    try { re = new RegExp(key, 'i'); } catch { continue; }
    if (!re.test(modelId)) continue;
    if (body.fimTemplate) {
      out.fimTemplate = body.fimTemplate;
      out.suffixFirst = TEMPLATES[body.fimTemplate].suffixFirst;
      out.stop = templateStops(body.fimTemplate);
      out.overridden.fimTemplate = true;
    }
    if (body.sampling) {
      out.sampling = { ...out.sampling, ...body.sampling };
      for (const k of Object.keys(body.sampling) as (keyof Sampling)[]) {
        if (body.sampling[k] !== undefined && !out.overridden.sampling.includes(k)) out.overridden.sampling.push(k);
      }
    }
    if (body.stop) {
      out.stop = [...new Set([...out.stop, ...body.stop])];
      overrideStops.push(...body.stop);
      out.overridden.stop = true;
    }
    if (body.extraBody) {
      out.extraBody = { ...out.extraBody, ...body.extraBody };
      out.overridden.extraBody = true;
    }
  }
  if (forceTemplate) {
    out.fimTemplate = forceTemplate;
    out.suffixFirst = TEMPLATES[forceTemplate].suffixFirst;
    out.stop = [...new Set([...templateStops(forceTemplate), ...overrideStops])];
  }
  return out;
}
