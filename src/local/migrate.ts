// From one llama-server per local model (backends `local-<recipe>`, records under `localServers`) to the one router
// (backend `local`, record under `localRouter`). Pure: the wiring in vscode/servers.ts applies the plan.
import type { Settings } from '../config/settings';
import { LOCAL_BACKEND_ID } from './backendEntry';

/** Key of the per-model server records the helper kept before the router. */
export const LEGACY_MANAGED_KEY = 'localServers';

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

const OLD_ID = /^local-[a-z0-9-]+$/;
const isEntry = (e: unknown): e is Record<string, unknown> => typeof e === 'object' && e !== null && !Array.isArray(e);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** An entry the helper wrote for one llama-server (`local-<recipe>`); LM Studio entries (`-lmstudio`) are ordinary backends. */
function isOldEntry(e: unknown): e is Record<string, unknown> & { id: string } {
  if (!isEntry(e) || typeof e.id !== 'string') return false;
  return e.id !== LOCAL_BACKEND_ID && OLD_ID.test(e.id) && !e.id.endsWith('-lmstudio') && e.kind === 'llamacpp';
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

/** What the migration does with these user backends, old records and settings. */
export function planMigration(o: { backends: unknown[]; managed: unknown; settings: Settings }): MigrationPlan {
  const old = o.backends.filter(isOldEntry);
  const byId = new Map(old.map((e) => [e.id, e]));
  const stopPids = legacyServers(o.managed)
    .filter((m) => !m.backendId.endsWith('-lmstudio') && m.pid !== undefined)
    .map((m) => m.pid as number);
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
