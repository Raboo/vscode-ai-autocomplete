import * as vscode from 'vscode';
import type { RecentSnippets } from '../nextEdit/history';
import type { ExtraContextRing } from './context';

const SELECTION_DEBOUNCE_MS = 1000;

/** The path prompts, diffs and snippets name a document by: relative to its workspace folder, led by the folder's name in a multi-root workspace. */
export function docPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri);
}

/** Unsaved files and files inside a workspace folder, in any scheme (a remote window's files are `vscode-remote:`). */
export function inProject(uri: vscode.Uri): boolean {
  return uri.scheme === 'untitled' || vscode.workspace.getWorkspaceFolder(uri) !== undefined;
}

/** Feeds recently viewed/edited regions of open files into the extra-context ring and Next Edit's recent snippets. */
export class ContextTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly ring: ExtraContextRing,
    private readonly isExcluded: (doc: vscode.TextDocument) => boolean,
    private readonly snippets?: RecentSnippets,
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
    // A file opened from outside the workspace is not project context.
    if (!inProject(doc.uri) || this.isExcluded(doc)) return;
    const lines = doc.getText().split(/\r?\n/);
    const path = docPath(doc.uri);
    this.ring.add(path, lines, line);
    this.snippets?.add(path, lines, line);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}
