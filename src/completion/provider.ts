import * as vscode from 'vscode';
import type { ErrorBackoff } from '../backends/backoff';
import { classifyError, HttpError, type ErrorClass } from '../backends/http';
import { MissingApiKeyError } from '../backends/mistral';
import { inferHostFlavor } from '../backends/hostFlavor';
import type { FimBackend } from '../backends/types';
import type { FimMode, ThinkingStrategy } from '../types';
import type { Settings } from '../config/settings';
import type { Log } from '../log';
import { THINKING_LABELS } from '../models/thinking';
import { isRouteMissing, usableRoutes, type Capabilities } from '../models/capabilities';
import { toItemText, type NextEditShow } from '../nextEdit/diff';
import type { NextEditController } from '../nextEdit/vscode/controller';
import type { SuggestionCache } from './cache';
import { buildExtraContext, buildFimWindowIn, cursorQuery, type ExtraContextRing, type LineSource } from './context';
import { docPath } from './contextTracker';
import { DetectedModels } from './detectedModels';
import { contextCaps, resolveFim } from './effective';
import { CompletionAccumulator, shouldCompleteMultiline } from './filters';
import { gate } from './gate';
import type { CompletionOutcome, OutcomeLog } from './outcomes';
import { collectCompletion, ThinkingError, type PlannedRequest } from './stream';
import { postprocess, toInsertion, type PostCtx } from './postprocess';
import { recordBackendFailure, RequestStatus, retryHint, type Outcome, type StatusSink } from './requestStatus';
import { noCompletionBackend } from '../ui/statusModel';
import { buildChatRequest, buildFimRequest, EFFORT_NONE_REJECTED, explainUnsupported, planInsertion, planRoute, thinkingBlocked, whyNoRoute, type FimRoute } from './route';
import type { Debouncer, InFlight } from './scheduler';
import { shouldPrefetch, shouldWarm, WarmLimiter, type SpeculateInput } from './warmup';

const MAX_LINES = 16;

/**
 * show: a request VS Code asked for. warm: fills llama.cpp's prompt cache (no tokens generated, the answer is ignored).
 * prefetch: the completion after an accepted one, cached and not shown. Neither speculative mode counts as a user request.
 */
type Mode = 'show' | 'warm' | 'prefetch';

export type { StatusSink } from './requestStatus';

export interface FimDeps {
  getSettings(): Settings;
  getBackend(id: string): FimBackend | undefined;
  isLocal(baseUrl: string): Promise<boolean>;
  cache: SuggestionCache;
  debouncer: (backendId: string) => Debouncer;
  inflight: InFlight;
  ring: ExtraContextRing;
  backoff: (backendId: string) => ErrorBackoff;
  status: StatusSink;
  log: Log;
  snoozedUntil(): number;
  capabilities: Capabilities;
  /** The last outcomes and the session counts (in memory only). */
  outcomes: OutcomeLog;
  /** Next Edit's result to show instead of FIM, and where FIM's own outcome goes. */
  nextEdit?: Pick<NextEditController, 'itemFor' | 'fimResult' | 'rejected' | 'recentEdits'>;
}

/** A request that passed every check and is about to be sent. */
interface Job {
  backend: FimBackend;
  backoff: ErrorBackoff;
  debouncer: Debouncer;
  planned: PlannedRequest;
  model: string | undefined;
  /** The thinking switch in use, named in the log when the model keeps thinking. */
  thinking: ThinkingStrategy;
  mode: FimMode;
  /** Another prompt route would remain if this one were learned as missing. */
  hasFallback: boolean;
  ctl: AbortController;
  uri: string;
  prefix: string;
  suffix: string;
  stop: string[];
  multiline: boolean;
  post: PostCtx;
  eol: '\n' | '\r\n';
  logPrompts: boolean;
  /** A prefetch: cached only, never shown, reported, counted or backed off. */
  quiet: boolean;
}

/** Where a suggestion is shown; shared by cache hits, joined requests and fresh ones. */
interface Spot {
  doc: vscode.TextDocument;
  pos: vscode.Position;
  lineSuffix: string;
  backendId: string;
  call: Call;
}

/** One call of the provider: whether FIM's outcome was already told to Next Edit. */
interface Call {
  reported: boolean;
}

/** A failure's status detail, plus "retrying in N s" while the backend backs off. */
function withRetry(detail: string, backoff: ErrorBackoff): string {
  const hint = retryHint(backoff.state(), Date.now());
  return hint ? `${detail}; ${hint}` : detail;
}

export class FimProvider implements vscode.InlineCompletionItemProvider {
  private readonly models = new DetectedModels<FimBackend>();
  private readonly logged = new Set<string>();
  /** Backends whose last request failed, with the failure's status detail. */
  private readonly failing = new Map<string, string>();
  private readonly requests: RequestStatus;
  /** The Next Edit items returned, so only their rejection reaches Next Edit. */
  private readonly nextEditItems = new WeakSet<vscode.InlineCompletionItem>();
  private readonly warmed = new WarmLimiter();
  /** A warm-up or prefetch is running (at most one at a time). */
  private speculating = false;

  constructor(private readonly d: FimDeps) {
    this.requests = new RequestStatus(d.status);
  }

  /** Shows idle again (after "Retry now", an API key change or a local server that became ready); a request still running reports its own outcome. Model detection is tried again too. */
  clearError(): void {
    this.models.forgetMisses();
    this.requests.report({ state: 'idle' });
  }

  /** Lets every once-only log line appear again, e.g. a route line for a model that was fixed and is broken again. */
  forgetLogged(): void {
    this.logged.clear();
  }

  /** Settings changed: the backend may be another one, so every document can be warmed again. */
  forgetWarmed(): void {
    this.warmed.clear();
  }

  /** A closed document can be warmed again when it is reopened (an untitled one reuses its URI). */
  documentClosed(uri: string): void {
    this.warmed.forget(uri);
  }

  /** The model detected for the backend's current instance, if any; read-only, never fetches. */
  detectedModel(backendId: string): string | undefined {
    const backend = this.d.getBackend(backendId);
    return backend ? this.models.get(backend) : undefined;
  }

  async provideInlineCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    ctx: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    const cancel = new AbortController();
    const sub = token.onCancellationRequested(() => cancel.abort());
    if (token.isCancellationRequested) cancel.abort();
    const version = doc.version;
    const call: Call = { reported: false };
    let items: vscode.InlineCompletionItem[] = [];
    try {
      items = await this.provide(doc, pos, ctx, cancel.signal, call, 'show');
    } catch (err) {
      this.d.log.error('inline completion failed', err);
    } finally {
      sub.dispose();
    }
    // FIM showed nothing without an answer (a gate, local-only, a backoff, a failure): Next Edit may still ask after an edit.
    // The controller applies its own checks (switch, snooze, excluded files) before it asks.
    if (!call.reported && !cancel.signal.aborted && doc.version === version) this.d.nextEdit?.fimResult(doc.uri.toString(), version, false);
    return items;
  }

  /**
   * Proposed API (inlineCompletionsAdditions): VS Code calls it only with the proposal enabled.
   * Kind 1 is InlineCompletionEndOfLifeReasonKind.Rejected, compared as a number because the enum is proposed too.
   */
  handleEndOfLifetime(item: vscode.InlineCompletionItem, reason: vscode.InlineCompletionEndOfLifeReason): void {
    if ((reason.kind as number) === 1 && this.nextEditItems.has(item)) this.d.nextEdit?.rejected();
  }

  /**
   * Fills llama.cpp's prompt cache with the window at `pos` (an /infill with n_predict 0, answer ignored): loopback llama.cpp
   * backends only, at most once per document per 30 s. Never shown, reported or counted; only a debug line without code text.
   */
  warm(doc: vscode.TextDocument, pos: vscode.Position): void {
    void this.speculate(doc, pos, 'warm');
  }

  /** After an accepted completion: asks for the completion at `pos` and caches it without showing it (loopback llama.cpp only). */
  prefetch(doc: vscode.TextDocument, pos: vscode.Position): void {
    void this.speculate(doc, pos, 'prefetch');
  }

  private async speculate(doc: vscode.TextDocument, pos: vscode.Position, mode: 'warm' | 'prefetch'): Promise<void> {
    const s = this.d.getSettings();
    const backend = s.fim.backendId === undefined ? undefined : this.d.getBackend(s.fim.backendId);
    const uri = doc.uri.toString();
    const input: SpeculateInput = {
      kind: backend?.config.kind,
      baseUrl: backend?.config.baseUrl,
      enabled: s.enabled && s.fim.enabled,
      snoozedUntil: this.d.snoozedUntil(),
      now: Date.now(),
      scheme: doc.uri.scheme,
      languageId: doc.languageId,
      disabledLanguages: s.fim.disableInLanguages,
      fileExcluded: s.fim.disableInFiles.some((pattern) => vscode.languages.match({ pattern }, doc) > 0),
      inBackoff: backend !== undefined && !this.d.backoff(backend.config.id).canRequest(),
      busy: this.speculating || this.d.inflight.busy(uri),
    };
    const decision = mode === 'warm' ? shouldWarm(input, this.warmed.last(uri)) : shouldPrefetch(input);
    if (!decision.ok) {
      // Not llama.cpp or not loopback is the usual case for most setups: not worth a line.
      if (decision.reason !== 'not llama.cpp' && decision.reason !== 'not loopback') this.d.log.debug(`${mode} skipped: ${decision.reason}`);
      return;
    }
    if (mode === 'warm') this.warmed.mark(uri);
    this.speculating = true;
    try {
      await this.provide(doc, pos, undefined, new AbortController().signal, { reported: true }, mode);
    } catch (err) {
      this.d.log.debug(`${mode} failed: ${err instanceof Error ? err.name : 'error'}`);
    } finally {
      this.speculating = false;
    }
  }

  private note(uri: string, kind: CompletionOutcome['kind'], extra: Partial<Pick<CompletionOutcome, 'detail' | 'ms' | 'chars'>> = {}): void {
    this.d.outcomes.record({ at: Date.now(), uri, feature: 'completions', kind, ...extra });
  }

  /** The request pipeline. A speculative mode (no `ctx`) was already checked by speculate() and returns silently wherever a shown request would report. */
  private async provide(doc: vscode.TextDocument, pos: vscode.Position, ctx: vscode.InlineCompletionContext | undefined, signal: AbortSignal, call: Call, mode: Mode): Promise<vscode.InlineCompletionItem[]> {
    if (signal.aborted) return [];
    const show = mode === 'show';
    // A Next Edit result for this document version is shown alone; the controller already applied the gate when it asked.
    const next = show ? this.d.nextEdit?.itemFor(doc, pos) : undefined;
    if (next) {
      call.reported = true;
      return [this.nextEditItem(next.show, doc, pos)];
    }
    const s = this.d.getSettings();
    const line = doc.lineAt(pos.line).text;
    const linePrefix = line.slice(0, pos.character);
    const lineSuffix = line.slice(pos.character);
    const editor = vscode.window.activeTextEditor;
    const invoked = ctx?.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
    const g = !ctx ? { ok: true as const } : gate({
      enabled: s.enabled && s.fim.enabled,
      snoozedUntil: this.d.snoozedUntil(),
      now: Date.now(),
      scheme: doc.uri.scheme,
      languageId: doc.languageId,
      disabledLanguages: s.fim.disableInLanguages,
      fileExcluded: s.fim.disableInFiles.some((pattern) => vscode.languages.match({ pattern }, doc) > 0),
      selections: editor?.document === doc ? editor.selections.length : 1,
      hasSelectedCompletionInfo: !!ctx.selectedCompletionInfo,
      lineSuffix,
      skipMidWord: s.fim.skipMidWord,
      invoked,
    });
    if (!g.ok) {
      // The status bar shows disabled/snoozed from the settings itself; status.set takes request outcomes only.
      this.d.log.debug(`fim skipped: ${g.reason}`);
      this.note(doc.uri.toString(), 'skipped', { detail: g.reason });
      return [];
    }

    const backend = s.fim.backendId === undefined ? undefined : this.d.getBackend(s.fim.backendId);
    if (!backend && !show) return [];
    if (!backend) {
      // Backends that are all Next Edit-only are a valid setup: completions are not configured, which is not an error.
      const none = noCompletionBackend(s.backends.length);
      this.d.status.set(none.state, none.detail);
      this.note(doc.uri.toString(), 'blocked', { detail: 'no-backend' });
      if (none.state === 'idle') this.once('no-completion-backend', () => this.d.log.info('no backend is used for completions; Next Edit is unaffected'));
      return [];
    }
    const id = backend.config.id;
    // speculate() allows loopback hosts only, which are local.
    if (show && s.privacy.localOnly && !(await this.d.isLocal(backend.config.baseUrl))) {
      this.d.status.set('error', 'Blocked: backend is not local');
      this.note(doc.uri.toString(), 'blocked', { detail: 'local-only' });
      this.once(`local:${id}:${backend.config.baseUrl}`, () => this.d.log.warn(`blocked: backend "${id}" (${backend.config.baseUrl}) is not local and privacy.localOnly is on`));
      return [];
    }
    const backoff = this.d.backoff(id);
    if (!backoff.canRequest()) {
      if (!show) return [];
      // Refresh the countdown in the error detail.
      const failure = this.failing.get(id);
      if (failure !== undefined) this.requests.report({ state: 'error', detail: withRetry(failure, backoff) });
      this.note(doc.uri.toString(), 'blocked', { detail: 'backoff' });
      return [];
    }

    // The window and the cache key use values that do not depend on the model (only a template/preset depends on it).
    const early = resolveFim(backend.config, undefined, s).values;
    const caps = contextCaps(early.contextTokens);
    // Only the lines the window may use are read: not the whole document on every keystroke.
    const lines: LineSource = {
      lineCount: doc.lineCount,
      text: (first, last) => doc.getText(new vscode.Range(first, 0, last, doc.lineAt(last).text.length)),
      offsetAt: (l, character) => doc.offsetAt(new vscode.Position(l, character)),
    };
    const win = buildFimWindowIn(lines, pos.line, pos.character, { prefixLines: early.prefixLines, suffixLines: early.suffixLines, maxPrefixChars: caps.maxPrefixChars, maxSuffixChars: caps.maxSuffixChars });
    // The version the window was read from: FIM's outcome is reported to Next Edit for it.
    const version = doc.version;
    const uri = doc.uri.toString();
    const spot: Spot = { doc, pos, lineSuffix, backendId: id, call };
    // A manual trigger (Alt+\) asks for a fresh suggestion, e.g. after an empty one was cached; its result is still cached.
    const cached = invoked ? undefined : this.d.cache.find(uri, win.prefix, win.suffix);
    // A prefetch whose answer is already cached has nothing to do; a warm-up fills the server's cache, not ours.
    if (mode === 'prefetch' && cached !== undefined) return [];
    if (show && cached !== undefined) {
      this.note(uri, 'cache', { chars: cached.length });
      return this.reported(cached, spot, version);
    }

    const join = show ? this.d.inflight.find(uri, win.prefix, win.suffix) : undefined;
    if (join) {
      // The owner of the flight reports its errors; a cancelled or failed flight is a silent no-op here.
      const finished = await join.result.then((t) => t !== undefined, () => false);
      if (!finished || signal.aborted) return [];
      // The finished flight is cached under its own prefix, so the cache derives what is left after the text typed since.
      const hit = this.d.cache.find(uri, win.prefix, win.suffix);
      if (hit !== undefined) {
        this.note(uri, 'joined', { chars: hit.length });
        return this.reported(hit, spot, version);
      }
      // The suggestion does not continue what was typed since: request a fresh one.
    }

    const debouncer = this.d.debouncer(id);
    if (show && !(await debouncer.wait(signal))) return [];
    if (this.d.getSettings() !== s) return [];

    const model = await this.model(backend, signal);
    if (signal.aborted || this.d.getSettings() !== s) return [];
    // A speculative request is for the document as it was: an edit since then, or a request VS Code started meanwhile, wins.
    if (!show && (doc.version !== version || this.d.inflight.busy(uri))) return [];
    if (model === undefined && inferHostFlavor(backend.config) === 'openrouter') {
      // OpenRouter would pick the payer's default model, so code would go to a model the user never chose.
      this.once(`model:${id}`, () => this.d.log.warn(`backend "${id}": OpenRouter needs a model: choose one in AI Autocomplete: Manage Backends`));
      this.requests.report({ state: 'error', detail: `${id}: choose a model`, action: { command: 'aiAutocomplete.manageBackends', args: [{ focus: id }] } });
      this.note(uri, 'blocked', { detail: 'no-model' });
      return [];
    }
    const fim = resolveFim(backend.config, model, s).values;
    const { kind, fimMode } = backend.config;
    const learned = this.d.capabilities.get(id, model);
    const routeCaps = usableRoutes(backend.routes(), learned.failedRoutes);
    const route = planRoute(kind, routeCaps, fim, fimMode);
    // Speculation is for raw FIM routes: a warm-up needs /infill (n_predict 0), and the chat route has its own thinking checks.
    if (!show && (route === 'unsupported' || route === 'chat' || (mode === 'warm' && route !== 'native'))) return [];
    if (route === 'unsupported') {
      // Only a detected model id is remembered, so an undetected one is probed again on the next request.
      const why = explainUnsupported(id, model, fimMode, whyNoRoute(routeCaps, fimMode), backend.routes().chat, kind);
      this.once(why.onceKey, () => this.d.log.warn(why.log));
      this.note(uri, 'blocked', { detail: 'no-route' });
      if (why.status) this.requests.report({ state: 'error', detail: why.status, ...(why.action ? { action: why.action } : {}) });
      return [];
    }

    // The extra-context ring names files the same way, so the current file's own chunks are left out.
    const filePath = docPath(doc.uri);
    // Ranked by the identifiers around the cursor; Next Edit's recent edits (only while it tracks them) go last.
    const extra = fim.extraContext
      ? buildExtraContext(this.d.ring, { path: filePath, startLine: win.startLine, endLine: win.endLine }, caps.extraChars, cursorQuery(win.prefix, win.suffix), (max) => this.d.nextEdit?.recentEdits(max))
      : [];
    const multiline = shouldCompleteMultiline(fim.multiline, linePrefix, lineSuffix, doc.languageId);
    // Not linked to the VS Code token: a newer keystroke may join this request. It is aborted by a newer request for this uri.
    const ctl = new AbortController();
    const input = { prefix: win.prefix, suffix: win.suffix, filePath, repoName: vscode.workspace.getWorkspaceFolder(doc.uri)?.name ?? '', extra };
    let planned: PlannedRequest;
    let stop = fim.stop;
    const flavor = inferHostFlavor(backend.config);
    if (route === 'chat') {
      const blocked = thinkingBlocked(fim.thinking, flavor, learned);
      if (blocked) {
        this.requests.report(this.reportThinking(id, model, blocked, fim.thinking));
        this.note(uri, 'blocked', { detail: 'thinking' });
        return [];
      }
      const req = buildChatRequest({
        fim,
        flavor,
        model,
        input: { ...input, languageId: doc.languageId, multiline },
        rejected: learned.rejected,
        signal: ctl.signal,
        onRejected: (fields) => {
          const added = this.d.capabilities.reject(id, model, fields);
          if (added.includes(EFFORT_NONE_REJECTED)) {
            this.d.log.info(`backend "${id}": ${model ?? 'the model'} must reason (the server rejected reasoning effort "none"); chat completions are off for it`);
          }
          const dropped = added.filter((f) => f !== EFFORT_NONE_REJECTED);
          if (dropped.length > 0) this.d.log.info(`backend "${id}": the server rejected ${dropped.join(', ')} for ${model ?? 'the model'}; sending without them`);
        },
      });
      planned = { route: 'chat', req, linePrefix, lineSuffix };
      stop = req.stop;
    } else {
      const built = buildFimRequest({ route, fim, model, multiline, signal: ctl.signal, input, flavor });
      // A warm-up generates no tokens: llama.cpp only processes the prompt into the slot's cache.
      const req = mode === 'warm' ? { ...built, sampling: { ...built.sampling, maxTokens: 0 } } : built;
      planned = { route, req: { ...req, onUnrepaired: () => this.d.log.debug(`fim ${id}: the answer did not continue the cursor line (LM Studio first-space repair); no suggestion`) } };
    }
    const hasFallback = planRoute(kind, usableRoutes(backend.routes(), new Set<FimRoute>([...learned.failedRoutes, route])), fim, fimMode) !== 'unsupported';
    const post: PostCtx = { linePrefix, lineSuffix, prevLine: pos.line > 0 ? doc.lineAt(pos.line - 1).text : '', suffix: win.suffix, chat: route === 'chat' };
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

    if (mode === 'warm') {
      await this.warmUp(backend, planned, ctl, win.prefix.length, win.suffix.length);
      return [];
    }
    this.d.inflight.abortAll(uri);
    const result = this.run({ backend, backoff, debouncer, planned, model, thinking: fim.thinking, mode: fimMode, hasFallback, ctl, uri, prefix: win.prefix, suffix: win.suffix, stop, multiline, post, eol, logPrompts: s.debug.logPrompts, quiet: !show });
    this.d.inflight.add(uri, win.prefix, win.suffix, result, ctl);
    const text = await result;
    // A prefetch only fills the cache: the trigger at this position reads it.
    if (!show) return [];
    return text === undefined || signal.aborted ? [] : this.reported(text, spot, version);
  }

  /** Sends a warm-up and drains its answer. Its result is recorded nowhere: one debug line with sizes and time, never text. */
  private async warmUp(backend: FimBackend, planned: PlannedRequest, ctl: AbortController, prefixChars: number, suffixChars: number): Promise<void> {
    if (planned.route === 'chat') return;
    const id = backend.config.id;
    const started = Date.now();
    try {
      for await (const chunk of backend.streamFim(planned.req)) void chunk;
      this.d.log.debug(`warm-up ${id}: prefix=${prefixChars} suffix=${suffixChars} in ${Date.now() - started} ms`);
    } catch (err) {
      // A failing server is reported by the next real request; the raw error can quote server output.
      const cls = ctl.signal.aborted ? 'abort' : classifyError(err).kind;
      this.d.log.debug(`warm-up ${id}: failed (${cls}) after ${Date.now() - started} ms`);
    }
  }

  /** Sends one request and records its result. Never rejects: resolves the insert text ('' = nothing), or undefined when cancelled or failed. */
  private async run(j: Job): Promise<string | undefined> {
    const id = j.backend.config.id;
    let outcome: Outcome | undefined;
    const started = Date.now();
    try {
      if (!j.quiet) {
        this.requests.begin();
        this.d.outcomes.requestSent();
      }
      // Client-side stops are the request's own list (the full preset list on FIM routes; backends may cap what they send, ruling R2).
      const acc = new CompletionAccumulator({ stop: j.stop, multiline: j.multiline, maxLines: MAX_LINES, suffix: j.suffix });
      const collected = await collectCompletion(j.backend, j.planned, acc, j.ctl, { failOnThinking: j.planned.route === 'chat' });
      const { stoppedEarly, timedOut } = collected;
      const ms = Date.now() - started;
      const completion = postprocess(collected.text, j.post);
      const text = completion === undefined ? '' : planInsertion(completion, j.eol);
      this.d.cache.add(j.uri, j.prefix, j.suffix, text);
      if (j.quiet) {
        // A prefetch is cached only; it is recorded nowhere else and does not change the backend's state.
        this.d.log.debug(`prefetch ${id} ${j.planned.route} prefix=${j.prefix.length} suffix=${j.suffix.length} → ${text.length} chars in ${ms} ms (cached)`);
        if (j.logPrompts) this.d.log.debug(`prefetch completion: ${JSON.stringify(text)}`);
        return text;
      }
      if (text !== '') this.note(j.uri, 'shown', { chars: text.length, ms });
      else this.note(j.uri, collected.text.trim() === '' ? 'empty' : 'filtered', { ms });
      j.debouncer.recordLatency(ms);
      j.backoff.recordSuccess();
      if (this.failing.delete(id)) this.d.log.info(`backend "${id}" is responding again`);
      this.d.log.debug(
        `fim ${id} ${j.planned.route} model=${j.model ?? '?'} prefix=${j.prefix.length} suffix=${j.suffix.length} ` +
          `→ ${text.length} chars in ${ms} ms${stoppedEarly ? ' (stopped early)' : ''}${timedOut ? ' (timed out; complete lines shown)' : ''}`,
      );
      if (j.logPrompts) {
        this.d.log.debug(`fim prompt: ${JSON.stringify(j.planned.route === 'chat' ? j.planned.req.messages : j.planned.req.payload)}`);
        const raw = collected.visible ?? collected.text;
        this.d.log.debug(`fim completion: raw ${JSON.stringify(raw)} → shown ${JSON.stringify(text)}`);
      }
      outcome = { state: 'idle' };
      return text;
    } catch (err) {
      if (j.quiet) {
        // The next real request reports a failing server; a prefetch learns nothing and backs nothing off.
        this.d.log.debug(`prefetch ${id}: ${j.ctl.signal.aborted ? 'cancelled' : `failed (${classifyError(err).kind})`}`);
        return undefined;
      }
      outcome = this.failed(err, j);
      return undefined;
    } finally {
      if (!j.quiet) this.requests.end(outcome);
    }
  }

  private failed(err: unknown, j: Job): Outcome | undefined {
    const id = j.backend.config.id;
    if (err instanceof ThinkingError) {
      // Configuration, not a backend failure: the next request is blocked before sending, so no backoff and nothing cached.
      // An OpenRouter model that rejected effort "none" during this request must reason: no other switch can help.
      const why = thinkingBlocked(j.thinking, inferHostFlavor(j.backend.config), this.d.capabilities.get(id, j.model)) ?? 'keepsThinking';
      if (why === 'keepsThinking') this.d.capabilities.sawThinking(id, j.model);
      this.note(j.uri, 'blocked', { detail: 'thinking' });
      return this.reportThinking(id, j.model, why, j.thinking);
    }
    // Our own controller is only aborted by a newer request or an early stop: that is a cancel, never a failure.
    const cls: ErrorClass = j.ctl.signal.aborted ? { kind: 'abort' } : classifyError(err);
    if (cls.kind === 'abort') {
      this.note(j.uri, 'cancelled');
      return undefined;
    }
    if (err instanceof MissingApiKeyError) {
      this.once(`key:${id}`, () => this.d.log.warn(`backend "${id}" has no API key; run "AI Autocomplete: Set API Key"`));
      this.note(j.uri, 'error', { detail: `Set API key for ${id}` });
      return { state: 'error', detail: `Set API key for ${id}` };
    }
    if (j.mode === 'auto' && j.planned.route !== 'chat' && err instanceof HttpError && isRouteMissing(err) && j.hasFallback) {
      // A server without this endpoint is not failing: the next request takes the next prompt route.
      const status = err.status;
      this.note(j.uri, 'error', { detail: `no ${j.planned.route} endpoint (HTTP ${status}); trying the next route` });
      this.models.delete(j.backend); // the server may have restarted with another model
      this.d.capabilities.failRoute(id, j.model, j.planned.route);
      this.once(`missing:${id}:${j.model ?? ''}:${j.planned.route}`, () =>
        this.d.log.info(`backend "${id}": no ${j.planned.route} endpoint for ${j.model ?? 'the model'} (HTTP ${status}); the next request uses the next prompt route`),
      );
      return { state: 'idle' };
    }
    const { detail, warn } = recordBackendFailure(j.backoff, id, err, cls, j.logPrompts, j.planned.req.timeoutMs);
    if (warn) this.d.log.warn(warn);
    else this.d.log.debug(detail);
    // Error messages can quote server output, so the raw one is logged only with logPrompts.
    if (j.logPrompts && err instanceof Error) this.d.log.debug(`${id}: raw error: ${err.message}`);
    this.failing.set(id, detail);
    this.note(j.uri, 'error', { detail });
    this.models.delete(j.backend); // the server may have restarted with another model
    return { state: 'error', detail: withRetry(detail, j.backoff) };
  }

  /** Model id from settings, else detected once per backend instance; a detection that found nothing is not repeated for 30 s. */
  private async model(backend: FimBackend, signal: AbortSignal): Promise<string | undefined> {
    if (backend.config.fimModel) return backend.config.fimModel;
    const known = this.models.get(backend);
    if (known !== undefined) return known;
    if (!this.models.shouldDetect(backend)) return undefined;
    const detected = await backend.detectModel(signal);
    if (signal.aborted) return detected;
    if (detected !== undefined) {
      this.models.set(backend, detected);
      this.d.log.info(`backend "${backend.config.id}": detected model ${detected}`);
    } else {
      this.models.missed(backend);
    }
    return detected;
  }

  /** Logs (once per backend and model) a model the chat route cannot use because of thinking; returns the status to show. */
  private reportThinking(id: string, model: string | undefined, why: 'cannotDisable' | 'keepsThinking', strategy: ThinkingStrategy): Outcome {
    const m = model ?? 'the model';
    const key = `thinking:${why}:${id}:${model ?? ''}`;
    if (why === 'cannotDisable') {
      this.once(key, () => this.d.log.warn(`model "${m}" cannot turn thinking off: autocomplete needs a model that answers without thinking; choose another model in AI Autocomplete: Manage Backends`));
    } else {
      this.once(key, () => this.d.log.warn(`backend "${id}": ${m} keeps thinking with the "${THINKING_LABELS[strategy]}" thinking switch: choose another switch or another model in AI Autocomplete: Manage Backends`));
    }
    const outcome: Outcome = {
      state: 'error',
      detail: why === 'cannotDisable' ? `${id}: ${m} cannot turn thinking off` : `${id}: ${m} keeps thinking`,
      action: { command: 'aiAutocomplete.manageBackends', args: [{ focus: id }] },
    };
    return outcome;
  }

  private items(text: string, at: Spot): vscode.InlineCompletionItem[] {
    if (text === '') return [];
    const { insertText, replaceToEndOfLine } = toInsertion(text, at.lineSuffix);
    const end = replaceToEndOfLine ? at.doc.lineAt(at.pos.line).range.end : at.pos;
    return [new vscode.InlineCompletionItem(insertText, new vscode.Range(at.pos, end), { command: 'aiAutocomplete.accepted', title: '', arguments: [at.backendId] })];
  }

  /** FIM's answer, told to Next Edit while the document is still at the window's version: Next Edit only asks when FIM had nothing. */
  private reported(text: string, at: Spot, version: number): vscode.InlineCompletionItem[] {
    at.call.reported = true;
    if (at.doc.version === version) this.d.nextEdit?.fimResult(at.doc.uri.toString(), version, text !== '');
    return this.items(text, at);
  }

  /** Ghost text at the cursor, or an inline edit of the range (shown only by VS Code's inline-edit UI). */
  private nextEditItem(show: NextEditShow, doc: vscode.TextDocument, pos: vscode.Position): vscode.InlineCompletionItem {
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const command: vscode.Command = { command: 'aiAutocomplete.nextEditAccepted', title: '' };
    let item: vscode.InlineCompletionItem;
    if (show.kind === 'ghost') {
      item = new vscode.InlineCompletionItem(toItemText(show.insertText, eol), new vscode.Range(pos, pos), command);
    } else {
      const range = new vscode.Range(show.start.line, show.start.character, show.end.line, show.end.character);
      item = new vscode.InlineCompletionItem(toItemText(show.text, eol), range, command);
      item.isInlineEdit = true;
    }
    this.nextEditItems.add(item);
    return item;
  }

  private once(key: string, log: () => void): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    log();
  }
}
