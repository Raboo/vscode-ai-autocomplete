import type { Settings } from '../../config/settings';
import { LOCAL_BACKEND_ID } from '../backendEntry';
import type { LocalModel } from '../modelList';
import type { RouterModel } from '../router';
import type { PoolState } from '../serverPool';
import type { AddState, LocalPageState, ModelForm, ModelRow, PageOverride } from './protocol';

const NO_DOWNLOAD: ModelRow['download'] = { kind: 'none' };

export interface PageStateInput {
  models: LocalModel[];
  problems: string[];
  downloads: Record<string, ModelRow['download']>;
  /** Undefined when the router is not running or did not answer. */
  routerModels: RouterModel[] | undefined;
  settings: Settings;
  server: { state: PoolState; failure?: string; port?: number; log: string[]; binary?: string; version?: string; modelsInMemoryError?: string };
  /** Uses that workspace or folder settings select another backend for. */
  overrides?: PageOverride[];
  modelsDir: string;
  tokenSet: boolean;
  totalMem: number;
  updates: Record<string, ModelRow['update']>;
  form?: ModelForm;
  add?: AddState;
  /** The default model to offer on a first run, and whether its one-button setup runs now. */
  offer?: { name: string; busy: boolean };
}

/** The page's state from plain data: the token is never part of it, only whether one is set. */
export function pageState(o: PageStateInput): LocalPageState {
  const local = o.settings.backends.find((b) => b.id === LOCAL_BACKEND_ID);
  const inMemory = o.settings.local.modelsInMemory;
  const routerUp = o.server.state === 'running' && o.routerModels !== undefined;
  const loadOf = (name: string): ModelRow['load'] => {
    if (!routerUp) return 'n/a';
    return o.routerModels!.find((m) => m.id === name)?.state ?? 'unloaded';
  };

  // What applies in this window: `settings` is the effective value (folder over workspace over user settings).
  const selected = (use: 'fim' | 'nextEdit'): boolean => o.settings[use].enabled && o.settings[use].backendId === LOCAL_BACKEND_ID;
  const models: ModelRow[] = o.models.map((m) => {
    const usedFor: ModelRow['usedFor'] = [];
    if (local?.fimModel === m.name && selected('fim')) usedFor.push('completions');
    if (local?.nextEditModel === m.name && selected('nextEdit')) usedFor.push('nextEdit');
    const update = o.updates[m.name];
    return {
      name: m.name, label: m.label, bytes: m.bytes, uses: m.uses, builtIn: m.builtIn, hidden: m.hidden,
      download: o.downloads[m.name] ?? NO_DOWNLOAD,
      load: loadOf(m.name), usedFor, mayNotFit: m.bytes > 0.4 * o.totalMem,
      ...(update !== undefined ? { update } : {}),
    };
  });

  const swapWarning = local !== undefined && selected('fim') && selected('nextEdit')
    && local.fimModel !== undefined && local.nextEditModel !== undefined && local.fimModel !== local.nextEditModel && inMemory < 2;

  const downloadedSizes = models.filter((m) => m.download.kind === 'done').map((m) => m.bytes).sort((a, b) => b - a).slice(0, Math.max(1, inMemory));
  const largest = downloadedSizes.reduce((a, b) => a + b, 0);
  const memoryWarning = inMemory > 1 && largest > 0.75 * o.totalMem
    ? `The ${downloadedSizes.length === 1 ? 'largest model' : `${downloadedSizes.length} largest downloaded models`} together take more than 75% of this computer's memory; loading ${downloadedSizes.length === 1 ? 'it' : 'them'} may slow everything down.`
    : undefined;

  const offered = o.offer ? models.find((m) => m.name === o.offer!.name && !m.hidden) : undefined;
  const firstRun = !models.some((m) => m.download.kind === 'done');
  const offer = offered && (firstRun || o.offer!.busy) ? { name: offered.name, label: offered.label, bytes: offered.bytes, busy: o.offer!.busy } : undefined;

  return {
    server: {
      ...(o.server.binary !== undefined ? { binary: o.server.binary } : {}),
      ...(o.server.version !== undefined ? { version: o.server.version } : {}),
      ...(o.server.failure !== undefined ? { hint: o.server.failure } : {}),
      state: o.server.state,
      ...(o.server.port !== undefined ? { port: o.server.port } : {}),
      modelsInMemory: inMemory, log: o.server.log, swapWarning,
      ...(o.server.modelsInMemoryError !== undefined ? { modelsInMemoryError: o.server.modelsInMemoryError } : {}),
      ...(memoryWarning !== undefined ? { memoryWarning } : {}),
      ...(o.overrides && o.overrides.length > 0 ? { overrides: o.overrides.map((x) => ({ use: x.use, value: x.value, level: x.level })) } : {}),
    },
    settings: { modelsDir: o.modelsDir, tokenSet: o.tokenSet },
    problems: o.problems,
    models,
    ...(o.form ? { form: o.form } : {}),
    ...(o.add ? { add: o.add } : {}),
    ...(offer ? { offer } : {}),
  };
}
