import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { totalmem } from 'node:os';
import * as vscode from 'vscode';
import { HF_TOKEN_KEY } from '../config/secrets';
import { findRuntime, INSTALL_HINT } from '../local/runtimes';
import { pageState } from '../local/page/state';
import type { DownloadView, HostMessage, LocalPageState, PageMessage } from '../local/page/protocol';
import { RouterClient, type RouterModel } from '../local/router';
import { LocalModelsActions } from '../local/vscode/localModelsActions';
import { downloadedPath, modelsDir, realEnv } from '../local/vscode/servers';
import { defaultModelName, localModels, settingUp, type LocalDeps } from '../local/vscode/setup';

export type LocalModelsPanelDeps = LocalDeps & { showLog(): void };

const VIEW_TYPE = 'aiAutocomplete.localModels';
const POLL_MS = 2000;
const VERSION_TIMEOUT_MS = 5000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function pageHtml(w: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const uri = (file: string): string => w.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', file)).toString();
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${w.cspSource} 'nonce-${nonce}'; img-src ${w.cspSource}; font-src ${w.cspSource}`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${uri('localModels.css')}">`
    + `<title>Local Models</title></head><body><script nonce="${nonce}" src="${uri('localModels.js')}"></script></body></html>`;
}

/** `llama-server --version` (an argument array, never a shell): the first "version: …" line, per binary path. */
const versions = new Map<string, Promise<string | undefined>>();
function versionOf(binary: string): Promise<string | undefined> {
  let v = versions.get(binary);
  if (!v) {
    v = new Promise((resolve) => {
      execFile(binary, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (_err, stdout, stderr) => {
        const m = /version:\s*([^\r\n]+)/.exec(`${stdout}\n${stderr}`);
        resolve(m ? m[1].trim().slice(0, 80) : undefined);
      });
    });
    versions.set(binary, v);
  }
  return v;
}

/**
 * The Local Models page. The host owns all state; the page posts intents and gets a full state back after each (and
 * on server, download and settings changes). While the page is visible and the router runs, `GET /models` is polled
 * every 2 s for the load states.
 */
export class LocalModelsPanel implements vscode.Disposable {
  private static instance: LocalModelsPanel | undefined;
  private readonly subs: vscode.Disposable[] = [];
  private readonly actions: LocalModelsActions;
  private routerModels: RouterModel[] | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private posting = false;
  private postAgain = false;
  private lastJson = '';
  private last: LocalPageState | undefined;
  private disposed = false;

  /** One panel at a time: a second call reveals it. */
  static show(d: LocalModelsPanelDeps): LocalModelsPanel {
    const p = LocalModelsPanel.instance;
    if (p) {
      p.panel.reveal();
      return p;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'AI Autocomplete: Local Models', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(d.context.extensionUri, 'dist', 'webview')],
    });
    return (LocalModelsPanel.instance = new LocalModelsPanel(panel, d));
  }

  static current(): LocalModelsPanel | undefined {
    return LocalModelsPanel.instance;
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly d: LocalModelsPanelDeps) {
    this.actions = new LocalModelsActions(d, () => void this.post(), () => this.poll());
    panel.webview.html = pageHtml(panel.webview, d.context.extensionUri);
    this.subs.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: unknown) => {
        if (isObj(m) && typeof m.type === 'string') void this.handle(m as PageMessage);
      }),
      panel.onDidChangeViewState(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('aiAutocomplete')) void this.post();
      }),
      d.context.secrets.onDidChange((e) => {
        if (e.key === HF_TOKEN_KEY) void this.post();
      }),
      d.router.onChange(() => {
        this.schedule();
        void this.poll();
      }),
      d.downloads.onChange(() => void this.post()),
    );
    this.schedule();
  }

  /** Handles one page message after the ones before it, then posts the state. */
  handle(msg: PageMessage): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.disposed) return;
      // A page that (re)loads, e.g. after being hidden, has no state yet.
      if (msg.type === 'ready') this.lastJson = '';
      try {
        await this.actions.handle(msg);
      } catch (err) {
        this.d.log.error('local models page: action failed', err);
        void vscode.window.showErrorMessage('AI Autocomplete: the Local Models page could not finish that action; see the log.');
      }
      await this.post();
    });
    this.queue = run;
    return run;
  }

  /** The last state posted to the page (tests read it). */
  lastState(): LocalPageState | undefined {
    return this.last;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (LocalModelsPanel.instance === this) LocalModelsPanel.instance = undefined;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const s of this.subs) s.dispose();
    this.panel.dispose();
  }

  /** Polls while the page is visible and the router runs; stops otherwise. */
  private schedule(): void {
    const want = !this.disposed && this.panel.visible && this.d.router.state() === 'running';
    if (want && !this.timer) {
      this.timer = setInterval(() => void this.poll(), POLL_MS);
      void this.poll();
    } else if (!want && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Reads the load states from the router (when it runs), then posts. */
  private async poll(): Promise<void> {
    if (this.disposed) return;
    const port = this.d.router.port();
    if (port !== undefined && this.d.router.state() === 'running') {
      try {
        this.routerModels = await new RouterClient(`http://127.0.0.1:${port}`).models();
      } catch {
        this.routerModels = undefined;
      }
    } else this.routerModels = undefined;
    await this.post();
  }

  /** Posts the state; a post asked for while one runs is sent once after it. Unchanged states are not sent again. */
  private async post(): Promise<void> {
    if (this.disposed) return;
    if (this.posting) {
      this.postAgain = true;
      return;
    }
    this.posting = true;
    try {
      do {
        this.postAgain = false;
        await this.send();
      } while (this.postAgain && !this.disposed);
    } finally {
      this.posting = false;
    }
  }

  private async send(): Promise<void> {
    try {
      const d = this.d;
      const settings = d.settings();
      const { models, problems } = localModels(d);
      const dir = modelsDir(d.context, settings);
      const downloads: Record<string, DownloadView> = {};
      for (const m of models) if (downloadedPath(dir, m) !== undefined) downloads[m.name] = { kind: 'done' };
      Object.assign(downloads, d.downloads.views());
      const binary = findRuntime('llamaServer', realEnv(), settings.local.llamaServerPath);
      const version = binary ? await versionOf(binary) : undefined;
      const tokenSet = (await d.secrets.getHfToken()) !== undefined;
      const view = this.actions.view();
      const failure = d.router.failure() ?? (binary === undefined ? `llama-server was not found. ${INSTALL_HINT.llamaServer}` : undefined);
      const offerName = defaultModelName(d.recipes());
      const state = pageState({
        models, problems, downloads, routerModels: this.routerModels, settings,
        server: {
          state: d.router.state(), log: d.router.lastOutput().slice(-100),
          ...(failure !== undefined ? { failure } : {}),
          ...(d.router.port() !== undefined ? { port: d.router.port() } : {}),
          ...(binary !== undefined ? { binary } : {}), ...(version !== undefined ? { version } : {}),
          ...(view.modelsInMemoryError !== undefined ? { modelsInMemoryError: view.modelsInMemoryError } : {}),
        },
        modelsDir: dir, tokenSet, totalMem: totalmem(), updates: view.updates,
        ...(view.form ? { form: view.form } : {}), ...(view.add ? { add: view.add } : {}),
        ...(offerName !== undefined ? { offer: { name: offerName, busy: settingUp() } } : {}),
      });
      if (this.disposed) return;
      this.last = state;
      const json = JSON.stringify(state);
      if (json === this.lastJson) return;
      this.lastJson = json;
      const msg: HostMessage = { type: 'state', state };
      if (!(await this.panel.webview.postMessage(msg))) this.lastJson = '';
    } catch (err) {
      this.d.log.error('local models page: could not build the page state', err);
    }
  }
}
