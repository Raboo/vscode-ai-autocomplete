# Local Model Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command sets up a local model: it picks a runtime (llama-server or LM Studio) and a recipe, downloads the GGUF with progress, starts it, adds and selects the backend, and runs Test.

**Architecture:** Pure modules under `src/local/` (recipes, runtime lookup, downloader, llama-server process, LM Studio CLI, backend entries) take their side effects (`spawn`, `exec`, `fetch`, clock) as parameters and are unit-tested. `src/local/vscode/` holds the VS Code glue: the managed llama-server processes (start on activation, stop on deactivation) and the setup, stop and remove commands.

**Tech Stack:** TypeScript, Node built-ins (`node:child_process`, `node:crypto`, `node:fs`, `node:net`, `node:os`), vitest, @vscode/test-electron.

**Spec:** `docs/superpowers/specs/2026-11-16-local-model-helper-design.md` (the recipe table there is the source of the exact recipe values); main spec `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md` ("Local model helper").

## Global Constraints

- Runtime dependencies stay `diff` and `jsonc-parser` only (`test/unit/manifest.test.ts` pins this); use Node built-ins.
- Only `src/local/vscode/*` (added to AGENTS.md's allowlist in Task 9) and the existing allowlist may `import 'vscode'`.
- Processes start with an argument array (`spawn`/`execFile`), never `shell: true`.
- llama-server listens on `127.0.0.1` only.
- New settings `aiAutocomplete.local.llamaServerPath` and `aiAutocomplete.local.lmsPath` are `machine` scope and read from `globalValue` only.
- The only request the helper sends off the machine is the model download from `https://huggingface.co/<repo>/resolve/<revision>/<file>`; every URL in a redirect chain must be `https:`, except loopback hosts (tests).
- Server output is logged at debug level; nothing else new is logged above debug except failures.
- Commits: Conventional Commits, one per task with the plan's message, no Co-Authored-By trailer; stage by explicit path.

## Review Focus

- A download cancelled or cut halfway, then started again: it resumes from the `.part` file and the result passes the checksum (Task 3 test "resumes").
- A server that answers a Range request with 200 instead of 206: the download starts over from byte 0 instead of appending (Task 3 test "restarts on 200").
- llama-server exits at once (bad model, port taken): setup fails with the server's last output lines and writes no backend (Task 4 test "early exit"; Task 8 integration "fails cleanly").
- The managed server's port is taken at the next VS Code start: a new free port is used and the backend's `baseUrl` is updated (Task 7 test).
- Setup run twice for the same recipe: the file is not downloaded again, the running server for that backend is stopped first, and the backend is replaced (Task 3 "present", Task 8 integration "second run").

---

### Task 1: Recipes

**Files:**
- Create: `src/local/recipes.ts`, `test/unit/local/recipes.test.ts`

**Interfaces:**
- Produces:
  - `interface Recipe { id: string; label: string; repo: string; revision: string; file: string; bytes: number; sha256: string; license: string; uses: BackendUse[]; modelName: string; contextTokens: number; url?: string }` (`url` overrides the Hugging Face URL; test recipes only)
  - `const RECIPES: readonly Recipe[]` with ids `sweep-1.5b` (first, the default), `qwen2.5-coder-1.5b`, `qwen2.5-coder-3b`, `qwen2.5-coder-7b`, `mellum-4b`; values from the design's table; `contextTokens` 8192; labels "Sweep Next Edit 1.5B", "Qwen2.5-Coder 1.5B", "Qwen2.5-Coder 3B", "Qwen2.5-Coder 7B", "Mellum 4B"
  - `downloadUrl(r: Recipe): string`
  - `fitsMemory(r: Recipe, totalMemBytes: number): boolean` (true when `r.bytes <= 0.4 * totalMemBytes`)

- [ ] **Step 1: Tests** (`recipes.test.ts`):
  - every recipe's sha256 is 64 hex chars, revision 40 hex chars, `bytes > 0`, ids unique, `RECIPES[0].id === 'sweep-1.5b'`;
  - `downloadUrl(sweep)` is `https://huggingface.co/sweepai/sweep-next-edit-1.5B/resolve/409016591c6c1a94f545f22328a85a3516118f34/sweep-next-edit-1.5b.q8_0.v2.gguf`; a recipe with `url` returns it;
  - each recipe's `modelName` works with the existing model rules: `resolvePreset(modelName, {}).fimTemplate` is `qwen` for Sweep and Qwen, `mellum` for Mellum; for Sweep `sweepVariant(modelName) === 'v1'` and `pickFormat('auto', modelName).id === 'sweep'`; no model name contains `v2`;
  - `fitsMemory`: with 18 GiB (`18 * 2 ** 30`) the 7B recipe does not fit and the 3B one does.
- [ ] **Step 2: Run** `npx vitest run test/unit/local/recipes.test.ts`: FAIL.
- [ ] **Step 3: Implement** `src/local/recipes.ts`.
- [ ] **Step 4: Run** the test: PASS; then `npm run typecheck && npm run lint`.
- [ ] **Step 5: Commit:** `feat: local model recipes`

### Task 2: Finding the runtimes, and their settings

**Files:**
- Create: `src/local/runtimes.ts`, `test/unit/local/runtimes.test.ts`
- Modify: `src/config/settings.ts` (`Settings.local: { llamaServerPath?: string; lmsPath?: string }` via the existing `machine()` reader; an empty string counts as unset), `package.json` (the two settings, `machine` scope, `type: string`, default `""`), `test/unit/settings.test.ts`

**Interfaces:**
- Produces:
  - `type RuntimeId = 'llamaServer' | 'lms'`
  - `interface RuntimeEnv { platform: NodeJS.Platform; home: string; pathEnv: string; exists(p: string): boolean; readFile(p: string): string | undefined }`
  - `runtimeCandidates(id: RuntimeId, env: RuntimeEnv, override?: string): string[]`
  - `findRuntime(id: RuntimeId, env: RuntimeEnv, override?: string): string | undefined` (first candidate that exists)
  - `INSTALL_HINT: Record<RuntimeId, string>`: llama-server: `Install llama.cpp (macOS: brew install llama.cpp), or set aiAutocomplete.local.llamaServerPath.`; lms: `Install LM Studio from https://lmstudio.ai and start it once, or set aiAutocomplete.local.lmsPath.`

- [ ] **Step 1: Tests:**
  - an override is the only candidate (even when it does not exist);
  - llama-server: each `pathEnv` entry (split on `:`, or `;` on win32) + `llama-server` (`.exe` on win32), then `/opt/homebrew/bin/llama-server`, `/usr/local/bin/llama-server` (not on win32);
  - lms: each PATH entry + `lms`, then `<home>/.lmstudio/bin/lms`, then `<pointer>/bin/lms` when `<home>/.lmstudio-home-pointer` reads to a path (trimmed), then `<home>/.cache/lm-studio/bin/lms`;
  - `findRuntime` returns the first existing one, undefined when none;
  - settings: `local.llamaServerPath` from a workspace value is ignored, from `globalValue` it is read; `""` is unset.
- [ ] **Step 2: Run** the tests: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run build && npm test && npm run typecheck && npm run lint`.
- [ ] **Step 5: Commit:** `feat: find llama-server and LM Studio's CLI`

### Task 3: The downloader

**Files:**
- Create: `src/local/download.ts`, `test/unit/local/download.test.ts`
- Modify: `test/unit/helpers/mockHttp.ts` only if it cannot already send a raw body with a status and headers (add `raw?: { status: number; headers?: Record<string, string>; body: Buffer }` to `MockResponse` if needed)

**Interfaces:**
- Produces:
  - `class DownloadError extends Error { constructor(message: string, readonly kind: 'space' | 'http' | 'checksum' | 'url' | 'cancelled') }`
  - `interface DownloadOptions { url: string; dest: string; bytes: number; sha256: string; signal: AbortSignal; onProgress(received: number, total: number): void; fetchFn?: typeof fetch; freeBytes?(dir: string): Promise<number> }` (`freeBytes` defaults to `fs.statfs`)
  - `downloadModel(o: DownloadOptions): Promise<'downloaded' | 'present'>`
  - `sha256File(path: string): Promise<string>`

- [ ] **Step 1: Tests** (real temp dirs, a local HTTP server; the server records the `Range` header):
  - "present": `dest` already has the right bytes and checksum → `'present'`, no request;
  - a full download writes `dest`, reports progress ending at `total`, leaves no `.part`;
  - "resumes": an existing `<dest>.part` of N bytes sends `Range: bytes=N-`; a 206 answer is appended and the checksum passes;
  - "restarts on 200": a 200 answer to a Range request rewrites the `.part` from byte 0;
  - a checksum mismatch deletes the `.part` and throws `kind: 'checksum'`;
  - a redirect to an `http:` non-loopback URL throws `kind: 'url'` (follow redirects by hand, at most 5);
  - a 404 throws `kind: 'http'`;
  - `freeBytes` below `(bytes - partBytes) * 1.1` throws `kind: 'space'` before any request;
  - aborting mid-stream throws `kind: 'cancelled'` and keeps the `.part`.
- [ ] **Step 2: Run** `npx vitest run test/unit/local/download.test.ts`: FAIL.
- [ ] **Step 3: Implement.** Create the destination directory; stream the body to the `.part` file; hash the finished file before renaming it.
- [ ] **Step 4: Run** all checks.
- [ ] **Step 5: Commit:** `feat: download local models with resume and checksum`

### Task 4: The llama-server process

**Files:**
- Create: `src/local/llamaServer.ts`, `test/unit/local/llamaServer.test.ts`

**Interfaces:**
- Produces:
  - `llamaServerArgs(o: { file: string; modelName: string; port: number; contextTokens: number }): string[]` → `['-m', file, '--alias', modelName, '--host', '127.0.0.1', '--port', String(port), '-c', String(contextTokens), '-ngl', '99', '-fa', 'on', '-np', '1', '--cache-reuse', '256', '--no-webui']`
  - `freePort(preferred?: number): Promise<number>` (the preferred port when it can be bound on 127.0.0.1, otherwise an OS-assigned one)
  - `interface ChildLike { readonly pid?: number; stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null; kill(signal?: NodeJS.Signals): boolean; once(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown }`
  - `type SpawnLike = (cmd: string, args: string[]) => ChildLike`
  - `class LocalRuntimeError extends Error {}`
  - `class LlamaServerProcess { static start(o: { binary: string; args: string[]; port: number; spawnFn: SpawnLike; fetchFn?: typeof fetch; log(line: string): void; timeoutMs?: number; pollMs?: number }): Promise<LlamaServerProcess>; readonly port: number; readonly exited: Promise<void>; stop(): Promise<void> }` (defaults: `timeoutMs` 120000, `pollMs` 500)

- [ ] **Step 1: Tests** (a fake child built on `EventEmitter` + `PassThrough`, a local HTTP server for `/health`):
  - `llamaServerArgs` returns the exact array above;
  - `start` resolves once `GET http://127.0.0.1:<port>/health` answers 200 (503 first, then 200); each output line goes to `log`;
  - "early exit": the child exits before healthy → rejects with `LocalRuntimeError` whose message includes the last output lines (at most 20);
  - the deadline passes → the child gets `SIGTERM` and `start` rejects;
  - `stop()` sends `SIGTERM`, then `SIGKILL` after 5 s if the child has not exited (fake timers), and resolves on exit;
  - `freePort(p)` returns `p` when free, another port when `p` is held by a test server.
- [ ] **Step 2–4:** run (FAIL), implement, run all checks.
- [ ] **Step 5: Commit:** `feat: start and stop llama-server`

### Task 5: LM Studio's CLI

**Files:**
- Create: `src/local/lmStudio.ts`, `test/unit/local/lmStudio.test.ts`

**Interfaces:**
- Produces:
  - `type ExecLike = (cmd: string, args: string[], o: { timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>`
  - `class LmStudio { constructor(lms: string, exec: ExecLike); importModel(file: string, repo: string): Promise<string>; ensureServer(): Promise<number>; load(modelKey: string, contextTokens: number, identifier: string): Promise<void> }`; failures throw `LocalRuntimeError` (from Task 4) with the command's stderr (first 500 chars).
  - Commands (exact): `ls --json` (entries with `modelKey`, `path`); `import --hard-link -y --user-repo <repo> <file>`; `server status --json` (`{"running":true,"port":1234}`); `server start`; `ps --json` (entries with `identifier`); `load <modelKey> -c <contextTokens> --identifier <identifier> -y`.

- [ ] **Step 1: Tests** (a recording fake `exec`):
  - `importModel` returns the `modelKey` of the `ls --json` entry whose `path` is `<repo>/<file>`, without importing, when it is already listed; otherwise it imports, lists again and returns the new key; not found after import → throws;
  - `ensureServer` returns the port from `server status --json` when running; when not running it runs `server start` and reads the status again;
  - `load` skips loading when `ps --json` already has that `identifier`; otherwise runs the exact `load` arguments;
  - a non-zero exit code throws `LocalRuntimeError` with stderr.
- [ ] **Step 2–4:** run (FAIL), implement, run all checks.
- [ ] **Step 5: Commit:** `feat: drive LM Studio through its CLI`

### Task 6: Backend entries and managed servers

**Files:**
- Create: `src/local/backendEntry.ts`, `test/unit/local/backendEntry.test.ts`

**Interfaces:**
- Consumes: `Recipe` (Task 1).
- Produces:
  - `type LocalRuntime = 'llamaServer' | 'lmStudio'`
  - `localBackendId(r: Recipe, runtime: LocalRuntime): string` → `local-<id>` / `local-<id>-lmstudio`
  - `localBackendEntry(r: Recipe, runtime: LocalRuntime, port: number): Record<string, unknown>`: llama-server `{ id, kind: 'llamacpp', baseUrl: 'http://127.0.0.1:<port>', use, fimModel?, nextEditModel? }`; LM Studio `{ id, kind: 'openai', hostFlavor: 'lmstudio', baseUrl: 'http://127.0.0.1:<port>/v1', ... }`; `fimModel` = `modelName` when `uses` has completions, `nextEditModel` = `modelName` when it has Next Edit; `use` = the recipe's uses
  - `interface ManagedServer { backendId: string; recipeId: string; file: string; port: number }`, `MANAGED_KEY = 'localServers'`, `parseManaged(raw: unknown): ManagedServer[]` (drops malformed entries)
  - `serversToStart(managed: ManagedServer[], s: Settings): ManagedServer[]`: those whose backend still exists in `s.backends` and is `s.fim.backendId` (with `s.fim.enabled`) or `s.nextEdit.backendId` (with `s.nextEdit.enabled`), all only when `s.enabled`

- [ ] **Step 1: Tests:** both entries parse with the existing settings parser (`parseSettings` with the entry as `backends` `globalValue`) into the expected `BackendConfig` (`use`, models, flavor); a completions-only recipe has no `nextEditModel`; `parseManaged` keeps valid and drops malformed entries; `serversToStart` covers selected for completions, selected for Next Edit, not selected, backend removed, switch off.
- [ ] **Step 2–4:** run (FAIL), implement, run all checks.
- [ ] **Step 5: Commit:** `feat: local backend entries`

### Task 7: Managed llama-servers in VS Code

**Files:**
- Create: `src/local/vscode/servers.ts`
- Modify: `src/extension.ts` (create the manager, start selected servers after activation without blocking it, stop all in `deactivate` and on dispose), `src/ui/commands.ts` + `package.json` (command `aiAutocomplete.stopLocalModels`, title "Stop Local Models"), `test/unit/manifest.test.ts` (command list)
- Test: `test/unit/local/backendEntry.test.ts` (port reuse decision, below)

**Interfaces:**
- Consumes: Tasks 2, 4, 6.
- Produces:
  - in `backendEntry.ts`: `portFor(saved: number, free: (preferred: number) => Promise<number>): Promise<{ port: number; changed: boolean }>`
  - `class LocalServers implements vscode.Disposable { constructor(d: { context: vscode.ExtensionContext; log: Log; settings(): Settings; spawnFn?: SpawnLike }); start(m: ManagedServer): Promise<LlamaServerProcess>; startSelected(): Promise<void>; stop(backendId: string): Promise<void>; stopAll(): Promise<void>; record(m: ManagedServer): Promise<void>; forget(backendId: string): Promise<void>; running(): string[]; dispose(): void }`
  - `start` stops a running server for the same backend first; when the saved port is taken it uses a new one and rewrites that backend's `baseUrl` in user settings (`upsertBackend` from `src/manage/form.ts`); a server that exits unexpectedly is logged as an error once.

- [ ] **Step 1: Test** `portFor`: a free saved port is kept (`changed: false`); a taken one gets the new port (`changed: true`).
- [ ] **Step 2: Implement** `portFor`, `LocalServers`, the wiring and the command (with no servers running it says "No local models are running.").
- [ ] **Step 3: Run** all checks.
- [ ] **Step 4: Commit:** `feat: run local llama-servers with VS Code`

### Task 8: The setup and remove commands

**Files:**
- Create: `src/local/vscode/setup.ts`, `test/integration/fixtures/fake-llama-server.mjs` (executable, `#!/usr/bin/env node`), `test/integration/local.test.ts`
- Modify: `src/ui/commands.ts` + `package.json` (commands `aiAutocomplete.setUpLocalModel` "Set Up Local Model", `aiAutocomplete.removeLocalModels` "Remove Downloaded Models"), `src/ui/statusModel.ts` (menu entry `{ label: 'Set up local model...', id: 'setUpLocalModel' }` right after "Manage backends..."), `test/unit/statusModel.test.ts`, `src/manage/protocol.ts` + `src/webview/backends/render.ts` + `src/webview/backends/main.ts` + `src/ui/backendsPanel.ts` (a "Set up local model" button next to "+ Add backend" posting `{ type: 'setUpLocal' }`, which runs the command), `test/unit/render.test.ts`, `src/extension.ts` (test API: `local: { setRecipes(r: Recipe[] | undefined): void }`), `test/integration/mockServer.ts` (`files?: Record<string, Buffer>` served at their path with Range support), `test/unit/manifest.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7; `useBackend`, `useNextEditBackend` (`src/ui/commands.ts`); `upsertBackend` (`src/manage/form.ts`); `runConnectionTest` (`src/manage/connectionTest.ts`).
- Produces: `setUpLocalModel(d: SetupDeps, arg?: { recipe: string; runtime: LocalRuntime }): Promise<void>`; with `arg` the pickers are skipped (tests and future callers).

Flow (decisions the code must follow):
1. A remote window (`vscode.env.remoteName` set) gets "The local model helper works in local windows only." and stops.
2. Runtime picker: the found runtimes first ("llama-server — runs the model as a process VS Code starts and stops", "LM Studio — loads the model into LM Studio"), missing ones listed with their `INSTALL_HINT` (picking one shows the hint).
3. Recipe picker: label, uses ("Completions · Next Edit" / "Completions"), size in GB with one decimal, "may not fit in memory" when `!fitsMemory(r, os.totalmem())`; Sweep first, marked "recommended".
4. If the backend id already exists in user settings: modal "Replace the backend <id>?" Yes/No; No stops.
5. Download with `vscode.window.withProgress` (Notification, cancellable): "Downloading <label> from huggingface.co" with percent and MB; `'present'` skips it. Files go to `<globalStorageUri>/models/<repo>/<file>`.
6. llama-server: stop that backend's server, `freePort(8012)`, start, `record`. LM Studio: `importModel`, `ensureServer`, `load(modelKey, contextTokens, modelName)`.
7. Write the entry (`localBackendEntry`) to user settings, select it for each of the recipe's uses, run the Test and show "Local model ready: <backend id>" or the failing step's text with **Open Backends**.
8. Any failure shows its message, writes no backend, and stops a server it started.

- `removeLocalModels`: a multi-select of the files under `<globalStorage>/models` (with sizes); a file used by a recorded managed server stops that server first and forgets it; LM Studio's hard links keep their data (said in the confirmation).

- [ ] **Step 1: Tests:**
  - unit: the menu order with `setUpLocalModel` after `manageBackends`; the page renders the button;
  - integration (`local.test.ts`, `main` launch), with a small test recipe served by the mock server (64 KiB of known bytes, its sha256 computed in the test), `local.llamaServerPath` pointing at the fake server (which answers `/health`, `/props`, `/v1/models` and `/infill` with `a + b;` on the `--port` it is given):
    - setup with `{ recipe: 'test', runtime: 'llamaServer' }` downloads the file, starts the fake server, writes `local-test`, selects it, and ghost text `a + b;` appears in a TypeScript file;
    - "second run": the same setup again sends no download request and replaces the backend (answer the modal through a test seam, or skip the modal when the existing entry was made by the helper, i.e. its id is in the managed list);
    - **Stop Local Models** stops it (`/health` refuses);
    - "fails cleanly": a fake server that exits at once (an env var tells the fixture to exit 1) shows the error and writes no backend.
- [ ] **Step 2: Run** them: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run build && npm test && npm run typecheck && npm run lint && npm run test:integration` (the known three local failures stay; everything else passes).
- [ ] **Step 5: Commit:** `feat: set up a local model in one command`

### Task 9: Docs

**Files:** `README.md` ("Local models": the command, runtimes, recipes with sizes and licences, where files go, stopping and removing, that the download is the only request off the machine), `AGENTS.md` (allowlist adds `src/local/vscode/*`; machine-scoped settings list adds `local.llamaServerPath`, `local.lmsPath`; layout lines for `src/local/`), `docs/ROADMAP.md` (3d "released in v0.5.1"; Phase 4 "implemented on `feat/local-models`" with this plan and the design; a Phase 4 smoke checklist: setup with llama-server and with LM Studio, restart VS Code with the backend selected, Stop Local Models, Remove Downloaded Models), main spec settings table (`local.*`).

- [ ] **Step 1: Update the docs.**
- [ ] **Step 2: Run** `npm run build && npm test && npm run lint`.
- [ ] **Step 3: Commit:** `docs: local model helper`
