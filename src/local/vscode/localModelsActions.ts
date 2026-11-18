import * as vscode from 'vscode';
import { rm } from 'node:fs/promises';
import type { BackendUse } from '../../config/settings';
import { HfError, authFor, checkUpdate, ggufFiles, pinnedFileUrl, repoCommit, updateModelFile, type HfFile, type UpdateCheck } from '../huggingFace';
import { isSplitOrProjector, modelNameFromFile, type LocalModel } from '../modelList';
import { MOVE_FAILED, moveModelFiles, type FileMove } from '../moveFiles';
import { addModelEdits, modelForm, removeModelEdits, saveModelEdits, unhideEdits } from '../page/edits';
import type { AddFile, AddState, ModelForm, ModelRow, PageMessage } from '../page/protocol';
import { modelPathSegments } from '../recipes';
import { RouterClient } from '../router';
import { downloadedPath, modelsDir } from './servers';
import {
  defaultModelName, downloadFile, hfProblem, localModels, modelPath, setUpModel, useModel, userValue, writeAll, writeUser, type LocalDeps,
} from './setup';

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const USES: readonly BackendUse[] = ['completions', 'nextEdit'];
const MULTI_FILE = 'multi-file models are not supported';
const NO_CHECKSUM = 'no checksum on Hugging Face (not stored with Git LFS)';
const BAD_PATH = 'this file path is not supported';

/** The host-owned page state the actions change: the edit form, the add flow and the update checks. */
export interface ActionsView {
  form?: ModelForm;
  add?: AddState;
  updates: Record<string, ModelRow['update']>;
}

const usesOf = (v: unknown): BackendUse[] => (Array.isArray(v) ? USES.filter((u) => (v as unknown[]).includes(u)) : []);

/**
 * The Local Models page's actions. Quick ones run in the page's message queue; downloads, Hugging Face requests and the
 * one-button setup run beside it (the page's other buttons keep working) and call `changed` when they end.
 */
export class LocalModelsActions {
  private form: ModelForm | undefined;
  private add: AddState | undefined;
  /** The repo commit and files the add flow lists: the picked file is taken from here, never from the page. */
  private addFiles: { repo: string; revision: string; files: HfFile[] } | undefined;
  private readonly updates: Record<string, ModelRow['update']> = {};
  private readonly checks = new Map<string, Extract<UpdateCheck, { kind: 'available' }>>();
  /** Bumped by each add-flow start or cancel: an older Hugging Face answer is dropped. */
  private addSerial = 0;

  constructor(
    private readonly d: LocalDeps & { showLog(): void },
    private readonly changed: () => void,
    private readonly refresh: () => Promise<void>,
  ) {}

  view(): ActionsView {
    return { ...(this.form ? { form: this.form } : {}), ...(this.add ? { add: this.add } : {}), updates: { ...this.updates } };
  }

  private models(): LocalModel[] {
    return localModels(this.d).models;
  }

  private model(name: unknown): LocalModel | undefined {
    return typeof name === 'string' ? this.models().find((m) => m.name === name) : undefined;
  }

  private downloaded(m: LocalModel): string | undefined {
    return downloadedPath(modelsDir(this.d.context, this.d.settings()), m);
  }

  /** Runs `work` beside the message queue; a failure is logged with fixed text shown. */
  private detach(what: string, work: () => Promise<unknown>): void {
    void work().catch((err: unknown) => {
      this.d.log.error(`local models page: ${what} failed`, err);
    }).finally(() => this.changed());
  }

  async handle(m: PageMessage): Promise<void> {
    const r = this.d.router;
    switch (m.type) {
      case 'ready':
        return;
      case 'start':
        return void r.start().catch((err: unknown) => this.d.log.error('local models: llama-server could not start', err));
      case 'stop':
        return r.stop();
      case 'restart':
        return void r.restart();
      case 'setModelsInMemory':
        if (Number.isInteger(m.n) && m.n >= 1 && m.n <= 64) await writeUser('local.modelsInMemory', m.n);
        return;
      case 'openLog':
        return this.d.showLog();
      case 'download':
        return this.download(m.name);
      case 'cancelDownload':
        return this.d.downloads.cancel(m.name);
      case 'removeFile':
        return this.removeFile(m.name);
      case 'load':
      case 'unload':
        return this.loadOrUnload(m.name, m.type);
      case 'use':
        return this.use(m.name, m.uses);
      case 'edit':
        return this.edit(m.name);
      case 'saveModel':
        return this.save(m.form);
      case 'hide':
      case 'removeModel':
        return this.remove(m.name, m.type === 'hide' ? 'hide' : 'remove');
      case 'unhide':
        return this.unhide(m.name);
      case 'addRepo':
        return this.addRepo(m.repo);
      case 'pickFile':
        return this.pickFile(m.path);
      case 'addFile':
        return this.addFile(m);
      case 'checkUpdate':
        return this.checkUpdate(m.name);
      case 'update':
        return this.update(m.name);
      case 'changeModelsDir':
        return this.changeModelsDir();
      case 'setToken':
        return this.setToken();
      case 'removeToken':
        return this.removeToken();
      case 'setUpDefault':
        return this.setUpDefault();
      case 'cancel':
        this.form = undefined;
        this.add = undefined;
        this.addFiles = undefined;
        this.addSerial++;
        return;
    }
  }

  private download(name: string): void {
    const m = this.model(name);
    if (!m || this.d.downloads.running(name)) return;
    this.detach(`downloading ${name}`, () => downloadFile(this.d, m));
  }

  private async removeFile(name: string): Promise<void> {
    const m = this.model(name);
    const path = m && modelPath(this.d, m);
    if (!m || !path || this.d.downloads.running(name)) return;
    const yes: vscode.MessageItem = { title: 'Remove File' };
    const pick = await vscode.window.showWarningMessage(`Delete the downloaded file of ${m.label}?`, { modal: true, detail: 'The model stays in the list; Download gets it again.' }, yes);
    if (pick !== yes) return;
    await this.deleteFile(m, path);
  }

  /** Unloads the model (errors ignored), deletes its file and partial download, then the presets drop it. */
  private async deleteFile(m: LocalModel, path: string): Promise<void> {
    const port = this.d.router.port();
    if (port !== undefined && this.d.router.state() === 'running') {
      await new RouterClient(`http://127.0.0.1:${port}`).unload(m.name).catch(() => undefined);
    }
    try {
      await rm(path, { force: true });
      await rm(`${path}.part`, { force: true });
    } catch (err) {
      this.d.log.error(`local models: deleting the file of ${m.name} failed`, err);
      void vscode.window.showErrorMessage(`Could not delete the file of ${m.label}.`);
    }
    this.d.downloads.clearFailure(m.name);
    await this.d.router.syncPresets();
  }

  private async loadOrUnload(name: string, what: 'load' | 'unload'): Promise<void> {
    const port = this.d.router.port();
    if (!this.model(name) || port === undefined || this.d.router.state() !== 'running') return;
    const client = new RouterClient(`http://127.0.0.1:${port}`);
    // A load can take a while: it runs beside the queue, and the poll shows "loading".
    this.detach(`${what} ${name}`, async () => {
      try {
        await (what === 'load' ? client.load(name) : client.unload(name));
      } catch (err) {
        this.d.log.warn(`llama-server: ${what} ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
        void vscode.window.showErrorMessage(`${what === 'load' ? 'Loading' : 'Unloading'} ${name} failed; see the server log.`);
      }
      await this.refresh();
    });
  }

  private async use(name: string, uses: unknown): Promise<void> {
    const m = this.model(name);
    const wanted = usesOf(uses).filter((u) => m?.uses.includes(u));
    if (!m || wanted.length === 0 || !this.downloaded(m)) return;
    await useModel(this.d, m.name, wanted);
  }

  private edit(name: string): void {
    const m = this.model(name);
    if (!m) return;
    this.form = modelForm({ model: m, entries: userValue('local.models'), overrides: userValue('modelOverrides') });
  }

  private async save(raw: unknown): Promise<void> {
    const f = raw as Partial<ModelForm> | undefined;
    const m = this.model(this.form?.name);
    if (!m || !this.form || typeof f !== 'object' || f === null || f.name !== this.form.name) return;
    const form: ModelForm = {
      name: m.name,
      contextTokens: typeof f.contextTokens === 'number' ? f.contextTokens : NaN,
      extraArgs: typeof f.extraArgs === 'string' ? f.extraArgs : '',
      sampling: typeof f.sampling === 'object' && f.sampling !== null ? f.sampling : {},
      otherOverridesMatch: this.form.otherOverridesMatch,
    };
    const r = saveModelEdits({ model: m, entries: userValue('local.models'), overrides: userValue('modelOverrides'), form });
    if ('error' in r) {
      this.form = { ...form, error: r.error };
      return;
    }
    if (r.models) await writeUser('local.models', r.models);
    if (r.overrides) await writeUser('modelOverrides', r.overrides);
    this.form = undefined;
  }

  private async remove(name: string, mode: 'hide' | 'remove'): Promise<void> {
    const m = this.model(name);
    if (!m || m.builtIn !== (mode === 'hide')) return;
    let deleteFile = false;
    if (mode === 'remove') {
      const yes: vscode.MessageItem = { title: 'Remove' };
      const withFile: vscode.MessageItem = { title: 'Remove and Delete File' };
      const file = this.downloaded(m);
      const pick = await vscode.window.showWarningMessage(`Remove ${m.label} from the list?`, { modal: true }, ...(file ? [withFile] : []), yes);
      if (pick !== yes && pick !== withFile) return;
      deleteFile = pick === withFile;
    }
    const r = removeModelEdits({
      entries: userValue('local.models'), backends: userValue('backends'), name, mode,
      selection: { completions: userValue('completions.backend'), nextEdit: userValue('nextEdit.backend') },
    });
    // The selection goes first: it never names `local` for a use the backend no longer has a model for.
    await writeAll(r.writes);
    if (r.backends) await writeUser('backends', r.backends);
    await writeUser('local.models', r.models);
    if (this.form?.name === name) this.form = undefined;
    const path = deleteFile ? modelPath(this.d, m) : undefined;
    if (path) await this.deleteFile(m, path);
  }

  private async unhide(name: string): Promise<void> {
    const m = this.model(name);
    if (m?.builtIn) await writeUser('local.models', unhideEdits(userValue('local.models'), name, true));
  }

  private addRepo(raw: unknown): void {
    const repo = typeof raw === 'string' ? raw.trim() : '';
    const serial = ++this.addSerial;
    this.addFiles = undefined;
    if (!REPO_RE.test(repo)) {
      this.add = { repo, error: 'Enter a Hugging Face repo id like owner/name.' };
      return;
    }
    this.add = { repo, busy: true };
    this.detach('listing the repo files', async () => {
      const token = await this.d.secrets.getHfToken();
      try {
        const revision = await repoCommit(repo, { token });
        const files = await ggufFiles(repo, revision, { token });
        if (serial !== this.addSerial) return;
        this.addFiles = { repo, revision, files };
        const view: AddFile[] = files.map((f) => {
          const reason = isSplitOrProjector(f.path) ? MULTI_FILE : f.sha256 === undefined ? NO_CHECKSUM : !modelPathSegments({ repo, file: f.path }) ? BAD_PATH : undefined;
          return { path: f.path, bytes: f.bytes, supported: reason === undefined && f.supported, ...(reason ? { reason } : {}) };
        });
        this.add = view.length > 0 ? { repo, files: view, uses: ['completions'], contextTokens: 8192 } : { repo, error: 'This repo has no .gguf files.' };
      } catch (err) {
        if (serial !== this.addSerial) return;
        if (!(err instanceof HfError)) this.d.log.error('local models: listing the repo files failed', err);
        this.add = { repo, ...hfProblem(err, repo) };
      }
    });
  }

  private pickFile(path: unknown): void {
    const a = this.add;
    const file = this.addFiles?.files.find((f) => f.path === path);
    if (!a || !file) return;
    this.add = { ...a, picked: file.path, name: modelNameFromFile(file.path) };
    delete this.add.error;
  }

  private async addFile(m: Extract<PageMessage, { type: 'addFile' }>): Promise<void> {
    const ctx = this.addFiles;
    const file = ctx?.repo === m.repo ? ctx.files.find((f) => f.path === m.path) : undefined;
    if (!ctx || !file || !this.add) return;
    const uses = usesOf(m.uses);
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    const r = addModelEdits({
      entries: userValue('local.models'), taken: this.models().map((x) => x.name), repo: ctx.repo, revision: ctx.revision, file: { ...file, supported: file.supported && modelPathSegments({ repo: ctx.repo, file: file.path }) !== undefined },
      name, uses, contextTokens: typeof m.contextTokens === 'number' ? m.contextTokens : NaN,
    });
    if ('error' in r) {
      this.add = { ...this.add, picked: file.path, name, uses, ...(typeof m.contextTokens === 'number' ? { contextTokens: m.contextTokens } : {}), error: r.error };
      return;
    }
    await writeUser('local.models', r.models);
    this.add = undefined;
    this.addFiles = undefined;
    if (/v2/.test(name)) void vscode.window.showInformationMessage(`The name ${name} contains "v2": Next Edit uses the Sweep v2 prompt layout for it.`);
  }

  private checkUpdate(name: string): void {
    const m = this.model(name);
    if (!m || m.builtIn || this.updates[name] === 'checking') return;
    this.updates[name] = 'checking';
    this.checks.delete(name);
    this.detach(`checking ${name} for an update`, async () => {
      try {
        const r = await checkUpdate(m, { token: await this.d.secrets.getHfToken() });
        if (r.kind === 'available') {
          this.checks.set(name, r);
          this.updates[name] = { available: { bytes: r.bytes, ...(r.date ? { date: r.date.slice(0, 10) } : {}) } };
        } else this.updates[name] = r.kind;
      } catch (err) {
        if (err instanceof HfError && err.kind === 'notFound') this.updates[name] = 'gone';
        else {
          if (!(err instanceof HfError)) this.d.log.error(`local models: checking ${name} for an update failed`, err);
          this.updates[name] = hfProblem(err, m.repo);
        }
      }
    });
  }

  /** Downloads the new file next to the old one, then replaces it and pins the entry to the new commit. */
  private update(name: string): void {
    const m = this.model(name);
    const check = this.checks.get(name);
    const dest = m && modelPath(this.d, m);
    if (!m || !check || !dest || this.d.downloads.running(name)) return;
    this.detach(`updating ${name}`, async () => {
      const token = await this.d.secrets.getHfToken();
      const done = await this.d.downloads.run(name, { part: `${dest}.update.part`, repo: m.repo }, async (signal, progress) => {
        await updateModelFile({
          url: pinnedFileUrl(m.repo, check.revision, m.file), dest, bytes: check.bytes, sha256: check.sha256, signal, authFor: authFor(token), onProgress: progress,
        });
        return true;
      });
      if (!done) return;
      const entries = userValue('local.models');
      const list = Array.isArray(entries) ? (entries as unknown[]) : [];
      await writeUser('local.models', list.map((e) => (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === name
        ? { ...e, revision: check.revision, bytes: check.bytes, sha256: check.sha256 } : e)));
      this.checks.delete(name);
      this.updates[name] = 'upToDate';
      await this.d.router.syncPresets();
    });
  }

  private async changeModelsDir(): Promise<void> {
    if (this.d.downloads.running()) {
      void vscode.window.showWarningMessage('Wait for the downloads to finish, or cancel them, before changing the models folder.');
      return;
    }
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use This Folder', title: 'Models folder' });
    const target = picked?.[0]?.fsPath;
    const from = modelsDir(this.d.context, this.d.settings());
    if (!target || target === from) return;
    const moves: FileMove[] = [];
    for (const m of this.models()) {
      const path = this.downloaded(m);
      const to = modelPath(this.d, m, target);
      if (path && to) moves.push({ from: path, to, bytes: m.bytes });
    }
    if (moves.length > 0) {
      const move: vscode.MessageItem = { title: 'Move' };
      const keep: vscode.MessageItem = { title: 'Keep' };
      const pick = await vscode.window.showInformationMessage(
        `Move the ${moves.length === 1 ? 'downloaded model' : `${moves.length} downloaded models`} to the new folder?`,
        { modal: true, detail: 'Keep leaves the files where they are; the models then show as not downloaded.' }, move, keep,
      );
      if (pick !== move && pick !== keep) return;
      if (pick === move) {
        try {
          await moveModelFiles(moves);
        } catch (err) {
          this.d.log.error('local models: moving the model files failed', err instanceof Error && 'cause' in err ? err.cause : err);
          void vscode.window.showErrorMessage(MOVE_FAILED);
          return;
        }
      }
    }
    await writeUser('local.modelsDir', target);
    await this.d.router.syncPresets();
  }

  private async setToken(): Promise<void> {
    const token = await vscode.window.showInputBox({
      title: 'Hugging Face token', prompt: 'A read token from huggingface.co/settings/tokens. It is kept in VS Code\'s secret storage and sent to huggingface.co only.',
      password: true, ignoreFocusOut: true,
    });
    if (token === undefined || token.trim() === '') return;
    await this.d.secrets.setHfToken(token.trim());
  }

  private async removeToken(): Promise<void> {
    const yes: vscode.MessageItem = { title: 'Remove' };
    if ((await vscode.window.showWarningMessage('Remove the stored Hugging Face token?', { modal: true }, yes)) === yes) await this.d.secrets.deleteHfToken();
  }

  private setUpDefault(): void {
    const m = this.model(defaultModelName(this.d.recipes()));
    if (!m) return;
    this.detach('setting up the default model', () => setUpModel(this.d, m));
  }
}

