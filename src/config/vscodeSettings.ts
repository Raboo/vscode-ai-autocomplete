import * as vscode from 'vscode';
import { parseSettings, type Settings } from './settings';

export function readSettings(): { settings: Settings; problems: string[] } {
  const cfg = vscode.workspace.getConfiguration('aiAutocomplete');
  return parseSettings({ inspect: (key) => cfg.inspect(key) });
}
