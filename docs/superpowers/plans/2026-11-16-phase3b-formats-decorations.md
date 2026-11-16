# Phase 3b: Sweep and Zeta formats, decoration fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Next Edit works with the small dedicated models (Sweep next-edit 0.5B/1.5B/v2-7B and Zeta 2.1) on llama.cpp and LM Studio, and inline edits show in any VS Code, not only with the proposed API.

**Architecture:**
- **Formats** become siblings behind one interface (`src/nextEdit/formats/format.ts`):
  - `chatXtab` (3a) on the chat route;
  - `sweep` and `zeta21` on the raw completion route: the backend's existing `streamFim` with a `template` payload, i.e. llama.cpp `/completion` or OpenAI `/v1/completions`.
  - `pickFormat` chooses one from the `nextEdit.format` setting, or from the model id in `auto`.
  - Each format's answer becomes new region lines, so 3a's `regionEdit`, `isTrivialEdit` and `classify` stay shared.
- **The history** keeps structured hunks next to the rendered text. Sweep needs `original:`/`updated:` blocks and the window before the latest change.
- **Decoration fallback** (`src/nextEdit/decorations.ts` pure, `src/nextEdit/vscode/decorations.ts`): theme-coloured backgrounds on the changed text, the new text as `after` decorations, and a hint. Tab (jump, then apply) and Esc work through a context key. No images, no new dependencies.
- **Settings** deferred in 3a arrive: `nextEdit.format`, `.display`, `.regionLinesAbove`, `.regionLinesBelow`, `.historySize`, `.contextBudget`.

**Tech Stack:** TypeScript ~6.0.3, esbuild, vitest, eslint, `@vscode/test-cli`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md`, sections "Approaches considered for Next Edit display" (option A, the decoration preview), "Next Edit pipeline" (formats 2 and 3, "Diff and classify"), "Sampling presets" (NES rows) and "Settings and security" (`nextEdit.*`). Read them.

**Research behind this plan** (2026-11-16; findings marked **(research)** go into the spec in Task 9):
- **Sweep** (`sweepai/sweep-next-edit-1.5B` `run_model.py` @ `409016591c6c1a94f545f22328a85a3516118f34`, `sweepai/sweep-next-edit-v2-7B` `inference.py` @ `851f4ac1427ec91eb6c19d408409490d6e0c00a0`, both Apache-2.0, plus Sweep's blog):
  - There are two layouts. **v1** (0.5B/1.5B, the official script):
    - context files as `<|file_sep|>{path}` blocks;
    - each recent change in its own `<|file_sep|>{path}.diff` block with `original:`/`updated:` text (no unified diff);
    - then `<|file_sep|>original/{path}`, `<|file_sep|>current/{path}` and `<|file_sep|>updated/{path}`;
    - no cursor marker, no line ranges, no prefill;
    - the window is 10 lines above and 10 below the cursor, and the model rewrites all of it.
  - **v2** (7B) adds:
    - a file section of about 300 lines;
    - `:start:end` ranges (1-based, absolute);
    - `<|cursor|>` in `current/`;
    - change blocks headed `{path}:{start}:{end}`;
    - a prefill of the window lines above the cursor line after the `updated/` header; the new window is prefill + output.
  - Both models: greedy, `max_tokens` 512 (v1) / 1024 (v2), stop `<|file_sep|>` and `<|endoftext|>`. They have no chat template and no BOS. "No change" is an answer equal to the window.
- **Zeta 2.1** (`zed-industries/zeta-2.1` model card, `sample.prompt` and `sample.output`, Apache-2.0):
  - Layout: `<[fim-suffix]>{after}<[fim-prefix]>{related <filename> files}{<filename>edit_history + unified diffs}<filename>{path}\n{before}{region with inline <|marker_N|> and <|user_cursor|>}\n<[fim-middle]>`.
  - Markers sit at block starts (blocks of 6–16 lines), and the last marker is glued to the end of the region.
  - The answer is `<|marker_s|>new text<|marker_e|>` and replaces old blocks s..e. The same number twice means no edit.
  - Stop only on `<[end▁of▁sentence]>`. Never stop on a marker: a span can cover several blocks.
  - The three `<[fim-*]>` strings are special tokens; `<filename>`, the markers and the cursor marker are plain text.
  - Zed's own prompt builder (`zeta_prompt`, `edit_prediction`) is **GPL-3.0-or-later**, so this format is written from the model card and our probe only. Nothing is ported.
- **Live probe** (user's LM Studio, `randmaru/zeta-2.1-mlx`, raw `/v1/completions`, temperature 0, a synthetic `circle.py` where `area(r)` was renamed to `area(radius)`):
  - The answer was `<|marker_1|>def circumference(radius):…def diameter(radius):…<|marker_2|>` in 4.0 s cold (171 prompt / 50 completion tokens).
  - An unrelated edit gave `<|marker_1|><|marker_1|>` in 1.1 s.
  - LM Studio's raw completion route parses the FIM special tokens.
- **sr-tream/vscode-nes** (AGPL-3.0: ideas only, no code):
  - It shows the fallback as a red background on the old range plus the new text beside it.
  - A context key gates Tab and Esc. Its Tab binding lacks `!inSnippetMode`, so ours adds it.
  - Its SVG/shiki preview, clipboard context and temp-dir files are things to avoid.
  - Its other good ideas (suppression rules, diagnostics, hunk queue, piggybacking, cursor target, `displayLocation` labels) go to the follow-ups doc in Task 9.

**Branch:** a local branch `feat/next-edit-formats` from `main` (already created; this plan is its first commit). Tasks never push. The Publish section does that, after the user says yes.

## Global Constraints

- **Imports:**
  - Only these files may `import 'vscode'`: `src/extension.ts`, `src/log.ts`, `src/config/vscodeSettings.ts`, `src/config/secrets.ts`, `src/completion/provider.ts`, `src/completion/contextTracker.ts`, `src/ui/*`, `src/nextEdit/vscode/*`.
  - Every module this plan creates outside `src/nextEdit/vscode/` is pure.
- **Runtime dependencies:** exactly `diff` and `jsonc-parser`. No syntax highlighter, no images, no files written to disk.
- **Privacy (unchanged from 3a):**
  - No telemetry. Requests go only to the backend in `aiAutocomplete.nextEdit.backend`.
  - `privacy.localOnly` applies.
  - Excluded files (`fim.disableInFiles`, `fim.disableInLanguages`, outside the workspace) never reach a prompt.
  - Other files' diffs and snippets go out only with extra context on.
  - Prompt and answer text is logged only with `aiAutocomplete.debug.logPrompts`.
  - The git-ignored `.env` is never read, logged or copied.
- **Licences:**
  - `src/nextEdit/formats/sweep.ts` adapts Apache-2.0 scripts. It starts with `// Portions adapted from sweepai/sweep-next-edit-1.5B run_model.py @ 409016591c6c1a94f545f22328a85a3516118f34 and sweepai/sweep-next-edit-v2-7B inference.py @ 851f4ac1427ec91eb6c19d408409490d6e0c00a0 (Apache-2.0). Copyright Sweep AI.`, and `THIRD_PARTY_NOTICES.md` gets a Sweep entry (Task 9).
  - `zeta21.ts` implements the format described on the Apache-2.0 model card and copies no code. It names the card in a plain comment, without a "Portions adapted" header.
  - Never read, copy or adapt Zed's source (GPL), sr-tream/vscode-nes (AGPL), cursortab or sweepai/vscode-nes (no licence).
  - Never add Zeta's `sample.prompt` or `sample.output` to the repo: their content is Zed GPL source. Test fixtures are our own.
- **Special tokens in user text:** a file text that contains a format's reserved strings would turn into control tokens. Such a region or current-file excerpt is not sent, and such snippets and history entries are left out (Review Focus 1).
- **Versions:** `engines.vscode` stays `^1.100.0`; nothing new from the proposed API.
- **Commits:**
  - Conventional Commits, one per task with the message given.
  - **No `Co-Authored-By` line** (the user's choice, 2026-11-16; the plan commit updates AGENTS.md).
  - Stage files by explicit path; never stage `*.swp` or `.env`.

## Rulings made while planning (each cheap to change)

1. **Format choice in `auto`:**
   - a model id matching `/zeta/i` gets `zeta21`;
   - `/sweep/i` gets `sweep` (v2 when it also matches `/v2|7b/i`, else v1);
   - anything else, or an unknown model, gets `chatXtab`.
   - The setting is global (resource scope). Users who run a Zeta model next to a FIM model set the backend's `nextEditModel`. *If wrong:* a per-backend format field.
2. **Raw formats use `streamFim` with a `template` payload**, so llama.cpp gets `/completion` (with `cache_prompt`) and OpenAI-compatible servers get `/v1/completions`. No new backend method. `FimRequest` gains an optional `onTruncated()` so a length-cut answer is dropped. *If wrong:* a dedicated backend method.
3. **Sweep v1 follows the official script; v2 follows `inference.py`.** The open question is which layout the 0.5B/1.5B GGUFs really saw: Sweep's own local server feeds them v2. The smoke test compares; a model id can always be forced with `nextEdit.format` plus a model name containing `v2`. *If wrong:* swap the variant rule.
4. **Sweep's window is its trained one** (10 above, 10 below). The region settings apply to `chatXtab` and `zeta21` only.
5. **Zeta's blocks follow our own rule** (Task 5) built from the spec's "blocks are 6–16 lines". Zed's exact boundary rule is GPL code we do not read. The model reads markers wherever they are; the probe used a single block and answered correctly.
6. **Zeta's history is our zero-context unified diff with `a/` and `b/` path prefixes.** The card shows unified diffs, and the probe used zero context.
7. **Temperature 0 for both raw formats.** The spec's dedicated-model row says greedy. The Zeta row said 0.2, but the probe at 0 answered well, and greedy keeps one request per version deterministic. Task 9 updates the spec row.
8. **The context budget is one number:** `nextEdit.contextBudget` in tokens, default 3500, split 3/7 file, 2/7 history, 2/7 snippets. That is 1500/1000/1000, exactly 3a's constants.
9. **Display modes:** `auto` uses native when the proposal is enabled and decorations otherwise; `native` drops inline edits without the proposal (3a behaviour, with its one-time notice); `decorations` always uses decorations. Ghost text (pure insertion at the cursor) is unaffected by the setting.
10. **The decoration preview is text, not an image.**
    - Changed parts of the old lines get a red background.
    - Each changed line shows its new text as an `after` decoration.
    - Extra new lines are counted ("+N lines") rather than drawn.
    - A hint on the cursor line says what Tab does.
    - The native UI stays the better view, and the README says so.
11. **Tab jumps first when the edit is away from the cursor** (the cursor line is outside `[startLine - 1, max(endLine, startLine)]`): it moves the cursor to the edit's first line. A second Tab applies. Esc dismisses and counts as a rejection (the 5 s cooldown).
12. **A pending decoration is cleared** by any change to its document, an active-editor change, a new result, Esc, apply, snooze or `reset()`. It is not cleared by cursor moves, because the jump is a cursor move. Applying checks the document version first and clears instead of applying when it changed.
13. **The extra features vscode-nes has are follow-ups, not 3b:** suppression rules, diagnostics in the prompt, a hunk queue, piggybacking on typing, a cursor target after accept, and native `displayLocation` labels. The user asked to stick to the plan. The spec's optional `instinct` format is not in 3b either.
14. **The status-bar menu gains two entries** (user request, 2026-11-16): **Enable native Next Edit UI...** while the proposed API is not enabled, and **Settings...**, which opens the Settings page filtered to this extension.

## Review Focus

1. **Reserved strings in the user's files.** This repo's own sources and tests contain `<|file_sep|>`, `<|marker_1|>` and `<[fim-suffix]>`. A region or current-file excerpt with a reserved string must not be sent, and snippets or history entries with one are dropped, never sent half-escaped. Tests: Task 4 and Task 5 (`problem` and dropped pieces), Task 6 (no request).
2. **Malformed raw answers.** None may produce an edit outside the region:
   - a Zeta answer with fewer than two markers, markers out of range or decreasing, or no `<[fim-middle]>` echo;
   - a Sweep answer starting with `<|`, empty for a non-blank window, or more than 20 lines longer than the window;
   - any answer cut at `max_tokens`.

   Tests: Task 3 (truncation), Task 4 and Task 5 (parsers).
3. **Tab never steals from the editor.** With a decoration pending, Tab must still accept a visible ghost text or suggest-widget item, move through snippet placeholders, and indent when a selection exists. Without a pending decoration, Tab is untouched. Tests: Task 8 (manifest `when` clauses, integration with no pending edit).
4. **A decoration applied to changed text.** If the document changes between showing and Tab (typing elsewhere, undo, another extension), Tab never applies the old edit to shifted lines. Tests: Task 7 (plan uses only the result's lines), Task 8 (version check, clear on change).
5. **File edges and line endings in raw formats.**
   - Cases: the cursor on line 0 or the last line, a file shorter than Sweep's 21-line window, a file without a trailing newline, a CRLF document.
   - Windows and prompts stay inside the file and use `\n`; the inserted text uses the document's EOL.
   - Tests: Task 4, Task 5 and Task 6.

---

### Task 1: Next Edit settings and budgets

**Files:**
- Modify: `src/config/settings.ts`, `package.json` (`contributes.configuration`), `src/nextEdit/region.ts`
- Test: `test/unit/settings.test.ts`, `test/unit/manifest.test.ts`, `test/unit/nextEdit/region.test.ts`

**Interfaces:**
- Produces:
  - In `settings.ts`: `export const NEXT_EDIT_FORMATS = ['auto', 'chatXtab', 'sweep', 'zeta21'] as const` and `export const NEXT_EDIT_DISPLAYS = ['auto', 'native', 'decorations'] as const`, with types `NextEditFormatSetting` and `NextEditDisplay`.
  - `Settings.nextEdit` gains `format: NextEditFormatSetting; display: NextEditDisplay; regionLinesAbove: number; regionLinesBelow: number; historySize: number; contextBudget: number`.
  - In `region.ts`: `editableRegion(cursorLine: number, lineCount: number, above = REGION_ABOVE, below = REGION_BELOW): LineSpan`. `REGION_MAX_LINES` is removed; the size is `above + below + 1`.
  - In `region.ts`: `export interface NextEditBudgets { fileChars: number; historyChars: number; snippetsChars: number }` and `export function nextEditBudgets(contextTokens: number): NextEditBudgets`. It takes `contextTokens × CHARS_PER_TOKEN` split 3/7, 2/7, 2/7, each rounded.

- [ ] **Step 1: Write the failing tests**

In `settings.test.ts`:
- `nextEdit 3b defaults`: an empty source gives `format: 'auto'`, `display: 'auto'`, `regionLinesAbove: 5`, `regionLinesBelow: 10`, `historySize: 5`, `contextBudget: 3500`.
- `nextEdit 3b values are read`: `format: 'zeta21'`, `display: 'decorations'`, `regionLinesAbove: 3`, `regionLinesBelow: 20`, `historySize: 2`, `contextBudget: 6000` come back as given.
- `nextEdit 3b invalid values fall back with a problem`:
  - `format: 'instinct'` gives `'auto'` and a problem naming `aiAutocomplete.nextEdit.format`;
  - `regionLinesAbove: 21`, `regionLinesBelow: -1`, `historySize: 11` and `contextBudget: 500` each give their default and a problem naming the key.

In `manifest.test.ts`:
- `nextEdit format and display enums match the code`: the `enum` of `aiAutocomplete.nextEdit.format` equals `[...NEXT_EDIT_FORMATS]` and that of `.display` equals `[...NEXT_EDIT_DISPLAYS]`.

In `region.test.ts`:
- `editableRegion takes the configured sizes`: `editableRegion(10, 100, 2, 3)` is `{ start: 8, end: 13 }`.
- `editableRegion keeps 3a's default`: `editableRegion(10, 100)` is `{ start: 5, end: 20 }`.
- `nextEditBudgets(3500)` is `{ fileChars: 5250, historyChars: 3500, snippetsChars: 3500 }` (3a's constants).

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/settings.test.ts test/unit/manifest.test.ts test/unit/nextEdit/region.test.ts`
Expected: FAIL (fields and exports missing).

- [ ] **Step 3: Implement**

`package.json`: add the six settings with `"scope": "resource"`. Their limits:
- `regionLinesAbove`: integer 0–20;
- `regionLinesBelow`: integer 0–40;
- `historySize`: integer 0–10;
- `contextBudget`: integer 1000–16000.

The format and display enums carry `enumDescriptions`:
- `auto`: picks by the model name;
- `sweep`: Sweep next-edit models on a raw completions route;
- `zeta21`: Zeta 2.1 on a raw completions route;
- display `decorations`: works without the proposed API.

`settings.ts` reads them like `nextEdit.timeoutMs`: an invalid value gives the default and a problem `aiAutocomplete.nextEdit.<key>: expected …, ignored`.

- [ ] **Step 4: Run the tests, typecheck and lint**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: PASS. `chatXtab.ts` still uses its own constants until Task 3.

- [ ] **Step 5: Commit**

```bash
git add src/config/settings.ts package.json src/nextEdit/region.ts test/unit/settings.test.ts test/unit/manifest.test.ts test/unit/nextEdit/region.test.ts
git commit -m "feat: Next Edit format, display, region, history and budget settings"
```

### Task 2: Structured history hunks and the text before the latest change

**Files:**
- Modify: `src/nextEdit/history.ts`
- Test: `test/unit/nextEdit/history.test.ts`

**Interfaces:**
- Produces:
  - `export interface DiffHunk { oldStart: number; newStart: number; oldLines: string[]; newLines: string[] }`. The starts are 0-based line indexes where the change begins in the old and new text; an empty side marks where lines would go.
  - `DiffEntry` gains `hunks: DiffHunk[]` (the zero-context hunks of `text`).
  - `EditHistory.maxEntries` becomes a public mutable number, and lowering it drops the oldest entries at the next commit.
  - `EditHistory.previous(path: string): { lines: string[]; hunks: DiffHunk[] } | undefined`. It returns the file before the change recorded by the newest entry for `path`, as lines, and that entry's hunks. It returns `undefined` when there is no entry for `path`, or when a later commit of `path` recorded no entry (over the diff budget, or the edits cancelled out). After that, the newest entry no longer describes the current text.
  - `export function spanBefore(hunks: DiffHunk[], span: LineSpan): LineSpan` maps a span of the new text to the old text. A bound inside a hunk's new lines expands to the hunk's whole old range.

- [ ] **Step 1: Write the failing tests**

- `entries carry zero-context hunks`: opening `a\nb\nc\n` and committing `a\nB\nB2\nc\n` gives one entry with `hunks` `[{ oldStart: 1, newStart: 1, oldLines: ['b'], newLines: ['B', 'B2'] }]`. Its `text` is unchanged from 3a.
- `a pure insertion has an empty old side`: `a\nc\n` → `a\nb\nc\n` gives `[{ oldStart: 1, newStart: 1, oldLines: [], newLines: ['b'] }]`.
- `previous gives the text before the latest change`: after the commit above, `previous(path)` is `{ lines: ['a', 'b', 'c'], hunks: [...] }`.
- `previous follows a merged entry`: two commits starting on the same line merge (3a rule), and `previous` gives the older snapshot's lines.
- `previous is undefined after a commit that recorded nothing`: a commit whose diff exceeds the budget (reuse 3a's large-file fixture) makes `previous` undefined. So does a commit that undoes the last edit exactly (cancel-out).
- `spanBefore maps across an insertion`: with the hunk above, `{ start: 3, end: 4 }` maps to `{ start: 2, end: 3 }`, and `{ start: 2, end: 3 }` (it starts inside the new lines) maps to `{ start: 1, end: 2 }`.
- `maxEntries can be lowered`: with 5 entries, setting `maxEntries = 2` and committing once more leaves the newest 2.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/nextEdit/history.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the hunk conversion from jsdiff's `structuredPatch` hunks: the 0-based start is the 1-based `oldStart`/`newStart` minus 1 in both the empty and the non-empty case. Check it against the tests. Keep the per-entry base text that 3a already stores; `previous` reads it.

- [ ] **Step 4: Run all unit tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/nextEdit/history.ts test/unit/nextEdit/history.test.ts
git commit -m "feat: structured history hunks and the text before the latest change"
```

### Task 3: The format interface and the raw completion transport

**Files:**
- Create: `src/nextEdit/formats/format.ts`, `src/nextEdit/formats/index.ts`
- Modify: `src/nextEdit/formats/chatXtab.ts`, `src/nextEdit/request.ts`, `src/backends/types.ts`, `src/backends/llamacpp.ts`, `src/backends/openaiCompat.ts`
- Test: `test/unit/nextEdit/chatXtab.test.ts`, `test/unit/nextEdit/request.test.ts`, `test/unit/nextEdit/formats.test.ts` (new), `test/unit/llamacpp.test.ts`, `test/unit/openaiCompat.test.ts`

**Interfaces:**
- Consumes: `NextEditBudgets` (Task 1), `DiffEntry.hunks` and `previous` (Task 2).
- Produces (in `format.ts`):
  - `export type FormatId = 'chatXtab' | 'sweep' | 'zeta21'`.
  - `NextEditInput` moves here from `chatXtab.ts`. It gains `budgets: NextEditBudgets` and `previous?: { lines: string[]; hunks: DiffHunk[] }`, and keeps `path`, `lines`, `cursor`, `region`, `history: DiffEntry[]` and `snippets: Snippet[]`.
  - `export type FormatAnswer = { kind: 'rewrite'; lines: string[] } | { kind: 'noChange' } | { kind: 'invalid'; why: string }`.
  - The shared base: `interface FormatBase { id: FormatId; region(cursorLine: number, lineCount: number, size: { above: number; below: number }): LineSpan; problem(input: NextEditInput): string | undefined }`.
  - `export interface ChatFormat extends FormatBase { transport: 'chat'; messages(input: NextEditInput, systemSuffix?: string): { messages: ChatMessage[]; stableChars: number }; done(visible: string): boolean; parse(visible: string, complete: boolean): FormatAnswer }`.
  - `export interface CompletionFormat extends FormatBase { transport: 'completion'; prompt(input: NextEditInput): { prompt: string; prefill: string; stop: string[]; maxTokens: number }; parse(answer: string, input: NextEditInput): FormatAnswer }`. Here `answer` is the prefill plus the generated text, with a trailing stop string, if a server echoed one, removed.
  - `export type NextEditFormat = ChatFormat | CompletionFormat`.
  - `export function tooLong(input: NextEditInput): boolean` is true when the region text is longer than `2 × budgets.fileChars`; every format's `problem` uses it.
- Produces (in `index.ts`): `export function pickFormat(setting: NextEditFormatSetting, model: string | undefined): NextEditFormat` (Ruling 1). Tasks 4 and 5 register sweep and zeta21. Until then, `sweep` and `zeta21` fall back to chatXtab, and Task 4 replaces that.
- Produces: `chatXtab` as a `ChatFormat`.
  - `region` is `editableRegion` with the settings sizes.
  - `problem` returns `'fence'` or `'tooLong'`.
  - Budgets come from `input.budgets`, and the constants `FILE_BUDGET_CHARS` etc. are removed.
  - The prompt text is otherwise unchanged.
- Produces: `FimRequest` gains `onTruncated?(): void`.
  - llama.cpp calls it when the final event has `stop_type === 'limit'`.
  - OpenAI-compatible backends call it on `choices[0].finish_reason === 'length'`.
- Produces: `runNextEdit` takes `format: NextEditFormat` and a snapshot whose `input` is the new `NextEditInput`.
  - Chat formats run as in 3a.
  - Completion formats call `backend.streamFim` with `{ model, payload: { route: 'template', prompt }, stop, sampling: { temperature: 0, maxTokens }, extraBody: values.extraBody, signal, timeoutMs: values.timeoutMs, onTruncated }`. No `timeMaxPredictMs`, no top_p or top_k.
  - A truncated answer resolves `undefined`.
  - `onPrompt` takes `ChatMessage[] | string`.

- [ ] **Step 1: Write the failing tests**

- In `formats.test.ts`, `pickFormat` cases:
  - `('auto', 'randmaru/zeta-2.1-mlx')` → `zeta21`;
  - `('auto', 'sweep-next-edit-1.5b')` → `sweep`;
  - `('auto', 'qwen3.8-flash-next-iq3_s')` → `chatXtab`;
  - `('auto', undefined)` → `chatXtab`;
  - `('chatXtab', 'zeta-2.1')` → `chatXtab`.
- In `chatXtab.test.ts`: the existing prompt tests pass `budgets: nextEditBudgets(3500)` and still produce the same text. Add `a smaller budget clips more`: with `nextEditBudgets(1000)`, the file section of a 200-line file is shorter.
- In `request.test.ts`, with a fake backend whose `streamFim` yields chunks and records the request:
  - `a completion format sends a template prompt with temperature 0`. A stub `CompletionFormat` returns prompt `P`, prefill `pre\n`, stop `['<|x|>']` and maxTokens 99. Expect the recorded request to have payload `{ route: 'template', prompt: 'P' }`, `sampling` equal to `{ temperature: 0, maxTokens: 99 }` and `stop` `['<|x|>']`, and the stub's `parse` to receive `pre\n` + the streamed text.
  - `a truncated completion gives no result`: the fake calls `req.onTruncated()` before ending; the result is `undefined`.
  - `chat formats are unchanged`: the 3a request tests pass with `format: pickFormat('chatXtab', …)`.
- In the backend tests:
  - `llama.cpp reports a length stop`: an SSE stream ending `{"stop":true,"stop_type":"limit"}` calls `onTruncated` once;
  - `OpenAI-compatible reports finish_reason length`: same for `{"choices":[{"text":"","finish_reason":"length"}]}`;
  - neither calls it on a normal stop.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/nextEdit test/unit/llamacpp.test.ts test/unit/openaiCompat.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**, keeping `request.ts`'s chat path byte-for-byte equivalent. The controller keeps compiling with 3a's behaviour:
  - it builds the input with `budgets: nextEditBudgets(s.nextEdit.contextBudget)` and picks snippets with `budgets.snippetsChars`;
  - it passes `pickFormat('chatXtab', model)` and calls that format's `problem` where it called `regionProblem`.

  Task 6 wires the real choice.

- [ ] **Step 4: Run all unit tests, typecheck and lint**

Run: `npm run build && npx vitest run && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/nextEdit/formats/format.ts src/nextEdit/formats/index.ts src/nextEdit/formats/chatXtab.ts src/nextEdit/request.ts src/nextEdit/vscode/controller.ts src/backends/types.ts src/backends/llamacpp.ts src/backends/openaiCompat.ts test/unit
git commit -m "feat: Next Edit format interface and the raw completion transport"
```
(Stage the exact test files you changed, not the whole directory, if `*.swp` files are present.)

### Task 4: The sweep format

**Files:**
- Create: `src/nextEdit/formats/sweep.ts`
- Modify: `src/nextEdit/formats/index.ts`
- Test: `test/unit/nextEdit/sweep.test.ts`

**Interfaces:**
- Consumes: `CompletionFormat`, `NextEditInput` (Task 3), `DiffHunk` and `spanBefore` (Task 2), `clipAroundRegion` (3a).
- Produces: `export function sweepFormat(variant: 'v1' | 'v2'): CompletionFormat`, registered by `pickFormat` (Ruling 1).

Exact behaviour (both variants unless marked):
- **`region`:** cursor line −10 to +10, clipped to the file. The size settings are ignored (Ruling 4).
- **Reserved strings:** `<|file_sep|>` and `<|endoftext|>`, plus `<|cursor|>` in v2. `problem` returns `'reserved'` when the region, or the current-file text the prompt would include, contains one; otherwise `tooLong` or `undefined`. Snippets and history hunks containing one are left out of the prompt.
- **Change blocks**, oldest first:
  - one block per hunk of the history entries;
  - keep the newest hunks whose blocks fit `budgets.historyChars`, at most `maxEntries` entries' worth (the history already caps entries).
- **v1 prompt.** The parts are joined with `\n`, and the prompt ends with `\n` after the last header:
  - each snippet: `<|file_sep|>{snippet.path}` and its text (within `budgets.snippetsChars`);
  - each change block: `<|file_sep|>{path}.diff`, `original:`, the old lines joined with `\n`, `updated:`, the new lines;
  - `<|file_sep|>original/{path}` and the original window;
  - `<|file_sep|>current/{path}` and the window;
  - `<|file_sep|>updated/{path}`.

  The original window is `input.previous.lines` over `spanBefore(previous.hunks, region)` when `previous` is set, else the current window. The prefill is `''`, the stop list is `['<|file_sep|>', '<|endoftext|>', '</s>']`, and `maxTokens` is 512.
- **v2 prompt** (s and e are `region.start + 1` and `region.end + 1`):
  ```
  {each snippet as `<|file_sep|>{path}\n{text}\n`}<|file_sep|>{path}
  {file section lines joined with \n}

  {change blocks joined with \n}
  <|file_sep|>original/{path}:{s}:{e}
  {original window}
  <|file_sep|>current/{path}:{s}:{e}
  {window with <|cursor|> at the cursor}
  <|file_sep|>updated/{path}:{s}:{e}
  {prefill}
  ```
  - Each change block is `<|file_sep|>{path}:{start}:{end}\noriginal:\n{old}\nupdated:\n{new}`, where start is the hunk's `newStart + 1` and end is `start + newLines.length - 1`.
  - The file section is `clipAroundRegion(lines, region, budgets.fileChars)`.
  - The prefill is the window lines above the cursor line, each followed by `\n`.
  - The stop list is `['<|file_sep|>', '<|endoftext|>']`, and `maxTokens` is 1024.
- **`parse(answer)`:**
  - The answer is invalid when it starts with `<|`.
  - Remove one trailing `\n` and any `<|cursor|>`, then split on `\n`.
  - If the window ends with k blank lines and the answer ends with fewer, append the missing blank lines.
  - An empty answer for a non-blank window is invalid, and so is an answer more than 20 lines longer than the window.
  - An answer equal to the window is `noChange`; anything else is `rewrite`.

- [ ] **Step 1: Write the failing tests** with our own fixture: a 30-line `circle.py` where `area(r)` became `area(radius)`, the cursor on line 12, and one history entry.
  - `v1 prompt layout`: the full prompt string equals the expected text, written out in the test.
  - `v1 window is 10 above and 10 below, clipped`: the cursor on line 2 of a 5-line file gives region `{ start: 0, end: 4 }`.
  - `v1 original window comes from the text before the latest change`.
  - `v2 prompt layout`: the full string, with `:3:23` ranges, `<|cursor|>` and the prefill.
  - `v2 answer is prefill + output`: `parse` receives the prefill plus generated text and returns the region lines.
  - `reserved strings`: a region line containing `<|file_sep|>` makes `problem` return `'reserved'`; a snippet containing `<|endoftext|>` is left out of the prompt.
  - `parse` cases: no change, `<|` start, too long, an empty answer, missing trailing blank lines restored, and a stray `<|cursor|>` removed.
  - `CRLF`: a document read as lines (no `\r`) gives a prompt without `\r`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/nextEdit/sweep.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** with the attribution header from the Global Constraints.

- [ ] **Step 4: Run all unit tests, typecheck and lint**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/nextEdit/formats/sweep.ts src/nextEdit/formats/index.ts test/unit/nextEdit/sweep.test.ts
git commit -m "feat: sweep Next Edit format for Sweep next-edit models"
```

### Task 5: The zeta21 format

**Files:**
- Create: `src/nextEdit/formats/zeta21.ts`
- Modify: `src/nextEdit/formats/index.ts`
- Test: `test/unit/nextEdit/zeta21.test.ts`

**Interfaces:**
- Consumes: as Task 4.
- Produces:
  - `export const zeta21Format: CompletionFormat`, registered by `pickFormat`;
  - `export function markerBlocks(lines: string[]): number[]`, the 0-based line indexes where blocks start (always `[0, …]`; an empty region gives `[0]`).

Exact behaviour:
- **`region`:** `editableRegion` with the settings sizes.
- **Blocks:** a new block starts at line i when the current block has 16 lines, or when it has at least 6 lines, line i is not blank and line i−1 is blank (Ruling 5).
- **Region text:** the region lines joined with `\n`, with no trailing newline.
  - Marker k (1-based) is glued to the start of block k's first line.
  - The last marker (number = blocks + 1) is glued to the end of the text.
  - `<|user_cursor|>` is inserted at the cursor's offset in that text.
- **Prompt:**
  ```
  <[fim-suffix]>{suffix}<[fim-prefix]>{related}{history}<filename>{path}
  {before}{region text}
  <[fim-middle]>
  ```
  - `suffix` is `\n` plus the lines after the region inside `clipAroundRegion(lines, region, budgets.fileChars)` joined with `\n`, then `\n`; with no lines after the region it is just `\n`.
  - `before` is the clipped lines above the region, each followed by `\n`.
  - `related` is each snippet as `<filename>{path}\n{text}\n` (within `budgets.snippetsChars`), then `\n` when there is any.
  - `history` is `<filename>edit_history\n` plus, oldest first, each entry's diff with `--- a/{path}` and `+++ b/{path}` headers and 3a's hunk lines, each ending in `\n`, then `\n`. It holds at most 6 entries within `budgets.historyChars`, and is left out when empty.
- **Request:** stop `['<[end▁of▁sentence]>']`, prefill `''`, and `maxTokens = min(1024, max(256, ceil(regionChars / 3 × 1.5) + 64))`.
- **Reserved strings:** `<[fim-`, `<filename>`, `<|marker_`, `<|user_cursor|>` and `<[end▁of▁sentence]>`, handled as in Task 4.
- **`parse(answer)`:**
  - Drop a trailing `<[end▁of▁sentence]>`.
  - Find the `<|marker_N|>` tags; with fewer than two the answer is invalid.
  - The first tag's number s equals the last's e → `noChange`.
  - Map s and e to character offsets of block starts in the old region text, where the last marker is the text's end. Out of range, or s > e, is invalid.
  - The new text is old[0, start) + the concatenated text between consecutive tags + old[end, ∞), with every `<|user_cursor|>` removed.
  - Equal to the old text → `noChange`; else `rewrite` with the new text split on `\n`.

- [ ] **Step 1: Write the failing tests** with the probe's `circle.py` as our own fixture.
  - `prompt layout`: the full string, with the edit_history diff, inline markers and the cursor.
  - `markerBlocks` cases:
    - 5 lines → `[0]`;
    - 20 non-blank lines → `[0, 16]`;
    - 8 lines with a blank line at index 6 → `[0, 7]`;
    - a blank line before line 3 does not split (fewer than 6 lines).
  - `the answer from the probe rewrites both functions`: `parse` of `<|marker_1|>def circumference(radius):\n    return 2 * 3.14159 * radius\n\n\ndef diameter(radius):\n    return 2 * radius\n<|marker_2|>` gives the expected lines.
  - `same marker twice is no change`: `<|marker_1|><|marker_1|>`.
  - `a span over the second block keeps the first`: a 20-line region and answer `<|marker_2|>X<|marker_3|>` replace only lines 16–19.
  - `invalid answers`: one marker, marker 9 out of range, and markers 3 then 1.
  - `reserved strings`: as Task 4.
  - `the cursor marker is stripped from the answer`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/nextEdit/zeta21.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** The file's first comment names the source: the format described on the zed-industries/zeta-2.1 model card (Apache-2.0), with no code copied.

- [ ] **Step 4: Run all unit tests, typecheck and lint**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/nextEdit/formats/zeta21.ts src/nextEdit/formats/index.ts test/unit/nextEdit/zeta21.test.ts
git commit -m "feat: zeta21 Next Edit format for Zeta 2.1"
```

### Task 6: Use the formats and settings in the controller

**Files:**
- Modify: `src/nextEdit/vscode/controller.ts`, `test/integration/mockServer.ts`, `test/integration/nextEdit.test.ts`
- Test: `test/integration/nextEdit.test.ts`

**Interfaces:**
- Consumes: everything above.
- Behaviour:
  - **Format and route.** After the model is known, the controller calls `format = pickFormat(s.nextEdit.format, model)`.
    - A chat format needs `routes().chat`; a completion format needs `routes().template`. Otherwise it logs once at info, `next edit: backend "{id}" has no {chat completions|raw completions} route; the {format} format needs one`, and sends nothing.
    - `thinkingBlocked` applies only to chat formats.
  - **Region and checks.** The region is `format.region(at.line, lines.length, { above: s.nextEdit.regionLinesAbove, below: s.nextEdit.regionLinesBelow })`. `format.problem(input)` replaces `regionProblem`, logged once per version as today: `next edit: not asked, {problem}`.
  - **Input.** The input carries `budgets: nextEditBudgets(s.nextEdit.contextBudget)` and `previous: this.history.previous(path)`. With extra context off, `previous` and history still use the current file only.
  - **History size.** Before each commit, `history.maxEntries` is set to `s.nextEdit.historySize`; 0 means no history.
  - **Log.** The request line gains `format={id}`. `onPrompt` logs a completion prompt as `next edit prompt: {JSON string}` (only with logPrompts).
- Produces (mock server): a `nextEditRaw?: { content: string[] }` option.
  - `POST /completion` streams it as llama.cpp events when the prompt contains `<|file_sep|>updated/`.
  - `POST /v1/completions` streams it as OpenAI events when the prompt contains `<[fim-middle]>`.
  - Both end with a normal stop.

- [ ] **Step 1: Write the failing integration tests** (`main` launch; ghost-text answers, so no inline-edit UI is needed). Set them up the way 3a's `nextEdit.test.ts` gets a Next Edit request past "FIM wins" (reuse its helpers):
  - `sweep on llama.cpp`:
    - setup: the mock's alias is `sweep-next-edit-1.5b`, Next Edit is on, and the format is `auto`;
    - edit a document so the cursor ends a line, and let the answer be the window with one line added after the cursor line;
    - expect a ghost text; the recorded `/completion` body has `prompt` containing `<|file_sep|>current/`, `temperature` 0, `stop` containing `<|file_sep|>` and no `top_p`.
  - `zeta21 on an OpenAI-compatible server`: the same with a `lmstudio`-type backend, alias `zeta-2.1`, `/v1/completions`, and an answer `<|marker_1|>{window + new line}<|marker_2|>`.
  - `a reserved string sends nothing`: a document whose region contains `<|file_sep|>` with the sweep alias records no `/completion` request after the pause.
  - `a chat-only backend skips raw formats`: with `nextEdit.format: 'sweep'` on a Strata-flavoured backend, no request is sent.

- [ ] **Step 2: Run them and see them fail**

Run: `npm run test:integration`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement** the controller changes and the mock option.

- [ ] **Step 4: Run all tests**

Run: `npm run build && npx vitest run && npm run typecheck && npm run lint && npm run test:integration`
Expected: PASS in both launches.

- [ ] **Step 5: Commit**

```bash
git add src/nextEdit/vscode/controller.ts test/integration/mockServer.ts test/integration/nextEdit.test.ts
git commit -m "feat: Next Edit picks its format and uses the raw completion route"
```

### Task 7: The decoration plan

**Files:**
- Create: `src/nextEdit/decorations.ts`
- Test: `test/unit/nextEdit/decorations.test.ts`

**Interfaces:**
- Consumes: `LineEdit`, `Pos`, `NextEditShow` from `diff.ts`; `NextEditDisplay` (Task 1).
- Produces:
  - `export function displayFor(show: NextEditShow, display: NextEditDisplay, native: boolean): 'item' | 'decorations' | 'drop'` (Ruling 9).
  - `export interface DecorationPlan { removed: { line: number; start: number; end: number }[]; deletedLines: number[]; added: { line: number; text: string }[]; hint: { line: number; text: string }; jump: boolean; target: Pos }`.
  - `export function decorationPlan(edit: LineEdit, docLines: string[], cursor: Pos): DecorationPlan`.

Rules for `decorationPlan`:
- **Pairing.** Pair old line `startLine + i` with `newLines[i]` for i below the smaller count.
  - For a pair that differs, remove the common prefix and the common suffix (never overlapping) and take the old line's differing range `[p, len − q)`. A non-empty range goes in `removed`.
  - Each differing pair adds `{ line, text: '→ ' + new line without leading whitespace }` to `added`, cut to 80 characters with `…`.
- **Unpaired lines.** Old lines beyond the pairs go in `deletedLines`.
  - New lines beyond the pairs add ` (+N lines)` to the last `added` entry. If there is none, they add an entry on the last old line, or for a pure insertion on line `startLine − 1` (line 0 when `startLine` is 0) with text `+ {first new line, trimmed}` and ` (+N lines)` when N > 1.
- **Jump.** `jump` is true when the cursor line is outside `[startLine − 1, max(endLine, startLine)]`. The `target` is the edit's first line, clamped to the document, at its first non-whitespace character.
- **Hint.** It sits on the cursor line. With a jump it reads `Next edit at line {startLine + 1} · Tab to jump · Esc to dismiss`; otherwise `Tab to apply · Esc to dismiss`. When an `added` entry is on the same line, the hint text is appended to it after `  ·  `, and `hint.text` is `''`.

- [ ] **Step 1: Write the failing tests:**
  - `displayFor` truth table: ghost → `item` in every mode; an edit with `auto` → `item` when native and `decorations` otherwise; with `native` → `item` or `drop`; with `decorations` → `decorations`.
  - `a rename marks only the changed characters`: old `    return 2 * r`, new `    return 2 * radius` → `removed` `[{ line, start: 15, end: 16 }]`, `added` text `→ return 2 * radius`.
  - `extra new lines are counted`: 1 old line → 3 new lines gives ` (+2 lines)`.
  - `deleted lines`: 3 old → 1 new gives two `deletedLines`.
  - `pure insertion anchors above`: an insertion at line 5 anchors at line 4 with `+ …`; at line 0 it anchors at line 0.
  - `jump`: the cursor 10 lines above → `jump` true, target the first non-blank of `startLine`; the cursor on `startLine − 1` → false.
  - `hint merges with an added text on the cursor line`.
  - `long new lines are cut at 80 characters`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/nextEdit/decorations.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run all unit tests, typecheck and lint**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/nextEdit/decorations.ts test/unit/nextEdit/decorations.test.ts
git commit -m "feat: plan the Next Edit decoration preview"
```

### Task 8: Show inline edits as decorations, with Tab and Esc

**Files:**
- Create: `src/nextEdit/vscode/decorations.ts`
- Modify: `src/nextEdit/vscode/controller.ts`, `src/ui/commands.ts`, `src/extension.ts`, `package.json` (commands, keybindings, palette `when: false`), `test/unit/manifest.test.ts`, `test/integration/nextEdit.test.ts`

**Interfaces:**
- Consumes: `displayFor`, `decorationPlan` (Task 7).
- Produces:
  - `class EditDecorations implements vscode.Disposable` with `show(editor: vscode.TextEditor, plan: DecorationPlan): void` and `clear(): void`. It owns five decoration types:
    - `removed`: `backgroundColor: new ThemeColor('diffEditor.removedTextBackground')`;
    - `deleted`: whole line, `diffEditor.removedLineBackground` and `textDecoration: 'line-through'`;
    - `added`: `after` with `color: new ThemeColor('editorGhostText.foreground')`, `backgroundColor: new ThemeColor('diffEditor.insertedTextBackground')` and `margin: '0 0 0 2ch'`;
    - `hint`: `after`, ghost-text colour, `fontStyle: 'italic'`, margin `0 0 0 2ch`;
    - `clear()` empties them all.
  - It sets the context key `aiAutocomplete.nextEditPending` (true on show, false on clear).
  - Controller:
    - Where 3a checked `!this.native`, the result goes through `displayFor(result.show, s.nextEdit.display, this.native)`:
      - `item` as 3a;
      - `drop` as 3a (log and `offerNativeUi`);
      - `decorations`: store the result as pending (not as `this.result`, so `itemFor` never returns it) and call `show` with its plan.
    - `nextEditTab()`:
      - With no pending edit, or a pending edit for another document or version, it clears.
      - If the plan says `jump` and the cursor is not yet on the edit's line range, it moves the cursor to `target`, reveals it `InCenterIfOutsideViewport`, and re-shows the plan for the new cursor.
      - Otherwise it applies the edit with `editor.edit` (undo stops before and after) using the document's EOL, puts the cursor at the end of the last new line (or the edit's start for a deletion), clears and calls `accepted()`.
    - `nextEditDismiss()` clears and calls `rejected()`.
    - `pendingEdit(): { uri: string; version: number; edit: LineEdit } | undefined` exists for tests.
    - A pending edit is cleared under Ruling 12: `changed()` for its document, `onDidChangeActiveTextEditor`, a new stored result, `reset()`, `dispose()`, and a snoozed `nextEditTab`.
  - Commands `aiAutocomplete.nextEditTab` and `aiAutocomplete.nextEditDismiss`, hidden from the palette (`when: false`).
  - Keybindings:
    - `tab` → `nextEditTab` when `editorTextFocus && aiAutocomplete.nextEditPending && !editorHasSelection && !inlineSuggestionVisible && !suggestWidgetVisible && !inSnippetMode && !editorTabMovesFocus && !editorReadonly`;
    - `escape` → `nextEditDismiss` when `editorTextFocus && aiAutocomplete.nextEditPending && !suggestWidgetVisible && !inSnippetMode && !inlineSuggestionVisible`.
  - `activate()` also returns `nextEditPending: () => controller.pendingEdit()` for the integration tests.

- [ ] **Step 1: Write the failing tests**
  - `manifest.test.ts`:
    - the command list adds `nextEditDismiss` and `nextEditTab`, both hidden from the palette;
    - the two keybindings exist with exactly the `when` clauses above.
  - `nextEdit.test.ts`, `main` launch (no proposed API, `display: 'auto'`), with the 3a rename fixture whose answer is an inline edit two functions below:
    - `the edit is pending and Tab jumps, then applies`: `nextEditPending()` returns the edit; the first `nextEditTab` moves the cursor to the edit's line; the second makes the document equal the expected text and clears the pending edit.
    - `Esc dismisses`: `nextEditDismiss` clears the pending edit, and the document is unchanged.
    - `typing clears a pending edit`: type a character on another line; `nextEditPending()` is undefined and a later `nextEditTab` changes nothing.
    - `display native drops it`: with `display: 'native'`, nothing is pending (3a behaviour).
  - `nextEdit.test.ts`, `proposed` launch:
    - `display decorations wins over native`: with `display: 'decorations'`, the edit is pending and no inline edit item is returned (the probe provider sees no `isInlineEdit` item).

- [ ] **Step 2: Run them and see them fail**

Run: `npm run build && npx vitest run test/unit/manifest.test.ts && npm run test:integration`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run all tests**

Run: `npm run build && npx vitest run && npm run typecheck && npm run lint && npm run test:integration`
Expected: PASS in both launches.

- [ ] **Step 5: Commit**

```bash
git add src/nextEdit/vscode/decorations.ts src/nextEdit/vscode/controller.ts src/ui/commands.ts src/extension.ts package.json test/unit/manifest.test.ts test/integration/nextEdit.test.ts
git commit -m "feat: show Next Edit inline edits as decorations with Tab and Esc"
```

### Task 9: Native UI and Settings entries in the status-bar menu

Added at the user's request (2026-11-16, Ruling 14).

**Files:**
- Modify: `src/ui/statusModel.ts`, `src/ui/commands.ts`, `src/extension.ts`, `package.json` (command `aiAutocomplete.openSettings`)
- Test: `test/unit/statusModel.test.ts`, `test/unit/manifest.test.ts`

**Interfaces:**
- Produces:
  - `menuEntries(shown: StatusState, backendCount: number, nextEditBackend: string | undefined, nativeNextEdit: boolean): MenuEntry[]`.
    - With `nativeNextEdit` false, the entry `{ label: 'Enable native Next Edit UI...', id: 'enableNativeNextEdit' }` follows `selectNextEditBackend`. With it true, the entry is absent: the UI is already on.
    - `{ label: 'Settings...', id: 'openSettings' }` follows `manageBackends`.
  - The command `aiAutocomplete.openSettings` (title `Open Settings`) runs `workbench.action.openSettings` with `@ext:raboo.ai-autocomplete`.
  - `CommandDeps` gains `nativeNextEdit(): boolean`, which `extension.ts` fills from the registration probe.

- [ ] **Step 1: Write the failing tests**
  - `statusModel.test.ts`: update the order tests.
    - Idle without native: `['toggle', 'snooze', 'selectBackend', 'selectNextEditBackend', 'enableNativeNextEdit', 'manageBackends', 'openSettings', 'setApiKey', 'retry', 'showLog', 'about']`.
    - With native: the same without `enableNativeNextEdit`.
    - The error, snoozed and no-backend orderings keep their first entries as today.
  - `manifest.test.ts`: the command list adds `openSettings`, categorised, visible in the palette.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/statusModel.test.ts test/unit/manifest.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run all tests**

Run: `npm run build && npx vitest run && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/statusModel.ts src/ui/commands.ts src/extension.ts package.json test/unit/statusModel.test.ts test/unit/manifest.test.ts
git commit -m "feat: native Next Edit UI and Settings entries in the status-bar menu"
```

### Task 10: Docs, notices, spec and roadmap

**Files:**
- Modify: `README.md`, `AGENTS.md`, `THIRD_PARTY_NOTICES.md`, `docs/ROADMAP.md`, `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md`, `docs/superpowers/followups/2026-11-13-phase0-1-review-followups.md`

- [ ] **Step 1: README**
  - Next Edit formats, and which models they fit:
    - Sweep next-edit 0.5B/1.5B/v2-7B and Zeta 2.1 on llama.cpp or LM Studio, with `nextEditModel` set when the server lists several models;
    - chatXtab for chat models such as Qwen3.8 on Strata.
  - The display modes: the native UI is the best view; decorations work everywhere with Tab (jump, then apply) and Esc.
  - The six new settings, and the two new menu entries.
  - In the troubleshooting part: debug lines appear only with the output channel's log level at Debug (**Developer: Set Log Level…** → AI Autocomplete → Debug), and `debug.logPrompts` belongs in User settings.
  - Files containing a format's special strings get no Next Edit.

- [ ] **Step 2: AGENTS.md**
  - The trailer rule already changed in the plan commit; leave it.
  - Layout: add `formats/format.ts`, `formats/index.ts`, `formats/sweep.ts`, `formats/zeta21.ts`, `decorations.ts` and `vscode/decorations.ts`.
  - The Next Edit summary line now names Sweep, Zeta and the decoration fallback.

- [ ] **Step 3: THIRD_PARTY_NOTICES.md**: a Sweep AI entry naming both HF files and commits, under Apache-2.0 (the project's own licence text applies; name the source).

- [ ] **Step 4: Spec**
  - Next Edit pipeline: the formats as built, with Rulings 1–7.
  - Display: Rulings 9–12.
  - Sampling: the Zeta row becomes temperature 0, `max_tokens = min(1024, max(256, region-based))`, stop `<[end▁of▁sentence]>` only.
  - Settings: the six settings with their limits.
  - "To verify":
    - the Zeta licence question is answered (GPL builder, clean-room from the card);
    - the Sweep cursor-marker question is answered (v1 has none, v2 has `<|cursor|>`);
    - new open item: which Sweep layout the 0.5B/1.5B GGUFs were trained on (Ruling 3).
  - The research facts marked **(research)** in this plan.

- [ ] **Step 5: ROADMAP**
  - 3a is "released in v0.3.0", and 3b links this plan as "implemented on `feat/next-edit-formats` (not merged or released)".
  - Add a Phase 3b smoke checklist under Deferred manual checks:
    - LM Studio with `randmaru/zeta-2.1-mlx` as the Next Edit model: a rename propagates, and an unrelated edit offers nothing;
    - Sweep 1.5B (GGUF in LM Studio or llama.cpp): a rename propagates; note whether v1 or v2 answers better;
    - decorations without the opt-in: Tab jumps then applies, Esc dismisses, and Tab still indents, accepts ghost text and moves through snippets;
    - `display: decorations` with the opt-in;
    - a file in this repo containing `<|file_sep|>` gets no request;
    - the status-bar menu shows **Enable native Next Edit UI...** until the opt-in is active, and **Settings...** opens the extension's settings.

- [ ] **Step 6: Follow-ups doc**
  - A "Phase 3b" section with the vscode-nes ideas from Ruling 13, each with one line on why it would help:
    - suppression rules (window unfocused, a multi-line selection, a bulk change, snippet mode);
    - LSP diagnostics in the prompt;
    - splitting disjoint hunks into a queue;
    - reusing a request while the user types into its ghost text;
    - a cursor target after accept;
    - a context-exit retrigger;
    - native `displayLocation` labels and `debounceDelayMs: 0` metadata.
  - Plus anything parked during execution.

- [ ] **Step 7: Check and commit**

Run: `npm run build && npx vitest run && npm run lint`
Expected: PASS.

```bash
git add README.md AGENTS.md THIRD_PARTY_NOTICES.md docs/ROADMAP.md docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md docs/superpowers/followups/2026-11-13-phase0-1-review-followups.md
git commit -m "docs: Phase 3b formats, decorations and settings"
```

---

## Publish (needs the user's yes at each step)

1. **Verify:** `npm run build && npx vitest run && npm run typecheck && npm run lint && npm run test:integration`, both launches green.
2. **Live probe (controller, local only):** build a zeta21 prompt for the test fixture with the built code and send it to the user's LM Studio (`http://127.0.0.1:1234/v1/completions`, model `randmaru/zeta-2.1-mlx`). Expect the rename. This sends synthetic code only, and only to the local server.
3. **Push and PR:** push `feat/next-edit-formats`, then open a PR. The squash commit body has no Claude line.
4. **The user smoke-tests the PR's CI `.vsix`** with the ROADMAP Phase 3b checklist.
5. **Merge:** a squash merge once the user OKs. Releasing (0.4.0) is a separate yes.
