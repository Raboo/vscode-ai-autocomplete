// Message and view types shared by the extension host and the Local Models page script. A leaf module: type imports only.
import type { BackendUse } from '../../config/settings';

export type DownloadView = { kind: 'none' | 'running' | 'done' | 'failed'; received?: number; error?: string };
export type UpdateView = 'checking' | 'upToDate' | 'gone' | { available: { bytes: number; date?: string } };

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
    swapWarning: boolean;
    memoryWarning?: string;
  };
  settings: { modelsDir: string; tokenSet: boolean };
  /** The model-list problems from merging the settings. */
  problems: string[];
  models: ModelRow[];
  form?: ModelForm;
  add?: AddState;
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
  | { type: 'checkUpdate'; name: string } | { type: 'update'; name: string }
  | { type: 'changeModelsDir' } | { type: 'setToken' } | { type: 'removeToken' } | { type: 'openLog' }
  | { type: 'cancel' };
