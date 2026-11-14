import { HttpError, StreamError } from '../backends/http';
import { MissingApiKeyError } from '../backends/mistral';
import type { FimBackend, ServerInfo } from '../backends/types';
import type { Settings } from '../config/settings';
import { resolveFim, templateMismatch } from '../completion/effective';
import { CompletionAccumulator } from '../completion/filters';
import { postprocess } from '../completion/postprocess';
import { buildFimRequest, noRouteText, planRoute, whyNoRoute } from '../completion/route';
import type { Log } from '../log';
import type { TemplateInput } from '../models/templates';
import type { TestStep } from './protocol';

export const TEST_TIMEOUT_MS = 30_000;
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
const POST = { linePrefix: '  return ', lineSuffix: '', prevLine: 'function add(a: number, b: number): number {', suffix: SAMPLE.suffix };

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

    const stream = async (req: ReturnType<typeof buildFimRequest>, ctl: AbortController, stop: string[]): Promise<string> => {
      const acc = new CompletionAccumulator({ stop, multiline: false, maxLines: MAX_LINES, suffix: SAMPLE.suffix });
      for await (const chunk of backend.streamFim(req)) {
        if (acc.push(chunk)) {
          ctl.abort();
          break;
        }
      }
      return postprocess(acc.text, POST) ?? '';
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
      await stream({ ...req, sampling: { ...req.sampling, maxTokens: 1 }, timeoutMs: TEST_TIMEOUT_MS }, ctl, v.stop);
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
    const route = planRoute(cfg.kind, backend.supportsNativeFim(), values, cfg.fimMode);
    if (route === 'unsupported') {
      const why = whyNoRoute(cfg.kind, backend.supportsNativeFim(), cfg.fimMode);
      if (why === 'template') emit({ id: 'model', state: 'warn', text: `${model} has no completion template`, hint: `pick a coder model, or choose a template${/zeta/i.test(model) ? '; seed-coder fits Zeta 2.x' : ''}` }, stageStart);
      else emit({ id: 'model', state: 'warn', text: noRouteText(why, cfg.fimMode), ...(why === 'mode' ? { hint: 'set the prompt mode to auto' } : {}) }, stageStart);
      return result;
    }
    // A Template chosen for another model is worth a warning, but the test still shows what this one answers.
    const mismatch = route === 'template' ? templateMismatch(cfg, model, settings) : undefined;
    emit({
      id: 'model', state: mismatch ? 'warn' : 'ok', text: route === 'native' ? `Model ${model} (server-side prompt)` : `Model ${model} with the ${values.fimTemplate} template`,
      ...(mismatch ? { hint: `${model}'s own template is ${mismatch.own}; reset the Template field` } : {}),
    }, stageStart);

    // 3. completion
    stage = 'completion';
    stageStart = now();
    const ctl = makeCtl();
    const req = buildFimRequest({ route, fim: values, model, multiline: false, input: SAMPLE, signal: ctl.signal });
    const text = await stream({ ...req, timeoutMs: TEST_TIMEOUT_MS }, ctl, values.stop);
    const elapsed = now() - stageStart;
    if (settings.debug.logPrompts) i.log.debug(`connection test sample completion: ${JSON.stringify(text)}`);
    if (text === '') {
      emit({ id: 'completion', state: 'warn', text: 'the server answered but returned no completion' }, stageStart);
    } else if (elapsed > values.timeoutMs) {
      emit({ id: 'completion', state: 'warn', text: `Test completion in ${elapsed} ms: "${text.slice(0, SHOWN_CHARS)}"`, hint: `slower than the ${values.timeoutMs} ms timeout; run the test again if the model was loading` }, stageStart);
    } else {
      emit({ id: 'completion', state: 'ok', text: `Test completion in ${elapsed} ms: "${text.slice(0, SHOWN_CHARS)}"` }, stageStart);
    }

    // 4. context
    stage = 'context';
    stageStart = now();
    const window = info.contextWindows[model];
    if (window !== undefined) {
      if (values.contextTokens + values.maxTokens > window) {
        emit({ id: 'context', state: 'warn', text: `context size ${values.contextTokens} + max tokens ${values.maxTokens} is more than the server's ${window}` }, stageStart);
      } else {
        emit({ id: 'context', state: 'ok', text: `Server context window: ${window} tokens` }, stageStart);
      }
    }
  } catch (err) {
    fail(stage, err, stageStart);
  }
  return result;
}
