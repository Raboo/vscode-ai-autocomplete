import * as vscode from 'vscode';
import { planRenameMigration } from '../config/rename';
import type { Log } from '../log';

/**
 * Moves the old `aiAutocomplete.fim.*` settings and backend fields to their new names (see `planRenameMigration`):
 * user settings always, the workspace only when it is trusted. Does nothing when nothing old is set.
 */
export async function migrateRenamedSettings(log: Log): Promise<void> {
  const config = vscode.workspace.getConfiguration('aiAutocomplete');
  const { writes, moved } = planRenameMigration(config, vscode.workspace.isTrusted);
  if (writes.length === 0) return;
  for (const w of writes) {
    const target = w.level === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
    await vscode.workspace.getConfiguration('aiAutocomplete').update(w.key, w.value, target);
  }
  log.info(`settings: moved to new names: ${moved.join('; ')}`);
}

/** Runs the migration once at a time; a request while one runs runs it once more afterwards. Never throws: a failure is logged. */
export function migrationRunner(log: Log): () => void {
  let running = false;
  let again = false;
  const run = (): void => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void migrateRenamedSettings(log)
      .catch((err: unknown) => log.error('settings: moving old setting names failed', err))
      .finally(() => {
        running = false;
        if (again) {
          again = false;
          run();
        }
      });
  };
  return run;
}
