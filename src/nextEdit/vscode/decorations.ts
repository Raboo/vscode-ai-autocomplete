import * as vscode from 'vscode';
import type { DecorationPlan } from '../decorations';

/** The context key the Tab and Esc keybindings read. */
const PENDING_KEY = 'aiAutocomplete.nextEditPending';

/**
 * Draws a Next Edit decoration plan in an editor, for VS Code without the proposed inline-edit API (or with
 * `nextEdit.display` set to decorations), and sets the context key Tab and Esc depend on. Rendering only: the
 * controller decides what is shown and when it is cleared.
 */
export class EditDecorations implements vscode.Disposable {
  private readonly removed = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
  });
  private readonly deleted = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
    textDecoration: 'line-through',
  });
  private readonly added = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorGhostText.foreground'),
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
      margin: '0 0 0 2ch',
    },
  });
  private readonly hint = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorGhostText.foreground'), fontStyle: 'italic', margin: '0 0 0 2ch' },
  });
  private readonly types = [this.removed, this.deleted, this.added, this.hint];
  /** Whether anything is drawn, so clear() only touches editors and the context key when needed. */
  private shown = false;

  show(editor: vscode.TextEditor, plan: DecorationPlan): void {
    this.clear();
    const doc = editor.document;
    const has = (line: number): boolean => line >= 0 && line < doc.lineCount;
    const after = (line: number, text: string): vscode.DecorationOptions => {
      const end = doc.lineAt(line).range.end;
      return { range: new vscode.Range(end, end), renderOptions: { after: { contentText: text } } };
    };
    editor.setDecorations(this.removed, plan.removed.filter((r) => has(r.line)).map((r) => new vscode.Range(r.line, r.start, r.line, r.end)));
    editor.setDecorations(this.deleted, plan.deletedLines.filter(has).map((line) => doc.lineAt(line).range));
    editor.setDecorations(this.added, plan.added.filter((a) => has(a.line)).map((a) => after(a.line, a.text)));
    editor.setDecorations(this.hint, plan.hint.text !== '' && has(plan.hint.line) ? [after(plan.hint.line, plan.hint.text)] : []);
    this.shown = true;
    void vscode.commands.executeCommand('setContext', PENDING_KEY, true);
  }

  clear(): void {
    if (!this.shown) return;
    this.shown = false;
    // Every visible editor: the one drawn on may have been replaced by a new editor object for the same document.
    for (const editor of vscode.window.visibleTextEditors) for (const type of this.types) editor.setDecorations(type, []);
    void vscode.commands.executeCommand('setContext', PENDING_KEY, false);
  }

  dispose(): void {
    this.clear();
    for (const type of this.types) type.dispose();
  }
}
