import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

/** Time for the extension's onDidChangeConfiguration handler to rebuild its backends. */
export const SETTLE_MS = 200;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `cond` every 50 ms; resolves whether it became true within `timeoutMs`. */
export async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
  return true;
}

export async function configure(values: Record<string, unknown>): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('aiAutocomplete');
  for (const [key, value] of Object.entries(values)) await cfg.update(key, value, vscode.ConfigurationTarget.Global);
  await sleep(SETTLE_MS);
}

/** Resets `keys` in the user settings, as each suite's teardown does for the settings its tests write. */
export async function unconfigure(keys: string[]): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('aiAutocomplete');
  for (const key of keys) await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
  await sleep(SETTLE_MS);
}

export async function showAtEnd(doc: vscode.TextDocument): Promise<vscode.TextEditor> {
  const editor = await vscode.window.showTextDocument(doc);
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  editor.selection = new vscode.Selection(end, end);
  return editor;
}

/** URIs of the documents VS Code asked for inline completions, recorded by the probe provider a suite registers. */
const asked = new Set<string>();

/**
 * Registers the probe that fills `asked`. Register it once per suite: adding or removing a provider while a request runs
 * could disturb the extension's request.
 */
export function registerProbe(): vscode.Disposable {
  return vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, {
    provideInlineCompletionItems: (doc) => {
      asked.add(doc.uri.toString());
      return [];
    },
  });
}

export const clearAsked = (): void => asked.clear();

/**
 * Triggers inline suggestions and fails unless VS Code asked for them in `editor`. Editor commands run on the editor
 * with text focus, which need not be the active one: while the window has no OS focus, an editor focused earlier keeps it.
 */
export async function trigger(editor: vscode.TextEditor): Promise<void> {
  // VS Code does not ask again for an unchanged document it already has an answer for: an edit and its undo bump the version.
  await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
  const end = editor.selection.active;
  await editor.edit((b) => b.insert(end, ' '));
  await editor.edit((b) => b.delete(new vscode.Range(end, end.translate(0, 1))));
  asked.delete(editor.document.uri.toString());
  await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
  const uri = editor.document.uri.toString();
  assert.ok(await waitFor(() => asked.has(uri), 2000), `the trigger did not reach ${uri}; VS Code asked for ${JSON.stringify([...asked])}`);
}

export const commit = (): Thenable<unknown> => vscode.commands.executeCommand('editor.action.inlineSuggest.commit');

/** Commits the ghost text every 50 ms until `cond` holds for the document text or 5 s pass (a commit with no ghost text does nothing). */
export async function commitWhen(editor: vscode.TextEditor, cond: (text: string) => boolean): Promise<void> {
  await waitFor(() => {
    void commit();
    return cond(editor.document.getText());
  }, 5000);
}
