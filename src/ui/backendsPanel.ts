import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { createBackend } from '../backends';
import type { ApiKeyProvider } from '../backends/types';
import type { Secrets } from '../config/secrets';
import type { Settings } from '../config/settings';
import type { Log } from '../log';
import { completionServed, explainFailure, runConnectionTest, type ConnectionTestResult } from '../manage/connectionTest';
import { entryToForm, formToConfig, formToEntry, knownChanged, newForm, planRename, removeBackend, retypeForm, upsertBackend, validateForm, type FieldError } from '../manage/form';
import { buildPageState, modelTag, type EditDraft } from '../manage/pageState';
import type { BackendForm, HostMessage, PageMessage, PageState, ServerTypeId, TestStep } from '../manage/protocol';
import { SERVER_TYPES } from '../manage/serverTypes';
import type { BackendConfig } from '../types';
import { useBackend } from './commands';

export interface BackendsPanelDeps {
  context: vscode.ExtensionContext;
  secrets: Secrets;
  log: Log;
  getSettings(): Settings;
  isLocal(baseUrl: string): Promise<boolean>;
  detectedModel(id: string): string | undefined;
  /** A connection test of the in-use backend got a completion from the server. */
  onTestPassed(id: string): void;
}
/** `add` opens a new backend in edit mode; `focus` opens that backend's card in edit mode. */
export interface OpenOptions { add?: boolean; focus?: string }

const VIEW_TYPE = 'aiAutocomplete.backends';
const RELOAD_TIMEOUT_MS = 5000;
const LOCAL_ONLY = 'local only is on in this workspace';
const FIX_FORM = 'fix the errors in the form first';
const URL_REQUIRED: FieldError = { field: 'baseUrl', message: 'URL is required' };
const TYPES: ReadonlySet<string> = new Set(SERVER_TYPES.map((t) => t.id));

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('aiAutocomplete');
/** Backends are machine-scoped: the page reads and writes the user-level value only. */
const userBackends = (): unknown => config().inspect('backends')?.globalValue;
const entriesOf = (raw: unknown): Record<string, unknown>[] => (Array.isArray(raw) ? (raw as unknown[]).filter(isObj) : []);
const idsOf = (raw: unknown): string[] => entriesOf(raw).map((e) => e.id).filter((id): id is string => typeof id === 'string');
const typedKey = (k: unknown): string | undefined => (typeof k === 'string' && k.trim() !== '' ? k.trim() : undefined);

/** A form from a page message, copied field by field; undefined when it is malformed. */
function asForm(v: unknown): BackendForm | undefined {
  if (!isObj(v) || typeof v.type !== 'string' || !TYPES.has(v.type) || typeof v.id !== 'string' || typeof v.baseUrl !== 'string'
    || typeof v.model !== 'string' || !isObj(v.changed)) return undefined;
  return { ...(typeof v.originalId === 'string' ? { originalId: v.originalId } : {}), type: v.type as ServerTypeId, id: v.id, baseUrl: v.baseUrl, model: v.model,
    changed: knownChanged(v.changed) };
}

function pageHtml(w: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const uri = (file: string): string => w.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', file)).toString();
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${w.cspSource} 'nonce-${nonce}'; img-src ${w.cspSource}; font-src ${w.cspSource}`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${uri('backends.css')}">`
    + `<title>Backends</title></head><body><script nonce="${nonce}" src="${uri('backends.js')}"></script></body></html>`;
}

/**
 * The Backends page. The host owns all state, including the unsaved draft; the page posts intents and gets a full state
 * back after each. Page messages are handled one at a time; connection tests and model reloads run beside that queue.
 */
export class BackendsPanel implements vscode.Disposable {
  private static instance: BackendsPanel | undefined;
  private readonly subs: vscode.Disposable[] = [];
  /** Last connection test per backend id, for this session only. */
  private readonly tests = new Map<string, TestStep[]>();
  /** Models detected by this page's tests, per backend id. */
  private readonly detected = new Map<string, string>();
  /** Running tests ('card:<id>', 'draft') and model reloads ('models'). */
  private readonly running = new Map<string, AbortController>();
  private draft: EditDraft | undefined;
  /** Changes whenever a draft opens or closes; a test or reload attaches its result only to the draft it started on. */
  private serial = 0;
  /** Errors only the host can find (an id used by a hand-written entry, a missing URL); cleared by the next edit. */
  private hostErrors: FieldError[] = [];
  private queue: Promise<void> = Promise.resolve();
  private posts: Promise<void> = Promise.resolve();
  private pendingPost: Promise<void> | undefined;
  private last: PageState | undefined;
  private disposed = false;

  /** One panel at a time: a second call reveals it and applies `o`. */
  static show(d: BackendsPanelDeps, o: OpenOptions = {}): BackendsPanel {
    let p = BackendsPanel.instance;
    if (p) p.panel.reveal();
    else {
      const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'AI Autocomplete: Backends', vscode.ViewColumn.Active, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(d.context.extensionUri, 'dist', 'webview')],
      });
      p = BackendsPanel.instance = new BackendsPanel(panel, d);
    }
    const shown = p;
    if (o.add || o.focus !== undefined) void shown.enqueue(() => shown.open(o));
    return shown;
  }

  static current(): BackendsPanel | undefined {
    return BackendsPanel.instance;
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly d: BackendsPanelDeps) {
    panel.webview.html = pageHtml(panel.webview, d.context.extensionUri);
    this.subs.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: unknown) => {
        if (isObj(m) && typeof m.type === 'string' && (m.id === undefined || typeof m.id === 'string')) void this.handle(m as PageMessage);
      }),
      // A card being edited keeps its draft; Save merges onto a fresh read.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('aiAutocomplete')) void this.post();
      }),
      d.secrets.onDidChange(() => void this.post()),
    );
  }

  /** Handles one page message after the ones before it, then posts the state. */
  handle(msg: PageMessage): Promise<void> {
    return this.enqueue(() => this.process(msg));
  }

  /** The last state posted to the page. */
  lastState(): PageState | undefined {
    return this.last;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (BackendsPanel.instance === this) BackendsPanel.instance = undefined;
    // A cancelled test must not come back as a stale failure.
    for (const ctl of this.running.values()) ctl.abort();
    this.running.clear();
    for (const s of this.subs) s.dispose();
    this.panel.dispose();
  }

  private enqueue(fn: () => unknown): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.disposed) return;
      try {
        await fn();
      } catch (err) {
        this.d.log.error('backends page: action failed', err);
        void vscode.window.showErrorMessage('AI Autocomplete: the Backends page could not finish that action; see the log.');
      }
      await this.post();
    });
    this.queue = run;
    return run;
  }

  private async process(m: PageMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        return;
      case 'add':
        return this.open({ add: true });
      case 'edit':
        return this.open({ focus: m.id });
      case 'cancel':
        return this.setDraft(undefined);
      case 'formChanged':
        return this.formChanged(m.form);
      case 'save':
        return this.save(m.form, typedKey(m.apiKey));
      case 'remove':
        return this.remove(m.id);
      case 'use':
        if (this.d.getSettings().backends.some((b) => b.id === m.id)) await useBackend(m.id);
        return;
      case 'test':
        return this.testCard(m.id);
      case 'testForm':
        return this.testForm(m.form, typedKey(m.apiKey));
      case 'reloadModels':
        return this.reloadModels(m.form, typedKey(m.apiKey));
      case 'removeKey':
        return this.removeKey(m.id);
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:raboo.ai-autocomplete');
        return;
    }
  }

  private open(o: OpenOptions): void {
    const raw = userBackends();
    if (o.add) return this.setDraft({ cardId: null, form: newForm('llamacpp', idsOf(raw)), testing: false });
    if (o.focus === undefined || this.draft?.cardId === o.focus) return;
    const entry = entriesOf(raw).find((e) => e.id === o.focus);
    if (entry) this.setDraft({ cardId: o.focus, form: entryToForm(entry), testing: false });
  }

  private setDraft(next: EditDraft | undefined): void {
    this.draft = next;
    this.serial++;
    this.hostErrors = [];
    for (const key of ['draft', 'models']) this.running.get(key)?.abort();
  }

  /** The form of a save, test or reload: what the page shows becomes the draft. */
  private adopt(raw: unknown): BackendForm | undefined {
    const form = asForm(raw);
    if (!form) return undefined;
    if (this.draft && this.draft.form.originalId === form.originalId) this.draft.form = form;
    else this.setDraft({ cardId: form.originalId ?? null, form, testing: false });
    return form;
  }

  private formChanged(raw: unknown): void {
    const form = asForm(raw);
    const d = this.draft;
    // A change for another draft (sent before the page saw this one) is dropped.
    if (!form || !d || form.originalId !== d.form.originalId) return;
    const next = retypeForm(d.form, form, idsOf(userBackends()), d.cardId === null);
    if (next.type !== d.form.type || next.baseUrl !== d.form.baseUrl) {
      // The list belongs to the old server.
      this.running.get('models')?.abort();
      delete d.models;
      delete d.modelsError;
    }
    d.form = next;
    this.hostErrors = [];
  }

  /** The config a form describes; when there is none and the form shows no error, the URL is missing. */
  private configOf(form: BackendForm): BackendConfig | undefined {
    const cfg = formToConfig(form);
    if (!cfg && validateForm(form, []).length === 0) this.hostErrors = [URL_REQUIRED];
    return cfg;
  }

  private async save(raw: unknown, apiKey: string | undefined): Promise<void> {
    const form = this.adopt(raw);
    if (!form) return;
    const list = userBackends();
    const errors = validateForm(form, idsOf(list).filter((id) => id !== form.originalId));
    if (errors.length === 0 && !formToConfig(form)) errors.push(URL_REQUIRED);
    if (errors.length > 0) {
      this.hostErrors = errors;
      return;
    }
    const old = form.originalId;
    for (const id of [old, form.id]) if (id !== undefined) this.stopCardTest(id);
    const original = old === undefined ? undefined : entriesOf(list).find((e) => e.id === old);
    await config().update('backends', upsertBackend(list, formToEntry(form, original), old), vscode.ConfigurationTarget.Global);
    if (old !== undefined) {
      const fimBackend = config().inspect<string>('fim.backend');
      const plan = planRename(old, form.id, fimBackend?.globalValue, fimBackend?.workspaceValue);
      const key = plan.moveKey ? await this.d.secrets.get(old) : undefined;
      if (key !== undefined) {
        await this.d.secrets.set(form.id, key);
        await this.d.secrets.delete(old);
      }
      if (plan.updateUserFimBackend) await config().update('fim.backend', form.id, vscode.ConfigurationTarget.Global);
      if (plan.warnWorkspace) void vscode.window.showWarningMessage(`AI Autocomplete: this workspace still selects "${old}" in aiAutocomplete.fim.backend.`);
    }
    if (apiKey !== undefined) await this.d.secrets.set(form.id, apiKey);
    this.d.log.info(`backends page: saved backend "${form.id}"`);
    this.setDraft(undefined);
  }

  private async remove(id: string): Promise<void> {
    const yes: vscode.MessageItem = { title: 'Remove' };
    const pick = await vscode.window.showWarningMessage(`Remove backend "${id}"?`, { modal: true, detail: 'Its stored API key is deleted too.' }, yes);
    if (pick !== yes) return;
    this.stopCardTest(id);
    await config().update('backends', removeBackend(userBackends(), id), vscode.ConfigurationTarget.Global);
    await this.d.secrets.delete(id);
    this.tests.delete(id);
    this.detected.delete(id);
    if (this.draft?.cardId === id) this.setDraft(undefined);
  }

  private async removeKey(id: string): Promise<void> {
    const yes: vscode.MessageItem = { title: 'Delete' };
    if ((await vscode.window.showWarningMessage(`Delete the stored API key for "${id}"?`, { modal: true }, yes)) === yes) await this.d.secrets.delete(id);
  }

  private testCard(id: string): void {
    const cfg = this.d.getSettings().backends.find((b) => b.id === id);
    if (!cfg) return;
    // The result belongs to the card only while its config is the one tested; a changed or removed card stops the test.
    const tested = JSON.stringify(cfg);
    const live = (): boolean => JSON.stringify(this.d.getSettings().backends.find((b) => b.id === id)) === tested;
    this.tests.set(id, []);
    void this.runTest(`card:${id}`, cfg, () => this.d.secrets.get(id), (steps) => {
      if (live()) this.tests.set(id, steps);
      else this.stopCardTest(id);
    }).then((r) => {
      if (r && live()) this.finish(id, r, cfg.fimModel === undefined);
    });
  }

  /** Stops a running test of a saved card and drops its partial result. */
  private stopCardTest(id: string): void {
    const ctl = this.running.get(`card:${id}`);
    if (!ctl) return;
    ctl.abort();
    this.tests.delete(id);
  }

  private testForm(raw: unknown, apiKey: string | undefined): void {
    const form = this.adopt(raw);
    const d = this.draft;
    if (!form || !d) return;
    const cfg = this.configOf(form);
    if (!cfg) {
      this.running.get('draft')?.abort();
      d.testing = false;
      d.test = [{ id: 'reach', state: 'fail', text: FIX_FORM }];
      return;
    }
    const own = form.originalId;
    // Results are kept per id only for this backend's own id, never for another backend's.
    const id = own ?? (idsOf(userBackends()).includes(form.id) ? undefined : form.id);
    const serial = this.serial;
    const current = (): EditDraft | undefined => (this.serial === serial ? this.draft : undefined);
    d.testing = true;
    d.test = [];
    const key: ApiKeyProvider = async () => apiKey ?? (own !== undefined ? await this.d.secrets.get(own) : undefined);
    void this.runTest('draft', cfg, key, (steps) => {
      const c = current();
      if (c) c.test = steps;
    }).then((r) => {
      const c = current();
      if (!r || !c) return;
      c.testing = false;
      c.test = r.steps;
      if (id !== undefined) this.finish(id, r, form.model.trim() === '');
      void this.post();
    });
  }

  /** Runs a connection test, posting each step; undefined when it was cancelled. */
  private async runTest(key: string, cfg: BackendConfig, apiKey: ApiKeyProvider, onSteps: (steps: TestStep[]) => void): Promise<ConnectionTestResult | undefined> {
    this.running.get(key)?.abort();
    const ctl = new AbortController();
    this.running.set(key, ctl);
    const s = this.d.getSettings();
    const steps: TestStep[] = [];
    const r = await runConnectionTest(
      { backend: createBackend(cfg, apiKey), settings: s, localOnly: s.privacy.localOnly, isLocal: this.d.isLocal, signal: ctl.signal, log: this.d.log },
      (step) => {
        if (ctl.signal.aborted || this.disposed) return;
        steps.push(step);
        onSteps([...steps]);
        void this.post();
      },
    );
    if (this.running.get(key) === ctl) this.running.delete(key);
    return ctl.signal.aborted || this.disposed ? undefined : r;
  }

  /**
   * Keeps a finished test's result and detected model. A test of the in-use backend that got a completion clears its backoff,
   * even with a warning (a JIT load slower than the timeout, a context overflow): the server just answered.
   */
  private finish(id: string, r: ConnectionTestResult, recordModel: boolean): void {
    this.tests.set(id, r.steps);
    if (recordModel && r.model !== undefined) this.detected.set(id, r.model);
    if (completionServed(r) && id === this.d.getSettings().fim.backendId) this.d.onTestPassed(id);
    void this.post();
  }

  private reloadModels(raw: unknown, apiKey: string | undefined): void {
    const form = this.adopt(raw);
    const d = this.draft;
    if (!form || !d) return;
    const cfg = this.configOf(form);
    if (!cfg) {
      delete d.models;
      d.modelsError = FIX_FORM;
      return;
    }
    this.running.get('models')?.abort();
    const ctl = new AbortController();
    this.running.set('models', ctl);
    const serial = this.serial;
    const s = this.d.getSettings();
    const own = form.originalId;
    const backend = createBackend(cfg, async () => apiKey ?? (own !== undefined ? await this.d.secrets.get(own) : undefined));
    void (async () => {
      let models: { id: string; tag: string }[] | undefined;
      let error: string | undefined;
      if (s.privacy.localOnly && !(await this.d.isLocal(cfg.baseUrl))) error = LOCAL_ONLY;
      else {
        const started = Date.now();
        try {
          const info = await backend.listModels(ctl.signal, RELOAD_TIMEOUT_MS);
          models = info.models.map((id) => ({ id, tag: modelTag(cfg, id, s) }));
        } catch (err) {
          const f = explainFailure(err);
          error = f.hint ? `${f.text}: ${f.hint}` : f.text;
        }
        this.d.log.debug(`backends page: model list for "${cfg.id}" in ${Date.now() - started} ms: ${models ? `${models.length} models` : error}`);
      }
      if (this.running.get('models') === ctl) this.running.delete('models');
      const c = this.draft;
      if (ctl.signal.aborted || this.disposed || this.serial !== serial || !c) return;
      if (models) {
        c.models = models;
        delete c.modelsError;
      } else {
        delete c.models;
        c.modelsError = error;
      }
      void this.post();
    })();
  }

  /** Posts the state; posts run one at a time and each builds from the draft as it is when it runs. */
  private post(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pendingPost) return this.pendingPost;
    const run = this.posts.then(() => {
      this.pendingPost = undefined;
      return this.send();
    });
    this.pendingPost = run;
    this.posts = run;
    return run;
  }

  private async send(): Promise<void> {
    if (this.disposed) return;
    try {
      const settings = this.d.getSettings();
      const raw = userBackends();
      const local = new Map<string, boolean>();
      const keysStored = new Set<string>();
      const detected = new Map(this.detected);
      await Promise.all(entriesOf(raw).map(async (e) => {
        if (typeof e.id !== 'string') return;
        // Locality only matters under local only; otherwise no lookup is made.
        if (settings.privacy.localOnly && typeof e.baseUrl === 'string') local.set(e.id, await this.d.isLocal(e.baseUrl));
        if ((await this.d.secrets.get(e.id)) !== undefined) keysStored.add(e.id);
        const model = this.d.detectedModel(e.id);
        if (model !== undefined) detected.set(e.id, model);
      }));
      if (this.disposed) return;
      const state = buildPageState({
        settings, rawBackends: raw, inUseId: settings.fim.backendId, keysStored, local, detected, tests: this.tests, ...(this.draft ? { edit: this.draft } : {}),
      });
      if (state.edit) for (const e of this.hostErrors) if (!state.edit.errors.some((x) => x.field === e.field)) state.edit.errors.push({ field: e.field, message: e.message });
      this.last = state;
      const msg: HostMessage = { type: 'state', state };
      void this.panel.webview.postMessage(msg);
    } catch (err) {
      this.d.log.error('backends page: could not build the page state', err);
    }
  }
}
