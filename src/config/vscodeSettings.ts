import * as vscode from 'vscode';
import { parseSettings, withFolderValues, type Settings } from './settings';

export function readSettings(): { settings: Settings; problems: string[] } {
  const cfg = vscode.workspace.getConfiguration('aiAutocomplete');
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => vscode.workspace.getConfiguration('aiAutocomplete', f.uri));
  return parseSettings(withFolderValues(cfg, folders));
}
