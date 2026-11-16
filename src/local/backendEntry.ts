import type { Settings } from '../config/settings';
import type { Recipe } from './recipes';

export type LocalRuntime = 'llamaServer' | 'lmStudio';

/** A server the extension started for a local model; kept in global state so it can start again next session. */
export interface ManagedServer {
  backendId: string;
  recipeId: string;
  file: string;
  port: number;
  /**
   * The process serving it, written by the window that started it. Stop Local Models clears it: a record without a pid
   * means nobody should be serving it, so a window that adopted the server does not start it again.
   */
  pid?: number;
}

/** Key of the managed servers in the extension's global state. */
export const MANAGED_KEY = 'localServers';

/** `local-<recipe id>` (plus `-lmstudio`), with dots turned into dashes: backend ids allow only lowercase letters, digits and dashes. */
export function localBackendId(r: Recipe, runtime: LocalRuntime): string {
  const id = `local-${r.id.replaceAll('.', '-')}`;
  return runtime === 'lmStudio' ? `${id}-lmstudio` : id;
}

/** The `aiAutocomplete.backends` entry for a local model served on `127.0.0.1:<port>`. */
export function localBackendEntry(r: Recipe, runtime: LocalRuntime, port: number): Record<string, unknown> {
  const host = `http://127.0.0.1:${port}`;
  const entry: Record<string, unknown> = runtime === 'lmStudio'
    ? { id: localBackendId(r, runtime), kind: 'openai', hostFlavor: 'lmstudio', baseUrl: `${host}/v1` }
    : { id: localBackendId(r, runtime), kind: 'llamacpp', baseUrl: host };
  entry.use = [...r.uses];
  if (r.uses.includes('completions')) entry.fimModel = r.modelName;
  if (r.uses.includes('nextEdit')) entry.nextEditModel = r.modelName;
  return entry;
}

/** Reads the managed servers from global state (untrusted): keeps well-formed entries, drops the rest. */
export function parseManaged(raw: unknown): ManagedServer[] {
  if (!Array.isArray(raw)) return [];
  const out: ManagedServer[] = [];
  for (const e of raw) {
    if (typeof e !== 'object' || e === null) continue;
    const { backendId, recipeId, file, port, pid } = e as Record<string, unknown>;
    if (typeof backendId !== 'string' || typeof recipeId !== 'string' || typeof file !== 'string') continue;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    const validPid = typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
    out.push(validPid ? { backendId, recipeId, file, port, pid } : { backendId, recipeId, file, port });
  }
  return out;
}

/** The managed servers to start now: the ones whose backend still exists and is selected for an enabled use, all only while the extension is on. */
export function serversToStart(managed: ManagedServer[], s: Settings): ManagedServer[] {
  if (!s.enabled) return [];
  const selected = new Set<string>();
  if (s.fim.enabled && s.fim.backendId) selected.add(s.fim.backendId);
  if (s.nextEdit.enabled && s.nextEdit.backendId) selected.add(s.nextEdit.backendId);
  const existing = new Set(s.backends.map((b) => b.id));
  return managed.filter((m) => existing.has(m.backendId) && selected.has(m.backendId));
}

/**
 * What a settings change means for the managed servers. `start`: the ones whose backend became selected (it was not
 * before) and that have no server in this window yet. `stop`: this window's servers (`active`) whose backend was
 * selected before and is not now, or no longer exists. A backend selected before and after is left alone, so a server
 * stopped with Stop Local Models stays stopped, and setup's server (started before its backend is written and
 * selected) is neither stopped nor started twice.
 */
export function selectionChange(managed: ManagedServer[], before: Settings, after: Settings, active: readonly string[]): { start: ManagedServer[]; stop: string[] } {
  const was = new Set(serversToStart(managed, before).map((m) => m.backendId));
  const now = serversToStart(managed, after);
  const isNow = new Set(now.map((m) => m.backendId));
  return {
    start: now.filter((m) => !was.has(m.backendId) && !active.includes(m.backendId)),
    stop: active.filter((id) => was.has(id) && !isNow.has(id)),
  };
}

/** The saved port when `free` gives it back, otherwise the one `free` found instead (`changed`: the backend's URL must follow). */
export async function portFor(saved: number, free: (preferred: number) => Promise<number>): Promise<{ port: number; changed: boolean }> {
  const port = await free(saved);
  return { port, changed: port !== saved };
}
