# Backend manager page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Backends webview page for adding, editing, removing and testing backends. It also tunes each backend's completion settings, with defaults prefilled. Clear "no completion template" feedback comes with it. All of this ships in v0.1.0.

**Architecture:**
- **Pure modules, unit-tested with vitest:**
  - `src/manage/`: server types, the form model, page state, the connection test and the message protocol;
  - `src/completion/effective.ts`: resolves the values every request uses, together with where each value came from.
- **The completion path** switches to `effective.ts`, so the page and real completions compute defaults the same way.
- **`src/ui/backendsPanel.ts`** hosts the webview. It owns all state, including the unsaved draft, and it does all settings and secret writes.
- **The page script** (`src/webview/backends/`) is plain TypeScript. Each state it receives replaces the whole page.

**Tech Stack:**
- Existing: TypeScript ~6.0.3, esbuild, vitest, eslint, `@vscode/test-cli`.
- New: a second esbuild entry (browser, IIFE) for the page script, and a second tsconfig with the DOM lib.
- No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-14-backend-manager-design.md`. The approved mockup is `docs/superpowers/specs/2026-11-14-backend-manager-mockup.html`. Both extend `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md`.

**Branch:** work on a local branch `feat/backend-manager` created from `main`. Tasks never push. The Publish section does that, after the user says yes.

## Global Constraints

- **Imports and dependencies:**
  - Only these files may `import 'vscode'`: `src/extension.ts`, `src/log.ts`, `src/config/vscodeSettings.ts`, `src/config/secrets.ts`, `src/completion/provider.ts`, `src/completion/contextTracker.ts`, `src/ui/*`.
  - `src/manage/*` and `src/completion/effective.ts` are pure.
  - Zero runtime dependencies; `manifest.test.ts` asserts `dependencies` is empty. No UI framework and no codicon font: the page uses Unicode symbols and VS Code theme CSS variables (`--vscode-*`).
- **Privacy:**
  - No telemetry. Nothing leaves the machine except requests to a backend URL the user configured or typed into the page.
  - Machine-scoped settings (`aiAutocomplete.backends`, `aiAutocomplete.modelOverrides`, `aiAutocomplete.debug.logPrompts`) are read from `globalValue` only. The page writes `backends` to `ConfigurationTarget.Global` only.
  - Prompt and completion text, including the test's sample completion, is logged only when `aiAutocomplete.debug.logPrompts` is true. Timings, status codes and sizes are always logged at debug level.
- **Anti-goals from the spec, all binding:**
  - The page reads backends from `globalValue` only.
  - An API key never appears in a host→page message.
  - Server-supplied text (model ids, error bodies) is HTML-escaped before it reaches the page.
  - Error text shown in the page is fixed text, never server output.
  - Opening the page makes no network request.
  - Test and "reload list" obey `privacy.localOnly` of the current window.
- **Network:**
  - Every request uses `redirect: 'manual'`.
  - A 3xx is an `HttpError`, as `postJson` already does.
- **Validation ranges** (inclusive unless noted). The parser, the page validation and the `package.json` schema all use one exported constant, `FIM_LIMITS`.

  | Field | Range |
  |---|---|
  | `temperature` | 0–2 |
  | `topP` | > 0 and ≤ 1 |
  | `topK` | integer ≥ 0 |
  | `maxTokens` | integer 1–4096 |
  | `prefixLines`, `suffixLines` | integer 0–10000 |
  | `contextTokens` | integer 256–131072 |
  | `debounceMs` | integer 0–2000 |
  | `timeoutMs` | integer 500–60000 |

- **Defaults:**
  - `contextTokens` is 4700, at 3.5 characters per token.
  - It splits into 50% prefix, 15% suffix and 35% extra context, each rounded with `Math.round`. 4700 tokens gives 8225, 2468 and 5758 characters.
  - The request timeout is 5000 ms; the connection test waits up to 30 000 ms.
  - Single-line completions are capped at 48 tokens.
- **Commits:**
  - Subjects follow Conventional Commits.
  - AI-authored commits end with a `Co-Authored-By:` trailer naming the model, for example `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Nobody edits `CHANGELOG.md` or `version` by hand.
- **Keeping docs current:** `AGENTS.md` and `docs/ROADMAP.md` stay current when a task changes what they describe.
- **Commands:**
  - `npm test` needs `npm run build` first.
  - Each task runs `npm run lint && npm run typecheck && npm run build && npm test` before committing.
  - Tasks 2, 8 and 9 also run `npm run test:integration`.

## Review Focus

1. **A hostile or odd model id from a server**, for example `"><img src=x onerror=alert(1)>`, shows as literal text and never as markup. Test `render escapes server-supplied text` (Task 7).
2. **Hand-written settings:**
   - Saving one card keeps every other entry and every unknown field of the edited entry verbatim, including unknown keys inside its `fim` object.
   - Tests: `upsert keeps other entries and unknown fields`, and `formToEntry keeps unknown fields of the original` (Task 4).
3. **A local-only workspace testing or listing a hosted backend:** the action is refused, and no request is made. Tests: `refuses a non-local URL under localOnly without any request` (Task 5), and `reloadModels under localOnly makes no request` (Task 8).
4. **The API key** never appears in any host→page message, even right after the user typed one. Test `page state never carries an API key` (Task 6).
5. **LM Studio JIT loading:** the first completion takes 8 s. The test reports a warning ("slower than the 5000 ms timeout"), not a failure. Test `slow first completion is a warning` (Task 5).

---

## File map

```
src/types.ts                         + BackendFimSettings, BackendConfig.fim
src/config/settings.ts               + FIM_LIMITS, parseBackendEntry (exported), fim validation
src/completion/effective.ts          NEW resolveFim, contextCaps, defaults (shared by provider and page)
src/completion/route.ts              planRoute/buildFimRequest take resolved values; explainUnsupported reworded
src/completion/requestStatus.ts      timeout-aware describeFailure; Outcome.action
src/completion/provider.ts           uses resolveFim; detectedModel(id)
src/completion/context.ts            DEFAULT_WINDOW removed (contextCaps replaces it)
src/backends/{types,http,llamacpp,openaiCompat,mistral}.ts   + listModels/ServerInfo, getJson
src/manage/protocol.ts               NEW leaf module: message and view types shared with the page
src/manage/serverTypes.ts            NEW server-type table, serverTypeOf, suggestId
src/manage/form.ts                   NEW form ↔ entry, validation, field views, upsert/remove, planRename
src/manage/connectionTest.ts         NEW runConnectionTest, explainFailure, SAMPLE
src/manage/pageState.ts              NEW buildPageState
src/webview/backends/{render.ts,main.ts,style.css}   NEW page (render.ts pure)
src/ui/backendsPanel.ts              NEW webview host
src/ui/{commands,statusModel,statusBar}.ts   manageBackends command, menu entry, status action
src/extension.ts                     wiring, notification button, test seam
esbuild.mjs  tsconfig.json  tsconfig.webview.json (NEW)  .vscodeignore  package.json
test/unit/*.test.ts  test/integration/{mockServer.ts,fim.test.ts,backends.test.ts (NEW)}
README.md  AGENTS.md  docs/ROADMAP.md  docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md
```

---

### Task 1: Per-backend `fim` settings

**Files:**
- Modify: `src/types.ts`, `src/config/settings.ts`, `package.json` (the `aiAutocomplete.backends` item schema).
- Test: `test/unit/settings.test.ts`, `test/unit/manifest.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  // src/types.ts
  export type Multiline = 'auto' | 'always' | 'never';
  export interface BackendFimSettings {
    template?: FimTemplateId; contextTokens?: number; prefixLines?: number; suffixLines?: number; extraContext?: boolean;
    multiline?: Multiline; maxTokens?: number; temperature?: number; topP?: number; topK?: number;
    debounceMs?: number; timeoutMs?: number; stop?: string[]; extraBody?: Record<string, unknown>;
  }
  // BackendConfig gains: fim?: BackendFimSettings   (absent when the entry has none or none survived validation)

  // src/config/settings.ts
  export const FIM_LIMITS: Record<'temperature'|'topP'|'topK'|'maxTokens'|'prefixLines'|'suffixLines'|'contextTokens'|'debounceMs'|'timeoutMs',
    { min: number; max?: number; integer: boolean; exclusiveMin?: boolean }>;
  /** Parses one raw backends entry; pushes every problem; undefined when the entry is unusable. `seen` collects ids for duplicate checks. */
  export function parseBackendEntry(raw: unknown, index: number, seen: Set<string>, problems: string[]): BackendConfig | undefined;
  ```
  `Settings['fim']['multiline']` uses `Multiline`.

- [x] **Step 1: Write the failing tests** in `settings.test.ts`. Problem strings use the format `aiAutocomplete.backends[0] ("lm").fim.<key>: <why>, ignored`.
  ```ts
  test('backend fim keeps valid keys', () => {
    // fim: { template: 'seed-coder', temperature: 0.05, prefixLines: 300, extraContext: false, multiline: 'never', stop: ['</s>'], extraBody: { a: 1 }, debounceMs: 120, timeoutMs: 9000, contextTokens: 8000 }
    // → backends[0].fim deep-equals the input; problems = []
  });
  test('backend fim drops invalid keys and reports each', () => {
    // fim: { temperature: '0.2', topP: 0, topK: 1.5, maxTokens: 5000, template: 'nope', multiline: 'x', stop: [1], extraBody: [], bogus: 1 }
    // → fim is undefined (nothing survived); the backend itself is kept; problems has 9 entries, one naming each key
  });
  test('range edges', () => {
    // temperature 0 and 2 kept, 2.01 dropped; topP 1 kept, 0 dropped; contextTokens 256 kept, 255 dropped; timeoutMs 500 kept, 499 dropped
  });
  test('parseBackendEntry is the parser parseSettings uses', () => {
    // parseBackendEntry({ id: 'x', kind: 'openai', baseUrl: 'http://h/v1', fim: { topK: 20 } }, 0, new Set(), problems)?.fim → { topK: 20 }
  });
  ```
  Then add to `manifest.test.ts`:
  ```ts
  test('backends schema fim limits match FIM_LIMITS', () => {
    // for each key of FIM_LIMITS: items.properties.fim.properties[key] has minimum (or exclusiveMinimum) / maximum equal to FIM_LIMITS,
    // and type 'integer' exactly when integer: true
  });
  ```
- [x] **Step 2: Run the tests** with `npx vitest run test/unit/settings.test.ts test/unit/manifest.test.ts`. Expected: FAIL (`FIM_LIMITS` not exported; no `fim` schema).
- [x] **Step 3: Implement.**
  - Refactor `parseBackend` into the exported `parseBackendEntry`, which takes the `problems` array, and add `fim` validation. A key that is valid but `undefined` is simply absent.
  - Add the `fim` object to the backend item schema in `package.json`:
    - `additionalProperties: false`;
    - every key above, each with a one-line `description`;
    - `template` with `enum` of the template ids;
    - `multiline` with `enum`.
- [x] **Step 4: Run the full check** with `npm run lint && npm run typecheck && npm run build && npm test`. Expected: all pass.
- [x] **Step 5: Commit.** `feat: per-backend fim settings with validated ranges`.

### Task 2: Effective values shared by completions and the page

**Files:**
- Create: `src/completion/effective.ts`, `test/unit/effective.test.ts`.
- Modify: `src/models/presets.ts`, `src/completion/route.ts`, `src/completion/context.ts`, `src/completion/requestStatus.ts`, `src/completion/provider.ts`, `src/extension.ts`.
- Test: `test/unit/route.test.ts`, `test/unit/context.test.ts`, `test/unit/requestStatus.test.ts`.

**Interfaces:**
- Consumes: `BackendFimSettings`, `Multiline` (Task 1); `resolvePreset` (existing).
- Produces:
  ```ts
  // src/completion/effective.ts
  export const DEFAULT_CONTEXT_TOKENS = 4700;
  export const CHARS_PER_TOKEN = 3.5;
  export const DEFAULT_TIMEOUT_MS = 5000;   // replaces route.ts REQUEST_TIMEOUT_MS
  export type ValueSource = 'backend' | 'modelOverride' | 'settings' | 'preset' | 'builtin';
  export type FimField = 'template' | 'temperature' | 'topP' | 'topK' | 'maxTokens' | 'multiline' | 'prefixLines' | 'suffixLines'
    | 'contextTokens' | 'extraContext' | 'debounceMs' | 'timeoutMs' | 'stop' | 'extraBody';
  export interface FimValues {
    presetId: string; fimTemplate?: FimTemplateId; suffixFirst: boolean; stop: string[]; extraBody: Record<string, unknown>;
    sampling: { temperature?: number; topP?: number; topK?: number }; maxTokens: number; multiline: Multiline;
    prefixLines: number; suffixLines: number; contextTokens: number; extraContext: boolean; debounceMs: number | null; timeoutMs: number;
  }
  export interface ResolvedFim { values: FimValues; sources: Record<FimField, ValueSource>; extraContextAllowed: boolean }
  /** Values one request to `backend` uses for `model` (undefined = unknown model → generic preset). */
  export function resolveFim(backend: BackendConfig, model: string | undefined, s: Settings): ResolvedFim;
  export function contextCaps(contextTokens: number): { maxPrefixChars: number; maxSuffixChars: number; extraChars: number };

  // src/completion/route.ts (changed signatures)
  export function planRoute(kind: BackendKind, supportsNative: boolean, fim: { fimTemplate?: FimTemplateId; suffixFirst: boolean }, mode: FimMode): FimRoute | 'unsupported';
  export interface FimRequestPlan { route: FimRoute; fim: FimValues; model: string | undefined; multiline: boolean; input: TemplateInput; signal: AbortSignal }
  export function buildFimRequest(p: FimRequestPlan): FimRequest;   // maxTokens = fim.maxTokens (single-line: min(…, 48)); timeoutMs = fim.timeoutMs

  // src/completion/requestStatus.ts (changed signatures)
  export function describeFailure(err: unknown, cls: ErrorClass, timeoutMs: number): string;
  export function recordBackendFailure(backoff: ErrorBackoff, backendId: string, err: unknown, cls: ErrorClass, logBody: boolean, timeoutMs: number, now?: number): { detail: string; warn?: string };
  ```

**Precedence**, highest first:
1. the backend's `fim` value;
2. a matching `modelOverrides` entry;
3. the `fim.*` settings;
4. the model preset or built-in constant.

**How each value combines:**
- `maxTokens` from levels 1–2 replaces `fim.maxTokens`. The preset's own 128 is never the budget (today's rule).
- `stop` is the preset's stops (`'\n\n\n'` first), then the override stops, then the backend stops, with duplicates removed.
- `extraBody` is merged shallowly: override, then backend.
- `extraContext` is `(backend ?? true) && settings.fim.extraContext`, and `extraContextAllowed` is the settings value.
- `debounceMs` is `backend ?? settings.fim.debounceMs`, where `null` means auto.

**Source labels:**
- `settings` covers both user-set values and package defaults.
- `builtin` is used for `contextTokens` and `timeoutMs` when no backend sets them.

`resolvePreset` may grow a field listing the keys a model override set. The implementer chooses how sources are tracked.

- [x] **Step 1: Write failing `effective.test.ts`.**
  ```ts
  test('defaults for a qwen coder model', () => {
    // backend {} , model 'qwen2.5-coder-1.5b', default settings →
    // values: fimTemplate 'qwen', sampling {temperature: 0.1, topP: 0.95, topK: 40}, maxTokens 128, prefixLines 200, suffixLines 60,
    //   contextTokens 4700, timeoutMs 5000, debounceMs null, extraContext true, multiline 'auto'
    // sources: template 'preset', temperature 'preset', maxTokens 'settings', prefixLines 'settings', contextTokens 'builtin', timeoutMs 'builtin'
  });
  test('backend beats model override beats preset', () => {
    // modelOverrides { qwen: { sampling: { temperature: 0.3 } } } → 0.3 'modelOverride'; plus backend fim.temperature 0.05 → 0.05 'backend'
  });
  test('backend maxTokens replaces fim.maxTokens and the override', () => {});
  test('backend template switches suffixFirst and stops', () => {
    // model 'randmaru/zeta-2.1-mlx', backend fim.template 'seed-coder' → fimTemplate 'seed-coder', suffixFirst true, stop[0] '\n\n\n',
    //   stop includes the seed-coder template stops; without the backend template: fimTemplate undefined, presetId 'generic'
  });
  test('stop merge order and dedupe', () => {});
  test('extraContext is restrict-only', () => {
    // settings false + backend true → value false, extraContextAllowed false; settings true + backend false → false, allowed true
  });
  test('contextCaps(4700)', () => expect(contextCaps(4700)).toEqual({ maxPrefixChars: 8225, maxSuffixChars: 2468, extraChars: 5758 }));
  ```
  In `route.test.ts`, build `planRoute` inputs and `buildFimRequest` plans from `resolveFim(...).values`, and add:
  ```ts
  test('buildFimRequest uses the resolved timeout and the single-line cap', () => {
    // fim.timeoutMs 9000, maxTokens 200 → req.timeoutMs 9000; multiline false → sampling.maxTokens 48; multiline true → 200
  });
  ```
  In `requestStatus.test.ts`:
  ```ts
  test('timeout detail names the actual timeout', () => expect(describeFailure(timeoutErr, { kind: 'network' }, 9000)).toBe('timed out after 9 s'));
  ```
- [x] **Step 2: Run** `npx vitest run test/unit/effective.test.ts test/unit/route.test.ts test/unit/requestStatus.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement `effective.ts` and the changed signatures.** Then switch the provider over:
  - `provider.ts` calls `resolveFim(backend.config, model, s)` once per request, after model detection.
  - The window is built from `prefixLines`/`suffixLines` plus `contextCaps(contextTokens)`. `ring.pick` gets `extraChars`, used only when `values.extraContext` is true.
  - `recordBackendFailure` gets `j.req.timeoutMs`.
  - Remove `DEFAULT_WINDOW`, `EXTRA_CONTEXT_CHARS` and `REQUEST_TIMEOUT_MS`; `context.test.ts` uses explicit caps.
  - `extension.ts` creates each backend's `Debouncer` with `fixedMs: resolveFim(cfg, undefined, settings).values.debounceMs`.
- [x] **Step 4: Run the full check** (`npm run lint && npm run typecheck && npm run build && npm test`), then `npm run test:integration`. Expected: all pass; the existing integration tests are unchanged.
- [x] **Step 5: Commit.** `feat: completions use per-backend context, sampling and timing values`.

### Task 3: Server info: model lists and context windows

**Files:**
- Modify: `src/backends/types.ts`, `src/backends/http.ts`, `src/backends/llamacpp.ts`, `src/backends/openaiCompat.ts`, `src/backends/mistral.ts`.
- Test: `test/unit/http.test.ts`, `test/unit/llamacpp.test.ts`, `test/unit/openaiCompat.test.ts`, `test/unit/mistral.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  // src/backends/types.ts
  export interface ServerInfo { models: string[]; contextWindows: Record<string, number> }
  // FimBackend gains:
  /** Lists the server's models. Throws HttpError (any non-2xx, including 3xx) or the network/timeout error. */
  listModels(signal: AbortSignal, timeoutMs?: number): Promise<ServerInfo>;   // default timeout 2000 ms
  // src/backends/http.ts
  export async function getJson(url: string, o: { headers?: Record<string, string>; signal: AbortSignal; timeoutMs: number }): Promise<unknown>;
  ```

**How each backend lists models:**
- **llama.cpp:** `GET /props`. The model is named with today's alias/path logic. The context window comes from `default_generation_settings.n_ctx`, or a top-level `n_ctx` when that is missing.
- **OpenAI-compatible:**
  - `GET {baseUrl}/models` gives `data[].id`.
  - An entry's numeric `max_model_len` (vLLM) becomes its context window.
  - For the `lmstudio` flavor, the backend also makes a best-effort `GET {origin}/api/v0/models`, where `origin = new URL(baseUrl).origin`. The `/api/v0` path is at the server root, not under `/v1`. An entry's numeric `loaded_context_length` becomes its context window. A failure of this second call is ignored.
  - **Ruling:** no context window for Ollama. `/api/show` reports the model's trained maximum, not the runtime `num_ctx`, so a "won't fit" warning based on it would be wrong. Cost if wrong: Ollama users get no context-window check.
- **Mistral:** no network. It returns `{ models: [fimModel ?? 'codestral-latest'], contextWindows: {} }`.
- **`detectModel` keeps its contract:** the single listed model, else `undefined`, never throwing. It is reimplemented on top of `listModels` for llama.cpp and OpenAI-compatible backends.

- [x] **Step 1: Write failing tests** with the existing `startMockHttp` helper.
  ```ts
  // http.test.ts
  test('getJson throws HttpError on 302 without following it', () => {});
  // llamacpp.test.ts
  test('listModels reads alias and n_ctx', () => { /* /props {model_alias:'q', default_generation_settings:{n_ctx:8192}} → {models:['q'], contextWindows:{q:8192}} */ });
  test('listModels throws HttpError on 401', () => {});
  // openaiCompat.test.ts
  test('listModels lists ids and vLLM max_model_len', () => {});
  test('lmstudio adds loaded_context_length from /api/v0/models at the origin', () => {
    // baseUrl `${url}/v1`; mock answers /v1/models and /api/v0/models → contextWindows from the second; request paths asserted
  });
  test('lmstudio ignores a failing /api/v0/models', () => {});
  test('detectModel: one model → id, two → undefined, 500 → undefined', () => {});
  // mistral.test.ts
  test('listModels makes no request and returns the configured model', () => {});
  ```
- [x] **Step 2: Run** them. Expected: FAIL.
- [x] **Step 3: Implement** `getJson` and the three `listModels` methods, then move `detectModel` onto `listModels`.
- [x] **Step 4: Run the full check.** Expected: PASS.
- [x] **Step 5: Commit.** `feat: backends list their models and context windows`.

### Task 4: Message protocol, server types and the form model

**Files:**
- Create: `src/manage/protocol.ts`, `src/manage/serverTypes.ts`, `src/manage/form.ts`.
- Test: `test/unit/serverTypes.test.ts`, `test/unit/form.test.ts`.

**Interfaces:**
- Consumes: `FIM_LIMITS`, `parseBackendEntry` (Task 1); `resolveFim`, `FimField` (Task 2); `planRoute` (Task 2); `inferHostFlavor`, `isHostedFlavor` (existing).
- Produces:
  ```ts
  // src/manage/protocol.ts: a leaf module (imports only types from ../types); the page script imports it
  export type ServerTypeId = 'llamacpp' | 'lmstudio' | 'ollama' | 'vllm' | 'sglang' | 'mistral' | 'deepseek' | 'fireworks' | 'together' | 'other';
  export type FormField = 'template' | 'fimMode' | 'multiline' | 'contextTokens' | 'prefixLines' | 'suffixLines' | 'extraContext'
    | 'temperature' | 'topP' | 'topK' | 'maxTokens' | 'debounceMs' | 'timeoutMs' | 'stop' | 'headers' | 'extraBody';
  /** The form never carries an API key; the key travels separately in page→host messages only. */
  export interface BackendForm { originalId?: string; type: ServerTypeId; id: string; baseUrl: string; model: string /* '' = auto-detect */;
    changed: Partial<Record<FormField, string>> /* text as typed; checkbox 'true'/'false' */ }
  export type StepId = 'reach' | 'model' | 'completion' | 'context';
  export interface TestStep { id: StepId; state: 'ok' | 'warn' | 'fail'; text: string; hint?: string; ms?: number }
  export interface FieldView { field: FormField; label: string; value: string; isDefault: boolean; hint: string; options?: string[]; disabledReason?: string; error?: string }
  export type Dot = 'grey' | 'green' | 'yellow' | 'red' | 'lock';
  export interface CardView { id: string; typeLabel: string; baseUrl: string; model?: string; modelDetected: boolean; inUse: boolean; keyStored: boolean; warning?: string; dot: Dot; test?: TestStep[] }
  export interface EditView { cardId: string | null; form: BackendForm; keyMode: 'no' | 'optional' | 'yes'; keyStored: boolean; fields: FieldView[];
    models?: { id: string; ready: boolean }[]; modelsError?: string; errors: { field: string; message: string }[]; warnings: string[]; testing: boolean; test?: TestStep[] }
  export interface PageState { completionsOn: boolean; localOnly: boolean; cards: CardView[]; edit?: EditView; serverTypes: { id: ServerTypeId; label: string }[] }
  export type HostMessage = { type: 'state'; state: PageState };
  export type PageMessage =
    | { type: 'ready' } | { type: 'add' } | { type: 'edit'; id: string } | { type: 'cancel' } | { type: 'formChanged'; form: BackendForm }
    | { type: 'save'; form: BackendForm; apiKey?: string } | { type: 'remove'; id: string } | { type: 'use'; id: string } | { type: 'test'; id: string }
    | { type: 'testForm'; form: BackendForm; apiKey?: string } | { type: 'reloadModels'; form: BackendForm; apiKey?: string }
    | { type: 'removeKey'; id: string } | { type: 'openSettings' };

  // src/manage/serverTypes.ts
  export interface ServerType { id: ServerTypeId; label: string; kind: BackendKind; hostFlavor?: HostFlavor; defaultUrl: string; defaultModel?: string; key: 'no' | 'optional' | 'yes' }
  export const SERVER_TYPES: readonly ServerType[];   // the spec's table, in its order; ids above; 'other' = openai/generic, empty URL
  export function serverTypeOf(cfg: { kind: BackendKind; hostFlavor?: HostFlavor; baseUrl: string }): ServerTypeId;   // via inferHostFlavor; unlisted pair → 'other'
  export function suggestId(type: ServerTypeId, taken: readonly string[]): string;   // mistral → 'codestral', other → 'openai', else the type id; then '-2', '-3', …

  // src/manage/form.ts
  export interface FieldError { field: FormField | 'id' | 'baseUrl' | 'model'; message: string }
  export function newForm(type: ServerTypeId, taken: readonly string[]): BackendForm;
  export function entryToForm(raw: Record<string, unknown>): BackendForm;          // fim keys, fimMode and headers → `changed`
  export function validateForm(f: BackendForm, taken: readonly string[]): FieldError[];
  export function formToEntry(f: BackendForm, original?: Record<string, unknown>): Record<string, unknown>;
  export function formToConfig(f: BackendForm): BackendConfig | undefined;          // formToEntry → parseBackendEntry
  export function fieldViews(f: BackendForm, model: string | undefined, s: Settings, errors: FieldError[]): FieldView[];
  export function upsertBackend(raw: unknown, entry: Record<string, unknown>, originalId?: string): unknown[];
  export function removeBackend(raw: unknown, id: string): unknown[];
  export function planRename(oldId: string, newId: string, userFimBackend?: string, workspaceFimBackend?: string): { moveKey: boolean; updateUserFimBackend: boolean; warnWorkspace: boolean };
  ```

**Rules:**
- **`formToEntry`:**
  - writes `id`, `kind`, `hostFlavor` (omitted for llama.cpp and Mistral), `baseUrl`, and `fimModel` (omitted when empty);
  - converts each `changed` text to its type: `stop` and `headers` from one line each (`Name: value`), `extraBody` with `JSON.parse`;
  - writes `fimMode` and `headers` at the top level and everything else under `fim`;
  - keeps every other key of `original` verbatim, including unknown keys inside `original.fim`;
  - when the type is `'other'` and the original's kind/flavor pair is not in the table, keeps the original pair.
- **`fieldViews`:**
  - builds one view per `FormField`, in the spec's section order;
  - takes `value` from `changed`, or else from `resolveFim({ ...cfg, fim: undefined }, model, s)`;
  - sets `hint` to `Default: <value> (<source label>)` for a changed field, or the source label for a default one;
  - disables Top K for hosted flavors (`not sent to hosted servers`), Template when the route is native (`the server builds the prompt`), and Top P for Mistral (`not sent while temperature is set`);
  - disables Extra context when `extraContextAllowed` is false (`off in your settings`);
  - shows the `debounceMs` default as `auto`, with the hint `adaptive, starts at 75 ms (local) or 250 ms (hosted)`. A cleared field returns to auto.
- **Validation:** the `FIM_LIMITS` ranges, plus:
  - `id` matches `^[a-z0-9][a-z0-9-]*$` and is unique (its own `originalId` excepted);
  - the URL is http(s), and required unless the type is `'other'` with nothing typed yet;
  - `extraBody` is a JSON object;
  - each header line has a `:`.
- **Warnings:** a hosted type whose merged stop list is longer than 4 adds `only the first 4 stop sequences are sent`.

- [x] **Step 1: Write failing tests.**
  ```ts
  // serverTypes.test.ts
  test('table matches the spec', () => { /* lmstudio → openai/lmstudio http://127.0.0.1:1234/v1 key 'no'; mistral → mistral, codestral-latest, key 'yes' */ });
  test('serverTypeOf infers LM Studio from port 1234 and maps unlisted pairs to other', () => {});
  test('suggestId', () => expect(suggestId('lmstudio', ['lmstudio'])).toBe('lmstudio-2'));
  // form.test.ts
  test('entryToForm → formToEntry round-trips a full entry', () => {});
  test('formToEntry keeps unknown fields of the original', () => {
    // original { id:'lm', kind:'openai', hostFlavor:'lmstudio', baseUrl:'…', nextEditModel:'zeta', custom:1, fim:{ temperature:0.1, future:true } }
    // changed { temperature: '0.05' } → nextEditModel, custom and fim.future kept; fim.temperature 0.05
  });
  test('formToEntry writes only changed fields', () => { /* changed {} → no fim key */ });
  test('validateForm reports range, id, duplicate id, URL and JSON errors', () => {});
  test('fieldViews prefill defaults with sources', () => { /* qwen model: temperature value '0.1', isDefault true, hint mentions the preset */ });
  test('fieldViews disables topK for hosted, template for native, topP for mistral', () => {});
  test('upsert keeps other entries and unknown fields', () => { /* raw [{id:'a',x:1},{id:'b'}], upsert b → a verbatim; rename via originalId replaces in place */ });
  test('upsert on a non-array setting starts a new list', () => {});
  test('planRename moves the key and the user fim.backend, warns for a workspace one', () => {});
  ```
- [x] **Step 2: Run** them. Expected: FAIL.
- [x] **Step 3: Implement** the three modules.
- [x] **Step 4: Run the full check.** Expected: PASS.
- [x] **Step 5: Commit.** `feat: backend form model and server types`.

### Task 5: Connection test runner

**Files:**
- Create: `src/manage/connectionTest.ts`, `test/unit/connectionTest.test.ts`.

**Interfaces:**
- Consumes: `FimBackend.listModels`/`streamFim` (Task 3); `resolveFim` (Task 2); `planRoute`, `buildFimRequest` (Task 2); `CompletionAccumulator`, `postprocess` (existing); `TestStep` (Task 4); `HttpError`, `MissingApiKeyError` (existing).
- Produces:
  ```ts
  export const TEST_TIMEOUT_MS = 30_000;
  export const SAMPLE: TemplateInput;   // prefix 'function add(a: number, b: number): number {\n  return ', suffix '\n}\n', filePath 'sample.ts', repoName 'sample', extra []
  export interface ConnectionTestInput { backend: FimBackend; settings: Settings; localOnly: boolean; isLocal(baseUrl: string): Promise<boolean>;
    signal: AbortSignal; log: Log; now?: () => number }
  export interface ConnectionTestResult { steps: TestStep[]; model?: string; info?: ServerInfo }
  /** Runs the steps in order, calling onStep after each; never throws. */
  export function runConnectionTest(i: ConnectionTestInput, onStep: (s: TestStep) => void): Promise<ConnectionTestResult>;
  /** Fixed text for a failure; never quotes server output. */
  export function explainFailure(err: unknown): { text: string; hint?: string };
  ```

**Steps.** The `text` values below are the exact strings unless marked as hints.

0. **Local-only check.** When `localOnly` is on and `isLocal(baseUrl)` is false, emit a single `reach` fail: `local only is on in this workspace`. Stop without any request.
1. **`reach`.**
   - For llama.cpp and OpenAI-compatible backends, call `listModels(signal, 5000)`. On success the text is `Server answered in N ms (K models)`.
   - For Mistral, stream a one-token FIM of `SAMPLE` instead. On success the text is `Server answered in N ms`.
   - On failure, use `explainFailure`, then stop.
2. **`model`.**
   - The model is `backend.config.fimModel`, else the only listed model.
   - With no model, warn: `the server lists K models; choose one`. Stop.
   - When `planRoute` returns `unsupported`:
     - for `fimMode: 'chat'`, warn `chat FIM arrives in v0.2`;
     - otherwise warn `<model> has no completion template`, with the hint `pick a coder model, or choose a template` (plus `; seed-coder fits Zeta 2.x` when the model matches `/zeta/i`).
     - Stop.
   - Otherwise the step is ok: `Model <m> with the <t> template`, or `Model <m> (server-side prompt)` for the native route.
3. **`completion`.**
   - Send `buildFimRequest` with `multiline: false`, its `timeoutMs` replaced by `TEST_TIMEOUT_MS`, through `CompletionAccumulator` and `postprocess`.
   - When the text is not empty, the step is ok: `Test completion in N ms: "<text, first 80 chars>"`.
   - When it is empty, warn `the server answered but returned no completion`.
   - When the elapsed time is greater than `values.timeoutMs`, change an ok to a warn with the hint `slower than the <timeoutMs> ms timeout; run the test again if the model was loading`.
4. **`context`.** This step runs only when `info.contextWindows[model]` exists.
   - When `contextTokens + maxTokens` is greater than the window, warn `context size <c> + max tokens <m> is more than the server's <w>`.
   - Otherwise the step is ok: `Server context window: <w> tokens`.

**`explainFailure` mapping:**

| Error | Text | Hint |
|---|---|---|
| 401 or 403 | `HTTP <s>` | `check the API key` |
| 404 | `HTTP 404` | `check the URL; OpenAI-compatible servers usually end in /v1` |
| 3xx | `HTTP <s>` | `redirects are not followed` |
| other HTTP status | `HTTP <s>` | — |
| `TimeoutError` | `timed out` | — |
| `cause.code` `ECONNREFUSED` | `connection refused` | `is the server running?` |
| `ENOTFOUND` or `EAI_AGAIN` | `host not found` | — |
| `MissingApiKeyError` | `no API key stored` | `enter the key in the API key field` |
| anything else | `request failed` | — |

**Logging:** each step is logged at debug level with its timing. The sample completion text is logged only when `settings.debug.logPrompts` is true.

- [x] **Step 1: Write failing tests** against fake `FimBackend` objects, with a fake clock through `now`.
  ```ts
  test('happy path: reach, model, completion, context all ok', () => {});
  test('refuses a non-local URL under localOnly without any request', () => { /* listModels and streamFim never called */ });
  test('401 → check the API key; 404 → /v1 hint; ECONNREFUSED → is the server running?', () => {});
  test('several models and no fimModel → warn and stop', () => {});
  test('zeta model without template → warn naming seed-coder, no completion request', () => {});
  test('backend template seed-coder makes zeta pass', () => {});
  test('slow first completion is a warning', () => { /* 8000 ms elapsed, timeoutMs 5000 → completion state 'warn', hint names 5000 */ });
  test('context overflow warns; no window → no context step', () => {});
  test('mistral reach uses a one-token FIM', () => {});
  test('explainFailure never includes server body text', () => {});
  ```
- [x] **Step 2: Run** them. Expected: FAIL.
- [x] **Step 3: Implement** the runner.
- [x] **Step 4: Run the full check.** Expected: PASS.
- [x] **Step 5: Commit.** `feat: connection test runner`.

### Task 6: Page state

**Files:**
- Create: `src/manage/pageState.ts`, `test/unit/pageState.test.ts`.

**Interfaces:**
- Consumes: Tasks 2, 4 and 5.
- Produces:
  ```ts
  export interface EditDraft { cardId: string | null; form: BackendForm; models?: { id: string; ready: boolean }[]; modelsError?: string; testing: boolean; test?: TestStep[] }
  export interface PageInputs {
    settings: Settings; rawBackends: unknown; inUseId?: string; keysStored: ReadonlySet<string>;
    local: ReadonlyMap<string, boolean>;        // isLocal per backend id, precomputed by the host
    detected: ReadonlyMap<string, string>;      // models detected this session (provider or tests)
    tests: ReadonlyMap<string, TestStep[]>;     // last test per backend id
    edit?: EditDraft;
  }
  export function buildPageState(i: PageInputs): PageState;
  export function dotFor(steps: TestStep[] | undefined, offlineWarning: boolean, locked: boolean): Dot;   // lock > red > yellow > green > grey
  ```

**Rules:**
- A card's `model` is `fimModel`, or else the detected model, with `modelDetected: true`.
- A card's `warning`:
  - `not used here (local only)` when it is locked;
  - otherwise `No completion template for this model`, when its model is known and `planRoute` is unsupported. There is no warning for an unknown model.
- `edit.keyMode` comes from the server type, and `edit.keyStored` comes from `keysStored`.
- `edit.errors` comes from `validateForm`. `edit.warnings` comes from the form rules, plus `model not detected yet: Test or reload the list to detect it` when the model is empty and nothing has been detected.

- [ ] **Step 1: Write failing tests.**
  ```ts
  test('cards: in use, key stored, detected model, lock and template warning', () => {});
  test('dot precedence', () => {});
  test('edit view: defaults for an undetected model show the generic preset and the not-detected warning', () => {});
  test('page state never carries an API key', () => {
    // a form built while a key was typed; JSON.stringify(buildPageState(...)) contains neither the key text nor an "apiKey" property
  });
  test('cards follow raw order and skip invalid entries', () => {});
  ```
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** `pageState.ts`.
- [ ] **Step 4: Run the full check.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: backends page state`.

### Task 7: Webview page, build and packaging

**Files:**
- Create: `src/webview/backends/render.ts`, `src/webview/backends/main.ts`, `src/webview/backends/style.css`, `tsconfig.webview.json`, `test/unit/render.test.ts`.
- Modify: `esbuild.mjs`, `tsconfig.json` (exclude `src/webview`), `package.json` (`typecheck` runs both configs), `.vscodeignore` (add `!dist/webview/**`), `test/unit/manifest.test.ts`.

**Interfaces:**
- Consumes: `protocol.ts` (Task 4).
- Produces:
  ```ts
  // render.ts: pure string building, no DOM types (vitest imports it in the node environment)
  export interface LocalUi { typedKey: string; advancedOpen: boolean }
  export function escapeHtml(s: string): string;
  export function renderPage(state: PageState, ui: LocalUi): string;
  ```
  The page script does the following:
  - loads as `dist/webview/backends.js` with its stylesheet `dist/webview/backends.css`;
  - posts `PageMessage` values and receives `HostMessage` values;
  - sends `ready` on load;
  - sends `formChanged` on each input `change` event (not on every keystroke);
  - sends the typed key only in `save`, `testForm` and `reloadModels`;
  - after each `state`, restores focus and the selection range to the element with the same `id`.

**Markup contract** (the integration test in Task 9 and the restore logic rely on it):
- Every control has a stable `id`:
  - `f-<field>` for each `FormField`;
  - `f-id`, `f-type`, `f-url`, `f-model` and `f-key`.
- Buttons carry `data-action` (one of the `PageMessage` types) and `data-id` where one applies.
- Layout and look follow the mockup:
  - cards in one column;
  - the edit form inside its card, with the sections Connection, Prompt, Context, Generation and Advanced (collapsed);
  - a grey `default` or blue `changed · reset` marker on each field.
- "reset" posts `formChanged` without that field.
- The API key field:
  - placeholder `stored` when a key exists;
  - a "Remove key" link;
  - the note `Re-enter the key if you switched tabs` shown when the key field is empty and `keyStored` is false.

**Build:**
- `esbuild.mjs` adds a second build:
  - entry points `src/webview/backends/main.ts` and `src/webview/backends/style.css`;
  - `outdir: 'dist/webview'`, `entryNames: 'backends'`, `platform: 'browser'`, `format: 'iife'`, `target: 'es2022'`.
  - It takes part in `--watch` and `--production`.
- `tsconfig.webview.json` extends the root config with `lib: ["ES2023", "DOM"]` and `include: ["src/webview"]`.

- [ ] **Step 1: Write failing tests.**
  ```ts
  // render.test.ts
  test('render escapes server-supplied text', () => {
    // a model id and a test step text of '"><img src=x onerror=alert(1)>' appear only escaped (&lt;img …), never as '<img'
  });
  test('every form control has a stable id', () => { /* f-temperature, f-prefixLines, …, f-url, f-model, f-key present once each */ });
  test('changed field shows reset, default field shows default', () => {});
  test('disabled field shows its reason', () => {});
  test('collapsed card shows Test, Edit, Use for completions (not on the in-use card) and Remove', () => {});
  test('header shows completions on/off, local only, the General settings link and Add backend', () => {});
  // manifest.test.ts
  test('webview bundle is built and packaged', () => {
    // dist/webview/backends.js and dist/webview/backends.css exist; .vscodeignore contains '!dist/webview/**'
  });
  ```
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** `render.ts`, `main.ts`, `style.css` and the build changes.
- [ ] **Step 4: Run the full check**, then `npm run package`. Expected: PASS, and `unzip -l *.vsix` lists `extension/dist/webview/backends.js`.
- [ ] **Step 5: Commit.** `feat: backends page webview`.

### Task 8: Panel host, command, menu and links

**Files:**
- Create: `src/ui/backendsPanel.ts`, `test/integration/backends.test.ts`.
- Modify:
  - `src/ui/commands.ts`, `src/ui/statusModel.ts`;
  - `src/completion/provider.ts` (`detectedModel`);
  - `src/extension.ts`;
  - `package.json` (the command, plus the link at the top of the backends `markdownDescription`: `[Manage backends](command:aiAutocomplete.manageBackends)`);
  - `test/unit/statusModel.test.ts`, `test/unit/manifest.test.ts`, `test/integration/mockServer.ts`.

**Interfaces:**
- Consumes: Tasks 3–7; `Secrets`, `readSettings`, `memoizeIsLocal` (existing).
- Produces:
  ```ts
  // src/ui/backendsPanel.ts
  export interface BackendsPanelDeps { context: vscode.ExtensionContext; secrets: Secrets; log: Log; getSettings(): Settings;
    isLocal(baseUrl: string): Promise<boolean>; detectedModel(id: string): string | undefined; onTestPassed(id: string): void }
  export interface OpenOptions { add?: boolean; focus?: string }
  export class BackendsPanel implements vscode.Disposable {
    static show(d: BackendsPanelDeps, o?: OpenOptions): BackendsPanel;   // one panel; a second call reveals it and applies o
    static current(): BackendsPanel | undefined;
    handle(msg: PageMessage): Promise<void>;   // test seam: the integration test drives it directly
    lastState(): PageState | undefined;        // test seam: the last state posted
  }
  // FimProvider gains: detectedModel(backendId: string): string | undefined
  // statusModel: menuEntries(shown: StatusState, backendCount: number): MenuEntry[]   // 'Manage backends...' first when backendCount is 0, else after 'Select backend...'
  // activate() returns { status, secrets, backendsPanel: () => BackendsPanel | undefined }
  ```

**Host behaviour:**
- **The panel:**
  - `createWebviewPanel('aiAutocomplete.backends', 'AI Autocomplete: Backends', ViewColumn.Active, { enableScripts: true, localResourceRoots: [<extensionUri>/dist/webview] })`, with no `retainContextWhenHidden`.
  - CSP: `default-src 'none'; script-src 'nonce-<n>'; style-src ${cspSource} 'nonce-<n>'; img-src ${cspSource}; font-src ${cspSource}`.
  - The HTML references `backends.css` and `backends.js` through `asWebviewUri`.
- **The host owns the draft** (`EditDraft`), so a hidden and re-shown tab keeps the form. Only the typed key is lost.
- **Every page message leads to a fresh `buildPageState` and a `state` post.** That includes `ready`: the page reloads each time the tab becomes visible.
  - The host precomputes `local` with `isLocal` for every card URL and the draft URL.
  - Opening the page makes no network request.
- **`save`:**
  - validates again on the host and shows the errors in the form when that fails;
  - `upsertBackend` on `inspect('backends').globalValue`, then `update('backends', next, ConfigurationTarget.Global)`;
  - applies `planRename`, moving the key (`secrets.get(old)`, then `set(new)`, then `delete(old)`);
  - stores a typed key with `secrets.set`;
  - closes the draft.
- **`remove`:** a modal `showWarningMessage` (`window.confirm` doesn't work in webviews). Then `removeBackend` and `secrets.delete`.
- **`use`:** writes `fim.backend` with the **Select Backend** target rule: the workspace when a folder is open, otherwise user settings.
- **`test` and `testForm`:**
  - build a throwaway backend with `createBackend(formToConfig(form) ?? savedConfig, key)`, where `key` is the typed key, else the stored key of `originalId`;
  - run `runConnectionTest` with each step posted as it arrives;
  - store the result per id, and record a detected model;
  - call `onTestPassed(id)` when every step is ok and the id is the in-use backend.
- **`reloadModels`:** honours local-only (no request when refused, `modelsError` set), then `listModels(signal, 5000)`. A model is tagged `ready` when `planRoute` is supported for it.
- **`openSettings`:** runs `workbench.action.openSettings` with `@ext:raboo.ai-autocomplete`.
- **Re-rendering:** `onDidChangeConfiguration('aiAutocomplete')` and `secrets.onDidChange` re-post the state. An open draft is kept.
- **Wiring:**
  - The command `aiAutocomplete.manageBackends` (title "Manage Backends") takes an optional `OpenOptions` argument.
  - The status-bar menu gets the entry.
  - The "no backends configured" notification gets an **Add Backend** button (opens with `{ add: true }`) beside **Open Settings**.
  - `onTestPassed` resets that backend's backoff and calls `provider.clearError()`.
- **The mock server:**
  - `startMockServer({ alias?, nCtx? })` sets the `/props` `model_alias` (default `qwen2.5-coder-1.5b`) and `default_generation_settings.n_ctx`;
  - it also answers `GET /v1/models` with that alias.

- [ ] **Step 1: Write failing tests.**
  ```ts
  // statusModel.test.ts
  test('Manage backends comes first when no backend exists', () => {});
  // manifest.test.ts: the command list includes aiAutocomplete.manageBackends; the backends description contains the command link
  // integration backends.test.ts
  test('the command opens one panel; a second call reveals the same one', () => {});
  test('save writes the entry to user settings and keeps other entries', () => {});
  test('testForm against the mock server ends with reach, model, completion and context ok', () => {});
  test('reloadModels under localOnly makes no request', () => {
    // privacy.localOnly true, draft URL https://example.invalid/v1 → mock.requests unchanged, edit.modelsError set
  });
  test('rename moves the stored key', () => {});
  ```
- [ ] **Step 2: Run** `npx vitest run test/unit/statusModel.test.ts test/unit/manifest.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the host, command, menu, links and wiring.
- [ ] **Step 4: Run the full check**, then `npm run test:integration`. Expected: all pass.
- [ ] **Step 5: Commit.** `feat: manage backends from a page with connection tests`.

### Task 9: "No completion template" feedback

**Files:**
- Modify: `src/completion/route.ts`, `src/completion/requestStatus.ts`, `src/completion/provider.ts`, `src/ui/statusBar.ts`.
- Test: `test/unit/route.test.ts`, `test/unit/requestStatus.test.ts`, `test/integration/fim.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export interface StatusAction { command: string; args: unknown[] }
  // Outcome: { state: 'idle' } | { state: 'error'; detail: string; action?: StatusAction }
  // StatusSink.set(state: RequestState, detail?: string, action?: StatusAction): void
  export function explainUnsupported(backendId: string, model: string | undefined, mode: FimMode): { onceKey: string; log: string; status?: string; action?: StatusAction };
  ```
  These are the exact texts:
  - model known, mode not `chat`:
    - log: `model "<model>" has no FIM template (not a known code-completion model): pick a coder model, or choose a template for it in AI Autocomplete: Manage Backends`;
    - status: `<backendId>: no completion template`;
    - action: `{ command: 'aiAutocomplete.manageBackends', args: [{ focus: backendId }] }`;
  - mode `chat`: log `backend "<id>": fimMode "chat" arrives in v0.2`, with no action;
  - model undefined: today's "could not detect its model" text, unchanged.
  - `StatusBar` sets `item.command` to `{ command, arguments: args, title: 'Open' }` while the shown state carries an action, else `aiAutocomplete.menu`.
- [ ] **Step 1: Write failing tests.**
  ```ts
  test('explainUnsupported: unknown template → reworded log, status and action', () => {});
  test('explainUnsupported: chat mode keeps the v0.2 message', () => {});
  test('RequestStatus forwards the action of an error outcome', () => {});
  // fim.test.ts (integration, mock alias 'zeta-2.1')
  test('a model without template shows "no completion template" and sends no completion request', () => {});
  ```
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the changes.
- [ ] **Step 4: Run the full check**, then `npm run test:integration`. Expected: PASS.
- [ ] **Step 5: Commit.** `fix: explain models without a FIM template and link to the backends page`.

### Task 10: Docs and handoff

**Files:**
- Modify: `README.md`, `AGENTS.md`, `docs/ROADMAP.md`, `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md`, `docs/superpowers/followups/2026-11-13-phase0-1-review-followups.md`.

- [ ] **Step 1: Update the docs.**
  - **README:**
    - Getting started leads with **AI Autocomplete: Manage Backends**, and the settings.json examples stay as the alternative.
    - A short "Per-backend settings" section lists the fields and the precedence rule.
    - One line notes that saving from the page rewrites the `backends` array, so comments inside it are lost.
    - One line says the test sends a built-in sample, never your code.
  - **AGENTS.md:**
    - The layout gains `src/manage/` (pure page logic) and `src/webview/` (page script, DOM, its own tsconfig).
    - Commands: `typecheck` covers both tsconfigs.
    - A rule: the page never receives API keys or unescaped server text.
  - **ROADMAP:**
    - The Phase 0–1 row adds "backends page".
    - Deferred manual checks add:
      - add an LM Studio backend from the page and reload its model list;
      - Test with Zeta: a warning, then pass after choosing seed-coder;
      - change a temperature and see "changed · reset";
      - the Settings-page link opens the page.
  - **Main spec:** the non-goal "a settings webview" now reads "a webview beyond the Backends page (see `2026-11-14-backend-manager-design.md`)".
  - **Follow-ups:** remove any entry this plan fixed. Add entries for anything the reviews park.
- [ ] **Step 2: Run the full check.** Expected: PASS (the docs don't affect tests; `repoAutomation.test.ts` still passes).
- [ ] **Step 3: Commit.** `docs: backends page in README, AGENTS and roadmap`.

---

## Publish (controller only, after Task 10 and the final review)

These steps create public state on GitHub. **Ask the user once, listing every step, and wait for a yes.**

1. `git push -u origin feat/backend-manager`.
2. `gh pr create -R Raboo/vscode-ai-autocomplete --base main --head feat/backend-manager --title "feat: backends page with connection test and per-backend settings" --body <summary ending with the Claude Code line>`.
3. Watch CI with `gh pr checks <n> -R Raboo/vscode-ai-autocomplete --watch`. Expected: `check`, `integration` and `analyze` pass. Fix forward on the branch.
4. **The user's smoke test:**
   - Download the PR's CI `.vsix` with `gh run download <run> -R Raboo/vscode-ai-autocomplete -n vsix -D <dir>`.
   - Install it with `code --install-extension <dir>/ai-autocomplete-*.vsix`.
   - Run the new ROADMAP manual checks against LM Studio.
   - Continue only after the user confirms.
5. Merge with `gh pr merge <n> --squash -R Raboo/vscode-ai-autocomplete`. The squash subject is the PR title, which release-please reads. Release PR #1 then updates itself to include the feature.
6. Then `git checkout main && git pull`, and delete the local branch.
7. **Release v0.1.0 needs its own yes from the user.** If granted, follow the previous plan's Publish steps 5–7: `gh pr merge 1 --squash --admin`, verify the `.vsix` asset, and record the release in the ROADMAP.
