// From one llama-server per local model (backends `local-<recipe>`, records under `localServers`) to the one router
// (backend `local`, record under `localRouter`). Pure: the wiring in vscode/servers.ts supplies the reads and writes.
import type { Settings } from '../config/settings';
import type { Log } from '../log';
import { DEFAULT_PORT, LOCAL_BACKEND_ID, localEntryPort, upsertLocalEntry } from './backendEntry';
import { RECIPES, type Recipe } from './recipes';

/** Key of the per-model server records the helper kept before the router. */
export const LEGACY_MANAGED_KEY = 'localServers';
/** Global-state key set once the migration has run: it never runs again. */
export const MIGRATED_KEY = 'localRouterMigrated';

/** An old per-model server record, as far as the migration needs it. */
export interface LegacyServer {
  backendId: string;
  recipeId?: string;
  port: number;
  file?: string;
  pid?: number;
}

export interface MigrationPlan {
  /** Old helper entries to remove from `aiAutocomplete.backends`. */
  removeIds: string[];
  /** The models `local` gets, when an old entry was selected for a use. */
  local?: { model?: string; nextEditModel?: string };
  /** The uses to select `local` for (the old selection was a removed entry). */
  select: { completions?: boolean; nextEdit?: boolean };
  /** Old llama-server processes to stop (by pid, after checking they still serve their port). */
  stopPids: number[];
  /** One line naming what moved; empty when there is nothing to migrate. */
  log: string;
}

const isEntry = (e: unknown): e is Record<string, unknown> => typeof e === 'object' && e !== null && !Array.isArray(e);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const isLmStudio = (id: string): boolean => id.endsWith('-lmstudio');

/** The id the helper gave a recipe's llama-server backend: `local-<recipe id>` with dots turned into dashes. */
export function legacyBackendId(r: Recipe): string {
  return `local-${r.id.replaceAll('.', '-')}`;
}

function onThisMachine(baseUrl: unknown): boolean {
  if (typeof baseUrl !== 'string') return false;
  try {
    const host = new URL(baseUrl).hostname;
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
}

/** The old records (untrusted): well-formed ones only. */
export function legacyServers(raw: unknown): LegacyServer[] {
  if (!Array.isArray(raw)) return [];
  const out: LegacyServer[] = [];
  for (const e of raw) {
    if (!isEntry(e) || typeof e.backendId !== 'string') continue;
    const { port, pid, file, recipeId } = e;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    out.push({
      backendId: e.backendId,
      ...(typeof recipeId === 'string' ? { recipeId } : {}),
      port,
      ...(typeof file === 'string' ? { file } : {}),
      ...(typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    });
  }
  return out;
}

/**
 * What the migration does with these user backends, old records and settings. An entry is the helper's own only when
 * an old record names its id, or when its id is `local-<recipe>` of a known recipe and it points at this machine; a
 * backend the user made (another host, another id) and LM Studio entries (`-lmstudio`) are never touched.
 */
export function planMigration(o: { backends: unknown[]; managed: unknown; settings: Settings; recipes?: readonly Recipe[] }): MigrationPlan {
  const records = legacyServers(o.managed).filter((m) => !isLmStudio(m.backendId));
  const recorded = new Set(records.map((m) => m.backendId));
  const recipeIds = new Set((o.recipes ?? RECIPES).map(legacyBackendId));
  const isOld = (e: unknown): e is Record<string, unknown> & { id: string } => {
    if (!isEntry(e) || typeof e.id !== 'string' || e.id === LOCAL_BACKEND_ID || isLmStudio(e.id) || e.kind !== 'llamacpp') return false;
    return recorded.has(e.id) || (recipeIds.has(e.id) && onThisMachine(e.baseUrl));
  };
  const old = o.backends.filter(isOld);
  const byId = new Map(old.map((e) => [e.id, e]));
  const stopPids = records.filter((m) => m.pid !== undefined).map((m) => m.pid as number);
  const completions = o.settings.fim.backendId !== undefined ? byId.get(o.settings.fim.backendId) : undefined;
  const nextEdit = o.settings.nextEdit.backendId !== undefined ? byId.get(o.settings.nextEdit.backendId) : undefined;
  const model = completions && (str(completions.model) ?? str(completions.fimModel));
  const nextEditModel = nextEdit && (str(nextEdit.nextEditModel) ?? str(nextEdit.model) ?? str(nextEdit.fimModel));

  const select: MigrationPlan['select'] = {
    ...(completions ? { completions: true } : {}),
    ...(nextEdit ? { nextEdit: true } : {}),
  };
  const local = completions || nextEdit ? { ...(model ? { model } : {}), ...(nextEditModel ? { nextEditModel } : {}) } : undefined;
  const removeIds = old.map((e) => e.id);
  if (removeIds.length === 0 && stopPids.length === 0) return { removeIds, select: {}, stopPids, log: '' };

  const parts = [removeIds.length > 0 ? `removed ${removeIds.join(', ')}` : 'no old backends'];
  if (local) parts.push(`local serves ${[model && `completions with ${model}`, nextEditModel && `Next Edit with ${nextEditModel}`].filter(Boolean).join(' and ')}`);
  if (stopPids.length > 0) parts.push(`stopping old llama-server pid ${stopPids.join(', ')}`);
  return { removeIds, ...(local ? { local } : {}), select, stopPids, log: `local models: moved to one router: ${parts.join('; ')}` };
}

/** The reads and writes the migration needs; vscode/servers.ts gives the real ones. */
export interface MigrationIo {
  /** Writes `aiAutocomplete.backends` in user settings. */
  writeBackends(list: unknown[]): Promise<void>;
  /** Selects `local` for a use in user settings. */
  select(use: 'completions' | 'nextEdit'): Promise<void>;
  alive(pid: number): boolean;
  /** Whether the old llama-server still serves the record's port (its `/props` names the record's file or alias). */
  serving(rec: LegacyServer): Promise<boolean>;
  terminate(pid: number): void;
  /** Clears the old records and marks the migration as done. */
  finish(): Promise<void>;
  log: Log;
}

/**
 * Runs the plan: stops the old processes still serving their port, adds `local` (or merges it), selects it, then removes
 * the old entries, in that order so no selection ever names a missing backend; then clears the old records and marks
 * the migration done. `routerPort`: the router record's port, used when `local` does not exist yet.
 */
export async function applyMigration(
  o: { backends: unknown[]; managed: unknown; settings: Settings; recipes?: readonly Recipe[]; routerPort?: number },
  io: MigrationIo,
): Promise<MigrationPlan> {
  const plan = planMigration(o);
  for (const rec of legacyServers(o.managed)) {
    if (rec.pid === undefined || !plan.stopPids.includes(rec.pid) || !io.alive(rec.pid)) continue;
    if (await io.serving(rec)) io.terminate(rec.pid);
  }
  let list = o.backends;
  if (plan.local) {
    list = upsertLocalEntry(list, plan.local, localEntryPort(list) ?? o.routerPort ?? DEFAULT_PORT);
    await io.writeBackends(list);
  }
  if (plan.select.completions) await io.select('completions');
  if (plan.select.nextEdit) await io.select('nextEdit');
  if (plan.removeIds.length > 0) {
    list = list.filter((e) => !(isEntry(e) && typeof e.id === 'string' && plan.removeIds.includes(e.id)));
    await io.writeBackends(list);
  }
  await io.finish();
  if (plan.log) io.log.info(plan.log);
  return plan;
}
