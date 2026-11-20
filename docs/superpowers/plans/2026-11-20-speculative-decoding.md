# Speculative Decoding Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Local Models router serves every model with `spec-type = ngram-cache,ngram-simple` when llama-server supports it.

**Architecture:** Pure: `renderPresets(models, filePath, { speculative })` and `supportsSpeculative(helpText)` in `src/local/router.ts`. Wiring: `src/local/serverPool.ts` passes the support answer from the `--help` text it already reads.

**Tech Stack:** TypeScript, vitest, llama.cpp router presets.

**Spec:** `docs/superpowers/specs/2026-11-20-speculative-decoding-design.md`

## Global Constraints

- Exact preset line: `spec-type = ngram-cache,ngram-simple`, in `[*]`, right after `cache-reuse = 256`.
- Support check: help text contains both `--spec-type` and `ngram-cache`.
- A model's extra `--spec-type` stays in its own section and overrides `[*]`.
- Commits: Conventional Commits, no trailer, explicit-path staging.

## Review Focus

- An old llama-server (router support, no `--spec-type`): presets without the line, server starts (Task 1 test).
- A model with `--spec-type none` in extra arguments: its section has `spec-type = none` (Task 1 test).

---

### Task 1: Speculative decoding in the presets

**Files:** Modify `src/local/router.ts`, `src/local/serverPool.ts`; Test `test/unit/local/router.test.ts`, `test/unit/local/serverPool.test.ts` (or wherever the pool's preset rendering is tested).

- [ ] Tests: `supportsSpeculative` true for help text with `--spec-type ... ngram-cache`, false without either; `renderPresets(..., { speculative: true })` has the line in `[*]` after `cache-reuse = 256`; with `false` it does not; a model with extra args `--spec-type none` gets `spec-type = none` in its section; the pool renders with `speculative` from the help text (a fake help with and without `--spec-type`).
- [ ] Implement.
- [ ] `npm run build && npm test && npm run typecheck && npm run lint` pass.
- [ ] Commit: `feat: local models use n-gram speculative decoding`

### Task 2: Docs

**Files:** `README.md` (latency table numbers from the spec, "Speculative decoding" note), `docs/ROADMAP.md` (row and manual checks: Local Models server log shows `draft acceptance`; `--spec-type none` in a model's extra arguments removes it).

- [ ] Commit: `docs: speculative decoding for local models`
