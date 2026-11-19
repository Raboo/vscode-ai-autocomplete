import * as vscode from 'vscode';
import { planRenameMigration } from '../config/rename';
import type { Log } from '../log';

/**
 * Moves the old `aiAutocomplete.fim.*` keys in user settings to their new names (see `planRenameMigration`). Workspace and
 * folder settings are never written: old keys there are named in one log line (once per set of keys). Backend entries
 * are left alone. Does nothing when nothing old is set.
 */
export function userSettingsMigration(log: Log): () => Promise<void> {
  let lastWorkspaceOld = '';
  return async () => {
    const config = vscode.workspace.getConfiguration('aiAutocomplete');
    const { writes, moved, workspaceOld } = planRenameMigration(config);
    const named = workspaceOld.map((k) => `aiAutocomplete.${k}`).join(', ');
    if (named !== '' && named !== lastWorkspaceOld) {
      log.info(`settings: workspace settings still use old names (read until 2.0, not changed by the extension): ${named}`);
    }
    lastWorkspaceOld = named;
    if (writes.length === 0) return;
    for (const w of writes) await vscode.workspace.getConfiguration('aiAutocomplete').update(w.key, w.value, vscode.ConfigurationTarget.Global);
    log.info(`settings: moved to new names in user settings: ${moved.join('; ')}`);
  };
}

/** Runs the migration once at a time; a request while one runs runs it once more afterwards. Never throws: a failure is logged. */
export function migrationRunner(log: Log): () => void {
  const migrate = userSettingsMigration(log);
  let running = false;
  let again = false;
  const run = (): void => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void migrate()
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
