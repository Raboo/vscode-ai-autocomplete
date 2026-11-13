# AI Autocomplete — Phase 0–1 (Scaffold + FIM core, v0.1.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code extension with ghost-text FIM autocomplete against llama.cpp `/infill`, OpenAI-compatible `/v1/completions` and Mistral Codestral, released on GitHub as `v0.1.0`. It is lean, has no telemetry, and is privacy-safe.

**Architecture:**
- Pure TypeScript modules with no `vscode` import do the work: settings parsing, templates/presets, HTTP/SSE, backends, context windows, stream filters, cache and debounce. They are unit-tested with vitest.
- A thin VS Code layer (provider, tracker, status bar, commands, `extension.ts`) wires them together and is covered by `@vscode/test-electron` integration tests against a mock HTTP server.

**Tech Stack:** TypeScript 6.0, esbuild, vitest 5, eslint 10 + typescript-eslint 8, @vscode/vsce 4, @vscode/test-cli / test-electron, Node ≥ 22. **Zero runtime dependencies in this phase.**

**Spec:** `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md` (read it first; this plan implements its Phase 0 and Phase 1 only).

## Global Constraints

- Extension identity:
  - `publisher: "raboo"`, `name: "ai-autocomplete"`, `displayName: "AI Autocomplete"`, settings prefix `aiAutocomplete.`, command prefix `aiAutocomplete.`;
  - `license: "Apache-2.0"`, `author: { "name": "Elias Abacioglu" }`, repository `https://github.com/Raboo/vscode-ai-autocomplete`.
- `engines.vscode: "^1.100.0"`, `@types/vscode: "~1.100.0"`. Use only stable API in this phase (no `enabledApiProposals`).
- `typescript` must be `~6.0.3`: typescript-eslint 8.72 supports TypeScript below 6.1 only.
- Only these files may `import 'vscode'`: `src/extension.ts`, `src/log.ts`, `src/config/vscodeSettings.ts`, `src/config/secrets.ts`, `src/completion/provider.ts`, `src/completion/contextTracker.ts`, `src/ui/*`. Everything else is pure and unit-testable.
- No telemetry, ever. Nothing leaves the machine except requests to the user-configured backend.
- Machine-scoped settings (`aiAutocomplete.backends`, `aiAutocomplete.modelOverrides`, `aiAutocomplete.debug.logPrompts`) are read from **`globalValue` only**. Workspace values are ignored, even if present.
- Prompt and completion text are logged only when `aiAutocomplete.debug.logPrompts` is true. Timings, status codes and sizes are always logged at debug level.
- Attribution:
  - Any file that copies or closely adapts upstream code starts with `// Portions adapted from <project> <path> @ <commit> (<license>). Copyright <holder>.`.
  - `THIRD_PARTY_NOTICES.md` gets an entry for that project, including the full MIT text for MIT projects.
  - Take the copyright holder from the upstream LICENSE file.
  - Upstream references: Continue `continuedev/continue@5522c6f44ca0ac3528b37244818fbfa39b5af470` (Apache-2.0); Kilo Code `Kilo-Org/kilocode@caf1f6069a51af72c1520cbad7a8adffe8eb59b9` (MIT); llama.vscode `ggml-org/llama.vscode` (MIT).
  - Read upstream with `gh api repos/<o>/<r>/contents/<path>?ref=<sha> --jq .content | base64 -d`. Never run upstream code.
- Never touch the GitHub repo `Raboo/ai-autocomplete`. Before `gh repo create`, any `git push`, changing GitHub repo settings, or creating a release, **ask the user and wait for a yes**. In this plan every such step is collected in the final **Publish** section, which the controller runs after Task 14 and the final review. Tasks never push or call GitHub write APIs.
- Commits end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commit subjects follow Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`, `build:`). release-please derives the version and `CHANGELOG.md` from them (Task 14). Nobody edits `CHANGELOG.md` or the `version` field by hand.
- GitHub Actions:
  - every `uses:` is pinned to a full 40-character commit SHA followed by a `# vX.Y.Z` comment. Resolve SHAs with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha` after finding the latest release tag with `gh release view -R <owner>/<repo> --json tagName --jq .tagName`;
  - every workflow declares top-level least-privilege `permissions:`;
  - the CI job ids are `check` and `integration`, with no `name:` override, because the repo ruleset requires those check names.
- Node: `.nvmrc` contains `22`; CI reads the Node version from it (`node-version-file: .nvmrc`). Code must also work on newer Node versions (local machines may run Node 26).
- Dependency updates come from Dependabot (`.github/dependabot.yml`, Task 14). It must never propose `typescript` ≥ 6.1 or `@types/vscode` minor/major bumps, because both are pinned on purpose (see above).
- AI-session handoff: `AGENTS.md` is the single source of rules for any AI agent working in this repo; `CLAUDE.md` only imports it. `docs/ROADMAP.md` records phase status. Keep both current when a task changes what they describe.

## Review Focus

1. **Backend down** (llama-server not running, connection refused): no notification spam, the status bar shows an error, requests back off, and the log gets one line per backoff transition, not one per keystroke. Covered by Task 3 `backoff: network errors back off` and Task 13 `unreachable backend → error status, no item`.
2. **Huge single-line files** (minified bundles): the prefix and suffix must respect character caps, not just line caps. Covered by Task 8 `caps a 1 MB single line`.
3. **CRLF documents**: filters must treat `\r\n` as one line break, and the inserted text must use the document's EOL. Covered by Task 9 `handles CRLF` and Task 11 `planInsertion converts to CRLF`.
4. **Fast typing cancels requests**: an aborted request is not a backend failure and must not trigger backoff or show an error. Covered by Task 3 `classifyError: abort`.
5. **`localOnly` with an unresolvable or public hostname**: DNS failure means "not local", so the request is blocked. Covered by Task 2 `dns failure is not local`.

---

## File map (all created in this plan)

```
package.json  tsconfig.json  tsconfig.integration.json  esbuild.mjs  eslint.config.mjs  vitest.config.ts
.gitignore  .vscodeignore  .vscode-test.mjs  .nvmrc  LICENSE  NOTICE  THIRD_PARTY_NOTICES.md  README.md  CHANGELOG.md
AGENTS.md  CLAUDE.md  docs/ROADMAP.md                      AI-session handoff (Tasks 1, 14)
.github/workflows/ci.yml  .github/workflows/release-please.yml  .github/workflows/dependabot-automerge.yml  .github/workflows/codeql.yml
.github/dependabot.yml  release-please-config.json  .release-please-manifest.json  scripts/setup-github-repo.sh
src/extension.ts            activation wiring
src/log.ts                  Log interface, nullLog, createLog(channel)
src/types.ts                shared types (BackendConfig, Sampling, ContextFile, …)
src/config/settings.ts      parseSettings (pure)
src/config/vscodeSettings.ts  adapter: vscode config → RawSettingsSource
src/config/secrets.ts       API keys in SecretStorage
src/config/localOnly.ts     isPrivateAddress, isLocalEndpoint
src/backends/http.ts        postJson, HttpError, joinUrl, classifyError
src/backends/sse.ts         parseSse
src/backends/backoff.ts     ErrorBackoff
src/backends/types.ts       FimBackend, FimRequest, FimPayload
src/backends/hostFlavor.ts  inferHostFlavor
src/backends/llamacpp.ts  src/backends/openaiCompat.ts  src/backends/mistral.ts  src/backends/index.ts (createBackend)
src/models/templates.ts     FIM templates + stops
src/models/presets.ts       PRESETS, resolvePreset
src/completion/context.ts   buildFimWindow, ExtraContextRing
src/completion/contextTracker.ts  feeds the ring from editor events
src/completion/filters.ts   CompletionAccumulator, shouldCompleteMultiline, levenshteinRatio
src/completion/postprocess.ts postprocess, toInsertion
src/completion/cache.ts     SuggestionCache
src/completion/scheduler.ts Debouncer, InFlight
src/completion/gate.ts      gate
src/completion/route.ts     planRoute, planInsertion
src/completion/provider.ts  FimProvider
src/ui/statusBar.ts  src/ui/commands.ts
test/unit/*.test.ts  test/integration/{mockServer.ts, fim.test.ts}
```

**Progress tracking (for the controller and for later AI sessions):** after a task passes review, the controller ticks that task's `- [ ]` boxes in this file and commits it as `docs(plan): mark Task N complete`. A fresh session can therefore see progress from the committed plan and from `git log` commit subjects, which match each task's commit step.

---

### Task 1: Scaffold, license files, CI, first commit

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.mjs`, `eslint.config.mjs`, `vitest.config.ts`, `.gitignore`, `.vscodeignore`, `.nvmrc`, `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, `README.md`, `CHANGELOG.md`, `AGENTS.md`, `CLAUDE.md`, `docs/ROADMAP.md`, `.github/workflows/ci.yml`, `src/extension.ts`
- Test: `test/unit/manifest.test.ts`
- Already present: `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md`, this plan, and an initialised git repo on branch `main` with no commits.

**Interfaces:**
- Produces:
  - npm scripts `build`, `watch`, `typecheck`, `lint`, `test`, `package`, `vscode:prepublish`;
  - `dist/extension.js` exporting `activate(ctx)` / `deactivate()`.

- [x] **Step 1: Write `package.json`** (the repo is already initialised on `main`)
  - Use the identity from Global Constraints, version `0.0.1`.
  - description: `"Fast AI code completion for self-hosted and cloud models. Autocomplete only: no chat, no agents, no telemetry."`
  - `categories: ["AI","Programming Languages"]`, `main: "./dist/extension.js"`, `activationEvents: ["onStartupFinished"]`, `extensionKind: ["ui","workspace"]`. Prefer running locally so `localhost` means the user's own machine in Remote/SSH sessions.
  - Scripts:
    - `build`: `node esbuild.mjs`
    - `watch`: `node esbuild.mjs --watch`
    - `typecheck`: `tsc --noEmit`
    - `lint`: `eslint .`
    - `test`: `vitest run`
    - `package`: `vsce package --no-dependencies`
    - `vscode:prepublish`: `node esbuild.mjs --production`
  - devDependencies: `typescript ~6.0.3`, `esbuild ^0.28.2`, `vitest ^5.1.0`, `eslint ^10.14.0`, `@eslint/js ^10.0.1`, `typescript-eslint ^8.72.2`, `@vscode/vsce ^4.1.1`, `@types/vscode ~1.100.0`, `@types/node ^22`.
  - `contributes` is left empty here; Tasks 2 and 12 fill it. Run `npm install`.

- [x] **Step 2: Write the build and lint configuration files**
  - `tsconfig.json`: `strict`, `target ES2022`, `lib ["ES2023"]`, `module ESNext`, `moduleResolution bundler`, `noEmit`, `types ["node"]`, `include ["src","test/unit"]`.
  - `esbuild.mjs`: entry `src/extension.ts` → `dist/extension.js`, `format cjs`, `platform node`, `target node20`, `external ["vscode"]`. Sourcemaps unless `--production`; minify with `--production`; `--watch` support.
  - `eslint.config.mjs`: flat config with `@eslint/js` recommended plus `typescript-eslint` recommended; ignore `dist`, `out`, `node_modules`.
  - `vitest.config.ts`: `include: ['test/unit/**/*.test.ts']`, `environment: 'node'`.
  - `.gitignore`: `node_modules/ dist/ out/ .vscode-test/ *.vsix .superpowers/`.
  - `.nvmrc`: `22`.
  - `.vscodeignore`: exclude everything except `dist/extension.js`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`.

- [x] **Step 3: Write the license, notice and readme files**
  - `LICENSE`: the unmodified Apache-2.0 text from `gh api licenses/apache-2.0 --jq .body`.
  - `NOTICE`, exactly:
    ```
    AI Autocomplete
    Copyright 2026 Elias Abacioglu

    Originally created by Elias Abacioglu — https://github.com/Raboo/vscode-ai-autocomplete

    This product includes software adapted from third-party projects;
    see THIRD_PARTY_NOTICES.md for their notices and licenses.
    ```
  - `THIRD_PARTY_NOTICES.md`: a heading plus one line saying entries are added per ported component.
  - `README.md`:
    - a one-paragraph pitch: "autocomplete only", self-hosted first (llama.cpp, LM Studio, vLLM), Codestral, OpenRouter later;
    - a "Status: pre-release" note;
    - "## License": Apache-2.0;
    - "## Credits & forks": forks and redistributions must keep `NOTICE` (Apache-2.0 §4(d)), and please credit the original project and author.
  - `CHANGELOG.md`: `# Changelog` plus one line: "Release notes are generated by release-please from Conventional Commit messages; do not edit by hand."

- [x] **Step 3b: Write the AI-session handoff files**
  - `AGENTS.md` (the rules every AI agent follows here; keep it under ~150 lines). Sections, in order:
    1. **What this is**: three lines (autocomplete-only VS Code extension; FIM now, Next Edit later; self-hosted first) and links to the spec and `docs/ROADMAP.md`.
    2. **Hard rules**: restate, one line each, these Global Constraints: no telemetry; machine-scoped settings read from `globalValue` only; the `import 'vscode'` allowlist; prompt logging only with `debug.logPrompts`; the attribution header format and `THIRD_PARTY_NOTICES.md`; never touch `Raboo/ai-autocomplete`; interactive sessions ask before creating repos, pushing, changing repo settings or releasing; Conventional Commits; AI-authored commits end with a `Co-Authored-By:` trailer naming the model; never run upstream code; the two pinned versions and why (`typescript ~6.0.x`, `@types/vscode ~1.100.0` tracks `engines.vscode`); zero runtime dependencies in Phase 0–1 (the spec allows `diff` and `jsonc-parser` later).
    3. **Commands**: each npm script with a one-line purpose; Node version from `.nvmrc`.
    4. **Layout**: the pure-vs-`vscode` module split and where each folder's responsibility lies (short; point to the spec's architecture tree for detail).
    5. **How work is done here**: the spec (`docs/superpowers/specs/`) is the authority → a plan per phase (`docs/superpowers/plans/`) → tasks executed test-first, one commit per task using the plan's commit message → the task's checkboxes ticked in the plan in a `docs(plan): mark Task N complete` commit.
    6. **How to continue the work**: read `docs/ROADMAP.md`; open the current phase's plan; done tasks have ticked boxes and matching commit subjects in `git log`; if the next phase has no plan yet, write one from the spec (with the Superpowers `writing-plans` skill when available) before writing code; check the spec's "To verify during implementation" list for open questions.
    7. **GitHub automation**: one line, "See Task 14 of the Phase 0–1 plan; this section is completed there."
  - `CLAUDE.md`: exactly two lines, `@AGENTS.md` and `Claude Code reads AGENTS.md through the import above; put project rules there, not here.`
  - `docs/ROADMAP.md`: a table of the spec's Phases 0–5 with columns Phase, Scope (one line from the spec), Plan (link or "not written yet"), Status. Phase 0–1 status: "in progress"; all others: "not started". Below it, a "Deferred manual checks" heading with the line "None yet."

- [x] **Step 4: Write the failing manifest test `test/unit/manifest.test.ts`**

```ts
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
test('identity', () => {
  expect(pkg.publisher).toBe('raboo'); expect(pkg.name).toBe('ai-autocomplete');
  expect(pkg.license).toBe('Apache-2.0'); expect(pkg.author.name).toBe('Elias Abacioglu');
  expect(pkg.enabledApiProposals).toBeUndefined();
  expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
});
test('NOTICE credits the original author', () => {
  expect(readFileSync('NOTICE', 'utf8')).toContain('Originally created by Elias Abacioglu');
});
test('bundle exists after build', () => { expect(readFileSync('dist/extension.js', 'utf8')).toContain('activate'); });
```

- [x] **Step 5: Run `npx vitest run test/unit/manifest.test.ts`.** Expected: `bundle exists after build` FAILS (no `src/extension.ts` and no build yet).

- [x] **Step 6: Create `src/extension.ts`**: `export function activate(context: vscode.ExtensionContext): void` (empty for now) and `export function deactivate(): void`. Then run `npm run build`.

- [x] **Step 7: Verify.** Run `npm run lint && npm run typecheck && npm test && npm run package`. Expected: all pass, and `ai-autocomplete-0.0.1.vsix` is produced. Then run `npx vsce ls --no-dependencies`. Expected: it lists `dist/extension.js`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md` and nothing from `src/`, `test/`, `docs/` or `node_modules/`. Delete the .vsix afterwards.

- [x] **Step 8: Write `.github/workflows/ci.yml`**
  - Triggers: `push` to `main`, `pull_request`, `workflow_dispatch`.
  - Top level: `permissions: contents: read`; `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`.
  - Job `check` (no `name:`) on `ubuntu-latest`, `actions/setup-node` with `node-version-file: .nvmrc` and npm cache. Actions pinned by SHA (Global Constraints).
  - Steps: `npm ci`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`, `npm run package`, then `actions/upload-artifact` for `*.vsix`.

- [x] **Step 9: Commit** with message `chore: scaffold AI Autocomplete extension (Apache-2.0)`. Include all files from this task plus `docs/`.

- [x] **Step 10: Do not create the GitHub repo or push.** That happens in the **Publish** section at the end of this plan, after the user says yes.

---

### Task 2: Shared types, settings, secrets, local-only check, log

**Files:**
- Create: `src/types.ts`, `src/log.ts`, `src/config/settings.ts`, `src/config/vscodeSettings.ts`, `src/config/secrets.ts`, `src/config/localOnly.ts`
- Modify: `package.json` (`contributes.configuration`)
- Test: `test/unit/settings.test.ts`, `test/unit/localOnly.test.ts`

**Interfaces:**
- Produces (`src/types.ts`):
  ```ts
  export type BackendKind = 'llamacpp' | 'openai' | 'mistral';
  export type HostFlavor = 'llamacpp'|'vllm'|'sglang'|'lmstudio'|'ollama'|'strata'|'deepseek'|'fireworks'|'together'|'openrouter'|'mistral'|'generic';
  export type FimMode = 'auto' | 'native' | 'template' | 'chat';
  export type FimTemplateId = 'qwen'|'codestral'|'deepseek'|'starcoder'|'codellama'|'codegemma'|'granite-code'|'granite4'|'seed-coder'|'mellum';
  export interface BackendConfig { id: string; kind: BackendKind; baseUrl: string; hostFlavor?: HostFlavor; fimModel?: string; nextEditModel?: string; fimMode: FimMode; headers: Record<string, string>; }
  export interface Sampling { temperature?: number; topP?: number; topK?: number; maxTokens: number; }
  export interface ContextFile { path: string; text: string; }
  export interface ModelOverrideBody { fimTemplate?: FimTemplateId; stop?: string[]; sampling?: Partial<Sampling>; extraBody?: Record<string, unknown>; }
  ```
- Produces (`settings.ts`):
  ```ts
  export interface Settings {
    backends: BackendConfig[];
    fim: { enabled: boolean; backendId?: string; debounceMs: number | null; multiline: 'auto'|'always'|'never'; maxTokens: number;
           prefixLines: number; suffixLines: number; extraContext: boolean; disableInLanguages: string[]; disableInFiles: string[]; skipMidWord: boolean };
    privacy: { localOnly: boolean };
    modelOverrides: Record<string, ModelOverrideBody>;
    debug: { logPrompts: boolean };
  }
  export interface Inspected<T> { defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T }
  export interface RawSettingsSource { inspect<T>(key: string): Inspected<T> | undefined }  // key without the 'aiAutocomplete.' prefix
  export function parseSettings(src: RawSettingsSource): { settings: Settings; problems: string[] }
  ```
- Produces (`localOnly.ts`): `isPrivateAddress(ip: string): boolean`, `isLocalEndpoint(baseUrl: string, lookup?: (host: string) => Promise<string[]>): Promise<boolean>`.
- Produces (`log.ts`): `interface Log { debug(m: string): void; info(m: string): void; warn(m: string): void; error(m: string, e?: unknown): void }`, `nullLog`, `createLog(ch: vscode.LogOutputChannel): Log`. `log.ts` uses `import type * as vscode from 'vscode'` only, so pure modules can import `Log` and `nullLog` and still run under vitest (the `vscode` module does not exist outside the extension host).
- Produces (`secrets.ts`): `class Secrets { constructor(s: vscode.SecretStorage); get(id: string): Promise<string|undefined>; set(id: string, v: string): Promise<void>; delete(id: string): Promise<void> }`. The storage key is `aiAutocomplete.apiKey.<id>`.
- Produces (`vscodeSettings.ts`): `readSettings(): { settings: Settings; problems: string[] }` (wraps `vscode.workspace.getConfiguration('aiAutocomplete')`).

- [x] **Step 1: Write failing tests `test/unit/settings.test.ts`.** Build a fake `RawSettingsSource` from a plain object.

```ts
test('machine-scoped backends ignore workspace values', () => {
  const { settings } = parseSettings(src({ backends: { globalValue: [B('local')], workspaceValue: [B('evil', 'https://evil.example')] } }));
  expect(settings.backends.map(b => b.id)).toEqual(['local']);
});
test('fim.backend may be chosen per workspace among configured ids', () => {
  const { settings } = parseSettings(src({ backends: { globalValue: [B('a'), B('b')] }, 'fim.backend': { globalValue: 'a', workspaceValue: 'b' } }));
  expect(settings.fim.backendId).toBe('b');
});
test('unknown fim.backend falls back to first backend with a problem', () => {
  const r = parseSettings(src({ backends: { globalValue: [B('a')] }, 'fim.backend': { workspaceValue: 'nope' } }));
  expect(r.settings.fim.backendId).toBe('a'); expect(r.problems[0]).toMatch(/nope/);
});
test('invalid backend entries are dropped with a problem', () => { /* missing baseUrl, bad kind, duplicate id → dropped; problems.length === 3 */ });
test('invalid override regex reported', () => { /* modelOverrides: { '(': {} } → problems contains "(" */ });
test('defaults', () => { /* fim.enabled true, multiline 'auto', maxTokens 128, prefixLines 200, suffixLines 60, debounceMs null, skipMidWord true,
  disableInLanguages ['plaintext'], disableInFiles ['**/.env','**/.env.*','**/*.pem','**/*.key'], localOnly false, fimMode 'auto', headers {} */ });
```

- [x] **Step 2: Write failing tests `test/unit/localOnly.test.ts`.**

```ts
test.each(['127.0.0.1','10.1.2.3','172.16.0.1','172.31.255.255','192.168.1.5','169.254.1.1','100.64.0.1','::1','fd12::1','fe80::1','::ffff:192.168.0.2'])('%s private', ip => expect(isPrivateAddress(ip)).toBe(true));
test.each(['8.8.8.8','172.32.0.1','100.128.0.1','2001:4860::8888','::ffff:8.8.8.8'])('%s public', ip => expect(isPrivateAddress(ip)).toBe(false));
test('localhost needs no DNS', async () => expect(await isLocalEndpoint('http://localhost:8012', () => { throw new Error('no dns'); })).toBe(true));
test('hostname resolving to LAN is local', async () => expect(await isLocalEndpoint('http://gpu-box:8000/v1', async () => ['192.168.1.20'])).toBe(true));
test('mixed resolution is not local', async () => expect(await isLocalEndpoint('http://x', async () => ['192.168.1.2', '8.8.8.8'])).toBe(false));
test('dns failure is not local', async () => expect(await isLocalEndpoint('http://nope.invalid', async () => { throw new Error('ENOTFOUND'); })).toBe(false));
test('codestral is not local', async () => expect(await isLocalEndpoint('https://codestral.mistral.ai', async () => ['104.18.1.1'])).toBe(false));
```

- [x] **Step 3: Run `npx vitest run test/unit/settings.test.ts test/unit/localOnly.test.ts`.** Expected: FAIL (modules missing).

- [x] **Step 4: Implement `src/types.ts`, `src/config/settings.ts` and `src/config/localOnly.ts`.**
  - Machine keys (`backends`, `modelOverrides`, `debug.logPrompts`) use `globalValue ?? defaultValue`.
  - Other keys use `workspaceFolderValue ?? workspaceValue ?? globalValue ?? defaultValue`.
  - Backend validation:
    - `id` matches `^[a-z0-9][a-z0-9-]*$` and is unique;
    - `kind` is one of the three kinds;
    - `baseUrl` parses with `new URL` and is http or https;
    - `fimMode` defaults to `'auto'`, `headers` to `{}`.
  - `localOnly`:
    - `localhost` and `*.localhost` are local with no DNS lookup;
    - IP literals (strip the `[]` from IPv6) are range-checked;
    - any other host uses `lookup`, defaulting to `dns.promises.lookup(host, { all: true })`, and every address must be private;
    - a thrown error counts as not local.
  - Private ranges: v4 `127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10`; v6 `::1, fc00::/7, fe80::/10`, and v4-mapped `::ffff:a.b.c.d` checks the embedded v4 address.

- [x] **Step 5: Run the tests.** Expected: PASS.

- [x] **Step 6: Implement `log.ts`, `secrets.ts` and `vscodeSettings.ts`, and add `contributes.configuration` to `package.json`.**
  - Schema entries, exact keys, defaults as in Step 1, with these scopes:
    - `backends`, `modelOverrides`, `debug.logPrompts`: `"scope": "machine"`;
    - everything else: `"scope": "resource"`.
  - `backends` item schema:
    - required `id`, `kind`, `baseUrl`;
    - `kind` enum `llamacpp|openai|mistral`;
    - `hostFlavor` enum (the `HostFlavor` list);
    - `fimMode` enum `auto|native|template|chat`;
    - `fimModel`, `nextEditModel` are strings; `headers` is an object of strings.
  - Every setting gets a `markdownDescription`. The `backends` description includes llama.cpp and Codestral JSON examples.

- [x] **Step 7: Verify.** Run `npm run lint && npm run typecheck && npm test`. Expected: PASS.

- [x] **Step 8: Commit** with message `feat: settings, secrets and local-only endpoint check`.

---

### Task 3: HTTP, SSE parsing, error classification, backoff

**Files:**
- Create: `src/backends/http.ts`, `src/backends/sse.ts`, `src/backends/backoff.ts`
- Test: `test/unit/sse.test.ts`, `test/unit/backoff.test.ts`, `test/unit/http.test.ts`
- Reference: Kilo `packages/kilo-vscode/src/services/autocomplete/ErrorBackoff.ts` (find it via `gh search code --repo Kilo-Org/kilocode ErrorBackoff`). Add attribution if adapted.

**Interfaces:**
- Produces:
  ```ts
  export class HttpError extends Error { constructor(readonly status: number, readonly bodyText: string, readonly url: string) }
  export interface PostOptions { headers?: Record<string, string>; signal: AbortSignal; timeoutMs: number }
  export function postJson(url: string, body: unknown, o: PostOptions): Promise<Response>   // non-2xx → throws HttpError (body text truncated to 500 chars)
  export function joinUrl(base: string, path: string): string
  export type ErrorClass = { kind: 'abort' } | { kind: 'http'; status: number } | { kind: 'network' };
  export function classifyError(err: unknown): ErrorClass
  export function parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string>        // yields each event's data; ends on "[DONE]"
  export class ErrorBackoff { constructor(now?: () => number); canRequest(): boolean; recordSuccess(): void; recordFailure(e: ErrorClass): void;
                              state(): { kind: 'ok' } | { kind: 'backoff'; until: number } | { kind: 'fatal'; status: number }; reset(): void }
  ```

- [x] **Step 1: Write failing tests.**
  - `sse.test.ts` (feed a `ReadableStream` built from string chunks):
    - `splits events across chunk boundaries` (`'data: {"a"'` + `':1}\n\n'` gives `['{"a":1}']`);
    - `handles CRLF`;
    - `ignores comment lines starting with ":"`;
    - `joins multi-line data with \n`;
    - `stops at [DONE]` (data after it is not yielded);
    - `flushes a final event without a trailing blank line`.
  - `http.test.ts`:
    - `joinUrl('http://h:8000/v1/', '/completions') === 'http://h:8000/v1/completions'` and `joinUrl('http://h', 'infill') === 'http://h/infill'`;
    - `classifyError(new DOMException('x','AbortError'))` gives `{kind:'abort'}`;
    - `classifyError(new HttpError(429,'',''))` gives `{kind:'http',status:429}`;
    - `classifyError(new TypeError('fetch failed'))` gives `{kind:'network'}`;
    - a `postJson` against a `node:http` server returning 500 rejects with `HttpError` status 500;
    - a `postJson` with `timeoutMs: 50` against a server that never answers rejects, and `classifyError` gives `network` (a timeout is a backend failure; ruling during execution);
    - a `postJson` whose caller `AbortController` is aborted rejects, and `classifyError` gives `abort`.
  - `backoff.test.ts` (fake `now`):

```ts
test('401/402/403 are fatal until reset', () => { b.recordFailure({kind:'http',status:401}); expect(b.canRequest()).toBe(false); expect(b.state()).toEqual({kind:'fatal',status:401}); b.reset(); expect(b.canRequest()).toBe(true); });
test('429 backs off exponentially 2s→120s cap', () => { /* until deltas: 2000, 4000, 8000, 16000 then reset by success; after many: max 120000 */ });
test('network errors back off', () => { b.recordFailure({kind:'network'}); expect(b.state()).toEqual({kind:'backoff', until: t0 + 2000}); });
test('circuit opens for 5 min after 5 consecutive failures', () => { /* 5 × 500 → until === now + 300000 */ });
test('abort never counts', () => { b.recordFailure({kind:'abort'}); expect(b.state()).toEqual({kind:'ok'}); });
test('canRequest true again after until passes', () => {});
```

- [x] **Step 2: Run the tests.** Expected: FAIL.

- [x] **Step 3: Implement the three modules.**
  - `postJson`:
    - uses global `fetch` with `AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs)])`;
    - sets the header `content-type: application/json`.
  - `classifyError`:
    - `name === 'AbortError'` gives `abort` (user cancellation); `name === 'TimeoutError'` gives `network`, so a hung backend backs off;
    - an `HttpError` gives `http`;
    - anything else gives `network`.
  - Backoff values: base 2000 ms, factor 2, cap 120000 ms; after 5 consecutive failures the circuit opens for 300000 ms.

- [x] **Step 4: Run the tests.** Expected: PASS.

- [x] **Step 5: Commit** with message `feat: http/sse helpers and error backoff`.

---

### Task 4: FIM templates and model presets

**Files:**
- Create: `src/models/templates.ts`, `src/models/presets.ts`
- Modify: `THIRD_PARTY_NOTICES.md` (Continue entry, Apache-2.0)
- Test: `test/unit/templates.test.ts`, `test/unit/presets.test.ts`
- Reference: Continue `core/autocomplete/templating/AutocompleteTemplate.ts`. Note that this plan deliberately departs from it: DeepSeek does not stop on `"//"`, there is no global `"/src/"` stop, and Seed-Coder is suffix-first per its model card.

**Interfaces:**
- Consumes: `FimTemplateId`, `ContextFile`, `Sampling`, `ModelOverrideBody` from `src/types.ts`.
- Produces:
  ```ts
  export interface TemplateInput { prefix: string; suffix: string; filePath: string; repoName: string; extra: ContextFile[] }
  export interface FimTemplate { id: FimTemplateId; suffixFirst: boolean; stop: string[]; render(i: TemplateInput): string }
  export const TEMPLATES: Record<FimTemplateId, FimTemplate>;
  export interface ResolvedPreset { id: string; fimTemplate?: FimTemplateId; suffixFirst: boolean; stop: string[]; sampling: Sampling; extraBody: Record<string, unknown> }
  export function resolvePreset(modelId: string, overrides: Record<string, ModelOverrideBody>): ResolvedPreset
  ```

- [ ] **Step 1: Write failing `templates.test.ts`.** There is one `render` and `stop` assertion per template with input `{prefix:'P', suffix:'S', filePath:'a.ts', repoName:'r', extra:[]}`; the exact strings are below (copy them verbatim). Add one repo-level case for qwen and codestral with `extra: [{path:'b.ts', text:'B'}]`.

| id | render (no extra) | stop | suffixFirst |
|---|---|---|---|
| qwen | `<\|fim_prefix\|>P<\|fim_suffix\|>S<\|fim_middle\|>` | `<\|endoftext\|>` `<\|fim_prefix\|>` `<\|fim_middle\|>` `<\|fim_suffix\|>` `<\|fim_pad\|>` `<\|repo_name\|>` `<\|file_sep\|>` `<\|im_start\|>` `<\|im_end\|>` | false |
| codestral | `[SUFFIX]S[PREFIX]P` | `[PREFIX]` `[SUFFIX]` `</s>` `\n+++++ ` | true |
| deepseek | `<｜fim▁begin｜>P<｜fim▁hole｜>S<｜fim▁end｜>` | `<｜fim▁begin｜>` `<｜fim▁hole｜>` `<｜fim▁end｜>` `<｜end▁of▁sentence｜>` | false |
| starcoder | `<fim_prefix>P<fim_suffix>S<fim_middle>` | `<fim_prefix>` `<fim_suffix>` `<fim_middle>` `<file_sep>` `<\|endoftext\|>` | false |
| codellama | `<PRE> P <SUF>S <MID>` | `<PRE>` `<SUF>` `<MID>` `<EOT>` | false |
| codegemma | `<\|fim_prefix\|>P<\|fim_suffix\|>S<\|fim_middle\|>` | `<\|fim_prefix\|>` `<\|fim_suffix\|>` `<\|fim_middle\|>` `<\|file_separator\|>` `<end_of_turn>` `<eos>` | false |
| granite-code | `<fim_prefix>P<fim_suffix>S<fim_middle>` | `<\|endoftext\|>` `<fim_prefix>` `<fim_suffix>` `<fim_middle>` | false |
| granite4 | `<\|fim_prefix\|>P<\|fim_suffix\|>S<\|fim_middle\|>` | `<\|end_of_text\|>` `<\|fim_prefix\|>` `<\|fim_middle\|>` `<\|fim_suffix\|>` `<\|fim_pad\|>` | false |
| seed-coder | `<[fim-suffix]>S<[fim-prefix]>P<[fim-middle]>` | `<[end▁of▁sentence]>` `<[fim-suffix]>` `<[fim-prefix]>` `<[fim-middle]>` `<[PAD▁TOKEN]>` `<[SEP▁TOKEN]>` `<[begin▁of▁sentence]>` | true |
| mellum | `<fim_suffix>S<fim_prefix>P<fim_middle>` | `<\|endoftext\|>` `<filename>` `<fim_prefix>` `<fim_suffix>` `<fim_middle>` `<fim_pad>` | true |

How repo-level context (extra files) is rendered:
- **qwen**: `<|repo_name|>r\n<|file_sep|>b.ts\nB\n<|file_sep|>a.ts\n<|fim_prefix|>P<|fim_suffix|>S<|fim_middle|>`.
- **codestral**: `[SUFFIX]S[PREFIX]+++++ b.ts\nB\n\n+++++ a.ts\nP`.
- **mellum**: `<filename>b.ts\nB\n` before `<fim_suffix>`. Check this against the Mellum-4b-base model card while implementing and adjust if the card differs.
- **All other templates** ignore `extra`.

- [ ] **Step 2: Write failing `presets.test.ts`.**

```ts
test.each([
  ['qwen2.5-coder-7b-instruct-q8_0', 'qwen-coder', 'qwen'], ['Qwen3-Coder-30B-A3B', 'qwen-coder', 'qwen'],
  ['codestral-latest', 'codestral', 'codestral'], ['deepseek-coder-v2-lite-base', 'deepseek-coder', 'deepseek'],
  ['starcoder2-7b', 'starcoder', 'starcoder'], ['codellama-7b', 'codellama', 'codellama'], ['codegemma-2b', 'codegemma', 'codegemma'],
  ['granite-8b-code-base', 'granite-code', 'granite-code'], ['granite-4.1-3b', 'granite4', 'granite4'],
  ['Seed-Coder-8B-Base', 'seed-coder', 'seed-coder'], ['Mellum-4b-base', 'mellum', 'mellum'],
])('%s → %s', (model, id, tpl) => { const p = resolvePreset(model, {}); expect(p.id).toBe(id); expect(p.fimTemplate).toBe(tpl); });
test('general Qwen gets no FIM template', () => expect(resolvePreset('Qwen3.8-Flash-Next', {}).fimTemplate).toBeUndefined());
test('codestral sampling omits topP', () => expect(resolvePreset('codestral-latest', {}).sampling).toEqual({ temperature: 0.2, maxTokens: 128 }));
test('coder default sampling', () => expect(resolvePreset('qwen2.5-coder-3b', {}).sampling).toEqual({ temperature: 0.1, topP: 0.95, topK: 40, maxTokens: 128 }));
test('overrides merge in order; stops are appended uniquely', () => {
  const p = resolvePreset('qwen2.5-coder', { 'qwen': { sampling: { temperature: 0 } }, 'coder': { stop: ['\n\n\n', '<|endoftext|>'], extraBody: { min_p: 0.05 } } });
  expect(p.sampling.temperature).toBe(0); expect(p.stop.filter(s => s === '<|endoftext|>')).toHaveLength(1);
  expect(p.stop).toContain('\n\n\n'); expect(p.extraBody).toEqual({ min_p: 0.05 });
});
test('override can set a template on an unknown model', () => expect(resolvePreset('my-ft', { '^my-ft$': { fimTemplate: 'qwen' } }).fimTemplate).toBe('qwen'));
test('invalid override regex is skipped', () => expect(() => resolvePreset('x', { '(': {} })).not.toThrow());
```

- [ ] **Step 3: Run the tests.** Expected: FAIL.

- [ ] **Step 4: Implement both modules.**
  - Presets are checked in this order; the first match wins (regexes are case-insensitive):

    | Preset | Regex |
    |---|---|
    | qwen-coder | `/qwen[\d.]*[-_ ]?coder\|codeqwen/` |
    | codestral | `/codestral/` |
    | deepseek-coder | `/deepseek[-_ ]?coder/` |
    | starcoder | `/starcoder/` |
    | codellama | `/code[-_ ]?llama/` |
    | codegemma | `/codegemma/` |
    | granite-code | `/granite.*code/` |
    | granite4 | `/granite[-_ ]?4/` |
    | seed-coder | `/seed[-_ ]?coder/` |
    | mellum | `/mellum/` |
    | generic | `/.*/`, no template |

  - Sampling: `{temperature: 0.1, topP: 0.95, topK: 40, maxTokens: 128}` for every preset except codestral, which uses `{temperature: 0.2, maxTokens: 128}`.
  - `resolvePreset` output:
    - `stop` = template stops plus `'\n\n\n'`;
    - `suffixFirst` comes from the template, false when there is none.
  - Then apply each override whose key (`new RegExp(key,'i')`) matches the model, in object order:
    - `sampling` is shallow-merged;
    - `stop` is appended, de-duplicated;
    - `extraBody` is shallow-merged;
    - `fimTemplate` replaces the template, and recomputes the template stops and `suffixFirst`.

- [ ] **Step 5: Run the tests.** Expected: PASS. Add the Continue entry to `THIRD_PARTY_NOTICES.md` if template code was adapted.

- [ ] **Step 6: Commit** with message `feat: FIM templates and model presets`.

---

### Task 5: Backend contract and llama.cpp backend

**Files:**
- Create: `src/backends/types.ts`, `src/backends/llamacpp.ts`, `test/unit/helpers/mockHttp.ts`
- Test: `test/unit/llamacpp.test.ts`

**Interfaces:**
- Consumes: `postJson`, `parseSse`, `joinUrl` (Task 3); `BackendConfig`, `Sampling`, `ContextFile` (Task 2).
- Produces:
  ```ts
  export type FimPayload =
    | { route: 'native'; prefix: string; suffix: string; extra: ContextFile[]; filePath: string; repoName: string }
    | { route: 'template'; prompt: string };
  export interface FimRequest { model?: string; payload: FimPayload; stop: string[]; sampling: Sampling; timeMaxPredictMs?: number;
                                extraBody: Record<string, unknown>; signal: AbortSignal; timeoutMs: number }
  export type ApiKeyProvider = () => Promise<string | undefined>;
  export interface FimBackend { readonly config: BackendConfig; supportsNativeFim(): boolean; detectModel(signal: AbortSignal): Promise<string | undefined>; streamFim(req: FimRequest): AsyncIterable<string> }
  export class LlamaCppBackend implements FimBackend { constructor(config: BackendConfig, apiKey: ApiKeyProvider) }
  // test helper
  export function startMockHttp(handler: (req: { url: string; body: any }) => { status?: number; sse?: string[]; json?: unknown }): Promise<{ url: string; requests: { url: string; body: any }[]; close(): Promise<void> }>
  ```

- [ ] **Step 1: Write the `mockHttp` helper**, using `node:http` on port 0. When `sse` is set, it sends each string as `data: <s>\n\n` with `content-type: text/event-stream`.

- [ ] **Step 2: Write failing `llamacpp.test.ts`.**

```ts
test('native route posts /infill with llama.cpp fields and streams content', async () => {
  // mock: /infill → sse ['{"content":"ret"}', '{"content":"urn a"}', '{"content":"","stop":true}']
  const out = await collect(b.streamFim(req({ payload: { route:'native', prefix:'P', suffix:'S', extra:[{path:'x.ts', text:'X'}], filePath:'a.ts', repoName:'r' },
    stop:['\n\n\n'], sampling:{ temperature:0.1, topP:0.95, topK:40, maxTokens:64 }, timeMaxPredictMs:500, extraBody:{ min_p:0.05 } })));
  expect(out.join('')).toBe('return a');
  expect(m.requests[0].url).toBe('/infill');
  expect(m.requests[0].body).toMatchObject({ input_prefix:'P', input_suffix:'S', input_extra:[{ filename:'x.ts', text:'X' }], prompt:'',
    n_predict:64, temperature:0.1, top_p:0.95, top_k:40, stop:['\n\n\n'], stream:true, cache_prompt:true, t_max_predict_ms:500, min_p:0.05 });
});
test('template route posts /completion with prompt', async () => { /* url '/completion', body.prompt === rendered string, no input_prefix */ });
test('sends Bearer key when set', async () => { /* header authorization === 'Bearer k' */ });
test('detectModel reads /props model_alias, else basename of model_path without .gguf', async () => {});
test('supportsNativeFim is true', () => {});
test('HTTP 503 surfaces as HttpError', async () => {});
```

- [ ] **Step 3: Run the tests.** Expected: FAIL.

- [ ] **Step 4: Implement `types.ts` and `LlamaCppBackend`.**
  - Field mapping: `topK` → `top_k`, `topP` → `top_p`, `maxTokens` → `n_predict`. Omit undefined fields. Include `model` only if set.
  - Spread `extraBody` last.
  - Stream parsing: yield `content` while `stop !== true`.
  - `detectModel` uses `GET /props` with a 2 s timeout and returns `undefined` on any error.

- [ ] **Step 5: Run the tests.** Expected: PASS.

- [ ] **Step 6: Commit** with message `feat: llama.cpp FIM backend (/infill, /completion)`.

---

### Task 6: OpenAI-compatible backend and host-flavor inference

**Files:**
- Create: `src/backends/openaiCompat.ts`, `src/backends/hostFlavor.ts`
- Test: `test/unit/openaiCompat.test.ts`, `test/unit/hostFlavor.test.ts`

**Interfaces:**
- Consumes: the Task 5 contract.
- Produces:
  - `inferHostFlavor(cfg: BackendConfig): HostFlavor`;
  - `isHostedFlavor(f: HostFlavor): boolean`, false for `llamacpp, vllm, sglang, lmstudio, ollama, strata`;
  - `class OpenAiCompatBackend implements FimBackend { constructor(config: BackendConfig, apiKey: ApiKeyProvider) }`.

- [ ] **Step 1: Write failing tests.**
  - `hostFlavor.test.ts`:
    - an explicit `hostFlavor` wins;
    - `api.deepseek.com` → `deepseek`;
    - `openrouter.ai` → `openrouter`;
    - `api.fireworks.ai` → `fireworks`;
    - `api.together.xyz` → `together`;
    - port `11434` → `ollama`;
    - port `1234` → `lmstudio`;
    - kind `llamacpp` → `llamacpp`;
    - kind `mistral` → `mistral`;
    - otherwise `generic`.
  - `openaiCompat.test.ts`:

```ts
test('template route posts /completions with prompt and parses choices[0].text', async () => {
  // baseUrl `${m.url}/v1`; mock /v1/completions → sse ['{"choices":[{"text":"a"}]}','{"choices":[{"text":"b"}]}','[DONE]']
  expect((await collect(b.streamFim(templateReq))).join('')).toBe('ab');
  expect(m.requests[0].body).toMatchObject({ model:'m', prompt:'<tpl>', max_tokens:128, temperature:0.1, top_p:0.95, stream:true });
});
test('native route sends suffix', async () => { /* body.prompt === prefix, body.suffix === suffix */ });
test('top_k only for self-hosted flavors', async () => { /* generic → no top_k; vllm → top_k:40 */ });
test('hosted flavors cap stop list at 4', async () => { /* deepseek with 6 stops → body.stop.length === 4 (first four) */ });
test('supportsNativeFim only for deepseek and ollama', () => {});
```

- [ ] **Step 2: Run the tests.** Expected: FAIL.

- [ ] **Step 3: Implement both modules.**
  - Endpoint: `joinUrl(baseUrl, 'completions')` (the baseUrl contains `/v1`).
  - Sampling: `top_k` only when `!isHostedFlavor`.
  - Send `Authorization: Bearer` when a key exists, and merge `config.headers`.
  - `detectModel` uses `GET models` and returns `data[0].id`, or `undefined` if there is more than one model or any error.

- [ ] **Step 4: Run the tests.** Expected: PASS.

- [ ] **Step 5: Commit** with message `feat: OpenAI-compatible completions backend`.

---

### Task 7: Mistral Codestral backend and backend factory

**Files:**
- Create: `src/backends/mistral.ts`, `src/backends/index.ts`
- Test: `test/unit/mistral.test.ts`
- Reference: Kilo `packages/kilo-gateway/src/mistral-fim-endpoint.ts` (endpoint fallback).

**Interfaces:**
- Produces:
  - `class MissingApiKeyError extends Error { constructor(readonly backendId: string) }`;
  - `class MistralBackend implements FimBackend`;
  - `createBackend(cfg: BackendConfig, apiKey: ApiKeyProvider): FimBackend`, which switches on `cfg.kind`.

- [ ] **Step 1: Write failing `mistral.test.ts`.**

```ts
test('posts /v1/fim/completions without top_p, with codestral multi-file prefix', async () => {
  // payload native with extra [{path:'b.ts',text:'B'}], filePath 'a.ts'
  expect(m.requests[0].url).toBe('/v1/fim/completions');
  expect(m.requests[0].body).toMatchObject({ model:'codestral-latest', prompt:'+++++ b.ts\nB\n\n+++++ a.ts\nP', suffix:'S', max_tokens:128, temperature:0.2, stream:true });
  expect(m.requests[0].body.top_p).toBeUndefined();
});
test('parses delta.content, message.content or text defensively', async () => { /* three SSE shapes → concatenated */ });
test('no key → MissingApiKeyError and no request', async () => {});
test('401 on codestral host retries api host once and remembers it', async () => {
  // constructor option resolveBase maps 'https://codestral.mistral.ai' → mockA (401) and 'https://api.mistral.ai' → mockB (ok);
  // expect one request on each mock, output from mockB, and a second streamFim call going straight to mockB
});
test('template route is rejected', async () => { /* throws Error /native only/ */ });
```

- [ ] **Step 2: Run the tests.** Expected: FAIL.

- [ ] **Step 3: Implement `MistralBackend`.**
  - Constructor: `constructor(config, apiKey, opts?: { resolveBase?: (base: string) => string })`. The test seam maps the real hostnames to mock URLs.
  - The default `baseUrl`, if empty, is `https://codestral.mistral.ai`.
  - Endpoint fallback runs only when the host is `codestral.mistral.ai` or `api.mistral.ai`: on a 401/403, retry once on the other host. The winning host is kept in memory for this instance.
  - `supportsNativeFim()` returns true.
  - `detectModel` returns `cfg.fimModel ?? 'codestral-latest'`.
  - Add the Kilo MIT entry to `THIRD_PARTY_NOTICES.md` if code was adapted.

- [ ] **Step 4: Run the tests.** Expected: PASS.

- [ ] **Step 5: Commit** with message `feat: Mistral Codestral FIM backend with endpoint fallback`.

---

### Task 8: Context window and extra-context ring buffer

**Files:**
- Create: `src/completion/context.ts`, `src/completion/contextTracker.ts`
- Test: `test/unit/context.test.ts`
- Reference: llama.vscode `src/extra-context.ts` (or the equivalent ring-buffer file; locate it with `gh api repos/ggml-org/llama.vscode/contents/src`).

**Interfaces:**
- Produces:
  ```ts
  export interface FimWindowOptions { prefixLines: number; suffixLines: number; maxPrefixChars: number; maxSuffixChars: number }
  export const DEFAULT_WINDOW: Omit<FimWindowOptions, 'prefixLines' | 'suffixLines'> = { maxPrefixChars: 8000, maxSuffixChars: 2500 };
  export function buildFimWindow(text: string, offset: number, o: FimWindowOptions): { prefix: string; suffix: string; startLine: number; endLine: number }
  export class ExtraContextRing {
    constructor(o?: { maxChunks?: number /* 16 */; chunkLines?: number /* 64 */ });
    add(path: string, lines: string[], centerLine: number): void;
    pick(exclude: { path: string; startLine: number; endLine: number }, budgetChars: number): ContextFile[];
  }
  export class ContextTracker implements vscode.Disposable { constructor(ring: ExtraContextRing, isExcluded: (doc: vscode.TextDocument) => boolean) }
  ```

- [ ] **Step 1: Write failing `context.test.ts`.**

```ts
test('takes N lines before and after the cursor', () => { /* 500-line doc, cursor line 250 col 3, prefixLines 200, suffixLines 60 → prefix starts at line 50 col 0, suffix ends at line 310 */ });
test('caps a 1 MB single line', () => { const t = 'x'.repeat(1_000_000); const w = buildFimWindow(t, 500_000, { prefixLines: 200, suffixLines: 60, ...DEFAULT_WINDOW });
  expect(w.prefix.length).toBeLessThanOrEqual(8000); expect(w.suffix.length).toBeLessThanOrEqual(2500); });
test('char cap drops whole leading lines when possible', () => { /* prefix after cap starts at a line boundary when the cut point is not inside the cursor line */ });
test('ring keeps insertion order and evicts oldest beyond maxChunks', () => {});
test('ring replaces an overlapping chunk of the same file', () => { /* add(a, lines, 100) then add(a, lines, 110) → one chunk for a */ });
test('pick skips chunks overlapping the current window and respects budget', () => {});
test('pick output is stable across calls (cache-friendly order)', () => {});
```

- [ ] **Step 2: Run the tests.** Expected: FAIL.

- [ ] **Step 3: Implement `context.ts`.**
  - A chunk is `chunkLines` lines centred on `centerLine`, clamped to the document.
  - "Overlapping" means the same path and at least 50% line overlap.
  - `pick` returns chunks oldest-first, keeping order so the start of llama.cpp's prompt stays cache-friendly. Each chunk becomes `{ path: \`${path}\`, text }`.

- [ ] **Step 4: Run the tests.** Expected: PASS.

- [ ] **Step 5: Implement `ContextTracker`.**
  - Events: `onDidChangeActiveTextEditor`, `onDidSaveTextDocument`, and `onDidChangeTextEditorSelection` debounced to 1000 ms.
  - Each event calls `ring.add(workspace-relative path, lines, cursor line)`.
  - Skip documents whose scheme isn't `file`/`untitled`, and documents where `isExcluded` is true.
  - Integration coverage comes in Task 13.

- [ ] **Step 6: Commit** with message `feat: FIM context window and extra-context ring`.

---

### Task 9: Stream filters, multiline decision, postprocess

**Files:**
- Create: `src/completion/filters.ts`, `src/completion/postprocess.ts`
- Test: `test/unit/filters.test.ts`, `test/unit/postprocess.test.ts`
- Reference: Continue `core/autocomplete/filtering/streamTransforms/lineStream.ts`, `core/autocomplete/postprocessing/index.ts`, `core/autocomplete/classification/shouldCompleteMultiline.ts`; Kilo `classic-auto-complete/uselessSuggestionFilter.ts`.

**Interfaces:**
- Produces:
  ```ts
  export interface StreamFilterOptions { stop: string[]; multiline: boolean; maxLines: number /* 16 */; suffix: string }
  export class CompletionAccumulator { constructor(o: StreamFilterOptions); push(chunk: string): boolean /* true → stop streaming */; get text(): string /* '\n' line endings */ }
  export function shouldCompleteMultiline(mode: 'auto'|'always'|'never', linePrefix: string, lineSuffix: string, languageId: string): boolean
  export function levenshteinRatio(a: string, b: string): number   // distance / max(len)
  export interface PostCtx { linePrefix: string; lineSuffix: string; prevLine: string; suffix: string }
  export function postprocess(raw: string, c: PostCtx): string | undefined
  export function toInsertion(completion: string, lineSuffix: string): { insertText: string; replaceToEndOfLine: boolean }
  ```

- [ ] **Step 1: Write failing `filters.test.ts`.** One test per rule, applied in this order on the accumulated, `\r\n`-normalised text:
  1. `cuts at the earliest stop string` (`stop: ['<|endoftext|>']`, chunks `'ab<|end'`, `'oftext|>cd'` → text `'ab'`, push returns true);
  2. `single-line mode cuts at the first newline after content` (`'foo()\nbar'` → `'foo()'`);
  3. `maxLines` (20 lines in, maxLines 16 → 16 lines);
  4. `stops on 3 identical consecutive non-blank lines, keeping one`;
  5. `stops before a line that matches the next existing line` (suffix `'\n  return x;\n}'`, output `'a = 1;\n  return x;\n'` → `'a = 1;'`; also when the levenshteinRatio is < 0.1 and the trimmed line is ≥ 4 chars);
  6. `handles CRLF` (chunks `'a\r'`, `'\nb'` with multiline → `'a\nb'`; and the suffix-match rule works when the suffix uses `\r\n`).
  - Plus `shouldCompleteMultiline`:
    - `'always'` → true and `'never'` → false;
    - `auto`: a non-whitespace `lineSuffix` → false;
    - `auto`: a `linePrefix` inside a line comment (`//`, `#` for python/shell/yaml/ruby) → false;
    - `auto`: otherwise → true.

- [ ] **Step 2: Write failing `postprocess.test.ts`.**

```ts
test('blank → undefined', () => expect(postprocess('  \n ', ctx())).toBeUndefined());
test('strips code fences', () => expect(postprocess('```ts\nfoo()\n```', ctx())).toBe('foo()'));
test('trims trailing whitespace lines, keeps leading indentation', () => expect(postprocess('  x\n\n', ctx())).toBe('  x'));
test('drops a repeat of the previous line', () => expect(postprocess('const a = 1;', ctx({ prevLine: 'const a = 1;' }))).toBeUndefined());
test('drops text that just retypes the suffix', () => expect(postprocess('return x;', ctx({ suffix: '\n  return x;\n}' }))).toBeUndefined());
test('drops degenerate repetition (last 30 chars appear ≥3 times)', () => {});
test('toInsertion replaces rest of line when completion ends with it', () => expect(toInsertion('foo(a, b))', ')')).toEqual({ insertText: 'foo(a, b))', replaceToEndOfLine: true }));
test('toInsertion keeps rest of line otherwise', () => expect(toInsertion('foo', ' bar')).toEqual({ insertText: 'foo', replaceToEndOfLine: false }));
test('toInsertion closing-chars rest of line', () => expect(toInsertion('x[0])', ');')).toEqual({ insertText: 'x[0])', replaceToEndOfLine: false }));
```

Note on the last case: the rest of the line is `);` and the completion ends with `)`, not `);`. So `endsWith(restOfLine.trimEnd())` is false and the line is kept. The rule is exactly that: `replaceToEndOfLine = lineSuffix.trim() !== '' && insertText.trimEnd().endsWith(lineSuffix.trim())`.

- [ ] **Step 3: Run the tests.** Expected: FAIL.

- [ ] **Step 4: Implement both modules.** Postprocess steps run in the order the tests list. "Retypes the suffix" means: `t = raw.trim()`, `t.length >= 4` and `suffix.trimStart().startsWith(t)`.

- [ ] **Step 5: Run the tests.** Expected: PASS. Add attribution for anything adapted.

- [ ] **Step 6: Commit** with message `feat: streaming filters and completion postprocessing`.

---

### Task 10: Suggestion cache, debouncer, in-flight reuse

**Files:**
- Create: `src/completion/cache.ts`, `src/completion/scheduler.ts`
- Test: `test/unit/cache.test.ts`, `test/unit/scheduler.test.ts`
- Reference: Kilo `classic-auto-complete/inline-utils.ts` (`findMatchingSuggestion`) and `AutocompleteInlineCompletionProvider.ts` (debounce, `findCoveringPendingRequest`).

**Interfaces:**
- Produces:
  ```ts
  export class SuggestionCache { constructor(max?: number /* 50 */); add(uri: string, prefix: string, suffix: string, text: string): void; find(uri: string, prefix: string, suffix: string): string | undefined }
  export class Debouncer { constructor(o: { initialMs: number; minMs: number /* 50 */; maxMs: number /* 600 */; fixedMs: number | null; now?: () => number });
    wait(signal: AbortSignal): Promise<boolean>; recordLatency(ms: number): void; delayMs(): number }
  export class InFlight { find(uri: string, prefix: string, suffix: string): { prefix: string; result: Promise<string | undefined> } | undefined;
    add(uri: string, prefix: string, suffix: string, result: Promise<string | undefined>, ctl: AbortController): void; abortAll(uri: string): void }
  ```

- [ ] **Step 1: Write failing tests.**
  - `cache.test.ts`:
    - `exact match`;
    - `typed-through` (cached `P`→`'foo()'`, find `P+'fo'` → `'o()'`);
    - `typed-through fully consumed → undefined`;
    - `typed text diverging → undefined`;
    - `backspace` (cached `P+'ab'`→`'c'`, find `P+'a'` → `'bc'`);
    - `suffix must match`;
    - `empty result is cached as ''` (so the provider can skip without a request);
    - `per-uri isolation`;
    - `evicts oldest beyond max`.
  - `scheduler.test.ts` (vitest fake timers):
    - `first call fires immediately (leading edge)`;
    - `burst: only the last waiter resolves true after delay`;
    - `abort resolves false`;
    - `adaptive delay = clamp(avg of last 10 latencies, min, max)`;
    - `fixedMs overrides adaptive`;
    - `InFlight.find returns a request whose prefix is a prefix of the new one with same suffix`;
    - `abortAll aborts controllers for that uri only`.

- [ ] **Step 2: Run the tests.** Expected: FAIL.

- [ ] **Step 3: Implement both modules.** Leading edge: if `now - lastCall > delayMs()`, resolve true immediately; otherwise wait `delayMs()`, and any newer `wait` call supersedes older ones (which resolve false).

- [ ] **Step 4: Run the tests.** Expected: PASS.

- [ ] **Step 5: Commit** with message `feat: suggestion cache, adaptive debounce, in-flight reuse`.

---

### Task 11: Gate, route planning, FIM provider

**Files:**
- Create: `src/completion/gate.ts`, `src/completion/route.ts`, `src/completion/provider.ts`
- Test: `test/unit/gate.test.ts`, `test/unit/route.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–10.
- Produces:
  ```ts
  export interface GateInput { enabled: boolean; snoozedUntil: number; now: number; scheme: string; languageId: string; disabledLanguages: string[];
    fileExcluded: boolean; selections: number; hasSelectedCompletionInfo: boolean; lineSuffix: string; skipMidWord: boolean; invoked: boolean }
  export function gate(i: GateInput): { ok: true } | { ok: false; reason: string }
  export function planRoute(kind: BackendKind, supportsNative: boolean, preset: ResolvedPreset, mode: FimMode): 'native' | 'template' | 'unsupported'
  export function planInsertion(text: string, eol: '\n' | '\r\n'): string
  export interface StatusSink { set(state: 'idle' | 'loading' | 'error' | 'disabled' | 'snoozed', detail?: string): void }
  export interface FimDeps { getSettings(): Settings; getBackend(id: string): FimBackend | undefined; isLocal(baseUrl: string): Promise<boolean>;
    cache: SuggestionCache; debouncer: (backendId: string) => Debouncer; inflight: InFlight; ring: ExtraContextRing;
    backoff: (backendId: string) => ErrorBackoff; status: StatusSink; log: Log; snoozedUntil(): number }
  export class FimProvider implements vscode.InlineCompletionItemProvider { constructor(d: FimDeps) }
  ```

- [ ] **Step 1: Write failing `gate.test.ts`.** There is one test per rejection reason:
  - `disabled`;
  - `snoozed`;
  - `scheme` (allowed: `file`, `untitled`, `vscode-notebook-cell`, `vscode-remote`);
  - `language`;
  - `excluded file`;
  - `multi-cursor`;
  - `suggest widget`;
  - `mid-word`: `lineSuffix` starts with `[\p{L}\p{N}_]` and `!invoked` (with `invoked: true`, the mid-word rule is bypassed).
  - Plus an `ok` case.

- [ ] **Step 2: Write failing `route.test.ts`.**

```ts
test('llamacpp auto → native /infill for prefix-first models', () => expect(planRoute('llamacpp', true, P('qwen'), 'auto')).toBe('native'));
test('llamacpp auto → template for suffix-first models', () => expect(planRoute('llamacpp', true, P('mellum'), 'auto')).toBe('template'));
test('openai auto → native when supported, else template, else unsupported', () => {});
test('mistral auto → native', () => {});
test('mode template without preset template → unsupported', () => {});
test('mode chat → unsupported in v0.1', () => {});
test('planInsertion converts to CRLF', () => expect(planInsertion('a\nb', '\r\n')).toBe('a\r\nb'));
```

- [ ] **Step 3: Run the tests.** Expected: FAIL. Then implement `gate.ts` and `route.ts`, and run again. Expected: PASS.

- [ ] **Step 4: Implement `FimProvider.provideInlineCompletionItems(doc, pos, ctx, token)`.** It follows the steps below. All failures are caught; it never throws.
  1. Read settings and run `gate`:
     - `fileExcluded` is computed with `vscode.languages.match({ pattern }, doc) > 0` for each glob in `disableInFiles`;
     - `selections` comes from `vscode.window.activeTextEditor`;
     - `hasSelectedCompletionInfo` is `!!ctx.selectedCompletionInfo`;
     - `invoked` is `ctx.triggerKind === Invoke`;
     - if the gate fails, return `[]`.
  2. Resolve the backend from `fim.backendId`. If it's missing, set status `error` ("No backend configured") and return.
  3. If `localOnly` is on and `!await isLocal(baseUrl)`, set status `error` ("Blocked: backend is not local"), log once per backend, and return.
  4. If `!backoff.canRequest()`, return `[]`.
  5. Context: `buildFimWindow` with the settings' line counts and `DEFAULT_WINDOW`. The extra context is `ring.pick(...)` within 6000 chars when `fim.extraContext` is on.
  6. Cache: `cache.find(uri, prefix, suffix)` returns '' (return `[]`) or a hit (build the item). Otherwise use `inflight.find` to join a pending request, and derive the result from the text typed since.
  7. `await debouncer(backendId).wait(signal)`, with `signal` linked to `token.onCancellationRequested`. If it returns false, return `[]`.
  8. Model: `backend.config.fimModel ?? await backend.detectModel(signal)`, memoised per backend. Then `preset = resolvePreset(model ?? '', settings.modelOverrides)` and `route = planRoute(...)`. If unsupported, log once ("model X has no FIM route; chat FIM arrives in v0.2") and return.
  9. Request:
     - `multiline = shouldCompleteMultiline(...)`;
     - `maxTokens = multiline ? fim.maxTokens : Math.min(fim.maxTokens, 48)` overrides `preset.sampling.maxTokens`;
     - the payload is `native` (prefix/suffix/extra/filePath/repoName = workspace folder name) or `template` (`TEMPLATES[id].render(...)`);
     - `timeMaxPredictMs: 500`, `timeoutMs: 5000`.
     - Register it in `inflight` after aborting older requests for this uri.
     - Set status `loading`.
  10. Stream through `CompletionAccumulator`. Stop early when `push` returns true, and abort the request.
  11. Finish:
      - `postprocess`, then `toInsertion` and `planInsertion` (the document's EOL);
      - cache the result (even an empty one);
      - `debouncer.recordLatency`, `backoff.recordSuccess()`, status `idle`.
  12. Errors: `classifyError`.
      - `abort` → return `[]` silently.
      - `MissingApiKeyError` → status `error` ("Set API key for <id>").
      - Anything else → `backoff.recordFailure`, status `error` with the status code/message, and log at warn only when the backoff state changes.
  13. Item: `new InlineCompletionItem(insertText, new Range(pos, replaceToEndOfLine ? lineEnd : pos), { command: 'aiAutocomplete.accepted', title: '', arguments: [backendId] })`.

- [ ] **Step 5: Verify.** Run `npm run lint && npm run typecheck && npm test`. Expected: PASS. The provider itself is exercised in Task 13.

- [ ] **Step 6: Commit** with message `feat: FIM inline completion provider`.

---

### Task 12: Status bar, commands, activation wiring

**Files:**
- Create: `src/ui/statusBar.ts`, `src/ui/commands.ts`
- Modify: `src/extension.ts`, `package.json` (`contributes.commands`)

**Interfaces:**
- Consumes: `FimProvider`, `FimDeps`, `readSettings`, `Secrets`, `createBackend`, `isLocalEndpoint`, `ContextTracker`.
- Produces:
  - `class StatusBar implements StatusSink, vscode.Disposable { current(): string; setLocalLock(on: boolean): void; setStats(accepted: number): void }`;
  - `activate` returns `{ status: StatusBar; secrets: Secrets }` for integration tests.

- [ ] **Step 1: Implement `StatusBar`.**
  - Text per state:
    - idle `$(sparkle) AI`
    - loading `$(loading~spin) AI`
    - error `$(error) AI` (tooltip = detail)
    - disabled `$(circle-slash) AI`
    - snoozed `$(clock) AI`
  - Prefix `$(lock) ` when `localOnly` is on.
  - Clicking it runs `aiAutocomplete.menu`.

- [ ] **Step 2: Implement the commands** (all with category `AI Autocomplete` in `package.json`):

  | Command | Behaviour |
  |---|---|
  | `aiAutocomplete.menu` | Quick pick of the commands below |
  | `aiAutocomplete.toggle` | Flips `fim.enabled` in the Global target |
  | `aiAutocomplete.snooze` | Quick pick of 15 min / 1 h / until restart; stored in `globalState` (`snoozedUntil`) or in memory |
  | `aiAutocomplete.selectBackend` | Pick a backend id and write `fim.backend` to the Workspace target when a folder is open, otherwise Global |
  | `aiAutocomplete.setApiKey` | Pick a backend, then a password input box, then `Secrets.set` |
  | `aiAutocomplete.showLog` | Shows the log channel |
  | `aiAutocomplete.about` | Opens the `NOTICE` file from `context.extensionUri` in a read-only text editor |
  | `aiAutocomplete.accepted` | Internal; increments the acceptance counter shown in the tooltip; hidden from the palette via `menus.commandPalette` `when: false` |

- [ ] **Step 3: Wire `activate`.**
  1. Create the log channel with `createOutputChannel('AI Autocomplete', { log: true })`.
  2. Create `Secrets`; read settings and show `problems` once in a warning message with an "Open Settings" button.
  3. Build backends with `createBackend` and the secrets-backed key provider; rebuild them on `onDidChangeConfiguration('aiAutocomplete')`.
  4. Keep per-backend `ErrorBackoff` and `Debouncer` maps.
     - The `Debouncer` initial delay is 75 ms when the backend is local (`isLocalEndpoint`, cached for 60 s), otherwise 250 ms.
     - On a settings change, reset the backoff and clear the caches.
  5. Create the ring and `ContextTracker`, `SuggestionCache`, `InFlight`, and the `StatusBar`.
  6. Register `FimProvider` with `vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider)`.
  7. When no backends are configured, show an info message with the "Open Settings" action, once per session.

- [ ] **Step 4: Manual smoke test — deferred to the user.** Subagents skip this step (it installs llama.cpp and opens a GUI) and say so in their report; the controller lists it under "Deferred manual checks" in `docs/ROADMAP.md`. The steps, for the user:
  1. `npm run build`, then launch the Extension Development Host (`code --extensionDevelopmentPath=$PWD`).
  2. Run `llama-server --fim-qwen-1.5b-default --port 8012` (needs `brew install llama.cpp`).
  3. Set user settings: `"aiAutocomplete.backends": [{"id":"local","kind":"llamacpp","baseUrl":"http://127.0.0.1:8012"}]`.
  4. Expected:
     - typing in a `.ts` file shows ghost text;
     - the status bar goes idle → loading → idle;
     - the "AI Autocomplete" log shows timings;
     - stopping llama-server shows the `$(error)` state, with no popups.

- [ ] **Step 5: Verify and commit.** Run `npm run lint && npm run typecheck && npm test && npm run build`, then commit with message `feat: status bar, commands and activation`.

---

### Task 13: Integration tests and getting-started docs

**Files:**
- Create: `tsconfig.integration.json`, `.vscode-test.mjs`, `test/integration/mockServer.ts`, `test/integration/fim.test.ts`
- Modify: `package.json` (devDeps `@vscode/test-cli ^0.0.15`, `@vscode/test-electron ^3.1.0`, `mocha`, `@types/mocha`; script `test:integration`), `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consumes: the `activate()` return value `{ status, secrets }`.

- [ ] **Step 1: Set up the integration harness.**
  - `tsconfig.integration.json` compiles `test/integration` to `out/test` (CommonJS).
  - `.vscode-test.mjs`: `defineConfig({ files: 'out/test/integration/**/*.test.js', version: 'stable', mocha: { timeout: 20000 } })`.
  - Script `test:integration`: `npm run build && tsc -p tsconfig.integration.json && vscode-test`.
  - `mockServer.ts` serves:
    - `/props` → `{"model_alias":"qwen2.5-coder-1.5b"}`;
    - `/infill` → SSE `{"content":"a + b;"}` then `{"content":"","stop":true}`;
    - it records request bodies.

- [ ] **Step 2: Write failing `fim.test.ts`** (mocha `suite`/`test`).
  - Each test sets `aiAutocomplete.backends` and `aiAutocomplete.fim.backend` with `ConfigurationTarget.Global`, opens an untitled `typescript` document with `function add(a: number, b: number) {\n  return `, and puts the cursor at the end.
  - Tests:
    1. `ghost text from llama.cpp /infill`: run `editor.action.inlineSuggest.trigger`, wait until the mock has received one request (poll up to 5 s), wait 300 ms, run `editor.action.inlineSuggest.commit`. Then:
       - the document text ends with `return a + b;`;
       - `requests[0].body.input_prefix` ends with `return `.
    2. `localOnly blocks a non-local backend`: the backend baseUrl is `https://example.com` and `privacy.localOnly` is true. After trigger and a 1 s wait:
       - the mock received 0 requests;
       - `api.status.current()` contains `error`.
    3. `unreachable backend → error status, no item`: the baseUrl is `http://127.0.0.1:9` (closed). After trigger:
       - `api.status.current()` contains `error`;
       - the document is unchanged after commit.
    4. `excluded file gets no request`: open a document named `.env` (`workspace.openTextDocument` on a temp file). After trigger, the mock received 0 requests.

- [ ] **Step 3: Run `npm run test:integration`.** Expected: PASS. Fix the provider and wiring until it does.

- [ ] **Step 4: Update CI.** Add an `integration` job (no `name:`) to `ci.yml`: ubuntu, same pinned setup as `check`, then `xvfb-run -a npm run test:integration`.

- [ ] **Step 5: (removed — releases are automated by release-please in Task 14.)**

- [ ] **Step 6: Write the docs.**
  - **README "Getting started"**:
    - `brew install llama.cpp` (or releases);
    - `llama-server --fim-qwen-3b-default --port 8012`;
    - the settings JSON for llama.cpp, Codestral (`{"id":"codestral","kind":"mistral","baseUrl":"https://codestral.mistral.ai","fimModel":"codestral-latest"}` plus the "Set API key" command), LM Studio/vLLM (`kind: openai`, `baseUrl: http://127.0.0.1:1234/v1`, `fimModel`), and `privacy.localOnly`;
    - a note that Strata/Qwen3.8 are chat-only, with chat FIM arriving in v0.2;
    - the keyboard shortcut `Alt+\` to trigger manually.
  - Do not touch `CHANGELOG.md` or the version; release-please owns both (Task 14).

- [ ] **Step 7: Final local check.** Run `npm run lint && npm run typecheck && npm test && npm run test:integration && npm run package`. Expected: all pass, and `ai-autocomplete-0.0.1.vsix` exists. Delete it afterwards. Installing the .vsix into the user's own VS Code and the manual smoke test are deferred to the user (listed in `docs/ROADMAP.md` by the controller).

- [ ] **Step 8: Commit** with message `test: VS Code integration tests and getting-started docs`.

- [ ] **Step 9: (removed — publishing happens in the Publish section after Task 14.)**

---

### Task 14: GitHub automation (releases, dependency updates, code scanning, repo settings) and handoff docs

**Files:**
- Create: `release-please-config.json`, `.release-please-manifest.json`, `.github/workflows/release-please.yml`, `.github/dependabot.yml`, `.github/workflows/dependabot-automerge.yml`, `.github/workflows/codeql.yml`, `scripts/setup-github-repo.sh`
- Modify: `.github/workflows/ci.yml` (only if a pin or permission is missing), `AGENTS.md` (section 7), `docs/ROADMAP.md`, `README.md` (CI badge)
- Test: `test/unit/repoAutomation.test.ts`

**Interfaces:**
- Consumes: CI job ids `check` and `integration` (Tasks 1, 13); npm scripts from Task 1.
- Produces:
  - `scripts/setup-github-repo.sh [--dry-run] [OWNER/REPO]` (default `Raboo/vscode-ai-autocomplete`), run only by the controller in the Publish section;
  - release tags `vX.Y.Z` with an attached `ai-autocomplete-X.Y.Z.vsix`.

Why each piece exists (put this reasoning in `AGENTS.md` section 7, one line each):
- release-please turns Conventional Commits on `main` into a release PR that bumps `package.json` and writes `CHANGELOG.md`. Merging that PR creates the tag and GitHub Release; a follow-up job attaches the .vsix. Releases need no hand-edited files.
- Dependabot keeps devDependencies and pinned action SHAs current. Patch/minor updates auto-merge once CI is green; major updates wait for a human or an AI session.
- CodeQL scans the TypeScript on every PR and weekly.
- `scripts/setup-github-repo.sh` records the repo settings these depend on, so they are reproducible and reviewable rather than clicked by hand.

- [ ] **Step 1: Write failing `test/unit/repoAutomation.test.ts`** (read files with `node:fs`; no YAML parser dependency, use line/regex scans):

```ts
test('every workflow action is pinned to a full commit SHA', () => {
  // for each .github/workflows/*.yml, every `uses:` value that does not start with './' matches /@[0-9a-f]{40}(\s+#.*)?$/
});
test('every workflow declares top-level permissions', () => { /* each file has a line matching /^permissions:/m */ });
test('CI job ids are check and integration', () => { /* ci.yml has /^  check:$/m and /^  integration:$/m, and no job-level `name:` under them */ });
test('release-please manifest matches package.json version', () => {
  expect(JSON.parse(readFileSync('.release-please-manifest.json','utf8'))['.']).toBe(pkg.version);
});
test('dependabot covers npm and github-actions and holds back pinned packages', () => {
  // dependabot.yml contains 'package-ecosystem: "npm"' (or unquoted) and 'package-ecosystem: "github-actions"',
  // an ignore entry for '@types/vscode' with semver-minor and semver-major, and an ignore entry for 'typescript' with versions '>=6.1.0'
});
test('setup script dry run prints the expected settings', () => {
  // execFileSync('bash', ['scripts/setup-github-repo.sh', '--dry-run', 'o/r']) output contains:
  // 'enable-auto-merge', 'delete-branch-on-merge', 'can_approve_pull_request_reviews', 'vulnerability-alerts',
  // 'automated-security-fixes', '"context": "check"', '"context": "integration"'
});
```

- [ ] **Step 2: Run `npx vitest run test/unit/repoAutomation.test.ts`.** Expected: FAIL (files missing).

- [ ] **Step 3: release-please.**
  - `release-please-config.json`: `$schema` `https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json`; `packages["."]`: `release-type: "node"`, `package-name: "ai-autocomplete"`, `include-component-in-tag: false`, `bump-minor-pre-major: true`, `changelog-path: "CHANGELOG.md"`; `changelog-sections` showing `feat` (Features), `fix` (Bug Fixes), `perf` (Performance), and hiding `docs`, `chore`, `test`, `ci`, `build`, `refactor`.
  - `.release-please-manifest.json`: `{ ".": "0.0.1" }`. The first release PR after Publish therefore proposes `0.1.0`.
  - `.github/workflows/release-please.yml`:
    - trigger `push` to `main`, plus `workflow_dispatch`; top-level `permissions: contents: read`;
    - job `release-please` with `permissions: contents: write, pull-requests: write` runs `googleapis/release-please-action` (pinned) with `token: ${{ secrets.RELEASE_PLEASE_TOKEN || github.token }}`, `config-file`, `manifest-file`; outputs `release_created` and `tag_name`;
    - job `vsix` (`needs: release-please`, `if: needs.release-please.outputs.release_created == 'true'`, `permissions: contents: write`) checks out the tag, runs `npm ci`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`, `npm run package`, then `gh release upload "$TAG" ai-autocomplete-*.vsix --clobber` with `GH_TOKEN: ${{ github.token }}`.
  - Note for `AGENTS.md`: release PRs opened with the default token do not trigger CI, so the `check`/`integration` checks never report on them; either add a `RELEASE_PLEASE_TOKEN` secret (fine-grained PAT: contents + pull requests write on this repo) or merge release PRs with the admin bypass (`gh pr merge --admin`).

- [ ] **Step 4: Dependabot.**
  - `.github/dependabot.yml`, `version: 2`:
    - `npm` at `/`: weekly (Monday), `open-pull-requests-limit: 10`, `commit-message: { prefix: "chore(deps)", prefix-development: "chore(deps-dev)" }`, one group `dev-dependencies` (patterns `["*"]`, `update-types: [minor, patch]`), ignores: `@types/vscode` for `version-update:semver-minor` and `version-update:semver-major`; `typescript` for versions `[">=6.1.0"]`; `@types/node` for `version-update:semver-major`. A comment above each ignore says why (Global Constraints).
    - `github-actions` at `/`: weekly (Monday), `commit-message: { prefix: "ci(deps)" }`, one group `actions` (patterns `["*"]`).
  - `.github/workflows/dependabot-automerge.yml`:
    - trigger `pull_request`; top-level `permissions: contents: write, pull-requests: write`;
    - one job with `if: github.event.pull_request.user.login == 'dependabot[bot]'`, runs `dependabot/fetch-metadata` (pinned), then `gh pr merge --auto --squash "$PR_URL"` only when `steps.meta.outputs.update-type` is `version-update:semver-patch` or `version-update:semver-minor`;
    - `--auto` waits for the ruleset's required checks, so nothing merges red.

- [ ] **Step 5: CodeQL.** `.github/workflows/codeql.yml`: triggers `push` to `main`, `pull_request`, weekly `schedule`; top-level `permissions: contents: read`; job `analyze` with `permissions: security-events: write, contents: read, actions: read`, checkout, `github/codeql-action/init` (`languages: javascript-typescript`, `build-mode: none`), `github/codeql-action/analyze`. All pinned.

- [ ] **Step 6: `scripts/setup-github-repo.sh`.** `set -euo pipefail`; `--dry-run` prints each command instead of running it; idempotent (safe to re-run). It applies:
  - `gh repo edit "$REPO" --enable-auto-merge --delete-branch-on-merge --enable-squash-merge --enable-merge-commit --enable-rebase-merge=false --add-topic vscode-extension,autocomplete,fim,llama-cpp,codestral`;
  - `gh api -X PUT repos/$REPO/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true` (lets release-please open PRs);
  - `gh api -X PUT repos/$REPO/vulnerability-alerts` and `gh api -X PUT repos/$REPO/automated-security-fixes`;
  - a branch ruleset named `main` on `~DEFAULT_BRANCH` (POST `repos/$REPO/rulesets` when none has that name, otherwise PUT `repos/$REPO/rulesets/<id>`), JSON body from a heredoc, printed pretty (two-space indent) in dry-run mode:
    - rules `deletion`, `non_fast_forward`, `pull_request` (0 required approvals, `allowed_merge_methods: ["merge","squash"]`), `required_status_checks` (`strict_required_status_checks_policy: false`, contexts `check` and `integration`);
    - `bypass_actors: [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }]` (5 = repository admin, so the owner can still push and merge release PRs).
  - Run `bash -n scripts/setup-github-repo.sh`. If `shellcheck` is installed, run it too.

- [ ] **Step 7: Validate workflows.** If Docker is available, run `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7 -color` (or the latest `rhysd/actionlint` tag; record which). Expected: no errors. If Docker is unavailable, say so in the report.

- [ ] **Step 8: Docs.**
  - `AGENTS.md` section 7 **GitHub automation**: the four "why" lines above; the workflow list (`ci.yml`: `check` + `integration`; `release-please.yml`; `dependabot-automerge.yml`; `codeql.yml`); the release-PR/CI-token note from Step 3; how to cut a release (merge the open release-please PR); what needs a human (creating the `RELEASE_PLEASE_TOKEN` secret, Marketplace/Open VSX tokens in Phase 5, approving major dependency updates).
  - `docs/ROADMAP.md`: Phase 0–1 status "implemented; v0.1.0 ships after Publish"; under "Deferred manual checks": the Task 12 Step 4 smoke test and installing the released .vsix with `code --install-extension`.
  - `README.md`: a CI status badge for `ci.yml` under the title.

- [ ] **Step 9: Run the tests.** `npm run lint && npm run typecheck && npm run build && npm test`. Expected: PASS.

- [ ] **Step 10: Commit** with message `ci: release-please, Dependabot, CodeQL and repo settings script`.

---

## Publish (controller only, after Task 14 and the final review)

These steps create public state on GitHub. **Ask the user once, listing all of them, and wait for a yes.** If the user approves only part, do only that part.

1. `gh repo create Raboo/vscode-ai-autocomplete --public --source . --remote origin --description "Lean AI autocomplete (FIM + Next Edit) for VS Code — self-hosted first, no telemetry"` (no `--push`).
2. `git push -u origin main`.
3. `bash scripts/setup-github-repo.sh Raboo/vscode-ai-autocomplete` (after the push, so the default branch exists).
4. Watch CI: `gh run watch -R Raboo/vscode-ai-autocomplete $(gh run list -R Raboo/vscode-ai-autocomplete -w ci.yml -L 1 --json databaseId --jq '.[0].databaseId')`. Expected: `check` and `integration` pass. Fix forward on failure (the ruleset admin bypass allows direct pushes).
5. release-please opens a release PR for `0.1.0`. Merge it: `gh pr merge <n> --squash --admin -R Raboo/vscode-ai-autocomplete` (CI does not run on it without `RELEASE_PLEASE_TOKEN`).
6. Verify: `gh release view v0.1.0 -R Raboo/vscode-ai-autocomplete --json assets --jq '.assets[].name'` lists `ai-autocomplete-0.1.0.vsix`.
7. Pull the release commit locally (`git pull`), tick the Publish steps here, and update `docs/ROADMAP.md` (Phase 0–1: "released as v0.1.0") in a `docs:` commit pushed to `main`.
