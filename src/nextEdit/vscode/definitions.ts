import * as vscode from 'vscode';
import { docPath } from '../../completion/contextTracker';
import type { Log } from '../../log';
import type { Snippet } from '../history';
import type { LineSpan } from '../region';
import { excerptFor, mergeExcerpts, pickIdentifiers, RelatedCache, type SymbolNode } from '../related';

/** Files larger than this are never read for a definition. */
const MAX_TARGET_BYTES = 1024 * 1024;
/** Target documents whose symbols are remembered (per version). */
const MAX_SYMBOL_DOCS = 32;

type Found = vscode.Location | vscode.LocationLink;

/** One target file's excerpts, collected as lookups finish. `rank` is the nearest identifier that led to it. */
interface Target {
  path: string;
  lines: string[];
  spans: LineSpan[];
  rank: number;
}

function toNodes(symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[]): SymbolNode[] {
  return symbols.map((s) =>
    'children' in s
      ? { range: { start: s.range.start.line, end: s.range.end.line }, children: toNodes(s.children) }
      : { range: { start: s.location.range.start.line, end: s.location.range.end.line }, children: [] },
  );
}

/** Items in order that fit `budgetChars`; an item over the remaining budget is dropped whole. */
function fit(items: Snippet[], budgetChars: number): Snippet[] {
  let remaining = budgetChars;
  const out: Snippet[] = [];
  for (const s of items) {
    if (s.text.length > remaining) continue;
    remaining -= s.text.length;
    out.push(s);
  }
  return out;
}

/**
 * Definitions of the symbols near the cursor, asked of the language servers, as related snippets for Next Edit. The
 * whole lookup waits at most `capMs`; lookups still running afterwards fill the cache for the next request.
 */
export class DefinitionLookup {
  private cache = new RelatedCache();
  /** Bumped by clear(), so lookups started before it do not fill the new cache. */
  private generation = 0;
  private readonly symbols = new Map<string, { version: number; nodes: SymbolNode[] | undefined }>();
  private readonly excluded: (doc: vscode.TextDocument) => boolean;
  private readonly log: Log;
  private readonly capMs: number;

  constructor(o: { excluded: (doc: vscode.TextDocument) => boolean; log: Log; capMs?: number }) {
    this.excluded = o.excluded;
    this.log = o.log;
    this.capMs = o.capMs ?? 100;
  }

  /** Forgets every result: the settings changed (a file may now be excluded). */
  clear(): void {
    this.cache = new RelatedCache();
    this.symbols.clear();
    this.generation++;
  }

  /** A target file changed: results that quote it are looked up again. */
  forget(path: string): void {
    this.cache.forgetTarget(path);
  }

  async related(doc: vscode.TextDocument, region: LineSpan, cursor: vscode.Position, budgetChars: number): Promise<Snippet[]> {
    const started = Date.now();
    const lines = doc.getText().split(/\r?\n/);
    const ids = pickIdentifiers(lines, region, { line: cursor.line, character: cursor.character });
    if (ids.length === 0) return [];
    const key = this.cache.key(doc.uri.toString(), region.start, ids.map((i) => i.name));
    const cached = this.cache.get(key);
    if (cached) {
      const sent = fit(cached, budgetChars);
      this.log.debug(`next edit definitions: cached, sent=${sent.length} in ${Date.now() - started} ms`);
      return sent;
    }

    const targets = new Map<string, Target>();
    const counts = { found: 0, dropped: 0 };
    const build = (): Snippet[] =>
      [...targets.values()].sort((a, b) => a.rank - b.rank).map((t) => mergeExcerpts(t.path, t.lines, t.spans));
    const self = doc.uri.toString();
    const generation = this.generation;
    const store = (): void => {
      if (this.generation === generation) this.cache.set(key, build());
    };

    const lookups = ids.map(async (id, rank) => {
      try {
        const found = await vscode.commands.executeCommand<Found[] | undefined>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(id.line, id.character));
        for (const f of found ?? []) {
          counts.found++;
          // A file that cannot be read (gone, no permission) is dropped like any other.
          const excerpt = await this.excerpt(f, self).catch(() => undefined);
          if (!excerpt) {
            counts.dropped++;
            continue;
          }
          const t = targets.get(excerpt.uri) ?? { path: excerpt.path, lines: excerpt.lines, spans: [], rank };
          t.spans.push(...excerpt.spans);
          t.rank = Math.min(t.rank, rank);
          targets.set(excerpt.uri, t);
        }
      } catch {
        // A failing provider adds nothing.
      }
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<'cap'>((resolve) => {
      timer = setTimeout(() => resolve('cap'), this.capMs);
    });
    const all = Promise.all(lookups).then(() => 'done' as const);
    // Lookups that finish after the cap still fill the cache, so the next request has them.
    void all.then(store);
    const how = await Promise.race([all, capped]);
    clearTimeout(timer);
    store();
    const items = build();
    const sent = fit(items, budgetChars);
    this.log.debug(
      `next edit definitions: found=${counts.found} dropped=${counts.dropped} sent=${sent.length}${how === 'cap' ? ' (cut)' : ''} in ${Date.now() - started} ms`,
    );
    return sent;
  }

  /** The excerpt for one definition, or undefined when it may not be sent or cannot be read. */
  private async excerpt(f: Found, self: string): Promise<{ uri: string; path: string; lines: string[]; spans: LineSpan[] } | undefined> {
    const uri = 'targetUri' in f ? f.targetUri : f.uri;
    const range = 'targetUri' in f ? (f.targetSelectionRange ?? f.targetRange) : f.range;
    if (uri.scheme !== 'file' || uri.toString() === self) return undefined;
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_TARGET_BYTES) return undefined;
    const target = await vscode.workspace.openTextDocument(uri);
    if (this.excluded(target)) return undefined;
    const line = range.start.line;
    // A stale result: the line is no longer in the document.
    if (line >= target.lineCount) return undefined;
    const lines = target.getText().split(/\r?\n/);
    const symbols = await this.symbolsOf(target);
    return { uri: uri.toString(), path: docPath(uri), lines, spans: excerptFor(lines, symbols, line) };
  }

  /** The target's document symbols, remembered per version; undefined without a symbol provider. */
  private async symbolsOf(doc: vscode.TextDocument): Promise<SymbolNode[] | undefined> {
    const key = doc.uri.toString();
    const known = this.symbols.get(key);
    if (known?.version === doc.version) return known.nodes;
    let nodes: SymbolNode[] | undefined;
    try {
      const found = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>('vscode.executeDocumentSymbolProvider', doc.uri);
      nodes = found && found.length > 0 ? toNodes(found) : undefined;
    } catch {
      nodes = undefined;
    }
    this.symbols.delete(key);
    this.symbols.set(key, { version: doc.version, nodes });
    while (this.symbols.size > MAX_SYMBOL_DOCS) this.symbols.delete(this.symbols.keys().next().value as string);
    return nodes;
  }
}
