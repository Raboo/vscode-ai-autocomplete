// Message and view types shared by the extension host and the Local Models page script. A leaf module: type imports only.
import type { BackendUse } from '../../config/settings';

/** `link`: the repo page on Hugging Face, shown with an access error (401/403). */
export type DownloadView = { kind: 'none' | 'running' | 'done' | 'failed'; received?: number; error?: string; link?: string };
/** An update's own state: its progress and failure never change the row's download state (the old file keeps working). */
export type UpdateView = 'checking' | 'upToDate' | 'gone' | { available: { bytes: number; date?: string } } | { updating: { received: number; total: number } } | { error: string; link?: string };

export interface ModelRow {
  name: string;
  label: string;
  bytes: number;
  uses: BackendUse[];
  builtIn: boolean;
  hidden: boolean;
  download: DownloadView;
  /** 'n/a' when the router is not running. */
  load: 'unloaded' | 'loading' | 'loaded' | 'sleeping' | 'failed' | 'n/a';
  /** What `local` uses this model for now. */
  usedFor: BackendUse[];
  /** The file is above 40% of the memory. */
  mayNotFit: boolean;
  update?: UpdateView;
}

/** The per-model edit form. Numbers are optional: unset means the default. `extraArgs` is the command-line text as typed. */
export interface ModelForm {
  name: string;
  contextTokens: number;
  extraArgs: string;
  sampling: { temperature?: number; topP?: number; topK?: number; maxTokens?: number };
  /** Whether another `modelOverrides` key also matches this model name (the form says so). */
  otherOverridesMatch: boolean;
  error?: string;
}

export interface PageOverride { use: BackendUse; value: string; level: 'workspace' | 'workspaceFolder' }

export interface AddFile { path: string; bytes: number; supported: boolean; reason?: string }
export interface AddState {
  repo?: string;
  files?: AddFile[];
  picked?: string;
  name?: string;
  uses?: BackendUse[];
  contextTokens?: number;
  busy?: boolean;
  error?: string;
  link?: string;
}

export interface LocalPageState {
  server: {
    binary?: string;
    version?: string;
    /** The failure or install hint: fixed text from the host. */
    hint?: string;
    state: 'stopped' | 'starting' | 'running' | 'failed';
    port?: number;
    modelsInMemory: number;
    log: string[];
    /** Fixed text when the typed Models in memory value was refused. */
    modelsInMemoryError?: string;
    swapWarning: boolean;
    memoryWarning?: string;
    /** Uses that workspace or folder settings select another backend for (Use for… does not apply in this window). */
    overrides?: PageOverride[];
  };
  settings: { modelsDir: string; tokenSet: boolean };
  /** The model-list problems from merging the settings. */
  problems: string[];
  models: ModelRow[];
  form?: ModelForm;
  add?: AddState;
  /** First run (no model downloaded): the default model, set up with one button. */
  offer?: { name: string; label: string; bytes: number; busy: boolean };
}

export type HostMessage = { type: 'state'; state: LocalPageState };
export type PageMessage =
  | { type: 'ready' } | { type: 'start' } | { type: 'stop' } | { type: 'restart' }
  | { type: 'setModelsInMemory'; n: number }
  | { type: 'download'; name: string } | { type: 'cancelDownload'; name: string } | { type: 'removeFile'; name: string }
  | { type: 'load'; name: string } | { type: 'unload'; name: string }
  | { type: 'use'; name: string; uses: BackendUse[] }
  | { type: 'edit'; name: string } | { type: 'saveModel'; form: ModelForm }
  | { type: 'hide'; name: string } | { type: 'unhide'; name: string } | { type: 'removeModel'; name: string }
  | { type: 'addRepo'; repo: string } | { type: 'pickFile'; path: string }
  | { type: 'addFile'; repo: string; path: string; name: string; uses: BackendUse[]; contextTokens: number }
  | { type: 'checkUpdate'; name: string } | { type: 'update'; name: string } | { type: 'cancelUpdate'; name: string }
  | { type: 'changeModelsDir' } | { type: 'setToken' } | { type: 'removeToken' } | { type: 'openLog' }
  | { type: 'setUpDefault' }
  | { type: 'cancel' };
