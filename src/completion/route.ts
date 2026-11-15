import type { Learned } from '../models/capabilities';
import type { StatusAction } from './requestStatus';
import type { ChatRequest, FimRequest, RouteCaps } from '../backends/types';
import { COMPLETION_CLOSE, holeFillerMessages, stableUserChars, type HoleFillerInput } from './holeFiller';
import { thinkingFields } from '../models/thinking';
import type { FimValues } from './effective';
import { TEMPLATES, type TemplateInput } from '../models/templates';
import type { BackendKind, FimMode, FimTemplateId, HostFlavor, ThinkingStrategy } from '../types';

export type FimRoute = 'native' | 'template' | 'chat';

const SINGLE_LINE_MAX_TOKENS = 48;
const TIME_MAX_PREDICT_MS = 500;
export const CHAT_OVERHEAD_TOKENS = 32;

/**
 * Picks how a FIM prompt is sent:
 * - native: the server builds the prompt (llama.cpp /infill, Mistral /v1/fim/completions, /v1/completions with `suffix`);
 * - template: the prompt is rendered client-side from the preset's FIM template;
 * - chat: a hole-filler prompt on /v1/chat/completions.
 * llama.cpp /infill lays tokens out prefix-first, so suffix-first models go through a template on /completion.
 * In auto mode the chat route takes two kinds of request:
 * - chat families, except where the server's native FIM serves chat models (DeepSeek);
 * - any model on a server with no template route (Strata, OpenRouter) that native FIM does not take.
 */
export function planRoute(
  kind: BackendKind,
  caps: RouteCaps,
  fim: { fimTemplate?: FimTemplateId; suffixFirst: boolean; chat: boolean },
  mode: FimMode,
): FimRoute | 'unsupported' {
  const templateOk = fim.fimTemplate !== undefined && caps.template;
  switch (mode) {
    case 'chat':
      return caps.chat ? 'chat' : 'unsupported';
    case 'native':
      return caps.native ? 'native' : 'unsupported';
    case 'template':
      return templateOk ? 'template' : 'unsupported';
    case 'auto':
      if (caps.native && !(kind === 'llamacpp' && fim.suffixFirst) && (!fim.chat || caps.nativeChatModels)) return 'native';
      if (templateOk) return 'template';
      return caps.chat && (fim.chat || !caps.template) ? 'chat' : 'unsupported';
  }
}

/** Why planRoute found no route: a prompt mode this server cannot use, a model without a FIM template, or a model that thinks. */
export type NoRoute = 'mode' | 'template' | 'thinking';

/** Why planRoute returned 'unsupported' for these inputs. */
export function whyNoRoute(caps: RouteCaps, mode: FimMode): NoRoute {
  return (mode === 'chat' && !caps.chat) || (mode === 'native' && !caps.native) || (mode === 'template' && !caps.template) ? 'mode' : 'template';
}

/** The short text the status bar, the Backends page and the connection test show for a model with no route. */
export function noRouteText(why: NoRoute, mode: FimMode, kind?: BackendKind): string {
  switch (why) {
    case 'mode':
      return `prompt mode "${mode}" does not work with this server`;
    case 'template':
      return kind === 'mistral' ? noRouteFix(false, kind) : 'no completion template';
    case 'thinking':
      return 'cannot turn thinking off';
  }
}

/** What to do about a model with no template route: shared by the provider's log and the Backends page's connection test. */
export function noRouteFix(chatPossible: boolean, kind?: BackendKind): string {
  // Mistral's completion endpoint serves Codestral models only, and it has no chat route here: a template cannot help.
  if (kind === 'mistral') return 'choose a Codestral model';
  return chatPossible ? 'pick a coder model, choose a template for it, or set the prompt mode to chat' : 'pick a coder model, or choose a template for it';
}

/**
 * What to log (once per `onceKey`) and show when a model has no route. An undetected model is a detection
 * problem, not a model problem, so it gets its own message and an error status.
 */
export function explainUnsupported(
  backendId: string,
  model: string | undefined,
  mode: FimMode,
  why: NoRoute,
  chatPossible: boolean,
  kind?: BackendKind,
): { onceKey: string; log: string; status?: string; action?: StatusAction } {
  if (model === undefined) {
    return {
      onceKey: `detect:${backendId}`,
      log: `backend "${backendId}": could not detect its model (server unreachable or several models listed); set fimModel`,
      status: `${backendId}: model not detected`,
    };
  }
  const onceKey = `route:${backendId}:${model}`;
  // Both fixes are on the Backends page: the prompt mode, or the model or its template.
  const action: StatusAction = { command: 'aiAutocomplete.manageBackends', args: [{ focus: backendId }] };
  if (why === 'mode') {
    return {
      onceKey,
      log: `backend "${backendId}": prompt mode (fimMode) "${mode}" does not work with this server: set it to auto in AI Autocomplete: Manage Backends`,
      status: `${backendId}: ${noRouteText(why, mode)}`,
      action,
    };
  }
  if (kind === 'mistral') {
    // Mistral's completion endpoint serves Codestral models only, and it has no chat route here: a template cannot help.
    return {
      onceKey,
      log: `model "${model}" cannot complete through Mistral's FIM endpoint: ${noRouteFix(chatPossible, kind)} in AI Autocomplete: Manage Backends`,
      status: `${backendId}: ${noRouteText(why, mode, kind)}`,
      action,
    };
  }
  return {
    onceKey,
    log: `model "${model}" has no FIM template (not a known code-completion model): ${noRouteFix(chatPossible)} in AI Autocomplete: Manage Backends`,
    status: `${backendId}: ${noRouteText(why, mode)}`,
    action,
  };
}

/** Converts line breaks to the document's EOL. */
export function planInsertion(text: string, eol: '\n' | '\r\n'): string {
  return text.replace(/\r?\n/g, eol);
}

export interface FimRequestPlan {
  route: Exclude<FimRoute, 'chat'>;
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

export interface ChatRequestPlan {
  fim: FimValues;
  flavor: HostFlavor;
  model: string | undefined;
  input: HoleFillerInput;
  rejected: ReadonlySet<string>;
  signal: AbortSignal;
  onRejected?(fields: string[]): void;
}

/**
 * Learned when OpenRouter rejects `reasoning: {effort: "none"}` (the model must reason). It has its own key, so the
 * `reasoning` field is still sent, with effort "low"; if that is rejected too, `reasoning` itself is learned.
 */
export const EFFORT_NONE_REJECTED = 'reasoning.effort=none';

/** The thinking strategy a chat request uses: an OpenRouter model that rejected effort "none" cannot turn thinking off. */
export function chatThinking(strategy: ThinkingStrategy, flavor: HostFlavor, rejected: ReadonlySet<string>): ThinkingStrategy {
  return flavor === 'openrouter' && rejected.has(EFFORT_NONE_REJECTED) ? 'cannotDisable' : strategy;
}

/**
 * True when the chat route must not be used for this model: a cannotDisable strategy (an OpenRouter model that rejected
 * effort "none" included), or a model learned to keep thinking. Autocomplete needs an answer in 5 s, so neither is asked.
 */
export function thinkingBlocked(strategy: ThinkingStrategy, flavor: HostFlavor, learned: Learned): 'cannotDisable' | 'keepsThinking' | undefined {
  if (chatThinking(strategy, flavor, learned.rejected) === 'cannotDisable') return 'cannotDisable';
  return learned.thinks ? 'keepsThinking' : undefined;
}

/** The chat stop rule: the closing tag, then the backend's own stops, deduplicated. Shared with the Backends page form. */
export function chatStops(fim: Pick<FimValues, 'backendStop'>): string[] {
  return [...new Set([COMPLETION_CLOSE, ...fim.backendStop])];
}

/** Strata's request field that pins the start of a message as a cache checkpoint; optional, so a server that rejects it is retried without it. */
export const STRATA_PIN_FIELD = 'strata_prefix';

const SAMPLING_WIRE = { temperature: 'temperature', topP: 'top_p', topK: 'top_k', presencePenalty: 'presence_penalty' } as const;

export function buildChatRequest(p: ChatRequestPlan): ChatRequest {
  const { fim, input, rejected } = p;
  const strategy = chatThinking(fim.thinking, p.flavor, rejected);
  const tf = thinkingFields(strategy, p.flavor);
  const thinking = Object.fromEntries(Object.entries(tf.body).filter(([k]) => !rejected.has(k)));
  const budget = (input.multiline ? fim.maxTokens : Math.min(fim.maxTokens, SINGLE_LINE_MAX_TOKENS)) + CHAT_OVERHEAD_TOKENS;
  const effortNone = (thinking.reasoning as { effort?: unknown } | undefined)?.effort === 'none';
  const report = p.onRejected;
  const onRejected = report && effortNone ? (fields: string[]) => report(fields.map((f) => (f === 'reasoning' ? EFFORT_NONE_REJECTED : f))) : report;
  const sampling: ChatRequest['sampling'] = {};
  if (fim.samplingParams !== 'omit') {
    const all: ChatRequest['sampling'] = { ...fim.sampling, presencePenalty: 0 };
    for (const k of Object.keys(SAMPLING_WIRE) as (keyof typeof SAMPLING_WIRE)[]) {
      if (all[k] !== undefined && !rejected.has(SAMPLING_WIRE[k])) sampling[k] = all[k];
    }
  }
  const messages = holeFillerMessages(input, tf.systemSuffix);
  // Strata resumes a hybrid-model prompt only at message boundaries unless the stable start is pinned as a cache checkpoint.
  const pinChars = p.flavor === 'strata' && !rejected.has(STRATA_PIN_FIELD) ? stableUserChars(messages) : 0;
  return {
    ...(p.model !== undefined ? { model: p.model } : {}),
    messages,
    maxTokens: budget,
    stop: chatStops(fim),
    sampling,
    thinking,
    extraBody: pinChars > 0 ? { [STRATA_PIN_FIELD]: { message: 1, chars: pinChars }, ...fim.extraBody } : fim.extraBody,
    signal: p.signal,
    timeoutMs: fim.timeoutMs,
    ...(onRejected ? { onRejected } : {}),
  };
}
