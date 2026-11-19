import { nextEditModel } from '../completion/effective';
import { renameBackendEntry } from '../config/rename';
import type { Settings } from '../config/settings';

/** The one backend the local model helper writes: the llama-server router on 127.0.0.1. */
export const LOCAL_BACKEND_ID = 'local';

/** The port tried first when the router has no record yet. */
export const DEFAULT_PORT = 8012;

/** The router the extension started; kept in global state so any window can adopt it and it starts again next session. */
export interface ManagedServer {
  port: number;
  /**
   * The process serving it, written by the window that started it. Stop Local Models clears it: a record without a pid
   * means nobody should be serving it, so a window that adopted the router does not start it again (unless `restarting`).
   */
  pid?: number;
  presetsPath: string;
  /** `--models-max` the router was started with. */
  modelsMax: number;
  /**
   * Set (without a pid) by a window that restarts the router while it stops the old process: other windows wait for the
   * new router instead of treating the exit as Stop Local Models. The new router's record drops it.
   */
  restarting?: true;
}

/** Key of the router record in the extension's global state (`localServers`, the per-model records, is read only by the migration). */
export const MANAGED_KEY = 'localRouter';

/** The `aiAutocomplete.backends` entry of the router on `127.0.0.1:<port>`; `use` lists the uses that have a model. */
export function localRouterEntry(port: number, o: { model?: string; nextEditModel?: string }): Record<string, unknown> {
  const entry: Record<string, unknown> = { id: LOCAL_BACKEND_ID, kind: 'llamacpp', baseUrl: `http://127.0.0.1:${port}` };
  const use = [...(o.model !== undefined ? ['completions'] : []), ...(o.nextEditModel !== undefined ? ['nextEdit'] : [])];
  // Without any model, `use` stays out (both): an empty list is a settings problem.
  if (use.length > 0) entry.use = use;
  if (o.model !== undefined) entry.model = o.model;
  if (o.nextEditModel !== undefined) entry.nextEditModel = o.nextEditModel;
  return entry;
}

const isEntry = (e: unknown): e is Record<string, unknown> => typeof e === 'object' && e !== null && !Array.isArray(e);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** The port of the `local` entry in this backends list, when it has one. */
export function localEntryPort(list: unknown): number | undefined {
  const entry = Array.isArray(list) ? (list as unknown[]).find((e) => isEntry(e) && e.id === LOCAL_BACKEND_ID) : undefined;
  if (!isEntry(entry) || typeof entry.baseUrl !== 'string') return undefined;
  try {
    const port = Number(new URL(entry.baseUrl).port);
    return isPort(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The backends list with `local` written for `models` on `port`: an existing entry keeps its other fields (old field
 * names renamed) and the model of a use `models` leaves out; `use` follows the models it ends with.
 */
export function upsertLocalEntry(list: unknown, models: { model?: string; nextEditModel?: string }, port: number): unknown[] {
  const out = Array.isArray(list) ? [...(list as unknown[])] : [];
  const at = out.findIndex((e) => isEntry(e) && e.id === LOCAL_BACKEND_ID);
  const old = at >= 0 && isEntry(out[at]) ? renameBackendEntry(out[at] as Record<string, unknown>).entry : {};
  const model = models.model ?? str(old.model);
  const nextEdit = models.nextEditModel ?? str(old.nextEditModel);
  const fresh = localRouterEntry(port, { ...(model !== undefined ? { model } : {}), ...(nextEdit !== undefined ? { nextEditModel: nextEdit } : {}) });
  const entry = { ...old, ...fresh };
  if (at >= 0) out[at] = entry;
  else out.push(entry);
  return out;
}

const isPort = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535;

/** Reads the router record from global state (untrusted): undefined unless it is well-formed. */
export function parseManaged(raw: unknown): ManagedServer | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { port, pid, presetsPath, modelsMax, restarting } = raw as Record<string, unknown>;
  if (!isPort(port) || typeof presetsPath !== 'string' || typeof modelsMax !== 'number' || !Number.isInteger(modelsMax) || modelsMax < 1) return undefined;
  const validPid = typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
  return { port, ...(validPid ? { pid } : {}), presetsPath, modelsMax, ...(restarting === true ? { restarting: true as const } : {}) };
}

/** Whether the router should run: the extension is on and `local` exists and is selected for an enabled use. */
export function routerWanted(s: Settings): boolean {
  if (!s.enabled || !s.backends.some((b) => b.id === LOCAL_BACKEND_ID)) return false;
  return (s.fim.enabled && s.fim.backendId === LOCAL_BACKEND_ID) || (s.nextEdit.enabled && s.nextEdit.backendId === LOCAL_BACKEND_ID);
}

/** The model names `local` serves for its enabled, selected uses: completions first, each once. */
export function selectedModels(s: Settings): string[] {
  const local = s.backends.find((b) => b.id === LOCAL_BACKEND_ID);
  if (!s.enabled || !local) return [];
  const names: string[] = [];
  if (s.fim.enabled && s.fim.backendId === LOCAL_BACKEND_ID && local.fimModel) names.push(local.fimModel);
  const ne = s.nextEdit.enabled && s.nextEdit.backendId === LOCAL_BACKEND_ID ? nextEditModel(local, undefined) : undefined;
  if (ne && !names.includes(ne)) names.push(ne);
  return names;
}

/** The saved port when `free` gives it back, otherwise the one `free` found instead (`changed`: the backend's URL must follow). */
export async function portFor(saved: number, free: (preferred: number) => Promise<number>): Promise<{ port: number; changed: boolean }> {
  const port = await free(saved);
  return { port, changed: port !== saved };
}
