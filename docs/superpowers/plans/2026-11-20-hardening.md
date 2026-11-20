# Hardening Before Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the nine problems public users or releases would hit (design items 1–10 minus the dropped deletion guard).

**Architecture:** Each task is independent: pure logic in the existing pure modules (`optIn.ts`, `http.ts`, `thinking.ts`, `trigger.ts`, `settings.ts`, `history.ts`), wiring in `src/ui/*`, `src/nextEdit/vscode/controller.ts`, `src/completion/provider.ts`, and a new `src/ui/conflicts.ts` with a pure `src/config/conflicts.ts`.

**Tech Stack:** TypeScript, vitest, @vscode/test-electron, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-20-hardening-design.md`

## Global Constraints

- No telemetry; the conflict check reads only `vscode.extensions` and configuration, sends nothing.
- Only allowlisted files import `vscode` (AGENTS.md).
- Commits: Conventional Commits, no trailer, explicit-path staging; one commit per task with the subject given.
- Never run upstream code; read other extensions' manifests only.

## Review Focus

- `argv.json` that is a symlink, or read-only: the link target is updated (or the error is reported and the file is unchanged) — Task 1 tests.
- A backend with both a stored key and `Authorization` header: exactly one auth header goes out — Task 2 test.
- A model with thinking off answering code that contains `</think>`: the whole answer stays — Task 4 test.

---

### Task 1: Atomic argv.json write
**Files:** `src/nextEdit/optIn.ts` (or a new pure `src/nextEdit/atomicWrite.ts` taking `fs/promises`), `src/ui/commands.ts`; tests in `test/unit/nextEdit/`.
- [ ] Tests on a temp dir: writes via rename (no partial file on a simulated write error, temp file removed); a symlinked target keeps the symlink and updates the real file; the mode is kept.
- [ ] Implement; `commands.ts` uses it.
- [ ] Commit: `fix: write argv.json atomically`

### Task 2: One Authorization header
**Files:** `src/backends/http.ts`, Backends page warnings (`src/manage/form.ts` or `pageState.ts`); tests.
- [ ] Tests: `authHeaders` with a key and `{ Authorization: 'x' }` / `{ AUTHORIZATION: 'x' }` → only the user's header; without a user header → bearer key; the page warning text "API key not sent: an Authorization header is set" when both exist.
- [ ] Commit: `fix: a user Authorization header replaces the stored key`

### Task 3: Model detection waits out the backoff
**Files:** `src/completion/provider.ts` (and the backoff it uses); tests (unit or integration on the mock).
- [ ] Test: server down → detection is not retried on every keystroke inside the backoff window; after the window it is tried once.
- [ ] Commit: `fix: model detection waits out the backoff while a server is down`

### Task 4: Bare `</think>` only when the model may think
**Files:** `src/models/thinking.ts`, the chat stream caller that knows the strategy and learned capability; tests in `test/unit/thinking.test.ts`, `stream.test.ts`.
- [ ] Tests: thinking off (strategy not `cannotDisable`, not learned) → `a</think>b` stays whole; `cannotDisable` or learned "thinks anyway" → text before the bare closer is hidden (today's behaviour); opener+closer unchanged in both.
- [ ] Commit: `fix: keep chat answers that contain a closing think tag`

### Task 5: Rejected Next Edit memory
**Files:** `src/nextEdit/trigger.ts` (pure memory) or a new pure helper, `src/nextEdit/vscode/controller.ts`; tests.
- [ ] Tests: the identical edit after a rejection is dropped; after the text near its range changes it can show; a different edit shows; a cursor move alone does not clear the memory.
- [ ] Commit: `feat: a rejected Next Edit does not come back unchanged`

### Task 6: Competing extensions notice
**Files:** create `src/config/conflicts.ts` (pure: the table of known extensions and settings, and `activeConflicts(installed, settings)`), `src/ui/conflicts.ts` (notification, global state), `src/extension.ts`, `docs/conflicts.md`, README link; tests (unit for the pure part).
- [ ] Tests: an installed extension with inline suggestions on → listed; its known setting off → not listed; dismissed id → not listed.
- [ ] Commit: `feat: warn when another extension also offers inline suggestions`

### Task 7: Limits on numeric settings
**Files:** `package.json`, `src/config/settings.ts`; `test/unit/settings.test.ts`, `test/unit/manifest.test.ts`.
- [ ] Tests: `prefixLines: -50` → 0 with one log line; `maxTokens: 0` → 1, `2000` → 1024; `debounceMs: 10.4` → 10, `null` stays automatic; manifest test: every numeric setting has bounds and its default equals the reader's.
- [ ] Commit: `fix: limits on the completion number settings`

### Task 8: Test isolation and the flaky history test
**Files:** `.vscode-test.mjs`, `src/nextEdit/history.ts`, `test/unit/nextEdit/history.test.ts`.
- [ ] `VSCODE_PORTABLE` for both launches; local `npm run test:integration` passes all main-launch tests on the owner's Mac (record the output).
- [ ] Diff time limit injectable; the "too large" test no longer depends on speed.
- [ ] Commit: `test: isolate integration runs from the user's argv.json and fix a timing test`

### Task 9: actionlint in CI, docs
**Files:** `.github/workflows/ci.yml` (+ fixes from findings), `docs/ROADMAP.md` (row 4g, manual checks: Enable Native Next Edit UI on a symlinked argv.json; Copilot installed shows the notice once; Esc'd Next Edit does not return), the follow-ups file (remove fixed and stale entries), AGENTS.md (conflicts module in Layout).
- [ ] actionlint step passes; findings fixed.
- [ ] Commit: `ci: lint workflows with actionlint`
