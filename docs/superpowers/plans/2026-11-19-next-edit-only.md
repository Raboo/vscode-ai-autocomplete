# Next Edit Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With completions off, Next Edit asks sooner, warms local llama.cpp, shows up in "Why No Suggestion?" and the stats; Zeta 2.1 is a Local Models recipe; latencies are measured.

**Architecture:** Pure decisions stay in `src/nextEdit/trigger.ts`, `src/completion/warmup.ts`, `src/completion/outcomes.ts` and `src/local/recipes.ts` (unit-tested). The wiring goes in `src/nextEdit/vscode/controller.ts`, `src/extension.ts` and `src/ui/commands.ts`.

**Spec:** `docs/superpowers/specs/2026-11-19-next-edit-only-design.md`

## Global Constraints

- Nothing changes while completions are on (same pause, no Next Edit warm-up).
- No telemetry: outcomes and stats stay in memory and carry no code text.
- Commits: Conventional Commits, no trailer, explicit-path staging.

## Review Focus

- Completions turned on or off while a Next Edit pause timer is running: the next schedule uses the new pause, with no double request.
- Warm-up must never show a suggestion, record history, or count as a shown or answered request.
- A Zeta model selected for completions (`use` excludes it) must not break the page or the format pick.

---

### Task 1: Shorter pause and Next Edit warm-up when completions are off

- [ ] `nextEditPauseMs(s: Settings): number` in `trigger.ts`: 150 when completions are off, disabled or have no backend, else `EDIT_PAUSE_MS` (400). Unit tests for each case. The controller uses it at both schedule sites.
- [ ] `shouldWarmNextEdit(i)` in `warmup.ts`: completions off, a loopback llama.cpp Next Edit backend, a raw format (`zeta21`/`sweep`), and the 30 s per-document limit. The controller sends the prompt with `n_predict: 0` on active-editor change and after an accepted Next Edit. Unit tests for the decision; an integration test on the mock checks that a warm-up request arrives with `n_predict: 0` and that nothing shows.
- [ ] Commit: `feat: Next Edit asks sooner and warms up when completions are off`

### Task 2: Next Edit in "Why No Suggestion?" and the stats

- [ ] Outcomes get `feature: 'completions' | 'nextEdit'`. The controller records Next Edit outcomes. The quick pick labels each entry, the stats count both features, and the median covers answered requests of both. Unit tests for the ring, the stats and the labels.
- [ ] Commit: `feat: Next Edit outcomes in Why No Suggestion and the stats`

### Task 3: Zeta 2.1 recipe

- [ ] The recipe from the design. `Recipe.note?: string` is shown on the page row. Tests: the recipe's id pattern, the format pick (`zeta-2.1` gives `zeta21`), and the note rendered and escaped. It is not the first-run default.
- [ ] Commit: `feat: Zeta 2.1 in the Local Models page`

### Task 4: Measurement and docs

- [ ] `scripts/bench/` script (esbuild bundle of the extension's request code; never part of the package). Live run on the owner's machine (Zeta Q4_K_M, Sweep 1.5B, Qwen2.5-Coder 1.5B). README "Choosing a model" with the numbers, ROADMAP row and manual checks, AGENTS.md layout line.
- [ ] Commit: `docs: Next Edit only mode and model latencies`
