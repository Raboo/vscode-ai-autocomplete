import { HttpError, StreamError } from '../backends/http';
import { MissingApiKeyError } from '../backends/mistral';
import type { FimBackend, ServerInfo } from '../backends/types';
import { THINKING_STRATEGIES, type Settings } from '../config/settings';
import { resolveFim, templateMismatch } from '../completion/effective';
import { CompletionAccumulator } from '../completion/filters';
import { postprocess } from '../completion/postprocess';
import { buildChatRequest, buildFimRequest, EFFORT_NONE_REJECTED, noRouteFix, noRouteText, planRoute, thinkingBlocked, whyNoRoute } from '../completion/route';
import { collectCompletion, ThinkingError, type Collected, type PlannedRequest } from '../completion/stream';
import { inferHostFlavor } from '../backends/hostFlavor';
import type { Log } from '../log';
import type { TemplateInput } from '../models/templates';
import { THINKING_LABELS, thinkingFields } from '../models/thinking';
import type { ThinkingStrategy } from '../types';
import type { TestStep } from './protocol';

export const TEST_TIMEOUT_MS = 30_000;
/** Each thinking probe request waits this long; a model that cannot stop thinking would otherwise run to the test's 30 s. */
export const PROBE_TIMEOUT_MS = 10000;
/** The switches the probe tries, in order: every strategy that sends something. */
const THINKING_PROBES: readonly ThinkingStrategy[] = THINKING_STRATEGIES.filter((t) => t !== 'none' && t !== 'cannotDisable');
const LIST_TIMEOUT_MS = 5000;
const MAX_LINES = 16;
const SHOWN_CHARS = 80;

export const SAMPLE: TemplateInput = {
  prefix: 'function add(a: number, b: number): number {\n  return ',
  suffix: '\n}\n',
  filePath: 'sample.ts',
  repoName: 'sample',
  extra: [],
};
const POST = { linePrefix: '  return ', lineSuffix: '', prevLine: 'function add(a: number, b: number): number {', suffix: SAMPLE.suffix, chat: false };

export interface ConnectionTestInput {
  backend: FimBackend;
  settings: Settings;
  localOnly: boolean;
  isLocal(baseUrl: string): Promise<boolean>;
  signal: AbortSignal;
  log: Log;
  now?: () => number;
}
export interface ConnectionTestResult { steps: TestStep[]; model?: string; info?: ServerInfo }

/** Fixed text for a failure; never quotes server output. */
export function explainFailure(err: unknown): { text: string; hint?: string } {
  if (err instanceof MissingApiKeyError) return { text: 'no API key stored', hint: 'enter the key in the API key field' };
  if (err instanceof StreamError) return { text: 'the server returned an error', hint: 'turn on aiAutocomplete.debug.logPrompts and test again to log its message' };
  if (err instanceof HttpError) {
    const s = err.status;
    if (s === 401 || s === 403) return { text: `HTTP ${s}`, hint: 'check the API key' };
    if (s === 404) return { text: 'HTTP 404', hint: 'check the URL; OpenAI-compatible servers usually end in /v1' };
    if (s >= 300 && s < 400) return { text: `HTTP ${s}`, hint: 'redirects are not followed' };
    return { text: `HTTP ${s}` };
  }
  if ((err as { name?: unknown } | null)?.name === 'TimeoutError') return { text: 'timed out' };
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (code === 'ECONNREFUSED') return { text: 'connection refused', hint: 'is the server running?' };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { text: 'host not found' };
  return { text: 'request failed' };
}

/** The server answered the sample completion; a slow or empty answer still is one. Steps stop at the first failure, so reach passed too. */
export function completionServed(r: ConnectionTestResult): boolean {
  return r.steps.some((s) => s.id === 'completion' && s.state !== 'fail');
}

/** Runs the steps in order, calling onStep after each; never throws. */
export async function runConnectionTest(i: ConnectionTestInput, onStep: (s: TestStep) => void): Promise<ConnectionTestResult> {
  const now = i.now ?? Date.now;
  const steps: TestStep[] = [];
  const result: ConnectionTestResult = { steps };
  // `logText` is fixed text only: a step's own text can quote the sample completion.
  const emit = (s: TestStep, started?: number, logText?: string): void => {
    const step = started === undefined ? s : { ...s, ms: now() - started };
    i.log.debug(`connection test ${step.id}: ${step.state}${step.ms !== undefined ? ` in ${step.ms} ms` : ''}${logText ? `: ${logText}` : ''}`);
    steps.push(step);
    onStep(step);
  };
  const fail = (id: TestStep['id'], err: unknown, started: number): void => {
    const f = explainFailure(err);
    emit({ id, state: 'fail', ...f }, started, f.text);
    // The server's own message can quote the prompt, so it is logged only with logPrompts.
    if (err instanceof StreamError && i.settings.debug.logPrompts) i.log.debug(`connection test ${id}: server error: ${err.message}`);
  };

  let stage: TestStep['id'] = 'reach';
  let stageStart = now();
  try {
    const { backend, settings } = i;
    const cfg = backend.config;
    if (i.localOnly && !(await i.isLocal(cfg.baseUrl))) {
      const text = 'local only is on in this workspace';
      emit({ id: 'reach', state: 'fail', text }, undefined, text);
      return result;
    }

    const stream = async (p: PlannedRequest, ctl: AbortController, stop: string[]): Promise<Collected> => {
      const acc = new CompletionAccumulator({ stop, multiline: false, maxLines: MAX_LINES, suffix: SAMPLE.suffix });
      // As in the provider: on the chat route a model that thinks fails the request at once.
      return collectCompletion(backend, p, acc, ctl, { failOnThinking: p.route === 'chat' });
    };
    const makeCtl = (): AbortController => {
      const ctl = new AbortController();
      const onAbort = (): void => ctl.abort();
      if (i.signal.aborted) ctl.abort();
      else i.signal.addEventListener('abort', onAbort, { once: true });
      return ctl;
    };

    // 1. reach
    let info: ServerInfo;
    if (cfg.kind === 'mistral') {
      const v = resolveFim(cfg, cfg.fimModel, settings).values;
      const ctl = makeCtl();
      const req = buildFimRequest({ route: 'native', fim: v, model: cfg.fimModel, multiline: false, input: SAMPLE, signal: ctl.signal });
      await stream({ route: 'native', req: { ...req, sampling: { ...req.sampling, maxTokens: 1 }, timeoutMs: TEST_TIMEOUT_MS } }, ctl, v.stop);
      emit({ id: 'reach', state: 'ok', text: `Server answered in ${now() - stageStart} ms` }, stageStart);
      info = await backend.listModels(i.signal); // answered locally, no request
    } else {
      info = await backend.listModels(i.signal, LIST_TIMEOUT_MS);
      emit({ id: 'reach', state: 'ok', text: `Server answered in ${now() - stageStart} ms (${info.models.length} models)` }, stageStart);
    }
    result.info = info;

    // 2. model
    stage = 'model';
    stageStart = now();
    const model = cfg.fimModel ?? (info.models.length === 1 ? info.models[0] : undefined);
    if (model === undefined) {
      emit({ id: 'model', state: 'warn', text: `the server lists ${info.models.length} models; choose one` }, stageStart);
      return result;
    }
    result.model = model;
    const values = resolveFim(cfg, model, settings).values;
    // A fresh probe: routes learned as missing during completions are ignored.
    const caps = backend.routes();
    const route = planRoute(cfg.kind, caps, values, cfg.fimMode);
    if (route === 'unsupported') {
      const why = whyNoRoute(caps, cfg.fimMode);
      if (why === 'template') {
        const mistral = cfg.kind === 'mistral';
        emit({
          id: 'model', state: 'warn', text: mistral ? `${model} cannot complete through Mistral's FIM endpoint` : `${model} has no completion template`,
          hint: `${noRouteFix(caps.chat, cfg.kind)}${!mistral && /zeta/i.test(model) ? '; seed-coder fits Zeta 2.x' : ''}`,
        }, stageStart);
      }
      else emit({ id: 'model', state: 'warn', text: noRouteText(why, cfg.fimMode), ...(why === 'mode' ? { hint: 'set the prompt mode to auto' } : {}) }, stageStart);
      return result;
    }
    // A Template chosen for another model is worth a warning, but the test still shows what this one answers.
    const mismatch = route === 'template' ? templateMismatch(cfg, model, settings) : undefined;
    const flavor = inferHostFlavor(cfg);
    if (route === 'chat') {
      const cannotDisable = thinkingBlocked(values.thinking, flavor, { rejected: new Set(), failedRoutes: new Set(), thinks: false }) === 'cannotDisable'
        || (info.thinkingMandatory ?? []).includes(model);
      if (cannotDisable) {
        const text = `Model ${model} cannot turn thinking off`;
        emit({ id: 'model', state: 'fail', text, hint: 'autocomplete needs a model that answers without thinking; choose another model' }, stageStart, text);
        return result;
      }
      emit({ id: 'model', state: 'ok', text: `Model ${model} (chat prompt)` }, stageStart);
    } else {
      emit({
        id: 'model', state: mismatch ? 'warn' : 'ok', text: route === 'native' ? `Model ${model} (server-side prompt)` : `Model ${model} with the ${values.fimTemplate} template`,
        ...(mismatch ? { hint: `${model}'s own template is ${mismatch.own}; reset the Template field` } : {}),
      }, stageStart);
    }

    const chatRequest = (v: typeof values, c: AbortController, onRejected?: (fields: string[]) => void) => buildChatRequest({
      fim: v, flavor, model, input: { ...SAMPLE, languageId: 'typescript', multiline: false }, rejected: new Set(), signal: c.signal, ...(onRejected ? { onRejected } : {}),
    });

    /**
     * Tries the other thinking switches on the sample; returns the hint for the thinking step. Never changes settings.
     * A switch that sends the same request as the current one or as one already tried is skipped: on Strata, OpenRouter,
     * DeepSeek and Ollama the flavor decides the request, so a thinking model would get identical requests.
     */
    const probe = async (): Promise<string | undefined> => {
      const key = (s: ThinkingStrategy): string => JSON.stringify(thinkingFields(s, flavor));
      const seen = new Set([key(values.thinking)]);
      let tried = 0;
      for (const strategy of THINKING_PROBES) {
        if (!seen.has(key(strategy))) seen.add(key(strategy));
        else continue;
        if (i.signal.aborted) return undefined;
        tried++;
        const pctl = makeCtl();
        const req = chatRequest({ ...values, thinking: strategy }, pctl);
        const acc = new CompletionAccumulator({ stop: req.stop, multiline: false, maxLines: MAX_LINES, suffix: SAMPLE.suffix });
        try {
          const c = await collectCompletion(backend, { route: 'chat', req: { ...req, timeoutMs: PROBE_TIMEOUT_MS }, linePrefix: POST.linePrefix }, acc, pctl, { failOnThinking: true });
          if ((postprocess(c.text, { ...POST, chat: true }) ?? '') !== '') return `choose "${THINKING_LABELS[strategy]}" as the Thinking switch`;
        } catch (err) {
          // Still thinking, rejected or timed out: this switch does not help, try the next.
          i.log.debug(`connection test probe ${strategy}: ${err instanceof ThinkingError ? 'still thinking' : explainFailure(err).text}`);
        }
      }
      if (i.signal.aborted) return undefined;
      return tried === 0 ? 'this server turns thinking off one way only; choose another model' : 'no thinking switch turned it off; choose another model';
    };

    // 3. completion
    stage = 'completion';
    stageStart = now();
    const ctl = makeCtl();
    const rejected = new Set<string>();
    let planned: PlannedRequest;
    let stop = values.stop;
    let limit = values.timeoutMs; // the timeout the editor's request would use; the test itself waits longer
    let maxTokens = values.maxTokens;
    if (route === 'chat') {
      const req = chatRequest(values, ctl, (fields) => fields.forEach((f) => rejected.add(f)));
      planned = { route: 'chat', req: { ...req, timeoutMs: TEST_TIMEOUT_MS }, linePrefix: POST.linePrefix };
      stop = req.stop; // the request's own list, as in the provider
      limit = req.timeoutMs;
      maxTokens = req.maxTokens; // with the chat overhead
    } else {
      planned = { route, req: { ...buildFimRequest({ route, fim: values, model, multiline: false, input: SAMPLE, signal: ctl.signal }), timeoutMs: TEST_TIMEOUT_MS } };
    }
    let collected: Collected;
    try {
      collected = await stream(planned, ctl, stop);
    } catch (err) {
      if (!(err instanceof ThinkingError)) throw err;
      // The model reasons: no completion step. Say so, then look for a switch that works.
      stage = 'thinking';
      const label = THINKING_LABELS[values.thinking];
      const text = `${model} keeps thinking with the "${label}" switch`;
      const ms = now() - stageStart; // until the thinking was seen, not the probe
      const probed = await probe();
      emit({ id: 'thinking', state: 'fail', text, ...(probed ? { hint: probed } : {}), ms }, undefined, text);
      return result;
    }
    const text = postprocess(collected.text, { ...POST, chat: route === 'chat' }) ?? '';
    const elapsed = now() - stageStart;
    if (settings.debug.logPrompts) i.log.debug(`connection test sample completion: ${JSON.stringify(text)}`);
    if (text === '' && collected.timedOut) {
      emit({ id: 'completion', state: 'fail', text: 'timed out' }, stageStart, 'timed out');
    } else if (text === '') {
      emit({ id: 'completion', state: 'warn', text: 'the server answered but returned no completion' }, stageStart);
    } else if (collected.timedOut || elapsed > limit) {
      const hint = collected.timedOut ? `timed out after ${TEST_TIMEOUT_MS} ms; only the complete lines are shown` : `slower than the ${limit} ms timeout; run the test again if the model was loading`;
      emit({ id: 'completion', state: 'warn', text: `Test completion in ${elapsed} ms: "${text.slice(0, SHOWN_CHARS)}"`, hint }, stageStart);
    } else {
      emit({ id: 'completion', state: 'ok', text: `Test completion in ${elapsed} ms: "${text.slice(0, SHOWN_CHARS)}"` }, stageStart);
    }

    // 3b. thinking (chat route only; a model that thinks failed above)
    if (route === 'chat') {
      stage = 'thinking';
      stageStart = now();
      const names = [...rejected].map((f) => (f === EFFORT_NONE_REJECTED ? 'reasoning effort "none"' : f));
      const rej = names.length > 0 ? `the server rejected ${names.join(', ')}; they are left out` : undefined;
      emit({ id: 'thinking', state: 'ok', text: 'Thinking is off', ...(rej ? { hint: rej } : {}) }, stageStart);
    }

    // 4. context
    stage = 'context';
    stageStart = now();
    const window = Object.hasOwn(info.contextWindows, model) ? info.contextWindows[model] : undefined;
    if (window !== undefined) {
      if (values.contextTokens + maxTokens > window) {
        emit({ id: 'context', state: 'warn', text: `context size ${values.contextTokens} + max tokens ${maxTokens} is more than the server's ${window}` }, stageStart);
      } else {
        emit({ id: 'context', state: 'ok', text: `Server context window: ${window} tokens` }, stageStart);
      }
    }
  } catch (err) {
    fail(stage, err, stageStart);
  }
  return result;
}
