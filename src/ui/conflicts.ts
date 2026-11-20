import * as vscode from 'vscode';
import { activeConflicts } from '../config/conflicts';

const DISMISSED_KEY = 'aiAutocomplete.conflicts.dismissed';
const DOC_URL = 'https://github.com/Raboo/vscode-ai-autocomplete/blob/main/docs/conflicts.md';
const FIX = 'How to fix';
const DISMISS = "Don't show again";

/** Warns once per extension and session when another extension also offers inline suggestions. */
export function watchConflicts(context: vscode.ExtensionContext): void {
  const shown = new Set<string>();
  const check = (): void => {
    const dismissed = new Set(context.globalState.get<string[]>(DISMISSED_KEY, []));
    const found = activeConflicts(
      // Extensions shipped with VS Code (Copilot Chat in current versions) live under the app root.
      vscode.extensions.all.map((e) => ({ id: e.id, isActive: e.isActive, builtIn: e.extensionUri.fsPath.startsWith(vscode.env.appRoot) })),
      (key) => {
        const i = key.lastIndexOf('.');
        // Keys like "github.copilot.enable" are read as section "github.copilot", key "enable"; try the longest section first.
        for (let dot = i; dot > 0; dot = key.lastIndexOf('.', dot - 1)) {
          const v = vscode.workspace.getConfiguration(key.slice(0, dot)).get(key.slice(dot + 1));
          if (v !== undefined) return v;
        }
        return undefined;
      },
      dismissed,
      (key) => {
        // Only values the user set count, not the default.
        const i = vscode.workspace.getConfiguration().inspect(key);
        return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
      },
    ).filter((c) => !shown.has(c.id));
    for (const c of found) {
      shown.add(c.id);
      void vscode.window
        .showInformationMessage(`${c.name} also offers inline suggestions, so they may compete with AI Autocomplete.`, FIX, DISMISS)
        .then((choice) => {
          if (choice === FIX) void vscode.env.openExternal(vscode.Uri.parse(DOC_URL));
          else if (choice === DISMISS) {
            const now = new Set(context.globalState.get<string[]>(DISMISSED_KEY, []));
            now.add(c.id);
            void context.globalState.update(DISMISSED_KEY, [...now]);
          }
        });
    }
  };
  context.subscriptions.push(vscode.extensions.onDidChange(check));
  check();
}
