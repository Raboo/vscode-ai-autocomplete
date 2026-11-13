import * as vscode from 'vscode';
import type { ErrorBackoff } from '../backends/backoff';
import { classifyError, type ErrorClass } from '../backends/http';
import { MissingApiKeyError } from '../backends/mistral';
import type { FimBackend, FimRequest } from '../backends/types';
import type { Settings } from '../config/settings';
import type { Log } from '../log';
import { resolvePreset } from '../models/presets';
import type { SuggestionCache } from './cache';
import { buildFimWindow, DEFAULT_WINDOW, type ExtraContextRing } from './context';
import { CompletionAccumulator, shouldCompleteMultiline } from './filters';
import { gate } from './gate';
import { postprocess, toInsertion, type PostCtx } from './postprocess';
import { recordBackendFailure, RequestStatus, retryHint, type Outcome, type StatusSink } from './requestStatus';
import { buildFimRequest, explainUnsupported, planInsertion, planRoute } from './route';
import type { Debouncer, InFlight } from './scheduler';

const EXTRA_CONTEXT_CHARS = 6000;
const MAX_LINES = 16;

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
}

/** A request that passed every check and is about to be sent. */
interface Job {
  backend: FimBackend;
  backoff: ErrorBackoff;
  debouncer: Debouncer;
  req: FimRequest;
  ctl: AbortController;
  uri: string;
  prefix: string;
  suffix: string;
  stop: string[];
  multiline: boolean;
  post: PostCtx;
  eol: '\n' | '\r\n';
  logPrompts: boolean;
}

/** Where a suggestion is shown; shared by cache hits, joined requests and fresh ones. */
interface Spot {
  doc: vscode.TextDocument;
  pos: vscode.Position;
  lineSuffix: string;
  backendId: string;
}

/** A failure's status detail, plus "retrying in N s" while the backend backs off. */
function withRetry(detail: string, backoff: ErrorBackoff): string {
  const hint = retryHint(backoff.state(), Date.now());
  return hint ? `${detail}; ${hint}` : detail;
}

export class FimProvider implements vscode.InlineCompletionItemProvider {
  private readonly models = new WeakMap<FimBackend, string>();
  private readonly logged = new Set<string>();
  /** Backends whose last request failed, with the failure's status detail. */
  private readonly failing = new Map<string, string>();
  private readonly requests: RequestStatus;

  constructor(private readonly d: FimDeps) {
    this.requests = new RequestStatus(d.status);
  }

  /** Shows idle again (after "Retry now" or an API key change); a request still running reports its own outcome. */
  clearError(): void {
    this.requests.report({ state: 'idle' });
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
    try {
      return await this.provide(doc, pos, ctx, cancel.signal);
    } catch (err) {
      this.d.log.error('inline completion failed', err);
      return [];
    } finally {
      sub.dispose();
    }
  }

  private async provide(doc: vscode.TextDocument, pos: vscode.Position, ctx: vscode.InlineCompletionContext, signal: AbortSignal): Promise<vscode.InlineCompletionItem[]> {
    if (signal.aborted) return [];
    const s = this.d.getSettings();
    const line = doc.lineAt(pos.line).text;
    const linePrefix = line.slice(0, pos.character);
    const lineSuffix = line.slice(pos.character);
    const editor = vscode.window.activeTextEditor;
    const invoked = ctx.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
    const g = gate({
      enabled: s.fim.enabled,
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
      return [];
    }

    const backend = s.fim.backendId === undefined ? undefined : this.d.getBackend(s.fim.backendId);
    if (!backend) {
      this.d.status.set('error', 'No backend configured');
      return [];
    }
    const id = backend.config.id;
    if (s.privacy.localOnly && !(await this.d.isLocal(backend.config.baseUrl))) {
      this.d.status.set('error', 'Blocked: backend is not local');
      this.once(`local:${id}:${backend.config.baseUrl}`, () => this.d.log.warn(`blocked: backend "${id}" (${backend.config.baseUrl}) is not local and privacy.localOnly is on`));
      return [];
    }
    const backoff = this.d.backoff(id);
    if (!backoff.canRequest()) {
      // Refresh the countdown in the error detail.
      const failure = this.failing.get(id);
      if (failure !== undefined) this.requests.report({ state: 'error', detail: withRetry(failure, backoff) });
      return [];
    }

    const win = buildFimWindow(doc.getText(), doc.offsetAt(pos), { prefixLines: s.fim.prefixLines, suffixLines: s.fim.suffixLines, ...DEFAULT_WINDOW });
    const uri = doc.uri.toString();
    const spot: Spot = { doc, pos, lineSuffix, backendId: id };
    // A manual trigger (Alt+\) asks for a fresh suggestion, e.g. after an empty one was cached; its result is still cached.
    const cached = invoked ? undefined : this.d.cache.find(uri, win.prefix, win.suffix);
    if (cached !== undefined) return this.items(cached, spot);

    const join = this.d.inflight.find(uri, win.prefix, win.suffix);
    if (join) {
      // The owner of the flight reports its errors; a cancelled or failed flight is a silent no-op here.
      const finished = await join.result.then((t) => t !== undefined, () => false);
      if (!finished || signal.aborted) return [];
      // The finished flight is cached under its own prefix, so the cache derives what is left after the text typed since.
      const hit = this.d.cache.find(uri, win.prefix, win.suffix);
      if (hit !== undefined) return this.items(hit, spot);
      // The suggestion does not continue what was typed since: request a fresh one.
    }

    const debouncer = this.d.debouncer(id);
    if (!(await debouncer.wait(signal))) return [];

    const model = await this.model(backend, signal);
    if (signal.aborted) return [];
    const preset = resolvePreset(model ?? '', s.modelOverrides);
    const route = planRoute(backend.config.kind, backend.supportsNativeFim(), preset, backend.config.fimMode);
    if (route === 'unsupported') {
      // Only a detected model id is remembered, so an undetected one is probed again on the next request.
      const why = explainUnsupported(id, model);
      this.once(why.onceKey, () => this.d.log.warn(why.log));
      if (why.status) this.requests.report({ state: 'error', detail: why.status });
      return [];
    }

    const filePath = vscode.workspace.asRelativePath(doc.uri, false);
    const extra = s.fim.extraContext ? this.d.ring.pick({ path: filePath, startLine: win.startLine, endLine: win.endLine }, EXTRA_CONTEXT_CHARS) : [];
    const multiline = shouldCompleteMultiline(s.fim.multiline, linePrefix, lineSuffix, doc.languageId);
    // Not linked to the VS Code token: a newer keystroke may join this request. It is aborted by a newer request for this uri.
    const ctl = new AbortController();
    const req = buildFimRequest({
      route,
      preset,
      model,
      multiline,
      maxTokens: s.fim.maxTokens,
      signal: ctl.signal,
      input: { prefix: win.prefix, suffix: win.suffix, filePath, repoName: vscode.workspace.getWorkspaceFolder(doc.uri)?.name ?? '', extra },
    });
    const post: PostCtx = { linePrefix, lineSuffix, prevLine: pos.line > 0 ? doc.lineAt(pos.line - 1).text : '', suffix: win.suffix };
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

    this.d.inflight.abortAll(uri);
    const result = this.run({ backend, backoff, debouncer, req, ctl, uri, prefix: win.prefix, suffix: win.suffix, stop: preset.stop, multiline, post, eol, logPrompts: s.debug.logPrompts });
    this.d.inflight.add(uri, win.prefix, win.suffix, result, ctl);
    const text = await result;
    return text === undefined || signal.aborted ? [] : this.items(text, spot);
  }

  /** Sends one request and records its result. Never rejects: resolves the insert text ('' = nothing), or undefined when cancelled or failed. */
  private async run(j: Job): Promise<string | undefined> {
    const id = j.backend.config.id;
    let outcome: Outcome | undefined;
    const started = Date.now();
    try {
      this.requests.begin();
      // Client-side stops use the full preset list; backends may cap the list they send (ruling R2).
      const acc = new CompletionAccumulator({ stop: j.stop, multiline: j.multiline, maxLines: MAX_LINES, suffix: j.suffix });
      let stoppedEarly = false;
      for await (const chunk of j.backend.streamFim(j.req)) {
        if (acc.push(chunk)) {
          stoppedEarly = true;
          break;
        }
      }
      if (stoppedEarly) j.ctl.abort();
      const ms = Date.now() - started;
      const completion = postprocess(acc.text, j.post);
      const text = completion === undefined ? '' : planInsertion(completion, j.eol);
      this.d.cache.add(j.uri, j.prefix, j.suffix, text);
      j.debouncer.recordLatency(ms);
      j.backoff.recordSuccess();
      if (this.failing.delete(id)) this.d.log.info(`backend "${id}" is responding again`);
      this.d.log.debug(
        `fim ${id} ${j.req.payload.route} model=${j.req.model ?? '?'} prefix=${j.prefix.length} suffix=${j.suffix.length} ` +
          `→ ${text.length} chars in ${ms} ms${stoppedEarly ? ' (stopped early)' : ''}`,
      );
      if (j.logPrompts) {
        this.d.log.debug(`fim prompt: ${JSON.stringify(j.req.payload)}`);
        this.d.log.debug(`fim completion: raw ${JSON.stringify(acc.text)} → shown ${JSON.stringify(text)}`);
      }
      outcome = { state: 'idle' };
      return text;
    } catch (err) {
      outcome = this.failed(err, j);
      return undefined;
    } finally {
      this.requests.end(outcome);
    }
  }

  private failed(err: unknown, j: Job): Outcome | undefined {
    // Our own controller is only aborted by a newer request or an early stop: that is a cancel, never a failure.
    const cls: ErrorClass = j.ctl.signal.aborted ? { kind: 'abort' } : classifyError(err);
    if (cls.kind === 'abort') return undefined;
    const id = j.backend.config.id;
    if (err instanceof MissingApiKeyError) {
      this.once(`key:${id}`, () => this.d.log.warn(`backend "${id}" has no API key; run "AI Autocomplete: Set API Key"`));
      return { state: 'error', detail: `Set API key for ${id}` };
    }
    const { detail, warn } = recordBackendFailure(j.backoff, id, err, cls, j.logPrompts);
    if (warn) this.d.log.warn(warn);
    else this.d.log.debug(detail);
    // Error messages can quote server output, so the raw one is logged only with logPrompts.
    if (j.logPrompts && err instanceof Error) this.d.log.debug(`${id}: raw error: ${err.message}`);
    this.failing.set(id, detail);
    this.models.delete(j.backend); // the server may have restarted with another model
    return { state: 'error', detail: withRetry(detail, j.backoff) };
  }

  /** Model id from settings, else detected once per backend instance (only a detected id is remembered). */
  private async model(backend: FimBackend, signal: AbortSignal): Promise<string | undefined> {
    if (backend.config.fimModel) return backend.config.fimModel;
    const known = this.models.get(backend);
    if (known !== undefined) return known;
    const detected = await backend.detectModel(signal);
    if (detected !== undefined && !signal.aborted) {
      this.models.set(backend, detected);
      this.d.log.info(`backend "${backend.config.id}": detected model ${detected}`);
    }
    return detected;
  }

  private items(text: string, at: Spot): vscode.InlineCompletionItem[] {
    if (text === '') return [];
    const { insertText, replaceToEndOfLine } = toInsertion(text, at.lineSuffix);
    const end = replaceToEndOfLine ? at.doc.lineAt(at.pos.line).range.end : at.pos;
    return [new vscode.InlineCompletionItem(insertText, new vscode.Range(at.pos, end), { command: 'aiAutocomplete.accepted', title: '', arguments: [at.backendId] })];
  }

  private once(key: string, log: () => void): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    log();
  }
}
