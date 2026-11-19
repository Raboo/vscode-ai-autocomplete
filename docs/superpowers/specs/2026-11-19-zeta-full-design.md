# Full Zeta 2.1 coverage, and definitions as Next Edit context — design

Date: 2026-11-19. The owner asked to "look at Zed's PyPI bindings and tell me what we are missing for full Zeta 2.1 coverage", then approved closing the gaps and chose approach C (definitions for every format).

## Why

Our Zeta 2.1 prompt matches the model card's layout, but the inputs differ from what the model was trained on (Zed's format `V0318SeedMultiRegions`, read in `zed-zeta-bindings` 1.10.2 for understanding only; no code copied):

- Zed's editable region is about 350 tokens (about 30 lines, cursor in the middle, two or three marker blocks); ours is 16 lines, usually one block.
- Zed keeps only about 150 tokens of the current file outside the region and spends the rest on related files and history; we spend 3/7 of the budget on the current file.
- Zed's history diffs have 3 context lines and real `@@` line numbers; ours have none.
- Zed's related files are definitions of symbols near the cursor (from the language server), cut to outlines with `...` gap lines; ours are 20-line windows of recently viewed files.
- Zeta answers with `<|user_cursor|>` where the cursor should go after the edit; we delete it.

## Goals

- The Zeta 2.1 prompt matches Zed's inputs: region size and marker blocks, context mix, history with context lines, related excerpts with `...`.
- Definitions of symbols near the cursor become Next Edit context for **every** format (Zeta, Sweep, chatXtab), from the language server.
- After accepting a Zeta edit, the cursor goes where Zeta predicted.
- Measure Zeta again with the bench and update the README numbers.

## Non-goals

- Labelling accepted predictions in history, snapping regions to syntax nodes, workspace-folder prefixes on paths, diagnostics or jump prediction (not part of the 2.1 format, or not confirmed for it).
- Changing Sweep's or chatXtab's region, budgets or history rendering. Their only change is the definitions they now receive.

## Anti-goals

- Next Edit getting noticeably slower to ask because of the language server: the lookup has a hard time cap and a cache.
- Sending code from a file the user excluded (`completions.disableInFiles`, `completions.disableInLanguages`), or from other files when extra context is off.
- Copying Zed code. AGENTS.md's Zeta line is reworded to say the format follows the model card and Zed's published bindings, read only.

## Approaches

- A. Zeta-only changes plus definitions for Zeta only.
- B. Zeta-only changes, no definitions (`...` lines on today's snippets).
- **C. Zeta changes, and definitions for every format (chosen by the owner).** Sweep and chatXtab likely gain from definitions too; the cost is that their tested behaviour changes, so the setting below can turn definitions off.

## Decisions

### Zeta region and marker blocks

- The `zeta21` region is sized by characters, not the `regionLinesAbove/Below` settings: starting at the cursor line, lines are added alternately below and above (below first) while the region stays within 1225 chars (350 tokens × 3.5 chars), at most 40 lines; at a file edge the other side keeps growing. A single cursor line longer than the budget is still the whole region (the existing `tooLong` check refuses minified text).
- The two settings' descriptions say they do not apply to Zeta 2.1.
- `CompletionFormat.region` gets the document lines, so a format can size by chars (Sweep and chatXtab ignore them).
- Marker blocks: the region splits into `ceil(lines / 16)` blocks of near-equal size, larger blocks first (31 lines give 16 + 15, as in the card's sample). The blank-line rule goes.

### Zeta context mix

- A format may set its own budget split. `zeta21`: the current file outside the region gets 525 chars (150 tokens), split around the region the way `clipAroundRegion` does but in whole lines, not 10-line pages; the rest of `contextBudget` goes half to history, half to related files.
- Other formats keep `nextEditBudgets`' 3/7, 2/7, 2/7.

### History with context lines (Zeta only)

- Each history entry also keeps a rendering with 3 context lines and real `@@ -a,b +c,d @@` headers, built from the same before/after texts when the entry is recorded or merged. `zeta21` renders `--- a/PATH` / `+++ b/PATH` plus those hunks; the other formats keep the zero-context text.
- The budget and the 6-entry cap stay.

### Definitions as related context (all formats)

- New setting `aiAutocomplete.nextEdit.definitions` (boolean, default true, resource scope): "Send definitions of symbols near the cursor (from the language server) as context." Like recently viewed snippets, definitions are sent only when extra context is on for the backend.
- Before each Next Edit request (and warm-up), the controller looks up definitions:
  - identifiers in the region, nearest to the cursor first, at most 8 distinct names, skipping language keywords is left to the builder (a short per-language list or a length ≥ 3 rule);
  - `vscode.executeDefinitionProvider` at one occurrence of each, in parallel; the whole lookup is abandoned after **100 ms**, keeping what has arrived;
  - results in the current file, in excluded files, in non-`file` schemes, or in files over 1 MB are dropped;
  - each result becomes an excerpt: the innermost document symbol (`vscode.executeDocumentSymbolProvider`) containing the definition. A symbol up to 20 lines is kept whole; a longer one keeps its first line and each child symbol's first line, with `...` for the gaps (an outline, bodies left out). Without a symbol provider, 10 lines from the definition line.
  - Results are cached per (document, version, region) so a repeated trigger costs nothing; target documents' symbols are cached per (uri, version).
- Excerpts of one file merge into one related item in row order, with a `...` line between excerpts and after the last one when the file continues; no leading `...`.
- Related items are definitions first, then recently viewed snippets of other files, within the format's related budget. Zeta writes them as `<filename>PATH` sections, Sweep as `<|file_sep|>PATH`, chatXtab inside its recently viewed block, as today. Recently viewed snippets get the same `...` after them when the file continues (all formats; it is text inside the snippet).
- The pure parts (identifier picking, excerpt shaping, merging, `...` placement) live outside `vscode/` and are unit-tested; the lookup lives in `src/nextEdit/vscode/`.
- Debug log: the number of definitions found, dropped, and the lookup time. Paths and text only with `debug.logPrompts`.

### Predicted cursor (Zeta)

- When the answer contains `<|user_cursor|>` exactly once inside the rewritten text, `FormatAnswer`'s rewrite carries its position (line and character in the new region). More than once, or none: no position.
- After the user accepts the edit (ghost text, native inline edit, or the decoration's Tab), and the document still holds exactly the accepted text at that place, the cursor moves to the predicted position. The chained next request then asks from there.

### Parser

- Markers between the first and last must count up by one. If they don't, the answer is still used from the first and last marker (as today), with a debug line.

### Measurement and docs

- Re-run `scripts/bench/latency.ts` for Zeta with the new prompt; update the README table. The bench builds its region through the format, so it follows the new sizing.
- README "Next Edit" gets a short "Definitions as context" paragraph; ROADMAP gets the row and manual checks; AGENTS.md's `zeta21.ts` line and layout lines are updated.

## Calls made after the builder check (the designer's, not the owner's)

- **Budgets:** `contextBudget` stays the total. For `zeta21`, the history and related budgets are each half of (total chars − 525); `tooLong` for Zeta refuses a region over 2 × 1225 chars (one huge line). The 1000-token minimum leaves room for both.
- **History data:** entries keep the text after the change next to `base` (a merged entry keeps its first `base` and the newest after-text), so the 3-line rendering is rebuilt from both.
- **Definitions cache and prompt stability:** results are cached per (document, region start line, set of identifiers), not per version, so typing inside a word does not change the related section and the server's prompt cache keeps the prefix. A lookup cut at 100 ms caches what arrived; lookups still running fill the cache when they finish, so the next request has them. Entries for a target file drop when that file changes.
- **Predicted cursor:** the held result stores it as a document position (region start + line), only when the shown edit is not trimmed away from it. The controller's existing accept paths (the item's accept command for ghost text and native edits, and the decoration's Tab) check that the document holds the accepted text at the edit's range, move the cursor, and then the chained request asks from there as it already does. `<|user_cursor|>` is always stripped from the new text, as today.
- **Not affected:** the Backends page Test and the bench get no definitions; the decoration and display code does not depend on region size.

## Left to the builder

- Identifier extraction (a regex per word is fine) and the keyword filter.
- How the definition lookup's cache is invalidated beyond version changes.
- Whether the context-line rendering is computed eagerly or on demand.
- Exact wording of the setting and docs.
