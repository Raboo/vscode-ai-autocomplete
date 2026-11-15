# Phase 3a: Next Edit core, chatXtab and the native display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Next Edit suggestions from a chat model (Qwen3.8 on Strata first). After an edit, the model rewrites a small region around the cursor. A pure insertion at the cursor shows as ghost text in any VS Code. Any other edit shows in VS Code's native inline-edit UI when the user has opted in to the proposed API.

**Architecture:**
- **New pure modules under `src/nextEdit/`, unit-tested with vitest:**
  - `history.ts`: edit-diff history and recently viewed snippets;
  - `region.ts`: the editable region, and clipping the current file to whole 10-line pages;
  - `formats/chatXtab.ts`: the prompt (our own wording, with Copilot/Mercury tag names) and the answer parser;
  - `diff.ts`: the old region vs the new region as one line edit, filters, and whether it shows as ghost text or as an inline edit;
  - `trigger.ts`: when to ask (after an edit pause or a cursor move) and the cooldowns;
  - `request.ts`: one Next Edit request over the backend's chat stream, failing fast on thinking;
  - `optIn.ts`: the argv.json path and edit for the native-UI opt-in.
- **Arbitration with FIM (spec: "one registered provider"):** the existing `FimProvider` returns a fresh Next Edit result for the document version when there is one, otherwise FIM as today. A Next Edit request after typing is sent only when FIM had nothing for that version ("FIM wins"). A cursor move within 10 s of an edit asks Next Edit directly.
- **VS Code side:** `src/nextEdit/vscode/controller.ts` listens to document, selection and editor events, records history, applies the trigger rules, runs requests and holds the latest result. When a fresh result arrives, it runs `editor.action.inlineSuggest.trigger`, because VS Code never asks providers again on a cursor move alone (research).
- **Display:**
  - Ghost text (stable API) for an edit that is a pure insertion at the cursor.
  - Everything else is an `InlineCompletionItem` with `isInlineEdit: true`, from the proposed API `inlineCompletionsAdditions`, shown only when the proposal is enabled.
  - A registration probe decides which: registering with `metadata` throws without the proposal.
  - Without the proposal, such edits are dropped, and a one-time notice offers the opt-in command. The decoration fallback is Phase 3b.

**Tech Stack:** TypeScript ~6.0.3, esbuild, vitest, eslint, `@vscode/test-cli`. New runtime dependencies, both allowed by the spec ("Runtime dependencies: only `diff` (jsdiff, BSD-3) … and `jsonc-parser` (MIT)"): `diff@^9.0.0` (ships its own types) and `jsonc-parser@^3.3.1`. Both are bundled by esbuild.

**Spec:** `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md`, sections "Approaches considered for Next Edit display", "Next Edit pipeline", "Sampling presets" (NES rows) and "Settings and security"; Phase 3 in "Phases". Read them.

**Research behind this plan** (findings marked **(research)** go into the spec in Task 12):
- VS Code at `release/1.146` (`69047191fc427f2f92828279aae1d90d8eeda7ab`) and `release/1.100` (`258e40fedc6cb8edf399a463ce3a9d32e7e1f6f3`):
  - Stable 1.146 has no inline-edit API. A stable item's `range` "Must begin and end on the same line". A multi-line range does not throw; it is simply never shown.
  - Without the proposal, `registerInlineCompletionItemProvider` throws synchronously when `metadata` is passed, or when the provider defines `handleDidShowCompletionItem` or `handleDidPartiallyAcceptCompletionItem`. Everything else is silently ignored; `isInlineEdit` becomes false and the item turns into ghost text.
  - An extension that declares `enabledApiProposals` without being allowed still activates; VS Code logs an ERROR.
  - argv.json `"enable-proposed-api": [ids]` works for any extension id on Stable and needs a full restart. Extension development mode on Stable does not enable proposals.
  - `isInlineEdit: true` alone makes an inline edit, with any range. Only one edit is kept, and a visible ghost-text item hides it.
  - Tab jumps to an edit more than one line from the cursor; a second Tab accepts. `showRange` is not used by the 1.146 editor.
  - Providers are asked again only on typing, explicit triggers and the provider's (proposed) `onDidChange`, never on cursor moves alone.
  - Plain `vsce package` does not check `enabledApiProposals`; only `vsce publish` does.
  - `@vscode/test-cli` configs take `launchArgs` and a `label`.
  - `isInlineEdit`, `handleEndOfLifetime` (with `InlineCompletionEndOfLifeReasonKind` Accepted 0, Rejected 1, Ignored 2) and `metadata.displayName` exist in both 1.100 and 1.146, so no VS Code version gate is needed.
- Copilot xtab (microsoft/vscode `extensions/copilot` @ `0fbab1451fed17c969feb57b0ab596adf895ba0b`, MIT) and Kilo Code NES (Kilo-Org/kilocode @ `cf41438e82da98e75cc97ef0eb9a6fea1c0ddcfa`, MIT). We take ideas and numbers only and copy no code or prompt text:
  - Copilot: one system message plus one user message with the tags; the current file clipped to whole 10-line pages; diffs as `--- path` / `+++ path` / `@@` hunks with no context, oldest first. Selection-change triggers need an edit within 10 s, with a 5 s same-line cooldown and a 5 s cooldown after a rejection.
  - Kilo: a region 5 lines above and 10 below the cursor, capped at 25; history diffs after 1500 ms idle, at most 5; a missing closing fence means a truncated answer, which is dropped; the next request is chained 60 ms after an accept.
- Live probe on the user's Strata (Qwen3.8, thinking off, the prompt of Task 4, a circle module where `r` was renamed to `radius` in one function):
  - The model carried the rename into the next function. The larger region also caught `circle_diameter`.
  - 2.6–3.0 s with a cold cache for both an 8-line and a 15-line region (472–489 prompt tokens, 40–57 completion tokens). Reading the prompt dominates, so the spec's region size stays.
  - Blank lines at the region's edges are echoed exactly, so the parser keeps them.

**Branch:** a local branch `feat/next-edit` from `main` (already created; this plan is its first commit). Tasks never push. The Publish section does that, after the user says yes.

## Global Constraints

- **Imports:**
  - Only these files may `import 'vscode'`: `src/extension.ts`, `src/log.ts`, `src/config/vscodeSettings.ts`, `src/config/secrets.ts`, `src/completion/provider.ts`, `src/completion/contextTracker.ts`, `src/ui/*`, and **(new, Task 7)** `src/nextEdit/vscode/*`. Task 12 updates the list in AGENTS.md.
  - Every other module this plan creates is pure.
- **Runtime dependencies:** exactly `diff` and `jsonc-parser` (`test/unit/manifest.test.ts` pins the list). Both are bundled into `dist/extension.js`, and `THIRD_PARTY_NOTICES.md` gets their license texts (Task 12).
- **Privacy:**
  - No telemetry. Next Edit requests go only to the backend chosen in `aiAutocomplete.nextEdit.backend`.
  - `privacy.localOnly` applies to that backend as it does to the FIM backend.
  - Nothing from a file that completions may not use goes into a request: files matching `fim.disableInFiles`, languages in `fim.disableInLanguages`, files outside the workspace (untitled files are allowed, as for extra context).
  - Diffs and snippets of **other** files are sent only while `fim.extraContext` is on, as extra context is today. The current file's own diffs are always sent.
  - Prompt, answer and reasoning text and server error bodies are logged only when `aiAutocomplete.debug.logPrompts` is true. Timings, sizes, status codes, model ids and outcome kinds are always fine at debug level.
  - The git-ignored `.env` is never read, logged or copied; tests use mocks.
- **No copied prompts:** the chatXtab system prompt and instructions are our own wording (Task 4 fixes the text). Only the tag names come from Copilot/Mercury. A test pins that the prompt contains none of the Copilot phrases `would have made next` or `Your revised code goes here`.
- **Upstream code:** the pinned proposal `.d.ts` (Task 9) is a copy of a Microsoft MIT file. It starts with `// Portions adapted from microsoft/vscode src/vscode-dts/vscode.proposed.inlineCompletionsAdditions.d.ts @ 69047191fc427f2f92828279aae1d90d8eeda7ab (MIT). Copyright Microsoft Corporation.` above the original header, and THIRD_PARTY_NOTICES gets a microsoft/vscode entry.
- **Versions:** `engines.vscode` stays `^1.100.0` and `@types/vscode` stays `~1.100.0`. The proposal file is pinned from `release/1.146`, and the code uses only `isInlineEdit`, `handleEndOfLifetime`, `InlineCompletionEndOfLifeReasonKind` and `metadata.displayName`, which exist in both.
- **Settings scopes:** `nextEdit.backend` is workspace-overridable, but only to choose among configured backend ids (as `fim.backend`). `nextEdit.enabled` and `nextEdit.timeoutMs` are resource settings.
- **Commits:** Conventional Commits, one per task with the message given. AI-authored commits end with `Co-Authored-By: <model> <noreply@anthropic.com>`. Stage files by explicit path; never stage `*.swp` or `.env`.

## Rulings made while planning (each cheap to change)

1. **Phase 3 is split.** 3a (this plan) is core + chatXtab + native display + ghost text. 3b (a later plan) adds the `sweep` and `zeta21` formats and the decoration fallback; those need their own research into prompt layouts and licenses. *If wrong:* 3b's tasks move here.
2. **Next Edit is off until a backend is chosen.** `nextEdit.backend` has no default (unlike `fim.backend`, which falls back to the first backend), so FIM-only users send no extra requests. *If wrong:* default to the FIM backend.
3. **FIM wins.** After typing, Next Edit asks only when FIM's result for that document version was empty, or when FIM is not active for the document. A cursor move within 10 s of an edit asks Next Edit directly. This also keeps the two from competing for one server. *If wrong:* request both and prefer Next Edit, as the spec's arbitration sentence could also be read.
4. **Only chat-capable backends serve Next Edit in 3a** (`routes().chat`). Others log once and send nothing. *If wrong:* nothing to undo; 3b adds raw-prompt formats.
5. **The Next Edit model** is the backend's `nextEditModel`, else its `fimModel`, else the detected model. Thinking and extraBody follow the backend's settings when it is the same model as FIM; otherwise they come from the model's preset and modelOverrides. Sampling is the spec's NES chat row (temperature 0.2, top_p 0.8, top_k 20, presence_penalty 0).
6. **Deadline:** `aiAutocomplete.nextEdit.timeoutMs`, default 10 000 ms (500–60 000). Next Edit runs in the background and a late answer for an old version is dropped anyway, while the live probe took ~3 s cold for a small prompt. *If wrong:* lower the default.
7. **Settings deferred to 3b** (the spec lists them): `nextEdit.format` (only chatXtab exists), `nextEdit.display` (only native exists), region size, history size and context budget, which stay constants here. *If wrong:* add the settings; the constants are named for that.
8. **Failures are logged, not put in the status bar** (the status bar stays FIM's). A thinking model and a request error each also show a one-time notification per backend and kind, with "Show Log". The shared per-backend backoff applies. *If wrong:* add a Next Edit state to the status bar.
9. **Showing a fresh result uses `editor.action.inlineSuggest.trigger`** in both modes, not the proposed `onDidChange`, so there is one code path. *If wrong:* fire `onDidChange` when native.
10. **The region is 5 lines above and 10 below, capped at 25** (spec, Kilo). Copilot's 2/5 was no faster on the live probe.
11. **Edit-pause delay: 400 ms** after the last change. Selection triggers are not debounced; the same-line cooldown limits them.
12. **Display classification:** ghost text only for a pure insertion at the cursor, including lines inserted right after the cursor line when the cursor is at its end. Copilot's "rebase as replace-to-end-of-line" is not done in 3a.
13. **The history merges per area:** a new diff whose first hunk starts on the same line as the newest entry's first hunk, in the same file, replaces that entry with one diff from the older snapshot. This is Copilot's "SameStartLine". Hunks use standard 1-based unified-diff numbering.

## Review Focus

1. **The user keeps typing while a request runs:** a result is shown only for the exact document version it was computed for. The controller drops its result on every change, and VS Code asks the provider again on every text change, so a stale item is replaced. We have no hook right before VS Code applies a native inline edit. The window between an edit appearing and Tab, in which VS Code may have shifted its range, is a follow-up and a smoke-test step. Tests: Task 6 (stale snapshot), Task 7 (a change clears the result), Task 8 (`itemFor` returns nothing for another version).
2. **Sensitive and excluded files:** a `.env` file (default `disableInFiles`), a disabled language or a file outside the workspace never gets a history entry, a snippet or a request. With `fim.extraContext` off, other files' diffs and snippets are not sent. Tests: Task 2 (path filter hook), Task 7 (gate), Task 11 (an excluded file sends no request).
3. **CRLF documents:** lines are split on `\r?\n`, edits are computed on lines, and inserted or replaced text uses the document's EOL. Test: Task 5 (`toItemText` with `\r\n`), Task 8.
4. **Malformed answers:**
   - prose without a fence;
   - a fence that never closes (truncated);
   - `<|cursor|>` or the tags echoed back;
   - `NO_CHANGE` / `<NO_CHANGE>`;
   - an echo identical to the region;
   - an answer much longer than the region.

   None may produce an edit outside the region. Tests: Task 4 and Task 5.
5. **File edges:** the cursor on line 0 or the last line, an empty file, a file without a trailing newline, an edit that deletes the region's last lines at the end of the file. Regions and ranges stay inside the document. Tests: Task 3 and Task 5.

---

### Task 1: Next Edit settings and values

**Files:**
- Modify: `src/config/settings.ts` (the `Settings` type and `parseSettings`), `package.json` (`contributes.configuration`), `src/completion/effective.ts`
- Test: `test/unit/settings.test.ts`, `test/unit/effective.test.ts`

**Interfaces:**
- Produces:
  - `Settings.nextEdit: { enabled: boolean; backendId?: string; timeoutMs: number }`;
  - `export const DEFAULT_NEXT_EDIT_TIMEOUT_MS = 10_000` and `export const NEXT_EDIT_SAMPLING = { temperature: 0.2, topP: 0.8, topK: 20 }` in `effective.ts`;
  - `export function nextEditModel(backend: BackendConfig, detected: string | undefined): string | undefined`;
  - `export function resolveNextEdit(backend: BackendConfig, model: string | undefined, s: Settings): FimValues`, which returns `resolveFim`'s values with `sampling` replaced by `NEXT_EDIT_SAMPLING` (unless `samplingParams === 'omit'`) and `timeoutMs` set to `s.nextEdit.timeoutMs`.

- [x] **Step 1: Write the failing tests**

In `settings.test.ts`:
- `nextEdit defaults: enabled, no backend, 10 s`: an empty source gives `{ enabled: true, timeoutMs: 10000 }` and no `backendId`.
- `nextEdit.backend chooses among configured ids`: with backends `a` and `b`, a workspace value `b` gives `backendId: 'b'`; an unknown id `c` gives no `backendId` and the problem `aiAutocomplete.nextEdit.backend: no backend with id "c"; Next Edit is off`.
- `nextEdit.timeoutMs out of range is ignored`: `100` gives `10000` and a problem naming `aiAutocomplete.nextEdit.timeoutMs`.

In `effective.test.ts`:
- `nextEditModel prefers nextEditModel, then fimModel, then the detected model`.
- `resolveNextEdit uses the NES chat sampling and the Next Edit deadline`: for a Strata backend with model `qwen3.8-flash-next-iq3_s`, expect `sampling` to equal `{ temperature: 0.2, topP: 0.8, topK: 20 }` and `timeoutMs` to equal `10000`.
- `resolveNextEdit keeps the backend thinking switch only for the FIM model`:
  - backend `fim.thinking: 'reasoningEffortNone'` and no `nextEditModel`: `thinking` is `'reasoningEffortNone'`;
  - with `nextEditModel: 'qwen3-8b'`: `thinking` is that preset's `'templateKwarg:enable_thinking'`.
- `resolveNextEdit keeps omitted sampling omitted`: a preset with `samplingParams: 'omit'` keeps it.

- [x] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/settings.test.ts test/unit/effective.test.ts`
Expected: FAIL (`nextEdit` undefined, `resolveNextEdit` not exported).

- [x] **Step 3: Implement**

- **`parseSettings`:** read `nextEdit.enabled` (resource, default `true`), `nextEdit.backend` (resource; no fallback to the first backend; the problem text above) and `nextEdit.timeoutMs` (resource, default `DEFAULT_NEXT_EDIT_TIMEOUT_MS`, kept only when an integer in 500–60000, the same limits as `FIM_LIMITS.timeoutMs`).
- **package.json:**
  - `aiAutocomplete.nextEdit.enabled`: boolean, default `true`, "Show Next Edit suggestions when a Next Edit backend is chosen.".
  - `aiAutocomplete.nextEdit.backend`: string, default `""`, "Backend for Next Edit suggestions (an id from aiAutocomplete.backends). Empty: Next Edit is off.".
  - `aiAutocomplete.nextEdit.timeoutMs`: integer 500–60000, default `10000`, "Deadline for one Next Edit request.".
- **`resolveNextEdit`:** when `backend.nextEditModel` is set and differs from `backend.fimModel`, resolve with `{ ...backend, fim: backend.fim?.extraBody ? { extraBody: backend.fim.extraBody } : undefined }`; otherwise resolve with `backend` as is.

- [x] **Step 4: Run them and see them pass**

Run: `npx vitest run test/unit/settings.test.ts test/unit/effective.test.ts`, then `npm run typecheck`
Expected: PASS, no type errors.

- [x] **Step 5: Commit**

```bash
git add src/config/settings.ts src/completion/effective.ts package.json test/unit/settings.test.ts test/unit/effective.test.ts
git commit -m "feat: Next Edit settings and per-backend values"
```

### Task 2: Edit history and recent snippets

**Files:**
- Modify: `package.json` (`"dependencies": { "diff": "^9.0.0" }`, then `npm install`), `package-lock.json`, `test/unit/manifest.test.ts`
- Create: `src/nextEdit/history.ts`
- Test: `test/unit/nextEdit/history.test.ts`

**Interfaces:**
- Produces (all in `history.ts`):
  - `export interface DiffEntry { path: string; text: string }`, where `text` is the rendered diff;
  - `export class EditHistory`:
    - `constructor(o?: { maxEntries?: number })` (default 5);
    - `open(path: string, text: string): void`: snapshot only;
    - `commit(path: string, text: string): void`: diff the snapshot against `text` and record it; the snapshot becomes `text`. With no snapshot, only the snapshot is taken;
    - `close(path: string): void`, `clear(): void`;
    - `entries(filter?: (path: string) => boolean): DiffEntry[]`, oldest first;
  - `export function renderDiff(path: string, before: string, after: string): string | undefined`: hunks with no context, `undefined` when equal;
  - `export interface Snippet { path: string; text: string }`;
  - `export class RecentSnippets`:
    - `constructor(o?: { max?: number; lines?: number })` (defaults 5 and 20);
    - `add(path: string, lines: string[], centerLine: number): void`;
    - `pick(excludePath: string, budgetChars: number): Snippet[]`, oldest first.

- [x] **Step 1: Write the failing tests**

- `renderDiff renders zero-context hunks with 1-based numbers`: before `a\nb\nc\n`, after `a\nB\nc\n` gives exactly `--- f.py\n+++ f.py\n@@ -2,1 +2,1 @@\n-b\n+B`.
- `renderDiff of equal texts is undefined`.
- `renderDiff treats CRLF and LF lines alike` (`a\r\nb` vs `a\nb` is `undefined`).
- `commit without a snapshot only snapshots`: `entries()` stays empty.
- `entries are oldest first and capped at 5`: 7 commits to different lines of a file give 5 entries, the first two dropped.
- `same-start-line edits merge into one entry`:
  - `open('f', 'x = 1\n')`, `commit('f', 'x = 12\n')`, `commit('f', 'x = 123\n')` give one entry, `@@ -1,1 +1,1 @@\n-x = 1\n+x = 123`;
  - a later commit on another line adds a second entry.
- `entries(filter) drops other files`: entries for `a` and `b`; `entries((p) => p === 'a')` returns only `a`'s.
- `RecentSnippets keeps one snippet per file, newest last, at most 5`: re-adding a path moves it to the end.
- `RecentSnippets trims to 20 lines around the center line`.
- `RecentSnippets.pick skips the excluded path and keeps the newest that fit the budget, returned oldest first`.
- In `manifest.test.ts`, the dependency list is `['diff']`.

- [x] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/nextEdit/history.test.ts test/unit/manifest.test.ts`
Expected: FAIL (module not found; the manifest test expects `['diff']`).

- [x] **Step 3: Implement**

- Use `structuredPatch(path, path, before, after, '', '', { context: 0 })` from `diff`, after normalizing `\r\n` to `\n`. Render each hunk as `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@` followed by its lines, and join with `\n`.
- Merging (Ruling 13): keep, for the newest entry, the snapshot it started from and the first hunk's `oldStart`. When the next commit for the same path starts its first hunk on that line, re-render from that older snapshot and replace the entry.

- [x] **Step 4: Run them and see them pass**

Run: `npx vitest run test/unit/nextEdit/history.test.ts test/unit/manifest.test.ts && npm run build`
Expected: PASS; the build bundles `diff`.

- [x] **Step 5: Commit**

```bash
git add package.json package-lock.json src/nextEdit/history.ts test/unit/nextEdit/history.test.ts test/unit/manifest.test.ts
git commit -m "feat: Next Edit edit history and recent snippets"
```

### Task 3: Editable region and current-file clipping

**Files:**
- Create: `src/nextEdit/region.ts`
- Test: `test/unit/nextEdit/region.test.ts`

**Interfaces:**
- Produces:
  - `export const REGION_ABOVE = 5, REGION_BELOW = 10, REGION_MAX_LINES = 25, PAGE_LINES = 10`;
  - `export interface LineSpan { start: number; end: number }` (0-based, inclusive);
  - `export function editableRegion(cursorLine: number, lineCount: number): LineSpan`;
  - `export function clipAroundRegion(lines: string[], region: LineSpan, budgetChars: number): LineSpan`.

- [x] **Step 1: Write the failing tests**

- `region is 5 above and 10 below the cursor`: `editableRegion(20, 100)` is `{ start: 15, end: 30 }`.
- `region stays inside the file`:
  - `editableRegion(0, 3)` is `{ start: 0, end: 2 }`;
  - `editableRegion(99, 100)` is `{ start: 94, end: 99 }`;
  - `editableRegion(0, 1)` is `{ start: 0, end: 0 }`.
- `clip keeps whole 10-line pages around the region`: 100 lines of 9 chars (10 with the newline), region 42–47, budget 400 gives `{ start: 30, end: 59 }`: page 40–49, then one page above and one below.
- `clip gives leftover budget from above to below`: region 2–7 near the top of a 100-line file, budget 400, gives `{ start: 0, end: 29 }`.
- `clip never cuts the region`: a budget smaller than the region returns the region itself.

- [x] **Step 2: Run it and see it fail**

Run: `npx vitest run test/unit/nextEdit/region.test.ts`
Expected: FAIL (module not found).

- [x] **Step 3: Implement**

- `editableRegion`: start = max(0, cursor − 5); end = min(lastLine, cursor + 10); when longer than 25 lines, trim from the bottom.
- `clipAroundRegion`: snap the region outward to whole pages (the first page starts at `floor(start / 10) * 10`, the last ends at `min(lastLine, floor(end / 10) * 10 + 9)`). Each line counts `length + 1` chars. Split the remaining budget: half for pages above, the other half plus whatever above did not use for pages below. Add the nearest page first, and stop on each side at the first page that does not fit.

- [x] **Step 4: Run it and see it pass**

Run: `npx vitest run test/unit/nextEdit/region.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/nextEdit/region.ts test/unit/nextEdit/region.test.ts
git commit -m "feat: Next Edit region and page clipping"
```

### Task 4: chatXtab prompt and answer parser

**Files:**
- Create: `src/nextEdit/formats/chatXtab.ts`
- Test: `test/unit/nextEdit/chatXtab.test.ts`

**Interfaces:**
- Consumes:
  - `DiffEntry`, `Snippet` (Task 2); `LineSpan`, `clipAroundRegion` (Task 3);
  - `ChatMessage` (`src/backends/types.ts`); `CURSOR_MARKER`, `PIN_BACK_LINES` (`src/completion/holeFiller.ts`); `CHARS_PER_TOKEN` (`effective.ts`).
- Produces:
  - `export interface NextEditInput { path: string; lines: string[]; cursor: { line: number; character: number }; region: LineSpan; history: DiffEntry[]; snippets: Snippet[] }`;
  - `export const CHAT_XTAB_SYSTEM: string`;
  - `export const FILE_BUDGET_CHARS = 5250, HISTORY_BUDGET_CHARS = 3500, SNIPPETS_BUDGET_CHARS = 3500` (1500, 1000 and 1000 tokens × 3.5);
  - `export function chatXtabMessages(i: NextEditInput, systemSuffix?: string): { messages: ChatMessage[]; stableChars: number }`;
  - `export type ChatXtabAnswer = { kind: 'rewrite'; lines: string[] } | { kind: 'noChange' } | { kind: 'invalid'; why: 'noFence' | 'truncated' }`;
  - `export function parseChatXtab(text: string, complete: boolean): ChatXtabAnswer`;
  - `export function chatXtabDone(text: string): boolean`: true once a closing fence follows an opening one, or the text is a no-change answer.

**The system prompt** is exact copy; it is the wording the live probe used:

```
You predict the next edit a developer will make in a code file.
You get: code the developer viewed recently (oldest first), the current file, the developer's recent edits as unified diffs (oldest first), and the code to edit, with the cursor marked <|cursor|>.
Rewrite the code between <|code_to_edit|> and <|/code_to_edit|> the way the developer would continue: finish what they started, and make the same change where it is still missing. Leave everything else exactly as it is, including indentation.
Answer with the rewritten code in one ``` block, without the tags and without <|cursor|>. If nothing should change, answer NO_CHANGE.
```

**The user message** is these blocks in this order, from most to least stable for prompt caches. A block with nothing in it is left out, and blocks are joined by one blank line:

```
<|recently_viewed_code_snippets|>
<|recently_viewed_code_snippet|>
code_snippet_file_path: {path}
{text}
<|/recently_viewed_code_snippet|>
… (oldest first, within SNIPPETS_BUDGET_CHARS)
<|/recently_viewed_code_snippets|>

<|current_file_content|>
current_file_path: {path}
{clipped lines before the region}
<|code_to_edit|>
{region lines, no cursor}
<|/code_to_edit|>
{clipped lines after the region}
<|/current_file_content|>

<|edit_diff_history|>
{entries joined by a blank line: the newest that fit HISTORY_BUDGET_CHARS, printed oldest first}
<|/edit_diff_history|>

<|code_to_edit|>
{region lines with <|cursor|> at the cursor}
<|/code_to_edit|>
```

`stableChars` is the user-message character count, in code points as for `stableUserChars`, up to the start of the line `PIN_BACK_LINES` lines above `<|code_to_edit|>` inside the current-file block. It is 0 when that line is the block's first line.

- [x] **Step 1: Write the failing tests**

- `the user message has the blocks in order`: with snippets, history and a 30-line file, the indexes of `<|recently_viewed_code_snippets|>`, `<|current_file_content|>`, `<|edit_diff_history|>` and the last `<|code_to_edit|>` increase.
- `empty history and snippets leave their blocks out`.
- `the cursor marker appears once, in the last block`: `<|cursor|>` occurs exactly once, after the last `<|code_to_edit|>`, at the cursor column.
- `history keeps the newest entries within budget, oldest first`: 3 entries of 2000 chars keep the newest one only; 3 of 1000 chars keep all three in the original order.
- `the system prompt is our own wording`: `CHAT_XTAB_SYSTEM` contains `NO_CHANGE`, ```` ``` ```` and `<|code_to_edit|>`, and contains neither `would have made next` nor `Your revised code goes here`.
- `a system suffix is appended`: `chatXtabMessages(i, '/no_think')` gives a system message ending in `\n/no_think`.
- `stableChars stops 4 lines above the region inside the current file`: `user.slice(stableChars)` starts with the line 4 above the region start.
- `parse keeps edge blank lines` (observed live): ```` ```python\n\ndef f(radius):\n    return radius\n\n``` ```` gives `rewrite` with lines `['', 'def f(radius):', '    return radius', '']`.
- `parse recognizes no-change answers`: `NO_CHANGE`, `  NO_CHANGE\n`, `<NO_CHANGE>`.
- `parse strips <|cursor|> and echoed tags`: ```` ```\n<|code_to_edit|>\na<|cursor|>b\n<|/code_to_edit|>\n``` ```` gives lines `['ab']`.
- `parse rejects prose without a fence and a fence that never closes`:
  - `I would rename it.` gives `invalid`/`noFence`;
  - ```` ```\na\nb ```` gives `invalid`/`truncated` with `complete: true`.
- `parse ignores text after the closing fence`.
- `chatXtabDone is true after the closing fence or a no-change answer, false mid-fence`.

- [x] **Step 2: Run it and see it fail**

Run: `npx vitest run test/unit/nextEdit/chatXtab.test.ts`
Expected: FAIL (module not found).

- [x] **Step 3: Implement** `chatXtabMessages`, `parseChatXtab` and `chatXtabDone`.

The opening fence is the first line starting with ```` ``` ````. The closing fence is the next line that is ```` ``` ```` after optional whitespace. Body lines are everything between, split on `\r?\n`.

- [x] **Step 4: Run it and see it pass**

Run: `npx vitest run test/unit/nextEdit/chatXtab.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/nextEdit/formats/chatXtab.ts test/unit/nextEdit/chatXtab.test.ts
git commit -m "feat: chatXtab Next Edit prompt and answer parser"
```

### Task 5: Region diff, filters and display classification

**Files:**
- Create: `src/nextEdit/diff.ts`
- Test: `test/unit/nextEdit/diff.test.ts`

**Interfaces:**
- Produces:
  - `export interface LineEdit { startLine: number; endLine: number; newLines: string[] }`: replace lines `[startLine, endLine)`; `startLine === endLine` is a pure line insertion;
  - `export function regionEdit(oldRegion: string[], newRegion: string[], regionStart: number): LineEdit | undefined`: trims common leading and trailing lines, `undefined` when equal;
  - `export function isTrivialEdit(e: LineEdit, docLines: string[]): boolean`: true when the old and new lines are equal after trimming each line and dropping blank lines (whitespace-only or blank-line-only);
  - `export interface Pos { line: number; character: number }`;
  - `export type NextEditShow = { kind: 'ghost'; insertText: string } | { kind: 'edit'; start: Pos; end: Pos; text: string }`;
  - `export function classify(e: LineEdit, docLines: string[], cursor: Pos): NextEditShow`;
  - `export function toItemText(text: string, eol: '\n' | '\r\n'): string`.

- [x] **Step 1: Write the failing tests**

- `regionEdit trims common lines`: old `['a','b','c']`, new `['a','B','c']`, start 10 gives `{ startLine: 11, endLine: 12, newLines: ['B'] }`.
- `regionEdit of an echo is undefined`.
- `regionEdit of a longer answer is an insertion`: old `['a','c']`, new `['a','b','c']`, start 0 gives `{ startLine: 1, endLine: 1, newLines: ['b'] }`.
- `regionEdit of a deletion has no new lines`.
- `whitespace-only and blank-line-only edits are trivial`.
- `an insertion at the cursor is ghost text`: doc line `  return a`, cursor at character 10, the edit replacing that line with `  return a + b` gives `{ kind: 'ghost', insertText: ' + b' }`.
- `lines inserted after the cursor line at its end are ghost text`: cursor at the end of line 3, edit `{ startLine: 4, endLine: 4, newLines: ['  x()'] }` gives `ghost` with `insertText: '\n  x()'`.
- `an edit on another line is an inline edit with its exact range`: renaming line 7 `def g(r):` to `def g(radius):` with the cursor on line 4 gives `{ kind: 'edit', start: { line: 7, character: 0 }, end: { line: 7, character: 9 }, text: 'def g(radius):' }`.
- `a pure line insertion away from the cursor is an inline edit at the line start`: text ends with `\n`, and start equals end at `{ line: N, character: 0 }`.
- `deleting the last lines of the file does not leave an empty line`: the range starts at the end of the line before.
- `a change before the cursor on the cursor line is an inline edit, not ghost text`.
- `toItemText converts line breaks to CRLF`.

- [x] **Step 2: Run it and see it fail**

Run: `npx vitest run test/unit/nextEdit/diff.test.ts`
Expected: FAIL (module not found).

- [x] **Step 3: Implement**

`classify` widens the edit to include the cursor line when the edit touches or directly follows it. It then checks whether the new text equals the old text with something inserted at the cursor offset. If so, the result is ghost text with what was inserted; otherwise it is an inline edit over the original (un-widened) lines.

- [x] **Step 4: Run it and see it pass**

Run: `npx vitest run test/unit/nextEdit/diff.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/nextEdit/diff.ts test/unit/nextEdit/diff.test.ts
git commit -m "feat: Next Edit region diff and display classification"
```

### Task 6: One Next Edit request

**Files:**
- Modify: `src/completion/route.ts` (extract the shared chat-request envelope from `buildChatRequest`; behaviour unchanged)
- Create: `src/nextEdit/request.ts`
- Test: `test/unit/nextEdit/request.test.ts`; `test/unit/route.test.ts` stays green unchanged

**Interfaces:**
- Consumes: Tasks 1, 3, 4 and 5; `ThinkingError` (`src/completion/stream.ts`); `ReasoningFilter` and `startsWithThinkOpener` (`src/models/thinking.ts`); `FimBackend`, `ChatRequest` and `ChatEvent` (`src/backends/types.ts`).
- Produces:
  - in `route.ts`, `export function chatRequestEnvelope(p: { values: FimValues; flavor: HostFlavor; model: string | undefined; rejected: ReadonlySet<string>; signal: AbortSignal; onRejected?(fields: string[]): void; maxTokens: number; stop: string[]; messages: (systemSuffix: string | undefined) => ChatMessage[]; pinChars: (messages: ChatMessage[]) => number }): ChatRequest`. It holds what `buildChatRequest` does today with thinking fields, sampling, the Strata pin, `EFFORT_NONE_REJECTED` mapping and the deadline, and `buildChatRequest` calls it;
  - `export interface NextEditSnapshot { uri: string; version: number; input: NextEditInput }`;
  - `export interface NextEditResult { uri: string; version: number; cursor: Pos; edit: LineEdit; show: NextEditShow }`;
  - `export function nextEditMaxTokens(regionChars: number): number`: `min(2048, ceil(regionChars / 3.5 * 1.5) + 64)`;
  - `export async function runNextEdit(o: { backend: FimBackend; values: FimValues; flavor: HostFlavor; model: string | undefined; snapshot: NextEditSnapshot; rejected: ReadonlySet<string>; signal: AbortSignal; onRejected?(fields: string[]): void; onPrompt?(messages: ChatMessage[]): void; onAnswer?(visible: string): void }): Promise<NextEditResult | undefined>`. It resolves `undefined` for no change, an invalid or trivial answer; it throws `ThinkingError`, the backend's errors and a `TimeoutError`.

- [x] **Step 1: Write the failing tests** (fake backend yielding scripted `ChatEvent`s, as in `test/unit/stream.test.ts`)

- `a rename in the answer becomes an inline edit`: the circle-module snapshot from the live probe (cursor at the end of `    return math.pi * radius ** 2`), with an answer that renames `r` in `circle_circumference`, gives `show.kind === 'edit'` on `def circle_circumference(r):`.
- `the request uses chatXtab messages, NES sampling and the Next Edit deadline`:
  - the captured `ChatRequest` has `messages[0].content === CHAT_XTAB_SYSTEM` and `sampling` `{ temperature: 0.2, topP: 0.8, topK: 20, presencePenalty: 0 }`;
  - `timeoutMs` is the values' `timeoutMs`; `stop` is `[]`.
- `Strata gets the cache pin`: flavor `strata` gives `extraBody.strata_prefix` with `message: 1` and `chars === stableChars`.
- `the stream is aborted once the closing fence arrives`: content events `['```\n', 'x\n', '```\n', 'chatter that never ends']`; the signal is aborted, the result is computed, and the chatter is not read.
- `a reasoning event fails fast with ThinkingError`.
- `a stream that ends inside the fence is dropped (truncated)`.
- `NO_CHANGE resolves undefined, and so does a whitespace-only edit`.
- `buildChatRequest is unchanged`: the existing `route.test.ts` passes untouched.

- [x] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/nextEdit/request.test.ts test/unit/route.test.ts`
Expected: the new file FAILs; `route.test.ts` passes.

- [x] **Step 3: Implement** the envelope extraction first, then `runNextEdit`.

- The stream loop feeds content to a `ReasoningFilter`. A reasoning event with non-whitespace text, or a think opener at the start of the content, aborts and throws `ThinkingError`, as the FIM chat route does.
- When `chatXtabDone(visible)` turns true, the loop aborts the request and stops reading.
- The answer is then `parseChatXtab(visible, true)`. A `rewrite` goes through `regionEdit`, then `isTrivialEdit` (drop), then `classify`.

- [x] **Step 4: Run them and see them pass**

Run: `npx vitest run test/unit/nextEdit/request.test.ts test/unit/route.test.ts test/unit/stream.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/completion/route.ts src/nextEdit/request.ts test/unit/nextEdit/request.test.ts
git commit -m "feat: run one Next Edit request over the chat stream"
```

### Task 7: Trigger rules and the Next Edit controller

**Files:**
- Create: `src/nextEdit/trigger.ts` (pure), `src/nextEdit/vscode/controller.ts` (imports `vscode`)
- Modify: `src/completion/contextTracker.ts` (also feeds a `RecentSnippets`), `src/extension.ts` (wiring)
- Test: `test/unit/nextEdit/trigger.test.ts`

**Interfaces:**
- Produces:
  - in `trigger.ts`:
    - `export const EDIT_PAUSE_MS = 400, HISTORY_IDLE_MS = 1500, AFTER_EDIT_WINDOW_MS = 10_000, SAME_LINE_COOLDOWN_MS = 5_000, REJECTION_COOLDOWN_MS = 5_000, CHAIN_DELAY_MS = 60`;
    - `export class TriggerPolicy` with `edited(uri: string, now: number): void`, `rejected(now: number): void`, `requested(uri: string, line: number, now: number): void`, `afterPause(now: number): boolean` and `onCursorMove(uri: string, line: number, now: number): boolean`;
  - in `controller.ts`, `export class NextEditController implements vscode.Disposable`:
    - `constructor(d: NextEditDeps)`;
    - `itemFor(doc: vscode.TextDocument, pos: vscode.Position): NextEditResult | undefined`;
    - `fimResult(uri: string, version: number, shown: boolean): void`;
    - `accepted(): void`, `rejected(): void`;
    - `native: boolean` (set by `extension.ts` from the probe).
  - `NextEditDeps` holds getSettings, getBackend, capabilities, backoff, isLocal, log, snoozedUntil, the `RecentSnippets`, an `isExcluded(doc)` predicate (the one `extension.ts` gives `ContextTracker`, minus the `extraContext` clause) and `detectedModel(backend, signal)`.

- [x] **Step 1: Write the failing tests** (`trigger.test.ts`, fake clock numbers)

- `a cursor move within 10 s of an edit triggers; after 10 s it does not`.
- `the same line does not trigger again within 5 s, another line does`.
- `nothing triggers within 5 s of a rejection, edit pause included`.
- `afterPause is true outside a rejection cooldown`.

- [x] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/nextEdit/trigger.test.ts`
Expected: FAIL (module not found).

- [x] **Step 3: Implement `TriggerPolicy`, then the controller**

**Gate.** The controller sends nothing unless all of these hold (the gate is shared by every path below):
- `nextEdit.enabled`, a `nextEdit.backendId`, and not snoozed;
- the document is not excluded (`isExcluded(doc)` is false) and is the active editor's, with one empty selection;
- the backend has a chat route, and passes `isLocal` when `privacy.localOnly` is on;
- the backoff allows a request;
- `thinkingBlocked(...)` is undefined for the Next Edit model.

**History.**
- `open` on `onDidOpenTextDocument` and for documents already open; `close` on close.
- On every change, restart a per-document `HISTORY_IDLE_MS` timer that calls `commit`.
- `commit` (flush) right before each request.
- History is recorded only for `file` documents inside a workspace folder and for `untitled` documents (the same check as `ContextTracker.capture`), and only when they are not excluded. Changes to `git:`, `output:`, `vscode-userdata:` and other documents are ignored.
- Entries of other files are included only while `fim.extraContext` is on (filter on `entries`).

**Triggers.**
- On a change to the active document (reason not Undo/Redo): call `policy.edited`, abort the in-flight request for that uri, drop its result, and reset the pause timer.
- When FIM is not active for the document (`fim.enabled` off, no `fim.backendId`, or the language or file disabled), schedule a request `EDIT_PAUSE_MS` after the change.
- When FIM is active, schedule it only once `fimResult(uri, version, false)` arrives for the current version (Ruling 3), at `EDIT_PAUSE_MS` after the last change.
- On a selection change of kind Keyboard, Mouse or Command: request when `policy.onCursorMove` allows it.

**Request.**
- At most one request per `(uri, version)`: skip when one is in flight or a result exists for that version. The accept chain supersedes a pending pause timer.
- Build the snapshot from the document: lines split on `\r?\n`, the cursor, `editableRegion`, the history entries, and `snippets.pick(path, SNIPPETS_BUDGET_CHARS)`.
- Run `runNextEdit`. Log the prompt and answer through `onPrompt` and `onAnswer` only with `logPrompts`.

**Result.**
- If the document version and the active editor still match:
  - an `edit` result when `native` is false is dropped, and the one-time notice from Task 9 is shown;
  - otherwise store it and run `editor.action.inlineSuggest.trigger`.

**Errors.**
- `ThinkingError`: `capabilities.sawThinking`, a debug log line, and a one-time notification per backend: `AI Autocomplete: Next Edit stopped for "<id>": <model> keeps thinking.` with "Show Log".
- Other errors: `backoff.recordFailure(classifyError(err))` (`src/backends/http.ts`) and a one-time notification per backend and error kind.
- Aborted requests are silent.

**Accept and reject.**
- `accepted()`: drop the result, `commit` the document, and request again after `CHAIN_DELAY_MS` (bypassing the same-line cooldown).
- `rejected()`: `policy.rejected(now)` and drop the result.

**`contextTracker.ts`:** the constructor gains an optional `snippets?: RecentSnippets`. Every `capture` also calls `snippets.add(path, lines, line)`.

**`extension.ts`:** create the history-free `RecentSnippets` and the controller, pass the snippets to `ContextTracker`, and dispose of the controller with the extension. On settings changes, clear stored results and abort requests, as for FIM.

- [x] **Step 4: Run them and see them pass**

Run: `npx vitest run test/unit/nextEdit/trigger.test.ts && npm run typecheck && npm run lint`
Expected: PASS, no type or lint errors (the vscode allowlist lint rule, if any, includes `src/nextEdit/vscode/*`).

- [x] **Step 5: Commit**

```bash
git add src/nextEdit/trigger.ts src/nextEdit/vscode/controller.ts src/completion/contextTracker.ts src/extension.ts test/unit/nextEdit/trigger.test.ts
git commit -m "feat: Next Edit triggers and controller"
```

### Task 8: Provider arbitration, items and the registration probe

**Files:**
- Modify: `src/completion/provider.ts`, `src/extension.ts`, `src/ui/commands.ts` (command `aiAutocomplete.nextEditAccepted`), `package.json` (the command, hidden from the palette like `accepted`)
- Create: `src/types/vscode.proposed.inlineCompletionsAdditions.d.ts`: the pinned 1.146 file with the header from Global Constraints. The research copy is at `/private/tmp/claude-501/-Users-raboo-ai-autocomplete/7a64019b-fdf6-4992-8adf-fba571f67e08/scratchpad/research/vscode.proposed.inlineCompletionsAdditions.1.146.d.ts`; if that path is gone, fetch `src/vscode-dts/vscode.proposed.inlineCompletionsAdditions.d.ts?ref=69047191fc427f2f92828279aae1d90d8eeda7ab` with `gh api`.
- Test: covered by Task 11. Unit tests stay green.

**Interfaces:**
- Consumes: `NextEditController.itemFor`, `fimResult`, `accepted`, `rejected` and `native` (Task 7); `NextEditShow` and `toItemText` (Task 5).
- Produces:
  - `FimProvider` deps gain `nextEdit?: Pick<NextEditController, 'itemFor' | 'fimResult' | 'rejected'>`;
  - `FimProvider.handleEndOfLifetime(item, reason)` (proposed; ignored without the proposal);
  - `activate()`'s return value gains `nativeNextEdit: boolean`.

- [x] **Step 1: Implement arbitration**

- At the top of `provide()`, before the FIM gate: when `nextEdit.itemFor(doc, pos)` returns a result, return one item:
  - `ghost`: `new vscode.InlineCompletionItem(toItemText(insertText, eol), new vscode.Range(pos, pos), { command: 'aiAutocomplete.nextEditAccepted', title: '' })`;
  - `edit`: an item with `range` from `start`/`end`, `insertText` `toItemText(text, eol)`, `isInlineEdit = true` and the same command.
- `itemFor` returns a `ghost` result only when `pos` equals the snapshot cursor; `edit` results only when native.
- Report FIM's outcome with `nextEdit.fimResult(uri, doc.version, shown)` only in two cases:
  - a completed request whose text is `''` (shown `false`) or non-empty (shown `true`), while the call was not aborted and the document version is unchanged;
  - a cache hit (shown is whether the cached text is non-empty).

  Gate skips (FIM disabled, suggest widget, mid-word), debounce bail-outs, superseded calls and failed or joined-then-aborted flights report nothing; the cursor-move trigger covers those cases. When FIM is not active for the document, the controller does not wait for this call (Task 7).

- [x] **Step 2: Implement the probe in `extension.ts`**

- `try { registerInlineCompletionItemProvider({ pattern: '**' }, provider, { displayName: 'AI Autocomplete' }); native = true } catch { registerInlineCompletionItemProvider({ pattern: '**' }, provider); native = false }`.
- Log `next edit: native inline edits available` or `… not available (VS Code's proposed API is not enabled for this extension)` at info.
- The provider never defines `handleDidShowCompletionItem` or `handleDidPartiallyAcceptCompletionItem`.
- `handleEndOfLifetime` passes kind `1` (Rejected) for a Next Edit item to `nextEdit.rejected()`. Compare the numeric value, because the enum is proposed. The provider keeps a `WeakSet` of the Next Edit items it returned, so FIM items never reach `rejected()`.

- [x] **Step 3: Add `enabledApiProposals`**

- `package.json` gains `"enabledApiProposals": ["inlineCompletionsAdditions"]`.
- Run `npm run build && npm run package`. Expected: the `.vsix` builds (plain `vsce package` does not check proposals).

- [x] **Step 4: Verify**

Run: `npm run lint && npm run typecheck && npm test`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/completion/provider.ts src/extension.ts src/ui/commands.ts package.json src/types/vscode.proposed.inlineCompletionsAdditions.d.ts
git commit -m "feat: show Next Edit results from the inline completion provider"
```

### Task 9: The native-UI opt-in command

**Files:**
- Modify: `package.json` (`"jsonc-parser": "^3.3.1"`, the command `aiAutocomplete.enableNativeNextEdit` titled "AI Autocomplete: Enable Native Next Edit UI"), `package-lock.json`, `test/unit/manifest.test.ts` (dependencies `['diff', 'jsonc-parser']`), `src/ui/commands.ts`, `src/nextEdit/vscode/controller.ts` (the one-time notice)
- Create: `src/nextEdit/optIn.ts`
- Test: `test/unit/nextEdit/optIn.test.ts`

**Interfaces:**
- Produces:
  - `export const EXTENSION_ID = 'raboo.ai-autocomplete'`;
  - `export function argvPath(appName: string, home: string, env: { VSCODE_PORTABLE?: string }): string | undefined`;
  - `export function withProposedApiOptIn(text: string, id: string): string | undefined`: the new argv.json text, or `undefined` when `id` is already listed.

- [x] **Step 1: Write the failing tests**

- `argvPath per product`:
  - `Visual Studio Code` gives `<home>/.vscode/argv.json`;
  - `Visual Studio Code - Insiders` gives `<home>/.vscode-insiders/argv.json`;
  - `VSCodium` gives `<home>/.vscode-oss/argv.json`;
  - `VSCodium - Insiders` gives `<home>/.vscodium-insiders/argv.json`;
  - an unknown name gives `undefined`;
  - `VSCODE_PORTABLE=/p` gives `/p/argv.json` for any name.
- `the opt-in keeps comments`: a JSONC text with a `//` comment and `"locale": "en"` keeps both, and gains `"enable-proposed-api": ["raboo.ai-autocomplete"]`.
- `the opt-in appends to an existing list and leaves an existing entry alone`:
  - `["other.ext"]` becomes `["other.ext", "raboo.ai-autocomplete"]`;
  - a list already holding the id gives `undefined`.
- `a non-array value is replaced by a list` (VS Code rejects non-arrays): `"enable-proposed-api": "x"` becomes `["raboo.ai-autocomplete"]`.
- `an empty file gets an object`.
- `manifest.test.ts`: the dependencies are `['diff', 'jsonc-parser']`.

- [x] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/nextEdit/optIn.test.ts test/unit/manifest.test.ts`
Expected: FAIL

- [x] **Step 3: Implement**

- `withProposedApiOptIn` uses jsonc-parser's `parse`, `modify` and `applyEdits` with `{ formattingOptions: { insertSpaces: true, tabSize: 2 } }`.
- **The command:**
  - Resolve the path from `vscode.env.appName`, `os.homedir()` and `process.env`.
  - Read the file (missing → `''`), apply `withProposedApiOptIn` and write it.
  - Then show "AI Autocomplete: native Next Edit UI enabled. Quit and reopen VS Code to finish." When the id was already there, show "… is already enabled. If Next Edit still shows only ghost text, quit and reopen VS Code."
  - On an unknown product or a read/write error, run `workbench.action.configureRuntimeArguments` and show "Add \"enable-proposed-api\": [\"raboo.ai-autocomplete\"] to argv.json, then quit and reopen VS Code."
- **The one-time notice** (controller, Task 7's drop path): "AI Autocomplete has a Next Edit suggestion that needs VS Code's inline-edit UI." with buttons "Enable" (runs the command) and "Not now", shown at most once per session.

- [x] **Step 4: Run them and see them pass**

Run: `npx vitest run test/unit/nextEdit/optIn.test.ts test/unit/manifest.test.ts && npm run build`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add package.json package-lock.json src/nextEdit/optIn.ts src/ui/commands.ts src/nextEdit/vscode/controller.ts test/unit/nextEdit/optIn.test.ts test/unit/manifest.test.ts
git commit -m "feat: command to enable the native Next Edit UI"
```

### Task 10: Choosing the Next Edit backend and model

**Files:**
- Modify: `src/ui/commands.ts` (command `aiAutocomplete.selectNextEditBackend`), `src/ui/statusModel.ts` (`menuEntries`), `package.json` (the command "AI Autocomplete: Select Next Edit Backend"), `src/manage/form.ts`, `src/manage/protocol.ts`, `src/webview/backends/render.ts`, `src/webview/backends/main.ts`
- Test: `test/unit/form.test.ts`, `test/unit/render.test.ts`, `test/unit/statusModel.test.ts`

**Interfaces:**
- Consumes: `Settings.nextEdit.backendId` (Task 1).
- Produces:
  - `BackendForm.nextEditModel: string`, mapped to and from `BackendConfig.nextEditModel` (blank: removed);
  - `menuEntries(...)` gains an entry `{ id: 'selectNextEditBackend', label: 'Next Edit: <id>' or 'Next Edit: off' }`.

- [x] **Step 1: Write the failing tests**

- `form maps nextEditModel both ways`: `toForm` reads it, `fromForm` writes it, and a blank value deletes it.
- `the card shows a Next Edit model field whose placeholder is the completion model`: render with `model: 'qwen3.8'` gives a `nextEditModel` input with placeholder `same as the completion model (qwen3.8)`, using the same model datalist.
- `the menu shows the Next Edit backend or off`.

- [x] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/form.test.ts test/unit/render.test.ts test/unit/statusModel.test.ts`
Expected: FAIL

- [x] **Step 3: Implement**

- The page field mirrors the model field: escaped values, the existing datalist, and no API key or server text unescaped.
- The command's quick pick lists the backend ids plus "Off". It writes `nextEdit.backend` with the same target rule as `useBackend` (workspace when a folder is open), and writes `""` for Off.

- [x] **Step 4: Run them and see them pass**

Run: `npx vitest run test/unit && npm run typecheck`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/ui/commands.ts src/ui/statusModel.ts package.json src/manage/form.ts src/manage/protocol.ts src/webview/backends/render.ts src/webview/backends/main.ts test/unit/form.test.ts test/unit/render.test.ts test/unit/statusModel.test.ts
git commit -m "feat: choose the Next Edit backend and model"
```

### Task 11: Integration tests with and without the proposed API

**Files:**
- Modify: `.vscode-test.mjs`, `test/integration/mockServer.ts`, `package.json` (`test:integration` runs both labels), `.github/workflows/ci.yml` (only if the script change needs it; the job id stays `integration`)
- Create: `test/integration/nextEdit.test.ts`

**Interfaces:**
- Consumes: `activate()`'s `nativeNextEdit` (Task 8); settings from Task 1.
- Produces:
  - `.vscode-test.mjs` exports an array of two configs:
    - label `main`: today's config, all test files except `nextEdit.test.js`, plus `nextEdit.test.js`;
    - label `proposed`: `files: 'out/test/integration/nextEdit.test.js'`, with `--enable-proposed-api raboo.ai-autocomplete` added to `launchArgs`.
  - The mock gains `nextEdit?: { content: string[] }`, streamed when a chat request's user message contains `<|code_to_edit|>`.

- [x] **Step 1: Write the tests** (`nextEdit.test.ts`; each reads `api.nativeNextEdit` to know its launch)

- `the probe matches the launch`: `nativeNextEdit` is `true` under `proposed` and `false` under `main`. Use an environment variable set in each config's `env`, for example `AI_AUTOCOMPLETE_TEST_LAUNCH`.
- `an insertion after the cursor line shows as ghost text and is accepted`, in both launches:
  - backends: one Strata-flavor mock for both FIM and Next Edit; FIM answers `<COMPLETION></COMPLETION>`;
  - Next Edit answers the region with one line added after the cursor line;
  - type a change with `editor.edit`, wait for the chat request containing `<|code_to_edit|>`, `commitWhen` the new line appears.
- `a rename elsewhere is applied as an inline edit` (`proposed` only):
  - the circle-module scenario; the cursor stays on line 4;
  - commit (`editor.action.inlineSuggest.commit` accepts a visible inline edit) and assert that line 7 reads `def circle_circumference(radius):`.
- `without the proposed API an edit elsewhere is not applied` (`main` only): the same scenario; after the Next Edit request completes and 1 s passes, commit, and the document is unchanged.
- `an excluded file sends no Next Edit request`: a `.env`-named file; edit; wait 1.5 s; the mock saw no request containing `<|code_to_edit|>`.
- `typing fast sends one Next Edit request`: type 5 characters 30 ms apart with `editor.edit`; after the pause, the mock saw exactly one request containing `<|code_to_edit|>`.
- `the Next Edit request carries the history diff`: after two edits more than 1.5 s apart, the user message contains `<|edit_diff_history|>` and `@@ -`.

- [x] **Step 2: Run them**

Run: `npm run test:integration`
Expected: every existing test plus the new ones pass under `main`, and the `proposed` run passes. If the trigger command misses because the window lacks OS focus, reuse the suite's existing `trigger`/`waitFor` helpers rather than new sleeps.

- [x] **Step 3: Commit**

```bash
git add .vscode-test.mjs test/integration/mockServer.ts test/integration/nextEdit.test.ts package.json
git commit -m "test: Next Edit integration tests with and without the proposed API"
```

### Task 12: Docs and handoff

**Files:**
- Modify: `README.md`, `AGENTS.md`, `THIRD_PARTY_NOTICES.md`, `docs/ROADMAP.md`, `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md`, `docs/superpowers/followups/2026-11-13-phase0-1-review-followups.md`

- [x] **Step 1: README, a "Next Edit" section**
  - What it does.
  - How to turn it on: **AI Autocomplete: Select Next Edit Backend**, optionally a Next Edit model on the Backends page.
  - What shows without the opt-in (only insertions at the cursor) and how to opt in: **AI Autocomplete: Enable Native Next Edit UI**, then quit and reopen VS Code. VS Code logs an error about proposed APIs for extensions that declare them without the opt-in; that is expected.
  - Tab jumps to an edit, then accepts it; Esc dismisses it.
  - Privacy: the current file's recent diffs always go to the Next Edit backend; other files' diffs and snippets only with `fim.extraContext`.
  - The deadline setting.
- [x] **Step 2: AGENTS.md**
  - The `import 'vscode'` allowlist gains `src/nextEdit/vscode/*`.
  - "Zero runtime dependencies" becomes "Runtime dependencies: only `diff` and `jsonc-parser`".
  - Layout gains `src/nextEdit/` (one line per module).
  - Commands: `npm run test:integration` runs two launches (`main`, `proposed`).
- [x] **Step 3: THIRD_PARTY_NOTICES.md:** jsdiff (BSD-3-Clause, full text), jsonc-parser (MIT, full text), and microsoft/vscode for the pinned proposal file (MIT, full text).
- [x] **Step 4: The spec**
  - Record the **(research)** facts from this plan's header under "Key API facts" (dated 2026-11-15, 1.146). Correct the old line "Defining `handleDidShowCompletionItem`, or passing registration `metadata`, throws".
  - Record that `showRange` is not used by the 1.146 editor.
  - Phase 3 is split into 3a/3b.
  - Rulings 2, 3, 6 and 9–13 go into "Next Edit pipeline".
  - The live probe's latency goes under "To verify" (answered for small prompts; large prompts still open).
- [x] **Step 5: ROADMAP:** the Phase 3 row is split into "3a. Next Edit core, chatXtab, native display" (plan: this file; status implemented) and "3b. Sweep and Zeta formats, decoration fallback" (plan not written yet; not started). Add Phase 3a's manual checks under "Deferred manual checks" (Publish step 4).
- [x] **Step 6: Follow-ups:** a "Phase 3a" section listing:
  - Copilot's replace-to-end-of-line rebase (Ruling 12);
  - no drift check is possible right before VS Code applies a native inline edit (Review Focus 1);
  - rejected-edit memory;
  - the import-only edit filter;
  - `onDidChange` instead of the trigger command;
  - a Next Edit status-bar state;
  - Test on the Backends page also testing Next Edit;
  - the settings deferred in Ruling 7.
- [x] **Step 7: Verify and commit**

Run: `npm run lint && npm run typecheck && npm run build && npm test && npm run test:integration && npm run package`
Expected: all pass, and the `.vsix` builds.

```bash
git add README.md AGENTS.md THIRD_PARTY_NOTICES.md docs/ROADMAP.md docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md docs/superpowers/followups/2026-11-13-phase0-1-review-followups.md
git commit -m "docs: Next Edit (Phase 3a) in README, AGENTS, spec and roadmap"
```

## Publish (controller only, after Task 12 and the final review)

These steps create public state on GitHub. **Ask the user once, listing every step, and wait for a yes.** If the user approves only part, do only that part.

1. `git push -u origin feat/next-edit`.
2. `gh pr create -R Raboo/vscode-ai-autocomplete --base main --head feat/next-edit --title "feat: Next Edit suggestions with chatXtab and the native inline-edit UI" --body <summary ending with the Claude Code line>`.
3. Watch CI with `gh pr checks <n> -R Raboo/vscode-ai-autocomplete --watch`. Expected: `check`, `integration` and `analyze` pass. Fix forward on the branch.
4. **The user's smoke test** with the PR's CI `.vsix`, on the user's Strata (credentials in the git-ignored `.env`). Select it with **Select Next Edit Backend**.
   - **Without the opt-in:**
     - rename a parameter in one function, then move the cursor down: nothing shows except, once, the notice offering the native UI;
     - press Enter at the end of a line inside a function whose next line is obvious: an insertion shows as ghost text and Tab accepts it;
     - FIM still works as before.
   - **With the opt-in** (run the command, quit and reopen VS Code):
     - the rename shows as an inline edit on the next function; Tab jumps, Tab accepts;
     - Esc dismisses it, and nothing re-shows for 5 s;
     - accepting chains the next suggestion.
     - with an inline edit showing, type a character on another line, then press Tab: the edit is either gone or still correct, never applied to shifted text.
   - With `debug.logPrompts` on, the log shows the chatXtab prompt with `<|edit_diff_history|>`, and the request time. Note the latency on a large file.
   - A `.env` file gets no Next Edit request.

   Continue only after the user confirms.
5. Merge with `gh pr merge <n> --squash -R Raboo/vscode-ai-autocomplete`. release-please then proposes 0.3.0. **Releasing waits for the user's call:** release 3a now as 0.3.0, or wait for 3b.
6. `git checkout main && git pull`, then delete the local branch.
