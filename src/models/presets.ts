import type { FimTemplateId, ModelOverrideBody, Sampling, ThinkingStrategy } from '../types';
import { TEMPLATES } from './templates';

export type SamplingParams = 'send' | 'omit';

export interface ResolvedPreset {
  id: string;
  fimTemplate?: FimTemplateId;
  suffixFirst: boolean;
  stop: string[];
  sampling: Sampling;
  extraBody: Record<string, unknown>;
  /** The model is a chat model: it has no FIM template and answers on the chat route. */
  chat: boolean;
  thinking: ThinkingStrategy;
  /** 'omit' = the model's API fixes its sampling values, so none are sent. */
  samplingParams: SamplingParams;
  /** What matching modelOverrides entries set, so callers can tell override values from preset ones. */
  overridden: { fimTemplate: boolean; sampling: (keyof Sampling)[]; stop: boolean; extraBody: boolean; thinking: boolean };
}

interface Preset {
  id: string; re: RegExp; fimTemplate?: FimTemplateId; sampling: Sampling;
  chat: boolean; thinking: ThinkingStrategy; samplingParams: SamplingParams;
}

const CODER_SAMPLING: Sampling = { temperature: 0.1, topP: 0.95, topK: 40, maxTokens: 128 };
const CODESTRAL_SAMPLING: Sampling = { temperature: 0.2, maxTokens: 128 };
export const CHAT_SAMPLING: Sampling = { temperature: 0.2, topP: 0.8, topK: 20, maxTokens: 128 };

/** A coder row: FIM template, no thinking, coder sampling. */
const coder = (id: string, re: RegExp, fimTemplate: FimTemplateId, sampling: Sampling = CODER_SAMPLING): Preset =>
  ({ id, re, fimTemplate, sampling, chat: false, thinking: 'none', samplingParams: 'send' });
/** A chat-family row: no FIM template, chat sampling. */
const family = (id: string, re: RegExp, thinking: ThinkingStrategy, samplingParams: SamplingParams = 'send'): Preset =>
  ({ id, re, sampling: CHAT_SAMPLING, chat: true, thinking, samplingParams });

// Order matters: the first match wins.
const PRESETS: Preset[] = [
  // Sweep's Next Edit models are Qwen2.5-Coder fine-tunes and keep its FIM tokens (checked live on sweep-next-edit-v2-7b).
  coder('sweep', /sweep/i, 'qwen'),
  coder('qwen-coder', /qwen[\d.]*[-_ ]?coder|codeqwen/i, 'qwen'),
  coder('codestral', /codestral/i, 'codestral', CODESTRAL_SAMPLING),
  coder('deepseek-coder', /deepseek[-_ ]?coder/i, 'deepseek'),
  coder('starcoder', /starcoder/i, 'starcoder'),
  coder('codellama', /code[-_ ]?llama/i, 'codellama'),
  coder('codegemma', /codegemma/i, 'codegemma'),
  coder('granite-code', /granite.*code/i, 'granite-code'),
  { ...coder('granite4-thinking', /granite[-_ ]?4\.2/i, 'granite4'), thinking: 'templateKwarg:enable_thinking' },
  coder('granite4', /granite[-_ ]?4/i, 'granite4'),
  coder('seed-coder', /seed[-_ ]?coder/i, 'seed-coder'),
  coder('mellum', /mellum/i, 'mellum'),
  family('deepseek-r1', /deepseek.*(r1|reasoner)/i, 'cannotDisable'),
  family('deepseek-v4', /deepseek.*(v4|flash)/i, 'templateKwarg:enable_thinking'),
  family('deepseek-v3', /deepseek.*v3\.[12]/i, 'templateKwarg:thinking'),
  family('deepseek', /deepseek/i, 'none'),
  family('qwen3-thinking', /qwen3.*thinking/i, 'cannotDisable'),
  family('qwen3-instruct-2507', /qwen3-.*2507/i, 'none'),
  family('qwen3.8-2.4t', /qwen3\.8.*2\.4t/i, 'cannotDisable'),
  family('qwen3', /qwen[-_ ]?3/i, 'templateKwarg:enable_thinking'),
  family('glm-5.3', /glm[-_ ]?5\.3/i, 'cannotDisable'),
  family('glm', /glm/i, 'templateKwarg:enable_thinking'),
  family('kimi-thinking', /kimi.*(k2.*thinking|k2\.7|k3)/i, 'cannotDisable', 'omit'),
  family('kimi-k2.5', /kimi.*k2\.[56]/i, 'templateKwarg:thinking', 'omit'),
  family('kimi', /kimi/i, 'none', 'omit'),
  family('minimax-m3.1', /minimax.*m3\.1/i, 'cannotDisable', 'omit'),
  family('minimax-m3', /minimax.*m3/i, 'templateKwarg:thinking_mode=disabled', 'omit'),
  family('minimax', /minimax/i, 'cannotDisable', 'omit'),
  family('gemma4', /gemma[-_ ]?4/i, 'templateKwarg:enable_thinking'),
  family('gemma', /gemma/i, 'none'),
  family('granite3.3', /granite[-_ ]?3\.3/i, 'templateKwarg:thinking'),
  family('granite', /granite/i, 'none'),
  family('nemotron-nano-v2', /nemotron.*nano.*v2/i, 'systemSoftSwitch:/no_think'),
  family('nemotron', /nemotron/i, 'templateKwarg:enable_thinking'),
  family('gpt-oss', /gpt-oss/i, 'cannotDisable'),
  family('mistral-large-4', /mistral[-_ ]?large[-_ ]?4/i, 'cannotDisable'),
  family('mistral-reasoning', /mistral[-_ ]?(small[-_ ]?4|small[-_ ]?2603|medium[-_ ]?3[.-]5)/i, 'reasoningEffortNone'),
  family('mistral', /magistral|ministral|devstral|mistral/i, 'none'),
  family('seed-oss', /seed[-_ ]?oss/i, 'templateKwarg:thinking_budget=0'),
  // Unknown models: templates that do not use the variable ignore it.
  { id: 'generic', re: /.*/, sampling: CODER_SAMPLING, chat: false, thinking: 'templateKwarg:enable_thinking', samplingParams: 'send' },
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
    chat: preset.chat,
    thinking: preset.thinking,
    samplingParams: preset.samplingParams,
    overridden: { fimTemplate: false, sampling: [], stop: false, extraBody: false, thinking: false },
  };
  const overrideStops: string[] = [];
  for (const [key, body] of Object.entries(overrides)) {
    let re: RegExp;
    try { re = new RegExp(key, 'i'); } catch { continue; }
    if (!re.test(modelId)) continue;
    if (body.fimTemplate) {
      out.fimTemplate = body.fimTemplate;
      out.suffixFirst = TEMPLATES[body.fimTemplate].suffixFirst;
      out.stop = [...new Set([...templateStops(body.fimTemplate), ...overrideStops])];
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
    if (body.thinking) {
      out.thinking = body.thinking;
      out.overridden.thinking = true;
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
