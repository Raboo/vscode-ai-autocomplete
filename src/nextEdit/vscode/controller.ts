import * as vscode from 'vscode';
import type { ErrorBackoff } from '../../backends/backoff';
import { classifyError } from '../../backends/http';
import { inferHostFlavor } from '../../backends/hostFlavor';
import { MissingApiKeyError } from '../../backends/mistral';
import type { ChatMessage, FimBackend } from '../../backends/types';
import { docPath, inProject } from '../../completion/contextTracker';
import { nextEditModel, resolveNextEdit } from '../../completion/effective';
import { describeFailure, recordBackendFailure } from '../../completion/requestStatus';
import { EFFORT_NONE_REJECTED, thinkingBlocked } from '../../completion/route';
import { ThinkingError } from '../../completion/stream';
import type { Settings } from '../../config/settings';
import type { Log } from '../../log';
import type { Capabilities } from '../../models/capabilities';
import type { ContextFile } from '../../types';
import { decorationPlan, displayFor } from '../decorations';
import { classify, editShow, toItemText, type LineEdit, type Pos } from '../diff';
import { formatRoute, pickFormat } from '../formats';
import type { NextEditFormat, NextEditInput } from '../formats/format';
import { EditHistory, recentEditsFile, type RecentSnippets } from '../history';
import { rebaseEdit } from '../rebase';
import { nextEditBudgets, type LineSpan } from '../region';
import { runNextEdit, type NextEditResult } from '../request';
import { CHAIN_DELAY_MS, EDIT_PAUSE_MS, HISTORY_IDLE_MS, keepRequestWhileTyping, TriggerPolicy } from '../trigger';
import { EditDecorations } from './decorations';

export interface NextEditDeps {
  getSettings(): Settings;
  getBackend(id: string): FimBackend | undefined;
  capabilities: Capabilities;
  backoff(id: string): ErrorBackoff;
  isLocal(baseUrl: string): Promise<boolean>;
  log: Log;
  snoozedUntil(): number;
  snippets: RecentSnippets;
  /** Files completions may not use (completions.disableInFiles, completions.disableInLanguages): no history, snippet or request. */
  isExcluded(doc: vscode.TextDocument): boolean;
  /** The model a backend without a configured one serves. */
  detectedModel(backend: FimBackend, signal: AbortSignal): Promise<string | undefined>;
}

type Timer = ReturnType<typeof setTimeout>;

/** Edit hunks completions get as extra context. */
const RECENT_EDIT_HUNKS = 3;

/** A result with the document text it applies to, so it can be rebased while the user types it. */
type Held = NextEditResult & { text: string };

/** Where the cursor is after a content change that typed `text` over `range` (before VS Code reports the selection). */
function cursorAfter(change: vscode.TextDocumentContentChangeEvent): Pos {
  const { start } = change.range;
  const parts = change.text.split(/\r?\n/);
  const last = parts[parts.length - 1];
  return parts.length === 1 ? { line: start.line, character: start.character + last.length } : { line: start.line + parts.length - 1, character: last.length };
}

const samePos = (a: { line: number; character: number }, b: { line: number; character: number }): boolean => a.line === b.line && a.character === b.character;

/**
 * Decides when to ask for a Next Edit, sends at most one request per document version and holds the latest result
 * for the inline completion provider. Also records the edit history of the documents Next Edit may read.
 */
export class NextEditController implements vscode.Disposable {
  /** VS Code's inline-edit UI is available (set from the registration probe). */
  native = false;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly policy = new TriggerPolicy();
  private readonly history = new EditHistory();
  private readonly models = new WeakMap<FimBackend, string>();
  /** `region` is set once the request's input is built: typing inside it keeps the request running (see changed()). */
  private readonly inflight = new Map<string, { version: number; ctl: AbortController; region?: LineSpan }>();
  private result: Held | undefined;
  /** An inline edit shown as decorations, waiting for Tab or Esc. Never returned by itemFor(). */
  private pending: Held | undefined;
  private readonly decorations = new EditDecorations();
  /** The version and cursor line each document was last asked about, so a repeated trigger does not ask again. */
  private readonly asked = new Map<string, { version: number; line: number }>();
  /** The version and time of each document's last edit (not undo/redo) in the active editor. */
  private readonly lastChange = new Map<string, { version: number; at: number }>();
  private readonly selectionVersions = new Map<string, number>();
  /** The document version whose region was last logged as not sendable, so the log line comes once per version. */
  private readonly skipped = new Map<string, number>();
  private readonly pauseTimers = new Map<string, Timer>();
  private readonly chainTimers = new Map<string, Timer>();
  private readonly idleTimers = new Map<string, { timer: Timer; doc: vscode.TextDocument }>();
  private readonly logged = new Set<string>();
  private readonly notified = new Set<string>();

  constructor(private readonly d: NextEditDeps) {
    for (const doc of vscode.workspace.textDocuments) this.opened(doc);
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.opened(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.closed(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.changed(e)),
      vscode.window.onDidChangeTextEditorSelection((e) => this.selectionChanged(e)),
      vscode.window.onDidChangeActiveTextEditor((e) => {
        this.clearPending();
        if (e) this.selectionVersions.set(e.document.uri.toString(), e.document.version);
      }),
      this.decorations,
    );
  }

  /** The result to show at `pos`: a ghost text only at the cursor it was computed for, an inline edit only with the native UI; nothing while snoozed. */
  itemFor(doc: vscode.TextDocument, pos: vscode.Position): NextEditResult | undefined {
    const r = this.result;
    if (!r || r.uri !== doc.uri.toString() || r.version !== doc.version || this.d.snoozedUntil() > Date.now()) return undefined;
    if (r.show.kind === 'ghost') return samePos(pos, r.cursor) ? r : undefined;
    return this.native ? r : undefined;
  }

  /** FIM's outcome for a document version. FIM wins: only an empty one lets Next Edit ask, after the edit pause. */
  fimResult(uri: string, version: number, shown: boolean): void {
    if (shown || this.chainTimers.has(uri)) return;
    // Only FIM's first answer for the latest edit arms a request: not a repeated one (a cache hit after a cursor move) or one after an undo.
    const change = this.lastChange.get(uri);
    if (change?.version !== version) return;
    this.lastChange.delete(uri);
    this.schedulePause(uri, version, change.at + EDIT_PAUSE_MS - Date.now());
  }

  /**
   * A Next Edit item was accepted; its change event has already run. Asks again shortly, so repeated Tabs walk through a change.
   * The chain skips the same-line cooldown, not the rejection cooldown or the gate.
   */
  accepted(): void {
    this.result = undefined;
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || !this.eligible(doc)) return;
    const uri = doc.uri.toString();
    this.flush(doc);
    this.clearTimer(this.pauseTimers, uri);
    this.clearTimer(this.chainTimers, uri);
    this.chainTimers.set(
      uri,
      setTimeout(() => {
        this.chainTimers.delete(uri);
        const current = vscode.window.activeTextEditor?.document;
        if (current?.uri.toString() === uri && this.policy.afterPause(Date.now())) this.trigger(current);
      }, CHAIN_DELAY_MS),
    );
  }

  rejected(): void {
    this.policy.rejected(Date.now());
    this.result = undefined;
  }

  /** The inline edit shown as decorations, for tests. */
  pendingEdit(): { uri: string; version: number; edit: LineEdit } | undefined {
    const p = this.pending;
    return p && { uri: p.uri, version: p.version, edit: p.edit };
  }

  /**
   * Tab on a pending decoration: jumps to the edit when the cursor is away from it, otherwise applies it. A pending edit
   * for another document or version, or one while snoozed, is cleared instead.
   */
  async nextEditTab(): Promise<void> {
    const p = this.pending;
    const editor = vscode.window.activeTextEditor;
    const doc = editor?.document;
    if (!p || !editor || !doc || doc.uri.toString() !== p.uri || doc.version !== p.version || this.d.snoozedUntil() > Date.now() || p.show.kind !== 'edit') {
      this.clearPending();
      return;
    }
    // The version matches the result's, so the document's lines are the ones the edit was computed on.
    const lines = doc.getText().split(/\r?\n/);
    const plan = decorationPlan(p.edit, lines, editor.selection.active);
    if (plan.jump) {
      const target = new vscode.Position(plan.target.line, plan.target.character);
      editor.selection = new vscode.Selection(target, target);
      editor.revealRange(new vscode.Range(target, target), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      this.decorations.show(editor, decorationPlan(p.edit, lines, plan.target));
      return;
    }
    const { start, end, text } = p.show;
    const range = new vscode.Range(start.line, start.character, end.line, end.character);
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    // Cleared first, so the edit's own change event finds nothing to clear.
    this.clearPending();
    const applied = await editor.edit((b) => b.replace(range, toItemText(text, eol)), { undoStopBefore: true, undoStopAfter: true });
    // False when the document changed after the check above: nothing was applied.
    if (!applied) return;
    const { startLine, newLines } = p.edit;
    const last = newLines.length - 1;
    const at = last < 0 ? new vscode.Position(start.line, start.character) : new vscode.Position(startLine + last, newLines[last].length);
    const cursor = editor.document.validatePosition(at);
    editor.selection = new vscode.Selection(cursor, cursor);
    this.accepted();
  }

  /** Esc on a pending decoration: a rejection. An Esc with nothing pending (a stale context key) rejects nothing. */
  nextEditDismiss(): void {
    if (!this.pending) return;
    this.clearPending();
    this.rejected();
  }

  /** A snooze started: a pending decoration goes, so Tab and Esc are the editor's again. */
  snoozed(): void {
    this.clearPending();
  }

  private clearPending(): void {
    if (!this.pending) return;
    this.pending = undefined;
    this.decorations.clear();
  }

  /** Forgets everything planned or recorded under the old settings; a newly excluded file must not keep diffs that would be sent. */
  reset(): void {
    this.clear();
    this.logged.clear();
    for (const doc of vscode.workspace.textDocuments) this.opened(doc);
  }

  dispose(): void {
    this.clear();
    for (const d of this.disposables) d.dispose();
  }

  private clear(): void {
    for (const f of this.inflight.values()) f.ctl.abort();
    this.inflight.clear();
    this.result = undefined;
    this.clearPending();
    for (const t of [...this.pauseTimers.values(), ...this.chainTimers.values()]) clearTimeout(t);
    for (const { timer } of this.idleTimers.values()) clearTimeout(timer);
    this.pauseTimers.clear();
    this.chainTimers.clear();
    this.idleTimers.clear();
    this.asked.clear();
    this.lastChange.clear();
    this.skipped.clear();
    this.history.clear();
    this.d.snippets.clear();
  }

  /**
   * The last edit hunks across workspace files as one extra-context entry for completions, within `maxChars`. `undefined` while
   * Next Edit is off (no history is kept then). The history only holds files completions may use (see eligible()).
   */
  recentEdits(maxChars: number): ContextFile | undefined {
    return this.tracking() ? recentEditsFile(this.history.entries(), RECENT_EDIT_HUNKS, maxChars) : undefined;
  }

  /** Next Edit is on: only then are snapshots, history and idle timers kept (reset() re-snapshots when it is turned on). */
  private tracking(): boolean {
    const { enabled, nextEdit } = this.d.getSettings();
    return enabled && nextEdit.enabled && nextEdit.backendId !== undefined;
  }

  /** Workspace files and unsaved files that completions may use, as for extra context. */
  private eligible(doc: vscode.TextDocument): boolean {
    return inProject(doc.uri) && !this.d.isExcluded(doc);
  }

  private path(doc: vscode.TextDocument): string {
    return docPath(doc.uri);
  }

  private opened(doc: vscode.TextDocument): void {
    if (!this.tracking()) return;
    if (!this.eligible(doc)) {
      // A document reopened in a disabled language (a language change closes and reopens it) must not keep diffs or a snippet that would be sent.
      const path = this.path(doc);
      this.history.forget(path);
      this.d.snippets.forget(path);
      return;
    }
    this.history.open(this.path(doc), doc.getText());
    this.selectionVersions.set(doc.uri.toString(), doc.version);
  }

  private closed(doc: vscode.TextDocument): void {
    const uri = doc.uri.toString();
    this.cancel(uri);
    this.policy.closed(uri);
    const idle = this.idleTimers.get(uri);
    if (idle) clearTimeout(idle.timer);
    this.idleTimers.delete(uri);
    this.asked.delete(uri);
    this.lastChange.delete(uri);
    this.selectionVersions.delete(uri);
    this.skipped.delete(uri);
    this.history.close(this.path(doc));
  }

  private changed(e: vscode.TextDocumentChangeEvent): void {
    const doc = e.document;
    // First, and silently: the log is a document too, so logging about its changes would loop.
    if (e.contentChanges.length === 0) return;
    const uri = doc.uri.toString();
    const active = this.tracking() && this.eligible(doc);
    // The user typing a pending edit or a held result keeps the rest of it; any other change to its document, an undo
    // included, leaves it pointing at shifted lines.
    const typing = active ? this.typing(e) : undefined;
    if (this.pending?.uri === uri) {
      const p = typing && this.rebased(this.pending, doc, typing.cursor);
      const editor = vscode.window.activeTextEditor;
      if (p && editor) {
        const lines = p.text.split(/\r?\n/);
        // Decorations show an inline edit, also when the rest has become an insertion at the cursor.
        this.pending = { ...p, show: editShow(p.edit, lines) };
        this.decorations.show(editor, decorationPlan(p.edit, lines, typing.cursor));
      } else {
        this.clearPending();
      }
    }
    const kept = typing && this.result?.uri === uri ? this.rebased(this.result, doc, typing.cursor) : undefined;
    if (!active) return;
    this.cancel(uri, typing !== undefined && this.inRegion(uri, typing.change) && this.keepsWhileTyping());
    if (kept) this.result = kept;
    this.restartIdle(doc);
    const reason = e.reason;
    if (reason === vscode.TextDocumentChangeReason.Undo || reason === vscode.TextDocumentChangeReason.Redo) return;
    if (vscode.window.activeTextEditor?.document !== doc) return;
    const now = Date.now();
    this.policy.edited(uri, now);
    this.lastChange.set(uri, { version: doc.version, at: now });
    // A language or file FIM is disabled in is not eligible here, so only these settings leave FIM inactive for the document.
    const s = this.d.getSettings();
    if (!s.enabled || !s.fim.enabled || s.fim.backendId === undefined) this.schedulePause(uri, doc.version, EDIT_PAUSE_MS);
  }

  /**
   * The change when it is the user typing in the active editor: one content change, no undo or redo, no snooze. The
   * caller has checked that Next Edit is on and may use the document.
   */
  private typing(e: vscode.TextDocumentChangeEvent): { change: vscode.TextDocumentContentChangeEvent; cursor: Pos } | undefined {
    const doc = e.document;
    const R = vscode.TextDocumentChangeReason;
    if (e.contentChanges.length !== 1 || e.reason === R.Undo || e.reason === R.Redo) return undefined;
    // Not editorFor(): the editor's selection is still the one before this change (a selection typed over is not empty).
    if (this.d.snoozedUntil() > Date.now() || vscode.window.activeTextEditor?.document !== doc) return undefined;
    const change = e.contentChanges[0];
    return { change, cursor: cursorAfter(change) };
  }

  /** `r` rebased onto the document's current text, when the user's edits since are the start of it; undefined when they are not or it is all typed. */
  private rebased(r: Held, doc: vscode.TextDocument, cursor: Pos): Held | undefined {
    const text = doc.getText();
    const edit = rebaseEdit(r.edit, r.text, text);
    if (edit === undefined || edit === 'done') return undefined;
    return { uri: r.uri, version: doc.version, cursor, edit, show: classify(edit, text.split(/\r?\n/), cursor), text };
  }

  /** Whether a change lies inside the lines the document's running request rewrites, so its answer may still be typed along. */
  private inRegion(uri: string, change: vscode.TextDocumentContentChangeEvent): boolean {
    const region = this.inflight.get(uri)?.region;
    return region !== undefined && change.range.start.line >= region.start && change.range.end.line <= region.end;
  }

  /** Whether the running request may outlive a keystroke without holding up completions (see keepRequestWhileTyping). */
  private keepsWhileTyping(): boolean {
    const s = this.d.getSettings();
    const id = s.nextEdit.backendId;
    if (id === undefined) return false;
    const backend = this.d.getBackend(id);
    return keepRequestWhileTyping({
      nextEditBackendId: id,
      completionsBackendId: s.fim.backendId,
      completionsActive: s.enabled && s.fim.enabled,
      kind: backend?.config.kind,
      slots: backend?.slotCount?.(),
    });
  }

  private selectionChanged(e: vscode.TextEditorSelectionChangeEvent): void {
    const doc = e.textEditor.document;
    if (!this.tracking() || !this.eligible(doc)) return;
    const uri = doc.uri.toString();
    // A ghost text belongs to the cursor it was computed for; kept after a move, it would block a request at the new one.
    const r = this.result;
    if (r?.uri === uri && r.show.kind === 'ghost' && !samePos(e.selections[0].active, r.cursor)) this.result = undefined;
    const seen = this.selectionVersions.get(uri);
    this.selectionVersions.set(uri, doc.version);
    // Typing moves the cursor too: a selection event in a new version was caused by an edit.
    if (seen !== doc.version) return;
    const K = vscode.TextEditorSelectionChangeKind;
    if (e.kind !== K.Keyboard && e.kind !== K.Mouse && e.kind !== K.Command) return;
    if (this.policy.onCursorMove(uri, e.selections[0].active.line, Date.now())) this.trigger(doc);
  }

  /**
   * Aborts the document's request and drops its result, pending pause and pending chain: they belong to an older version.
   * accepted() runs after the accept's own change event, so a chain is only cancelled by a later change. With `keepRequest`
   * (the user typing inside the request's region) the request runs on and its answer is rebased when it comes.
   */
  private cancel(uri: string, keepRequest = false): void {
    if (!keepRequest) {
      this.inflight.get(uri)?.ctl.abort();
      this.inflight.delete(uri);
    }
    if (this.result?.uri === uri) this.result = undefined;
    this.clearTimer(this.pauseTimers, uri);
    this.clearTimer(this.chainTimers, uri);
  }

  private restartIdle(doc: vscode.TextDocument): void {
    const uri = doc.uri.toString();
    const idle = this.idleTimers.get(uri);
    if (idle) clearTimeout(idle.timer);
    this.idleTimers.set(uri, { doc, timer: setTimeout(() => this.flush(doc), HISTORY_IDLE_MS) });
  }

  /** Commits the document's edits to the history now. */
  private flush(doc: vscode.TextDocument): void {
    const uri = doc.uri.toString();
    const idle = this.idleTimers.get(uri);
    if (idle) clearTimeout(idle.timer);
    this.idleTimers.delete(uri);
    if (!this.tracking()) return;
    // The current size, set just before this commit so it applies to it; 0 keeps no history.
    this.history.maxEntries = this.d.getSettings().nextEdit.historySize;
    this.history.commit(this.path(doc), doc.getText());
  }

  private schedulePause(uri: string, version: number, delayMs: number): void {
    this.clearTimer(this.pauseTimers, uri);
    const timer = setTimeout(() => {
      this.pauseTimers.delete(uri);
      const doc = vscode.window.activeTextEditor?.document;
      if (doc?.uri.toString() !== uri || doc.version !== version || !this.policy.afterPause(Date.now())) return;
      this.trigger(doc);
    }, Math.max(0, delayMs));
    this.pauseTimers.set(uri, timer);
  }

  private clearTimer(timers: Map<string, Timer>, uri: string): void {
    const t = timers.get(uri);
    if (t !== undefined) clearTimeout(t);
    timers.delete(uri);
  }

  private trigger(doc: vscode.TextDocument): void {
    this.request(doc).catch((err: unknown) => this.d.log.error('next edit failed', err));
  }

  /** The active editor when it shows `doc` with one empty selection. */
  private editorFor(doc: vscode.TextDocument): vscode.TextEditor | undefined {
    const e = vscode.window.activeTextEditor;
    return e?.document === doc && e.selections.length === 1 && e.selection.isEmpty ? e : undefined;
  }

  /** Sends one request when every check passes; never more than one per document version and cursor line. */
  private async request(doc: vscode.TextDocument): Promise<void> {
    const s = this.d.getSettings();
    const uri = doc.uri.toString();
    const version = doc.version;
    if (this.inflight.get(uri)?.version === version) return;
    const editor = this.editorFor(doc);
    if (!editor) return;
    // A result that can still be shown here stays; one for another cursor is replaced. A pending decoration stays too:
    // moving the cursor towards it must not replace it.
    if (this.itemFor(doc, editor.selection.active)) return;
    if (this.pending?.uri === uri && this.pending.version === version) return;
    const asked = this.asked.get(uri);
    if (asked?.version === version && asked.line === editor.selection.active.line) return;
    if (!s.enabled || !s.nextEdit.enabled || s.nextEdit.backendId === undefined || this.d.snoozedUntil() > Date.now() || !this.eligible(doc)) return;
    const backend = this.d.getBackend(s.nextEdit.backendId);
    if (!backend) return;
    const id = backend.config.id;
    const backoff = this.d.backoff(id);
    if (!backoff.canRequest()) return;

    // Registered before the first await, so a change aborts it.
    const ctl = new AbortController();
    this.inflight.get(uri)?.ctl.abort();
    this.inflight.set(uri, { version, ctl });
    let model: string | undefined;
    const flavor = inferHostFlavor(backend.config);
    try {
      if (s.privacy.localOnly && !(await this.d.isLocal(backend.config.baseUrl))) {
        this.once(`local:${id}:${backend.config.baseUrl}`, () => this.d.log.warn(`next edit blocked: backend "${id}" (${backend.config.baseUrl}) is not local and privacy.localOnly is on`));
        return;
      }
      model = await this.model(backend, ctl.signal);
      if (ctl.signal.aborted || this.d.getSettings() !== s) return;
      if (model === undefined && flavor === 'openrouter') {
        // OpenRouter would pick the payer's default model, so code would go to a model the user never chose.
        this.once(`model:${id}`, () => this.d.log.warn(`next edit: backend "${id}": OpenRouter needs a model: choose one in AI Autocomplete: Manage Backends`));
        return;
      }
      const format = pickFormat(s.nextEdit.format, model);
      if (!this.routeFor(backend, format)) return;
      const values = resolveNextEdit(backend.config, model, s);
      const learned = this.d.capabilities.get(id, model);
      // Thinking is a chat-route matter: a raw completion has no reasoning channel.
      const blocked = format.transport === 'chat' ? thinkingBlocked(values.thinking, flavor, learned) : undefined;
      if (blocked) {
        const why = blocked === 'cannotDisable' ? 'cannot turn thinking off' : 'keeps thinking';
        this.once(`thinking:${blocked}:${id}:${model ?? ''}`, () => this.d.log.info(`next edit: backend "${id}": ${model ?? 'the model'} ${why}; no Next Edit requests to it`));
        return;
      }
      // The cursor may have moved while the checks above awaited.
      const at = this.editorFor(doc)?.selection.active;
      if (!at) return;
      const text = doc.getText();
      const lines = text.split(/\r?\n/);
      const path = this.path(doc);
      const budgets = nextEditBudgets(s.nextEdit.contextBudget);
      const base: NextEditInput = {
        path,
        lines,
        cursor: { line: at.line, character: at.character },
        region: format.region(at.line, lines.length, { above: s.nextEdit.regionLinesAbove, below: s.nextEdit.regionLinesBelow }),
        history: [],
        snippets: [],
        budgets,
      };
      // Checked before the history is flushed, so a region that cannot be sent leaves the pending edits uncommitted.
      if (this.notSendable(format, base, uri, version)) return;

      for (const { doc: pending } of [...this.idleTimers.values()]) this.flush(pending);
      this.flush(doc);
      // Other files' diffs and snippets go out only with extra context, as for FIM. `previous` is always the current file's.
      const extra = values.extraContext;
      const previous = this.history.previous(path);
      const input: NextEditInput = {
        ...base,
        history: this.history.entries(extra ? undefined : (p) => p === path),
        snippets: extra ? this.d.snippets.pick(path, budgets.snippetsChars) : [],
        ...(previous ? { previous } : {}),
      };
      // Again on what is sent: `previous` (Sweep's original window) is known only after the flush.
      if (this.notSendable(format, input, uri, version)) return;
      const flight = this.inflight.get(uri);
      if (flight?.ctl === ctl) flight.region = input.region;
      const started = Date.now();
      this.policy.requested(uri, at.line, started);
      this.asked.set(uri, { version, line: at.line });
      const log = this.d.log;
      const fresh = await runNextEdit({
        backend,
        values,
        flavor,
        model,
        format,
        snapshot: { uri, version, input },
        rejected: learned.rejected,
        signal: ctl.signal,
        onRejected: (fields) => this.rejectedFields(id, model, fields),
        onTruncated: () => log.debug('next edit: answer cut at max_tokens'),
        ...(s.debug.logPrompts
          ? { onPrompt: (m: ChatMessage[] | string) => log.debug(`next edit prompt: ${JSON.stringify(m)}`), onAnswer: (a: string) => log.debug(`next edit answer: ${JSON.stringify(a)}`) }
          : {}),
      });
      backoff.recordSuccess();
      log.debug(
        `next edit ${id} model=${model ?? '?'} format=${format.id} lines=${lines.length} history=${input.history.length} snippets=${input.snippets.length} ` +
          `→ ${fresh ? fresh.show.kind : 'no edit'} in ${Date.now() - started} ms`,
      );
      if (!fresh || ctl.signal.aborted) return;
      if (vscode.window.activeTextEditor?.document !== doc) {
        log.debug('next edit: result dropped, the editor changed');
        return;
      }
      if (this.d.snoozedUntil() > Date.now()) {
        log.debug('next edit: result dropped, snoozed');
        return;
      }
      const cursor = this.editorFor(doc)?.selection.active;
      // The user typed while the request ran: kept only when what they typed is the start of the suggestion.
      const result = doc.version === version ? { ...fresh, text } : cursor && this.rebased({ ...fresh, text }, doc, { line: cursor.line, character: cursor.character });
      if (!result) {
        log.debug('next edit: result dropped, the document changed');
        return;
      }
      // Stored for another cursor, it would show nothing and the trigger below would make FIM answer at the new cursor.
      if (result.show.kind === 'ghost' && !(cursor && samePos(cursor, result.cursor))) {
        log.debug('next edit: result dropped, the cursor moved');
        return;
      }
      const display = displayFor(result.show, s.nextEdit.display, this.native);
      if (display === 'drop') {
        log.debug("next edit: result dropped, an inline edit needs VS Code's inline-edit UI");
        this.offerNativeUi();
        return;
      }
      this.clearPending();
      if (display === 'decorations') {
        const shown = vscode.window.activeTextEditor;
        if (!shown) return;
        this.result = undefined;
        const current = result.text.split(/\r?\n/);
        this.pending = { ...result, show: editShow(result.edit, current) };
        this.decorations.show(shown, decorationPlan(result.edit, current, shown.selection.active));
        return;
      }
      this.result = result;
      void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    } catch (err) {
      // A newer change, a settings change or dispose aborted it: nothing to record.
      if (ctl.signal.aborted) return;
      this.failed(err, backend, model, s.nextEdit.timeoutMs, s.debug.logPrompts);
    } finally {
      if (this.inflight.get(uri)?.ctl === ctl) this.inflight.delete(uri);
    }
  }

  /** Whether the backend has the route the format is sent on; logs once per backend and format when not. */
  private routeFor(backend: FimBackend, format: NextEditFormat): boolean {
    const { ok, name } = formatRoute(format, backend.routes());
    if (ok) return true;
    const id = backend.config.id;
    this.once(`route:${id}:${format.id}`, () => this.d.log.info(`next edit: backend "${id}" has no ${name} route; the ${format.id} format needs one`));
    return false;
  }

  /** Whether the format cannot send this input; logged once per document version. */
  private notSendable(format: NextEditFormat, input: NextEditInput, uri: string, version: number): boolean {
    const problem = format.problem(input);
    if (!problem) return false;
    if (this.skipped.get(uri) !== version) {
      this.skipped.set(uri, version);
      this.d.log.debug(`next edit: not asked, ${problem}`);
    }
    return true;
  }

  private offeredNative = false;

  private offerNativeUi(): void {
    if (this.offeredNative) return;
    this.offeredNative = true;
    void vscode.window
      .showInformationMessage("Next Edit has a suggestion VS Code can show only with its inline-edit view. Enable it (needs a VS Code restart)?", 'Enable', 'Not now')
      .then((pick) => (pick === 'Enable' ? vscode.commands.executeCommand('aiAutocomplete.enableNativeNextEdit') : undefined))
      .then(undefined, (err: unknown) => this.d.log.debug(`next edit: native UI notice failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private failed(err: unknown, backend: FimBackend, model: string | undefined, timeoutMs: number, logPrompts: boolean): void {
    const id = backend.config.id;
    if (err instanceof ThinkingError) {
      // Configuration, not a backend failure: the gate stops the next request, so no backoff.
      this.d.capabilities.sawThinking(id, model);
      this.d.log.debug(`next edit ${id}: ${model ?? 'the model'} reasoned with thinking off`);
      this.notifyOnce(`thinking:${id}`, `AI Autocomplete: Next Edit stopped for "${id}": ${model ?? 'the model'} keeps thinking.`);
      return;
    }
    const cls = classifyError(err);
    if (cls.kind === 'abort') return;
    this.models.delete(backend); // the server may have restarted with another model
    if (err instanceof MissingApiKeyError) {
      // Configuration too, and FIM does not back off for it either.
      this.once(`key:${id}`, () => this.d.log.warn(`backend "${id}" has no API key; run "AI Autocomplete: Set API Key"`));
      this.notifyOnce(`error:${id}:key`, `AI Autocomplete: Next Edit request to "${id}" failed (no API key).`);
      return;
    }
    const { detail, warn } = recordBackendFailure(this.d.backoff(id), id, err, cls, logPrompts, timeoutMs);
    if (warn) this.d.log.warn(`next edit: ${warn}`);
    else this.d.log.debug(`next edit: ${detail}`);
    // Error messages can quote server output, so the raw one is logged only with logPrompts.
    if (logPrompts && err instanceof Error) this.d.log.debug(`next edit ${id}: raw error: ${err.message}`);
    // One notification per backend and error kind (HTTP, network, timeout); the text names this occurrence.
    const kind = (err as { name?: unknown } | null)?.name === 'TimeoutError' ? 'timeout' : cls.kind;
    this.notifyOnce(`error:${id}:${kind}`, `AI Autocomplete: Next Edit request to "${id}" failed (${describeFailure(err, cls, timeoutMs)}).`);
  }

  private rejectedFields(id: string, model: string | undefined, fields: string[]): void {
    const added = this.d.capabilities.reject(id, model, fields);
    const m = model ?? 'the model';
    if (added.includes(EFFORT_NONE_REJECTED)) this.d.log.info(`backend "${id}": ${m} must reason (the server rejected reasoning effort "none"); Next Edit is off for it`);
    const dropped = added.filter((f) => f !== EFFORT_NONE_REJECTED);
    if (dropped.length > 0) this.d.log.info(`backend "${id}": the server rejected ${dropped.join(', ')} for ${m}; sending without them`);
  }

  /** The configured Next Edit model, else the detected one (remembered per backend instance once found). */
  private async model(backend: FimBackend, signal: AbortSignal): Promise<string | undefined> {
    const cfg = backend.config;
    if (cfg.nextEditModel !== undefined || (cfg.use.completions && cfg.fimModel !== undefined)) return nextEditModel(cfg, undefined);
    let detected = this.models.get(backend);
    if (detected === undefined) {
      detected = await this.d.detectedModel(backend, signal);
      if (detected !== undefined && !signal.aborted) this.models.set(backend, detected);
    }
    return nextEditModel(cfg, detected);
  }

  private notifyOnce(key: string, text: string): void {
    if (this.notified.has(key)) return;
    this.notified.add(key);
    void vscode.window
      .showWarningMessage(text, 'Show Log')
      .then((c) => (c ? vscode.commands.executeCommand('aiAutocomplete.showLog') : undefined))
      .then(undefined, (err: unknown) => this.d.log.debug(`next edit: notification failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private once(key: string, log: () => void): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    log();
  }
}
