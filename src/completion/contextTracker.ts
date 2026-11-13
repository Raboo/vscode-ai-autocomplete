import * as vscode from 'vscode';
import type { ExtraContextRing } from './context';

const SELECTION_DEBOUNCE_MS = 1000;

/** Feeds recently viewed/edited regions of open files into the extra-context ring. */
export class ContextTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly ring: ExtraContextRing,
    private readonly isExcluded: (doc: vscode.TextDocument) => boolean,
  ) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e) this.capture(e.document, e.selection.active.line);
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const e = vscode.window.visibleTextEditors.find((x) => x.document === doc);
        this.capture(doc, e?.selection.active.line ?? 0);
      }),
      vscode.window.onDidChangeTextEditorSelection((ev) => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.capture(ev.textEditor.document, ev.selections[0].active.line), SELECTION_DEBOUNCE_MS);
      }),
    );
  }

  private capture(doc: vscode.TextDocument, line: number): void {
    if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') return;
    if (this.isExcluded(doc)) return;
    const lines = doc.getText().split(/\r?\n/);
    this.ring.add(vscode.workspace.asRelativePath(doc.uri, false), lines, line);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}
