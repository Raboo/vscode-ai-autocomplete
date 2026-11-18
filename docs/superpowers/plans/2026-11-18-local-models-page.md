# Local Models Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The local model helper runs one llama-server in router mode for every local model, LM Studio leaves the helper, and a Manage Local Models page shows and controls the server, the model list, downloads, per-model settings, the models folder and a Hugging Face token.

**Architecture:** Pure modules in `src/local/` (model list, extra arguments, presets file and router client, Hugging Face API, migration, page state) are unit-tested; `src/local/vscode/` and `src/ui/localModelsPanel.ts` wire them to VS Code; the page itself is `src/webview/localModels/`, built like the Backends page. The existing `ServerPool` keeps its adopt / watch / take-over lifecycle but manages one record, `local`.

**Tech Stack:** TypeScript, esbuild, vitest, @vscode/test-electron with the mock server and a fake llama-server script.

**Spec:** `docs/superpowers/specs/2026-11-18-local-models-page-design.md` (read it; it holds the live-checked router behaviour). Earlier helper design: `docs/superpowers/specs/2026-11-16-local-model-helper-design.md`.

## Global Constraints

- Only files on the AGENTS.md allowlist import `vscode`; the new host file is `src/ui/localModelsPanel.ts` (allowed by `src/ui/*`) and `src/local/vscode/*`.
- Runtime dependencies stay `diff` and `jsonc-parser`.
- The router listens on `127.0.0.1` only; processes start with an argument array, never a shell.
- New settings are machine-scoped and read from `globalValue` only: `aiAutocomplete.local.models`, `aiAutocomplete.local.modelsDir`, `aiAutocomplete.local.modelsInMemory` (integer ≥ 1, default 1). `aiAutocomplete.local.lmsPath` is removed. `test/unit/manifest.test.ts`'s machine-scoped list and AGENTS.md's hard rule list follow.
- The one backend id is `local` (kind `llamacpp`, `baseUrl` `http://127.0.0.1:<port>`).
- The Hugging Face token lives in SecretStorage, is never sent to the page or logged, and is sent as `Authorization: Bearer <token>` only to host `huggingface.co`.
- Server-supplied text (model ids, log lines, error bodies) is HTML-escaped on the page; page errors are fixed text plus escaped details.
- No requests to Hugging Face except on a user action (download, add, check for update).
- Commits: Conventional Commits, no Co-Authored-By or other trailer; stage files by explicit path; never stage `*.swp`.

## Review Focus

- A models folder or model path with spaces (macOS `Application Support`) must work in `presets.ini` (live-checked unquoted) and must never be split.
- A value or extra argument containing a line break, `[` at a line start, `;` or `=` in a key must not inject a preset section or key: refused.
- A port held by another program or by a plain (non-router) llama-server must not be adopted; a new free port is chosen and written to `local`.
- A llama-server without router mode (no `--models-preset` in `--help`), or none installed, shows the update/install hint and never crashes activation.
- A redirect from huggingface.co to the CDN must not carry the token; a 401/403 shows the "needs a token or access" message.

---

### Task 1: LM Studio leaves the helper

**Files:**
- Delete: `src/local/lmStudio.ts`, `src/local/setupArg.ts` and their tests under `test/unit/local/`
- Modify: `src/local/runtimes.ts` (only `llamaServer`), `src/local/backendEntry.ts` (no `LocalRuntime`), `src/local/vscode/setup.ts` (no runtime pick), `src/config/settings.ts` (`local.lmsPath` gone), `package.json` (setting removed), `test/unit/manifest.test.ts`, `test/integration/local.test.ts`, `AGENTS.md`

- [ ] **Step 1: Tests:** update the unit and integration tests so nothing refers to LM Studio in the helper; manifest test: `aiAutocomplete.local.lmsPath` is not contributed. `localBackendId(recipe)` takes no runtime.
- [ ] **Step 2: Run** `npm run build && npx vitest run`: FAIL.
- [ ] **Step 3: Remove** the LM Studio code paths. Existing `-lmstudio` backend entries in settings are untouched (they are ordinary LM Studio backends).
- [ ] **Step 4: Run all checks:** `npm run build && npm test && npm run typecheck && npm run lint`.
- [ ] **Step 5: Commit:** `feat!: local model helper supports llama.cpp only`

### Task 2: The model list and extra arguments

**Files:**
- Create: `src/local/modelList.ts`, `src/local/extraArgs.ts`, `test/unit/local/modelList.test.ts`, `test/unit/local/extraArgs.test.ts`
- Modify: `src/config/settings.ts` (`Settings.local`), `package.json`, `test/unit/manifest.test.ts`, `test/unit/settings.test.ts`

**Interfaces:**
- Produces:
  - `interface LocalModel { name: string; label: string; repo: string; revision: string; file: string; bytes: number; sha256: string; license?: string; uses: BackendUse[]; contextTokens: number; extraArgs: string[]; builtIn: boolean; hidden: boolean }`
  - `parseLocalModels(raw: unknown): { entries: LocalModelEntry[]; problems: string[] }` (`LocalModelEntry` = the setting's shape from the spec)
  - `mergeModels(recipes: readonly Recipe[], entries: LocalModelEntry[]): LocalModel[]` — built-ins first in recipe order, then added models in setting order
  - `modelNameFromFile(file: string): string`; `isSplitOrProjector(file: string): boolean`
  - `parseExtraArgs(line: string): { args: string[]; refused?: string }` and `extraArgsToPreset(args: string[]): [key: string, value: string][]`
  - `Settings.local: { llamaServerPath?: string; modelsDir?: string; modelsInMemory: number; models: LocalModelEntry[] }`

- [ ] **Step 1: Tests.**
  - `mergeModels`: an entry named `sweep-next-edit-1.5b` with `contextTokens: 4096, hidden: true` changes only those fields of the built-in (repo/sha256 in the entry are ignored); an added entry missing `sha256` is dropped with a problem; two entries with the same name keep the first, with a problem.
  - `modelNameFromFile('Qwen2.5-Coder-3B-Q8_0.gguf')` → `qwen2.5-coder-3b-q8_0`; `'sub/My Model+1.gguf'` → `my-model-1`.
  - `isSplitOrProjector`: `x-00001-of-00003.gguf` true, `mmproj-F16.gguf` true, `model.gguf` false.
  - `parseExtraArgs('--threads 8 --no-mmap')` → args `['--threads','8','--no-mmap']`; `'--temp "0.2"'` → `['--temp','0.2']`; refused, with the flag named: `--port 1`, `-c 4096`, `--ctx-size 1`, `-np 2`, `--parallel 2`, `--host 0.0.0.0`, `-m x`, `--model x`, `--alias x`, `-a x`, `--api-key k`, `--api-key-file f`, `--hf-repo x`, `--models-max 2`, `--webui`, `--no-webui`, `--ssl-key-file f`, `--path p`, `--mmproj f`; a line break or a value starting with `[` → refused.
  - `extraArgsToPreset(['--threads','8','--no-mmap'])` → `[['threads','8'],['no-mmap','true']]`.
  - Settings: `local.modelsInMemory` missing → 1, `0` or `1.5` → 1 with a problem; workspace values of the three new settings are ignored (globalValue only).
- [ ] **Step 2: Run** `npx vitest run test/unit/local/modelList.test.ts test/unit/local/extraArgs.test.ts test/unit/settings.test.ts`: FAIL.
- [ ] **Step 3: Implement**; contribute the three settings in `package.json` (Local models section, machine scope; `local.models` as an array of objects matching the spec's fields).
- [ ] **Step 4: Run all checks.**
- [ ] **Step 5: Commit:** `feat: editable local model list and extra arguments`

### Task 3: Presets file and router client

**Files:**
- Create: `src/local/router.ts`, `test/unit/local/router.test.ts`
- Modify: `src/local/llamaServer.ts` (old per-model `llamaServerArgs` removed; `probePort` replaced), its tests

**Interfaces:**
- Consumes: `LocalModel`, `extraArgsToPreset` (Task 2).
- Produces:
  - `renderPresets(models: LocalModel[], filePath: (m: LocalModel) => string): string` — only the models passed (callers pass downloaded, not hidden ones)
  - `routerArgs(o: { presetsPath: string; modelsMax: number; port: number }): string[]` → `['--models-preset', p, '--models-max', String(n), '--host', '127.0.0.1', '--port', String(port), '--no-webui']`
  - `supportsRouter(helpText: string): boolean`
  - `class RouterClient { constructor(baseUrl: string, fetchFn?: typeof fetch); isRouter(): Promise<boolean>; models(): Promise<RouterModel[]>; load(name: string): Promise<void>; unload(name: string): Promise<void>; reload(): Promise<void> }` with `RouterModel = { id: string; state: 'unloaded' | 'loading' | 'loaded' | 'sleeping' | 'failed' }` (`status.failed: true` → `failed`)
  - `probeRouter(port: number, names: string[], fetchFn?): Promise<'ours' | 'loading' | 'none'>` — `ours` when `/health` is 200, `/props` has `role: "router"` and `/models` lists every name; `loading` on 503.

- [ ] **Step 1: Tests.** `renderPresets` for Sweep (Next Edit + completions, context 8192, extra `--threads 8`) and Mellum (completions, 8192) with a path under `/Users/x/Library/Application Support/...` equals:
  ```ini
  version = 1

  [*]
  ngl = 99
  fa = on
  cache-reuse = 256

  [sweep-next-edit-1.5b]
  model = /Users/x/Library/Application Support/m/sweep.gguf
  c = 16384
  np = 2
  threads = 8

  [mellum-4b-base]
  model = /Users/x/Library/Application Support/m/mellum.gguf
  c = 8192
  np = 1
  ```
  A path or value containing `\n` or `\r` throws. `supportsRouter` true for text with `--models-preset`, false otherwise. `RouterClient` against a local `http.createServer`: `models()` maps the README's status shapes; `load` posts `{"model":"x"}` to `/models/load`; `reload` calls `GET /models?reload=1`. `probeRouter`: plain llama-server `/props` (no `role`) → `none`; router missing a name → `none`; 503 → `loading`.
- [ ] **Step 2: Run** `npx vitest run test/unit/local/router.test.ts`: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all checks.**
- [ ] **Step 5: Commit:** `feat: llama-server router presets and client`

### Task 4: llama.cpp backend in router mode

**Files:**
- Modify: `src/backends/llamacpp.ts`, `test/unit/llamacpp.test.ts`

- [ ] **Step 1: Tests:** with a model name set, the slot read is `GET /props?model=<url-encoded name>&autoload=false`; without one, plain `/props`. Slot counts are per model: completions on model A with `total_slots` 2 sends `id_slot: 0`, Next Edit on model B with `total_slots` 1 sends no `id_slot`. A 400 from `/props` leaves that model's count unknown (no `id_slot`), and it is read again on a later request after the existing retry delay. Model detection (no model set) against a router (`role: "router"`) reports no model rather than `none`.
- [ ] **Step 2: Run** `npx vitest run test/unit/llamacpp.test.ts`: FAIL.
- [ ] **Step 3: Implement** (`totalSlots` becomes a `Map<string, number>` keyed by model name, `''` for none; `slotCount(model?)`).
- [ ] **Step 4: Run all checks.**
- [ ] **Step 5: Commit:** `feat: llama.cpp backend talks to a llama-server router`

### Task 5: One router instead of one server per model

**Files:**
- Modify: `src/local/backendEntry.ts`, `src/local/serverPool.ts`, `src/local/vscode/servers.ts`, `src/extension.ts`, their tests (`test/unit/local/*`)
- Create: `src/local/migrate.ts`, `test/unit/local/migrate.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces:
  - `LOCAL_BACKEND_ID = 'local'`; `localRouterEntry(port: number, o: { model?: string; nextEditModel?: string }): Record<string, unknown>` (`use` = the uses that have a model)
  - `ManagedServer` becomes `{ port: number; pid?: number; presetsPath: string; modelsMax: number }`, stored under a new key `localRouter` (the old `localServers` key is read only by the migration)
  - `planMigration(o: { backends: unknown[]; managed: unknown; settings: Settings }): { removeIds: string[]; local?: { model?: string; nextEditModel?: string }; select: { completions?: boolean; nextEdit?: boolean }; stopPids: number[]; log: string }`
  - `ServerPool` methods: `start(): Promise<Started>`, `stop(): Promise<void>`, `restart(): Promise<void>`, `syncPresets(): Promise<void>` (writes the file, calls `reload()` when running), `warm(names: string[]): Promise<void>`, `state(): 'stopped' | 'starting' | 'running' | 'failed'`, `lastOutput(): string[]` (last 200 lines), `onChange(listener: () => void): Disposable`
  - `LocalServers` (vscode) exposes the pool to the page and runs the migration once at activation.

- [ ] **Step 1: Tests.**
  - `planMigration`: backends `local-sweep-1-5b` (selected for completions and Next Edit) and `local-qwen2-5-coder-3b` → `removeIds` both, `local` with `model` and `nextEditModel` `sweep-next-edit-1.5b`, both selected; completions on `local-qwen2-5-coder-3b` and Next Edit on `local-sweep-1-5b` → `model: 'qwen2.5-coder-3b'`, `nextEditModel: 'sweep-next-edit-1.5b'`; `local-sweep-1-5b-lmstudio` is never removed; managed records with pids → `stopPids`; nothing to migrate → empty plan.
  - Pool (with the existing fakes): start writes the presets and launches `routerArgs`; a port answering `ours` is adopted; `none` on a busy port picks a new free port and moves `local`; `syncPresets` on a running router calls `reload` once; a `modelsInMemory` change restarts; `warm` posts `load` for each name (up to `modelsMax`); the cross-window rules (watch every 15 s, take over, pid-less record means stopped on purpose) still pass with the single record.
  - Activation: no llama-server or one without router mode → `state()` `failed` with the install/update hint, no throw.
- [ ] **Step 2: Run** `npx vitest run test/unit/local`: FAIL.
- [ ] **Step 3: Implement.** The router starts when `local` is selected for an enabled use, or on `start()`; `local` deselected stops it (this window's process only). After start and after a selection change, `warm` loads the selected completions and Next Edit models. The presets file is `<globalStorage>/presets.ini`; the help text check runs once per binary path.
- [ ] **Step 4: Run all checks.**
- [ ] **Step 5: Commit:** `feat: one llama-server router for all local models`

### Task 6: Hugging Face API, token and updates

**Files:**
- Create: `src/local/huggingFace.ts`, `test/unit/local/huggingFace.test.ts`
- Modify: `src/local/download.ts` (an `authFor(url: URL): string | undefined` option applied per request, so redirects to other hosts drop it), `src/config/secrets.ts` (`HF_TOKEN_KEY`, get/set/delete), tests

**Interfaces:**
- Produces:
  - `tokenHeader(url: URL, token: string | undefined): Record<string, string>` — header only when `url.protocol === 'https:'` and `url.hostname === 'huggingface.co'`
  - `repoCommit(repo: string, o: HfOptions): Promise<string>` (`/api/models/<repo>` → `sha`)
  - `ggufFiles(repo: string, revision: string, o: HfOptions): Promise<HfFile[]>` (`/api/models/<repo>/tree/<revision>?recursive=true`, following `Link: <…>; rel="next"`), `HfFile = { path: string; bytes: number; sha256?: string; supported: boolean }`
  - `checkUpdate(m: LocalModel, o: HfOptions): Promise<{ kind: 'upToDate' } | { kind: 'available'; revision: string; bytes: number; sha256: string; date?: string } | { kind: 'gone' }>`
  - `HfError` with `kind: 'auth' | 'notFound' | 'http' | 'network'`

- [ ] **Step 1: Tests** against a local HTTP server standing in for the API (the base URL is injectable in `HfOptions`): `tokenHeader` sends the header for `https://huggingface.co/...` only (not `cdn-lfs.huggingface.co`, not `http:`); a download from a test server that redirects to another host sends `Authorization` on the first request and not on the redirect; two pages of tree results are joined; files without `lfs.oid` have no `sha256` and `supported: false`, split and `mmproj` files `supported: false`; 401 → `HfError` `auth`; `checkUpdate` covers `upToDate`, `available` (new size and sha256) and `gone`.
- [ ] **Step 2: Run** `npx vitest run test/unit/local/huggingFace.test.ts test/unit/local/download.test.ts`: FAIL.
- [ ] **Step 3: Implement.** An update downloads to `<file>.update.part`, verifies the new sha256, renames over the old file, then the caller writes the entry's `revision`, `bytes`, `sha256`; failure or cancel deletes the `.part` and leaves the old file.
- [ ] **Step 4: Run all checks.**
- [ ] **Step 5: Commit:** `feat: Hugging Face token, model files and update checks`

### Task 7: Page state, protocol and the webview

**Files:**
- Create: `src/local/page/protocol.ts`, `src/local/page/state.ts`, `src/webview/localModels/main.ts`, `src/webview/localModels/render.ts`, `src/webview/localModels/style.css`, `test/unit/local/pageState.test.ts`, `test/unit/local/pageRender.test.ts`
- Modify: `esbuild.mjs` (second webview entry `localModels`), `.vscodeignore` if needed

**Interfaces:**
- Produces:
  - `LocalPageState = { server: { binary?: string; version?: string; hint?: string; state: 'stopped'|'starting'|'running'|'failed'; port?: number; modelsInMemory: number; log: string[]; swapWarning: boolean; memoryWarning?: string }; settings: { modelsDir: string; tokenSet: boolean }; models: ModelRow[]; form?: ModelForm; add?: AddState }`
  - `ModelRow = { name; label; bytes; uses; builtIn; hidden; download: { kind: 'none'|'running'|'done'|'failed'; received?: number; error?: string }; load: 'unloaded'|'loading'|'loaded'|'failed'|'n/a'; usedFor: BackendUse[]; mayNotFit: boolean; update?: 'checking'|'upToDate'|{ available: { bytes: number; date?: string } }|'gone' }`
  - `pageState(o: { models: LocalModel[]; downloads; routerModels; settings: Settings; pool; tokenSet: boolean; totalMem: number }): LocalPageState`
  - Messages to the host: `ready`, `start`, `stop`, `restart`, `setModelsInMemory {n}`, `download {name}`, `cancelDownload {name}`, `removeFile {name}`, `load {name}`, `unload {name}`, `use {name; uses: BackendUse[]}`, `edit {name}`, `saveModel {form}`, `hide {name}`, `unhide {name}`, `removeModel {name}`, `addRepo {repo}`, `addFile {repo; path; name; uses; contextTokens}`, `checkUpdate {name}`, `update {name}`, `changeModelsDir`, `setToken`, `removeToken`, `openLog`, `cancel`. Host to page: `state {state}`.
  - `ModelForm = { name; contextTokens: number; extraArgs: string; sampling: { temperature?: number; topP?: number; topK?: number; maxTokens?: number }; otherOverridesMatch: boolean; error?: string }`

- [ ] **Step 1: Tests.** `pageState`: `swapWarning` true when `local`'s `model` ≠ `nextEditModel`, both enabled, `modelsInMemory` 1, false at 2; `memoryWarning` when the largest `modelsInMemory` downloaded models pass 75% of RAM; `mayNotFit` above 40%; `usedFor` from `local`'s fields; the token never appears (only `tokenSet`). `render`: escapes a model id `<img src=x>` and log lines; shows Download / Cancel / Remove file by download kind; Load/Unload only while the router runs; Check for update only on added models; Remove from list only on added models, Hide on built-ins.
- [ ] **Step 2: Run** `npx vitest run test/unit/local/pageState.test.ts test/unit/local/pageRender.test.ts`: FAIL.
- [ ] **Step 3: Implement**; the page's look follows the Backends page (`src/webview/backends/style.css` variables). `main.ts` only wires DOM events to messages and calls `render`.
- [ ] **Step 4: Run all checks.**
- [ ] **Step 5: Commit:** `feat: Local Models page view`

### Task 8: The page host and its actions

**Files:**
- Create: `src/ui/localModelsPanel.ts`
- Modify: `src/local/vscode/setup.ts` (download, remove, folder move become functions the panel calls), `src/ui/commands.ts`, `src/ui/statusModel.ts`, `src/extension.ts`, `package.json` (command `aiAutocomplete.manageLocalModels` "Manage Local Models", walkthrough step button), `test/unit/statusModel.test.ts`, `test/unit/manifest.test.ts`

- [ ] **Step 1: Tests (unit, pure parts):** the model-entry edits the actions write: `saveModel` writes only changed fields to the `local.models` entry and `modelOverrides["^<escaped>$"].sampling` (empty sampling form removes that key; other keys untouched; regex escaping of `qwen2.5-coder-3b` → `^qwen2\.5-coder-3b$`); `use` writes `local`'s `model` / `nextEditModel` / `use` and selects `local` for each use; `removeModel` on a model in use clears that field. Manifest: `manageLocalModels` is contributed; the status menu's local entry and **Set Up Local Model...** open the page.
- [ ] **Step 2: Run** the tests: FAIL.
- [ ] **Step 3: Implement.** Panel behaviour (from the spec): polls `RouterClient.models()` every 2 s while visible and running; pushes download progress; Add model runs `repoCommit` + `ggufFiles` with the token, then the add form; Change models folder asks to move files (same volume `rename`, else copy, check size, delete) and then `syncPresets`; Set token uses `showInputBox({ password: true })` and stores it in SecretStorage; 401/403 shows the fixed text with a link to `https://huggingface.co/<repo>`. **Set Up Local Model...** opens the page; on a first run with nothing downloaded the page offers the default (Sweep 1.5B): download → start → use for both → run the Backends page's Test for `local` and show the result. **Stop Local Models** calls `pool.stop()` (and clears the record); **Remove Downloaded Models...** keeps its pick.
- [ ] **Step 4: Run all checks.**
- [ ] **Step 5: Commit:** `feat: Manage Local Models page`

### Task 9: Integration test with a fake router, and docs

**Files:**
- Modify: `test/integration/local.test.ts`, `test/integration/fixtures/` (fake router script), `README.md`, `AGENTS.md` (layout: new modules; settings rule), `docs/ROADMAP.md` (Phase 4 released in v0.6.0; new row "4b. Polish" released in v0.6.0; new row "4c. Local Models page" with manual checks from the spec's Testing section), the 2026-11-16 helper design (a note at the top pointing to the new design)

- [ ] **Step 1: Tests:** the fake router (a Node script set through `local.llamaServerPath`) prints `--models-preset` for `--help`, answers `/health`, `/props` (`role: "router"`, and per model with `?model=`), `/models`, `/models/load`, `/models/unload`, `/infill`. The test: open Manage Local Models, download the test model from the mock server, Start (the script records its arguments: `--models-preset <path>`, `--models-max 1`, `--host 127.0.0.1`), Use for completions selects `local`, and a completion arrives through the router with `model` in the body. A second test: settings with an old `local-test` backend selected migrate to `local` on activation.
- [ ] **Step 2: Run** `npm run test:integration`: new tests pass; the 3 known local Next Edit failures (the user's argv.json opt-in) are unchanged.
- [ ] **Step 3: Update the docs.**
- [ ] **Step 4: Commit:** `test: local model router end to end` then `docs: Local Models page`

### Finish

- [ ] Final whole-branch review, fix wave; live check against the real llama-server (Sweep 1.5B for both; Qwen2.5-Coder 3B + Sweep at Models in memory 1 and 2).
