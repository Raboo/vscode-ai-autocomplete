# Backend Roles ("Use for") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each backend says whether it serves Completions, Next Edit or both; the page, pickers and Test follow that, and Next Edit-only models stay out of ghost text.

**Architecture:** A `use` array on each backend entry (missing = both) is parsed in `config/settings.ts` and drives backend selection. The pure page logic (`manage/form.ts`, `manage/pageState.ts`) and the page (`webview/backends/*`) gain checkboxes and per-use fields. The connection test gains a Next Edit step that runs `runNextEdit` with a built-in sample. Ghost text cuts answers at Next Edit special tokens in `completion/postprocess.ts`.

**Tech Stack:** TypeScript (strict), vitest, esbuild, VS Code extension API.

**Spec:** `docs/superpowers/specs/2026-11-16-backend-roles-design.md` (the decisions there are binding), within `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md` and `docs/superpowers/specs/2026-11-14-backend-manager-design.md`.

## Global Constraints

- Only these files may `import 'vscode'`: `src/extension.ts`, `src/log.ts`, `src/config/vscodeSettings.ts`, `src/config/secrets.ts`, `src/completion/provider.ts`, `src/completion/contextTracker.ts`, `src/ui/*`, `src/nextEdit/vscode/*`.
- The Backends page never receives an API key; server-supplied text (model ids, error bodies) is HTML-escaped; error text shown in the page is fixed text.
- Prompt, completion and answer text is logged only when `aiAutocomplete.debug.logPrompts` is true.
- `aiAutocomplete.backends` is machine-scoped and read from `globalValue` only.
- Existing settings without `use` must behave exactly as before this phase.
- UI words: "Completions" and "Next Edit"; never FIM, NES or NEP in page text.
- Commits: Conventional Commits, one per task with the plan's message, **no `Co-Authored-By` trailer**; stage by explicit path only (never `git add -A`; the user keeps `*.swp` files in the tree).
- Run `npm run build` before `npm test` (a manifest test reads `dist/extension.js`); `npm run typecheck` and `npm run lint` must pass.

## Review Focus

1. Settings without `use` (the user's own `lmstudio` backend with `fim.backend: "lmstudio"`): same backend chosen for completions, same Next Edit model, same page.
2. `fim.backend` set to a backend whose `use` lacks completions: completions have no backend (a problem entry), never a silent switch to another backend.
3. Hand-edited `use: []`, `use: "nextEdit"` (not an array) or `use: ["nextEdit", "chat"]`: a problem entry, and the parsed value is "both" (for `[]`, non-arrays) or the known values only.
4. Next Edit test on a backend without the route its format needs (for example Strata, chat only, with a Sweep model): a warning naming the missing route, and no request sent.
5. A normal completion model whose answer contains `<|endoftext|>` in the middle: ghost text keeps the text before it, not nothing.

---

### Task 1: The `use` setting, backend selection and pickers

**Files:**
- Modify: `src/types.ts` (`BackendConfig`), `src/config/settings.ts` (`parseBackendEntry`, `fim.backend` and `nextEdit.backend` selection), `src/completion/effective.ts` (`nextEditModel`), `src/nextEdit/vscode/controller.ts` (`model()`), `src/ui/commands.ts` (pickers), `package.json` (schema)
- Test: `test/unit/settings.test.ts`, `test/unit/effective.test.ts`, `test/unit/manifest.test.ts`

**Interfaces:**
- Produces:
  - `export type BackendUse = 'completions' | 'nextEdit'` and `export const BACKEND_USES: readonly BackendUse[] = ['completions', 'nextEdit']` in `src/config/settings.ts`.
  - `BackendConfig.use: { completions: boolean; nextEdit: boolean }` (always set by `parseBackendEntry`; missing in the entry = both true).
  - `export function usesFor(cfg: BackendConfig, use: BackendUse): boolean` in `src/config/settings.ts`.
  - `nextEditModel(backend, detected)`: unchanged signature; ignores `fimModel` when `backend.use.completions` is false.

- [x] **Step 1: Write the failing tests** (in `settings.test.ts`, `effective.test.ts`, `manifest.test.ts`)

```ts
test('a backend without use serves both', () => {
  const b = parseBackendEntry(B('a'), 0, new Set(), []);
  expect(b?.use).toEqual({ completions: true, nextEdit: true });
});
test('use lists the uses', () => {
  const b = parseBackendEntry({ ...B('z'), use: ['nextEdit'] }, 0, new Set(), []);
  expect(b?.use).toEqual({ completions: false, nextEdit: true });
});
test('bad use values are problems; an empty or non-array use counts as both', () => {
  for (const use of [[], 'nextEdit', 5]) {
    const problems: string[] = [];
    expect(parseBackendEntry({ ...B('a'), use }, 0, new Set(), problems)?.use).toEqual({ completions: true, nextEdit: true });
    expect(problems.join()).toMatch(/aiAutocomplete\.backends\[0\] \("a"\): use/);
  }
  const problems: string[] = [];
  expect(parseBackendEntry({ ...B('a'), use: ['nextEdit', 'chat'] }, 0, new Set(), problems)?.use).toEqual({ completions: false, nextEdit: true });
  expect(problems.join()).toMatch(/"chat"/);
});
test('fim.backend unset falls back to the first backend with completions', () => {
  const { settings } = parseSettings(src({ backends: { globalValue: [{ ...B('z'), use: ['nextEdit'] }, B('c')] } }));
  expect(settings.fim.backendId).toBe('c');
});
test('fim.backend naming a Next Edit-only backend gives completions no backend', () => {
  const { settings, problems } = parseSettings(src({ backends: { globalValue: [{ ...B('z'), use: ['nextEdit'] }, B('c')] }, 'fim.backend': { globalValue: 'z' } }));
  expect(settings.fim.backendId).toBeUndefined();
  expect(problems.join()).toMatch(/fim\.backend: backend "z" is not used for completions/);
});
test('nextEdit.backend naming a completions-only backend leaves Next Edit off', () => {
  const { settings, problems } = parseSettings(src({ backends: { globalValue: [{ ...B('c'), use: ['completions'] }] }, 'nextEdit.backend': { globalValue: 'c' } }));
  expect(settings.nextEdit.backendId).toBeUndefined();
  expect(problems.join()).toMatch(/nextEdit\.backend: backend "c" is not used for Next Edit/);
});
// effective.test.ts
test('a Next Edit-only backend never uses its completion model for Next Edit', () => {
  const cfg = { ...base, fimModel: 'coder', use: { completions: false, nextEdit: true } };
  expect(nextEditModel(cfg, 'detected')).toBe('detected');
  expect(nextEditModel({ ...cfg, use: { completions: true, nextEdit: true } }, 'detected')).toBe('coder');
});
// manifest.test.ts
test('backends entries declare use', () => {
  const use = manifest.contributes.configuration.properties['aiAutocomplete.backends'].items.properties.use;
  expect(use.items.enum).toEqual(['completions', 'nextEdit']);
});
```

Every existing test that builds a `BackendConfig` literal gets `use: { completions: true, nextEdit: true }` (or a shared helper), so the suites typecheck.

- [x] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/settings.test.ts test/unit/effective.test.ts test/unit/manifest.test.ts`
Expected: FAIL (no `use` on the parsed backend, no schema entry).

- [x] **Step 3: Implement**
  - `parseBackendEntry` parses `use` as above; problem texts start `${at} ("${id}"): use …`.
  - `fim.backend`: the fallback is the first backend with `use.completions`. A requested id that exists but lacks completions → `backendId` undefined plus the problem `aiAutocomplete.fim.backend: backend "<id>" is not used for completions; completions have no backend`. An unknown id keeps today's text, now falling back to the first completions backend.
  - `nextEdit.backend`: an existing id without `use.nextEdit` → off plus `aiAutocomplete.nextEdit.backend: backend "<id>" is not used for Next Edit; Next Edit is off`.
  - `package.json`: under the backends item, `"use": { "type": "array", "items": { "type": "string", "enum": ["completions", "nextEdit"] }, "uniqueItems": true, "description": "What the backend is used for. Missing means both." }`.
  - `controller.ts` `model()`: the early return uses `cfg.nextEditModel !== undefined || (cfg.use.completions && cfg.fimModel !== undefined)`.
  - `commands.ts`: `pickBackend` gets a `use?: BackendUse` filter; **Select backend** passes `'completions'`, **Select Next Edit Backend** lists only `usesFor(b, 'nextEdit')` backends; **Set API key** lists all. With none matching, the message says no backend is set up for completions (or Next Edit) and to open **AI Autocomplete: Manage Backends**.

- [x] **Step 4: Run all checks**

Run: `npm run build && npx vitest run && npm run typecheck && npm run lint`
Expected: all pass.

- [x] **Step 5: Commit**

```bash
git add src/types.ts src/config/settings.ts src/completion/effective.ts src/nextEdit/vscode/controller.ts src/ui/commands.ts package.json test/unit/settings.test.ts test/unit/effective.test.ts test/unit/manifest.test.ts <other test files touched>
git commit -m "feat: backends declare what they are used for"
```

### Task 2: Next Edit-only models stay out of ghost text

**Files:**
- Modify: `src/nextEdit/formats/index.ts`, `src/completion/postprocess.ts`, `src/manage/form.ts` (`formWarnings`), `src/manage/pageState.ts` (card warning), `src/manage/connectionTest.ts` (model step)
- Test: `test/unit/postprocess.test.ts`, `test/unit/nextEdit/formats.test.ts`, `test/unit/form.test.ts`, `test/unit/pageState.test.ts`, `test/unit/connectionTest.test.ts`

**Interfaces:**
- Consumes: `formatIdFor(setting, model)` from `src/nextEdit/formats/index.ts`.
- Produces:
  - `export function nextEditOnlyModel(model: string | undefined): 'Zeta 2.1' | 'Sweep' | undefined` in `src/nextEdit/formats/index.ts`, using the same id rules as `formatIdFor('auto', model)`.
  - `export const NEXT_EDIT_TOKENS = /<\|marker_\d+\|>|<\|user_cursor\|>|<\|file_sep\|>|<\|endoftext\|>|<\|cursor\|>/` in `src/completion/postprocess.ts`.

- [x] **Step 1: Write the failing tests**

```ts
// formats.test.ts
test('nextEditOnlyModel names Zeta and Sweep models only', () => {
  expect(nextEditOnlyModel('randmaru/zeta-2.1-mlx')).toBe('Zeta 2.1');
  expect(nextEditOnlyModel('sweep-next-edit-v2-7b')).toBe('Sweep');
  expect(nextEditOnlyModel('qwen2.5-coder-3b')).toBeUndefined();
  expect(nextEditOnlyModel(undefined)).toBeUndefined();
});
// postprocess.test.ts
test('an answer is cut at the first Next Edit special token', () => {
  expect(postprocess('<|marker_1|><|marker_1|>', ctx)).toBeUndefined();
  expect(postprocess('a + b;<|endoftext|>junk', ctx)).toBe('a + b;');
  expect(postprocess('x<|file_sep|>other.ts', ctx)).toBe('x');
});
// form.test.ts
test('a Next Edit-only model for completions is a warning', () => {
  expect(formWarnings(form({ model: 'zeta-2.1' }), 'zeta-2.1', SETTINGS).join()).toMatch(/zeta-2\.1 is a Zeta 2\.1 Next Edit model; it cannot do completions/);
});
// pageState.test.ts: a card whose completion model is a Sweep model has a warning naming Sweep.
// connectionTest.test.ts: with fimModel 'zeta-2.1', the model step is a warning naming Zeta 2.1 and no completion request is sent.
```

- [x] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/postprocess.test.ts test/unit/nextEdit/formats.test.ts test/unit/form.test.ts test/unit/pageState.test.ts test/unit/connectionTest.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**
  - `postprocess` cuts `raw` before its first `NEXT_EDIT_TOKENS` match, before any other step.
  - The warning text, the same in the form, on the card and in the test's model step: `<model> is a <name> Next Edit model; it cannot do completions`, with the hint `untick Completions, or choose a completion model`. In the connection test this replaces the `seed-coder fits Zeta 2.x` hint and stops the test before the completion request.
  - These warnings apply only when the backend is used for completions (`use.completions`).

- [x] **Step 4: Run all checks** (as in Task 1, Step 4)

- [x] **Step 5: Commit**: `git commit -m "feat: keep Next Edit-only models out of completions"` (explicit paths)

### Task 3: Page logic for uses (pure)

**Files:**
- Modify: `src/manage/protocol.ts`, `src/manage/form.ts`, `src/manage/pageState.ts`
- Test: `test/unit/form.test.ts`, `test/unit/pageState.test.ts`

**Interfaces:**
- Consumes: `BackendConfig.use`, `formatIdFor`, `sweepVariant` (`src/nextEdit/formats/index.ts`).
- Produces:
  - `BackendForm.use: { completions: boolean; nextEdit: boolean }`.
  - `ErrorField` gains `'use'`.
  - `CardView` gains `uses: { completions: boolean; nextEdit: boolean }` and `nextEditInUse: boolean`; `CardView.model` is the completion model, and a new `CardView.nextEditModel?: string` the Next Edit model (configured or "same as completions" resolved).
  - `EditView` gains `nextEditFormat?: string`: `'Zeta 2.1 format' | 'Sweep v1 format' | 'Sweep v2 format' | 'chat prompt (chatXtab)'`, from `settings.nextEdit.format` and the Next Edit model (or the completion model when both uses are ticked and the Next Edit model is empty).
  - `PageInputs.nextEditInUseId?: string`.
  - `PageMessage` gains `{ type: 'useNextEdit'; id: string }`.

- [x] **Step 1: Write the failing tests**

```ts
test('newForm and entryToForm tick both uses; entryToForm reads use', () => {
  expect(newForm('lmstudio', []).use).toEqual({ completions: true, nextEdit: true });
  expect(entryToForm({ id: 'z', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', use: ['nextEdit'] }).use).toEqual({ completions: false, nextEdit: true });
});
test('formToEntry writes use only when not both, and drops the model of an unticked use', () => {
  const both = formToEntry({ ...form(), model: 'coder', nextEditModel: 'zeta' });
  expect(both.use).toBeUndefined();
  const ne = formToEntry({ ...form(), model: 'coder', nextEditModel: 'zeta', use: { completions: false, nextEdit: true } });
  expect(ne.use).toEqual(['nextEdit']);
  expect(ne.fimModel).toBeUndefined();
  expect(ne.nextEditModel).toBe('zeta');
  const c = formToEntry({ ...form(), model: 'coder', nextEditModel: 'zeta', use: { completions: true, nextEdit: false } });
  expect(c.use).toEqual(['completions']);
  expect(c.nextEditModel).toBeUndefined();
});
test('no use ticked is a form error', () => {
  expect(validateForm({ ...form(), use: { completions: false, nextEdit: false } }, []).map((e) => e.field)).toContain('use');
});
test('the edit view names the Next Edit format', () => {
  // nextEditModel 'zeta-2.1' → 'Zeta 2.1 format'; 'sweep-next-edit-1.5b' → 'Sweep v1 format'; 'sweep-next-edit-v2-7b' → 'Sweep v2 format';
  // both uses, empty Next Edit model, model 'qwen3.8' → 'chat prompt (chatXtab)'; settings nextEdit.format 'sweep' with 'qwen3.8' → 'Sweep v1 format'.
});
test('cards carry uses and the Next Edit in-use flag', () => {
  // a use: ['nextEdit'] entry → uses { completions: false, nextEdit: true }, no completion-model warning, nextEditInUse true when nextEditInUseId matches.
});
test('an entry without use builds the same card as before', () => {
  // the existing card fields are unchanged for an entry without use; uses is both.
});
```

- [x] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/form.test.ts test/unit/pageState.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement** the interfaces above. `buildPageState` copies `form.use` field by field (booleans only). `modelTag` and the route warning apply to the completion model only, and only when `use.completions`.

- [x] **Step 4: Run all checks** (as in Task 1, Step 4)

- [x] **Step 5: Commit**: `git commit -m "feat: page logic for what a backend is used for"`

### Task 4: The Backends page shows uses

**Files:**
- Modify: `src/webview/backends/render.ts`, `src/webview/backends/main.ts`, `src/webview/backends/style.css` (only if needed), `src/ui/backendsPanel.ts`
- Test: `test/unit/render.test.ts`

**Interfaces:**
- Consumes: Task 3's `BackendForm.use`, `CardView.uses`, `CardView.nextEditInUse`, `CardView.nextEditModel`, `EditView.nextEditFormat`, `PageMessage` `useNextEdit`, `PageInputs.nextEditInUseId`.
- Produces: checkbox ids `f-use-completions` and `f-use-nextEdit`; button id `a-useNextEdit-<id>`.

- [x] **Step 1: Write the failing tests** (in `render.test.ts`)

```ts
test('the connection section has Use for checkboxes', () => {
  // both ticked: two checked checkboxes labelled Completions and Next Edit; the 'use' error, when set, shows under them.
});
test('each ticked use shows its model field', () => {
  // completions only: f-model present, f-nextEditModel absent.
  // nextEdit only: f-nextEditModel present with placeholder "auto-detect", f-model absent.
  // both: both present; the Next Edit placeholder says "same as the completion model".
});
test('the Next Edit model field names its format', () => {
  // nextEditFormat 'Zeta 2.1 format' appears as a hint under f-nextEditModel, escaped.
});
test('cards show uses, badges and use buttons per use', () => {
  // a both-uses card that is the Next Edit backend: an "in use" badge for completions only when inUse, a "Next Edit" badge when nextEditInUse;
  // "Use for completions" only with uses.completions and not inUse; "Use for Next Edit" (a-useNextEdit-<id>) only with uses.nextEdit and not nextEditInUse.
  // the meta line names the Next Edit model when it differs from the completion model.
});
```

- [x] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/render.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**
  - `render.ts` renders the checkboxes and per-use fields as tested.
  - `main.ts` reads both checkboxes into `form.use` and re-renders on change, as the other controls do.
  - `backendsPanel.ts`:
    - handles `useNextEdit` by writing `nextEdit.backend` to the same target **Select Next Edit Backend** uses (export that helper from `commands.ts`);
    - passes `nextEditInUseId: settings.nextEdit.backendId` to `buildPageState`;
    - validates the `use` message field as booleans only.

- [x] **Step 4: Run all checks** (as in Task 1, Step 4)

- [x] **Step 5: Commit**: `git commit -m "feat: Use for checkboxes on the Backends page"`

### Task 5: Test runs a Next Edit check

**Files:**
- Modify: `src/manage/protocol.ts` (`StepId` gains `'nextEdit'`), `src/manage/connectionTest.ts`, `src/nextEdit/request.ts` (`RunOptions.onParsed`), `src/ui/backendsPanel.ts` (only if the step list needs it)
- Create: `src/manage/nextEditSample.ts` (the sample input)
- Test: `test/unit/connectionTest.test.ts`, `test/unit/nextEdit/request.test.ts`

**Interfaces:**
- Consumes: `pickFormat`, `runNextEdit`, `resolveNextEdit`, `nextEditModel`, `nextEditBudgets`, `usesFor`.
- Produces:
  - `RunOptions.onParsed?(answer: FormatAnswer): void`, called with the parsed answer before `resultOf`; not called for a truncated answer.
  - `export function nextEditSample(format: NextEditFormat, settings: Settings): NextEditInput` in `src/manage/nextEditSample.ts`. It returns our own small Python file in which `area` was just renamed to `a` on one line, with two more uses of `area` below it, the cursor after the rename, and matching `history` and `previous`. It never contains a reserved string of any format (a test checks `format.problem(input)` is undefined for all three formats).

- [x] **Step 1: Write the failing tests**

```ts
test('a Next Edit-only backend runs reach and the Next Edit step only', async () => {
  // fake backend: use { completions: false, nextEdit: true }, nextEditModel 'zeta-2.1', template route,
  // streamFim answers a Zeta rewrite of block 1 → steps ids ['reach', 'nextEdit'], nextEdit ok with text /Next Edit .* Zeta 2\.1 format .* suggests an edit/;
  // no FIM request was sent (streamFim called once, with the Zeta prompt).
});
test('both uses run the completion steps, then the Next Edit step', async () => { /* order: reach, model, completion, [thinking], context, nextEdit */ });
test('noChange is a warning, an unreadable answer a failure naming why, a truncated answer a warning', async () => {
  // '<|marker_1|><|marker_1|>' → warn /no edit suggested/; '<|marker_9|>x' → fail /could not be read/; onTruncated → warn /cut at max tokens/.
});
test('a format whose route is missing is a warning and sends nothing', async () => {
  // chat-only routes with a Sweep model → warn /no raw completions route/, streamFim and streamChat not called.
});
test('a chat Next Edit model that thinks fails the step', async () => { /* ThinkingError → fail /keeps thinking/ */ });
test('the sample is sendable in every format', () => {
  for (const f of [pickFormat('chatXtab', 'm'), pickFormat('sweep', 'sweep-1.5b'), pickFormat('sweep', 'sweep-v2-7b'), pickFormat('zeta21', 'zeta')]) expect(f.problem(nextEditSample(f, SETTINGS))).toBeUndefined();
});
// request.test.ts: onParsed receives the parsed answer for a completion format, and is not called when truncated.
```

- [x] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/connectionTest.test.ts test/unit/nextEdit/request.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**
  - In `runConnectionTest`, the completion steps (model through context) run only with `use.completions`.
  - With `use.nextEdit`, a `nextEdit` step follows, timed from its own start:
    - The model is `nextEditModel(cfg, single listed model)`. With no model, the step warns `the server lists N models; choose a Next Edit model`.
    - The format comes from `pickFormat(settings.nextEdit.format, model)`.
    - The route check is the controller's, with the text `<model>: the <format> format needs a <chat completions|raw completions> route; this server has none`.
    - Then `runNextEdit` runs with `resolveNextEdit` values, `TEST_TIMEOUT_MS` and the sample.
    - The ok text is `Next Edit in <ms> ms with <model> (<format label>): suggests an edit`. The format label is the same text as `EditView.nextEditFormat`; share one function.
  - A thrown error goes through `explainFailure`, as the other steps do.
  - The answer text is logged only with `logPrompts`.
  - `completionServed` is unchanged.
  - Every step's fixed log text stays free of answer text.

- [x] **Step 4: Run all checks** (as in Task 1, Step 4)

- [x] **Step 5: Commit**: `git commit -m "feat: Test checks Next Edit with a sample edit"`

### Task 6: Docs and roadmap

**Files:**
- Modify: `README.md` (Backends page: Use for, the Next Edit test; troubleshooting: a Zeta/Sweep model as the completion model), `AGENTS.md` (layout line for `manage/nextEditSample.ts`, one line on `use`), `docs/ROADMAP.md` (3b released in v0.4.0; new row "3c. Backend roles" linking this plan and the design, status "implemented on `feat/backend-roles` (not merged or released)"; a 3c smoke checklist under "Deferred manual checks"), `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md` (settings table: the `use` field, linking the roles design)

- [x] **Step 1: Update the docs.** The 3c smoke checklist:
  - a Zeta-only LM Studio backend: Test shows the Next Edit step and no completion step;
  - the completion picker does not list it;
  - a both-uses Strata backend: Test shows both;
  - an existing backend without `use` looks and works as before;
  - unticking Completions on the selected completion backend turns completions off, with a problem in the log.
- [x] **Step 2: Run** `npm run build && npx vitest run && npm run lint` (README is linted only by markdownlint if configured; check `git diff --stat` shows docs only).
- [x] **Step 3: Commit**: `git commit -m "docs: backend roles"`

### Task 7: Status bar menu: Completions entry and the on/off switch

Added after the final review at the user's request; design: the addendum at the end of the design doc.

**Files:**
- Modify: `src/config/settings.ts` (`Settings.enabled`), `package.json` (`aiAutocomplete.enabled`, command `aiAutocomplete.toggleEnabled` "Turn On/Off", "Select Completion Backend", `aiAutocomplete.toggle` removed), `src/ui/statusModel.ts` (`activity`, `MenuInputs`, pure `menuInputs(settings, native)`, `menuEntries(shown, m)`), `src/ui/commands.ts` (`setSwitch`, `pickBackendOrOff`, `toggleEnabled`; `useBackend`/`useNextEditBackend` turn their feature back on), `src/ui/statusBar.ts` (tooltip note), `src/extension.ts`, `src/completion/provider.ts`, `src/nextEdit/vscode/controller.ts` (gates honour `enabled`), `src/manage/pageState.ts` (`completionsOn`), README, ROADMAP 3c checklist, main spec settings table
- Test: `test/unit/statusModel.test.ts`, `test/unit/settings.test.ts`, `test/unit/pageState.test.ts`, `test/unit/manifest.test.ts`, `test/integration/fim.test.ts`, `test/integration/nextEdit.test.ts`, `test/integration/backends.test.ts`

- [x] **Step 1: Tests**: menu order `toggleEnabled, snooze, selectBackend, selectNextEditBackend, …` with no `toggle`; labels "Completions: <id>"/"Completions: off", "Turn off/on AI Autocomplete"; `activity` (off only when nothing runs, "Completions off" note); `enabled` read from a workspace; the page shows completions off under the switch; `menuInputs` (backends named while the switch is off, "none"); integration: the switch off sends no completion and no Next Edit request, and turning it on brings both back; the page's Use for buttons turn a feature that was off back on.
- [x] **Step 2: Implement** as listed above.
- [x] **Step 3: Run all checks**: `npm run build && npm test && npm run typecheck && npm run lint`, `npm run test:integration`.
- [x] **Step 4: Commit**: `git commit -m "feat: status bar menu turns completions and everything off"`
