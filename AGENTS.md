# AGENTS.md

Rules every AI agent follows in this repo. `CLAUDE.md` only imports this file.

## What this is

- An autocomplete-only VS Code extension: no chat, no agents, no telemetry.
- Fast FIM (fill-in-the-middle) ghost-text completion and Next Edit (Phases 3a and 3b: the chatXtab, Sweep and Zeta 2.1 formats, ghost text, native inline edits and a decoration fallback); self-hosted backends first.
- Design spec: `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md`. Phase status: `docs/ROADMAP.md`.

## Hard rules

- No telemetry, ever. Nothing leaves the machine except requests to the user-configured backend.
- Machine-scoped settings (`aiAutocomplete.backends`, `aiAutocomplete.modelOverrides`, `aiAutocomplete.debug.logPrompts`, `aiAutocomplete.local.llamaServerPath`, `aiAutocomplete.local.lmsPath`) are read from `globalValue` only; workspace values are ignored.
- Only these files may `import 'vscode'`: `src/extension.ts`, `src/log.ts`, `src/config/vscodeSettings.ts`, `src/config/secrets.ts`, `src/completion/provider.ts`, `src/completion/contextTracker.ts`, `src/ui/*`, `src/nextEdit/vscode/*`, `src/local/vscode/*`. Everything else is pure and unit-testable.
- The Backends page never receives an API key, and server-supplied text (model ids, error bodies) is HTML-escaped before it reaches the page. Error text shown in the page is fixed text.
- Prompt and completion text, reasoning text and server error bodies are logged only when `aiAutocomplete.debug.logPrompts` is true; timings, status codes and sizes are always logged at debug level.
- The chat prompt (`src/completion/holeFiller.ts`) is our own wording. Never copy Continue's hole-filler prompt (its upstream license is unverified).
- A git-ignored `.env` in the repo root may hold the user's local test endpoint credentials. Agents never commit them, copy them into docs, plans or tests, or print them; tests use mocks.
- A file that copies or closely adapts upstream code starts with `// Portions adapted from <project> <path> @ <commit> (<license>). Copyright <holder>.`, and `THIRD_PARTY_NOTICES.md` gets an entry for that project (full MIT text for MIT projects).
- Never touch the GitHub repo `Raboo/ai-autocomplete`.
- Interactive sessions ask the user before creating repos, pushing, changing repo settings or releasing, and wait for a yes.
- Commit subjects follow Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`, `build:`); nobody edits `CHANGELOG.md` or the `version` field by hand.
- Commits carry no Co-Authored-By trailer: they show only the user (their choice, 2026-11-16).
- Never run upstream code; read it only (for example with `gh api repos/<o>/<r>/contents/<path>?ref=<sha>`).
- Two versions are pinned on purpose: `typescript ~6.0.x` (typescript-eslint supports TypeScript below 6.1 only) and `@types/vscode ~1.100.0` (tracks `engines.vscode`).
- Runtime dependencies: only `diff` and `jsonc-parser` (`test/unit/manifest.test.ts` pins the list). esbuild bundles both; jsonc-parser through its ES module build (`mainFields: ['module', 'main']`), because its UMD build cannot be bundled.
- GitHub Actions are pinned by full commit SHA with a `# vX.Y.Z` comment, and every workflow declares top-level least-privilege `permissions:`.

## Commands

Node version comes from `.nvmrc` (22); code must also work on newer Node.

- `npm run build`: bundle `src/extension.ts` into `dist/extension.js` and the Backends page into `dist/webview/backends.{js,css}` with esbuild.
- `npm run watch`: rebuild on change.
- `npm run typecheck`: `tsc --noEmit` for both `tsconfig.json` and `tsconfig.webview.json`.
- `npm run lint`: ESLint over the repo.
- `npm test`: unit tests with vitest. Run `npm run build` first: a manifest test reads `dist/extension.js`.
- `npm run test:integration`: builds, compiles `test/integration` to `out/test` and runs it in a downloaded VS Code (into `.vscode-test/`) against a mock llama.cpp server in two launches, `main` (all integration tests) and `proposed` (the nextEdit tests with `--enable-proposed-api raboo.ai-autocomplete`); tests type with the `type` command, because VS Code treats an explicit trigger after `editor.edit` as already answered. CI runs it under `xvfb-run`. `.vscode-test.mjs` sets `chat.disableAIFeatures` in the test profile: VS Code 1.146 focuses its chat input at startup, and without OS window focus (a locked screen) editor actions like `inlineSuggest.trigger` would hit it.
- `npm run package`: build a `.vsix` with `vsce package --no-dependencies`.
- `npm run vscode:prepublish`: production (minified) build, run by vsce.
- `bash scripts/setup-github-repo.sh --dry-run`: print the GitHub repo settings the automation needs (never run it without `--dry-run` unless the user approved; see section 7).

## Layout

- Pure modules (config parsing, backends, models, most of `completion/`) never import `vscode` and are unit-tested in `test/unit/`.
- Chat path and thinking control: `src/models/thinking.ts` (request fields per strategy and host flavor, reasoning filter), `src/models/capabilities.ts` (what a server rejected or lacks, learned per session, never persisted), `src/completion/holeFiller.ts` (the chat prompt), `src/completion/stream.ts` (streaming of all routes), `src/backends/chat.ts` (`/v1/chat/completions`) and `src/backends/openrouter.ts` (OpenRouter's model list). Route choice lives in `src/completion/route.ts`.
- `src/manage/` is the pure logic of the Backends page (protocol, server types, form, page state, connection test, and `nextEditSample.ts`, the fixture of the Test's Next Edit step). `src/completion/effective.ts` resolves per-backend values and is shared with the provider.
- `src/backends/firstSpace.ts` repairs the leading space LM Studio's MLX engine drops (the request holds back the end of the cursor line; `OpenAiCompatBackend` repairs the stream and sends LM Studio only stops without whitespace). Design: `docs/superpowers/specs/2026-11-16-lmstudio-mlx-fixes-design.md`.
- Old setting names until 1.0: `aiAutocomplete.fim.*` is now `aiAutocomplete.completions.*`, and backend fields `fimModel`/`fimMode`/`fim` are `model`/`mode`/`completions` (internal TypeScript names such as `Settings.fim` and `fimModel` stayed). `src/config/rename.ts` holds the pure fallback and migration plan; `src/ui/migrateSettings.ts` moves old `fim.*` keys in user settings only, on start and after settings changes (`disableInFiles` lists are joined, in the move and in the reader); workspace and folder settings are never written (old keys there get one log line), and `backends` is never rewritten automatically: entries get the new field names when saved from the Backends page or by the local helper. The old keys stay registered (deprecated) in `package.json` because VS Code only writes registered keys.
- A backend's `use` (`completions`, `nextEdit` or both; missing means both) says what it serves: `src/config/settings.ts` parses it, `usesFor` answers it, the pickers, the selection fallbacks and the Backends page's Test follow it, and `NEXT_EDIT_TOKENS` in `src/completion/postprocess.ts` keeps Next Edit markers out of ghost text. Design: `docs/superpowers/specs/2026-11-16-backend-roles-design.md`.
- `src/webview/backends/` is the page itself: `main.ts` (DOM), pure `render.ts`, `style.css`, with its own `tsconfig.webview.json`. `src/ui/backendsPanel.ts` hosts it.
- Next Edit (`src/nextEdit/`, all pure except `vscode/`):
  - `history.ts`: edit-diff history per file (merged per area, with structured hunks and the text before the latest change) and recently viewed snippets;
  - `region.ts`: the editable region (default 5 above, 10 below; the `regionLinesAbove`/`regionLinesBelow` settings change it) and clipping the file to 10-line pages;
  - `formats/format.ts`: the format interface (chat or raw completion transport), the answer type and the shared reserved-string and budgeting helpers;
  - `formats/index.ts`: `pickFormat`, which maps the `nextEdit.format` setting and the model id to a format;
  - `formats/chatXtab.ts`: the chat prompt (our own wording, Copilot/Mercury tag names) and the answer parser;
  - `formats/sweep.ts`: Sweep next-edit prompts (v1 and v2 layouts) and answer parser; adapts Apache-2.0 scripts, see `THIRD_PARTY_NOTICES.md`;
  - `formats/zeta21.ts`: Zeta 2.1 prompt with marker blocks and answer parser, written from the model card only (never read Zed's GPL source);
  - `diff.ts`: old region vs new region as one line edit, filters, ghost text or inline edit;
  - `decorations.ts`: the decoration plan for an inline edit (which text to mark, what to show, the hint, whether Tab jumps first) and `displayFor`, which picks item, decorations or drop from the `display` setting;
  - `trigger.ts`: when to ask (edit pause, cursor move after an edit) and the cooldowns;
  - `request.ts`: one request over the backend's chat stream or raw completion route, failing fast on thinking;
  - `optIn.ts`: the argv.json path and edit for the native-UI opt-in;
  - `vscode/decorations.ts`: draws a decoration plan and sets the `aiAutocomplete.nextEditPending` context key that the Tab and Esc keybindings read;
  - `vscode/controller.ts`: events, history, trigger rules, requests and the latest result; the proposed-API `.d.ts` is `src/types/vscode.proposed.inlineCompletionsAdditions.d.ts` (pinned from `release/1.146`).
- Local model helper (`src/local/`, all pure except `vscode/`; design: `docs/superpowers/specs/2026-11-16-local-model-helper-design.md`):
  - `recipes.ts`: the curated GGUF recipes (Hugging Face repo, pinned revision, file, size, sha256, licence, model name) and the memory check;
  - `runtimes.ts`: finding `llama-server` and `lms` (settings path, PATH, usual install places) and the install hints;
  - `download.ts`: the resumable, sha256-checked download;
  - `llamaServer.ts`: llama-server arguments, free port choice, health polling; `serverPool.ts`: the servers VS Code started (start, stop, start again for selected backends);
  - `lmStudio.ts`: the `lms` calls (import, server, load); `backendEntry.ts`: the backend entry a recipe writes, backend ids and the managed-server records kept in global state;
  - `vscode/servers.ts`: the pool wired to VS Code (global state, user settings); `vscode/setup.ts`: the Set Up Local Model and Remove Downloaded Models flows.
- `vscode`-facing modules are limited to the allowlist above: extension entry, logging, settings and secrets access, the inline completion provider, context tracking, `src/ui/*` and `src/nextEdit/vscode/*`.
- See the spec's architecture tree for the full folder-by-folder breakdown.

## How work is done here

1. The spec (`docs/superpowers/specs/`) is the authority.
2. Each phase gets a plan (`docs/superpowers/plans/`).
3. Tasks run test-first, one commit per task, using the plan's commit message.
4. The task's checkboxes are ticked in the plan in a `docs(plan): mark Task N complete` commit.

## How to continue the work

- Read `docs/ROADMAP.md` and open the current phase's plan.
- Done tasks have ticked boxes and matching commit subjects in `git log`.
- If the next phase has no plan yet, write one from the spec before writing code (with the Superpowers `writing-plans` skill when available).
- Check the spec's "To verify during implementation" list for open questions.

## GitHub automation

Why each piece exists:

- release-please turns Conventional Commits on `main` into a release PR that bumps `package.json` and writes `CHANGELOG.md`; merging it creates the tag and GitHub Release, and a follow-up job attaches the `.vsix`. Releases need no hand-edited files. Versions follow semver strictly: `fix:` is a patch, `feat:` a minor, and a breaking change (`feat!:`, `fix!:` or a `BREAKING CHANGE:` footer) a major version. With squash merges the PR title is the commit subject, so it decides the bump.
- Dependabot keeps devDependencies and pinned action SHAs current. Patch/minor updates auto-merge once CI is green; major updates wait for a human or an AI session.
- CodeQL scans the TypeScript on every PR and weekly.
- `scripts/setup-github-repo.sh` records the repo settings these depend on (merge options, workflow permissions, security alerts, the `main` ruleset requiring `check` and `integration`), so they are reproducible and reviewable rather than clicked by hand.

Workflows (`.github/workflows/`):

- `ci.yml`: jobs `check` (lint, typecheck, build, test, package) and `integration` (VS Code under `xvfb-run`). Job ids must stay `check` and `integration`, with no `name:`, because the ruleset requires those names.
- `release-please.yml`: job `release-please` opens or updates the release PR and turns on auto-merge (squash) for it; job `vsix` runs on release and uploads `ai-autocomplete-X.Y.Z.vsix` to the release.
- `dependabot-automerge.yml`: enables auto-merge (squash) for Dependabot patch and minor PRs.
- `codeql.yml`: job `analyze`.
- Every job has `timeout-minutes`; keep it when adding jobs.

Releases are automatic: release-please opens the release PR with the `RELEASE_PLEASE_TOKEN` secret (fine-grained PAT: contents and pull requests write on this repo, set on 2026-11-19), so CI runs on it, and the workflow turns on auto-merge; when `check` and `integration` pass it merges, which tags and publishes the release. Release PRs opened with the default `GITHUB_TOKEN` (the secret missing or expired) do not trigger CI and never merge on their own: renew the secret, or merge with the admin bypass (`gh pr merge --admin --squash`).

Needs a human: renewing the `RELEASE_PLEASE_TOKEN` secret when it expires, Marketplace and Open VSX tokens (Phase 5), approving major dependency updates.

If the CI `integration` job ever fails with Chromium sandbox errors on ubuntu-24.04 (it passed on GitHub on 2026-11-13), add a CI-only `--no-sandbox` launch arg in `.vscode-test.mjs`, or a `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` step before it.
