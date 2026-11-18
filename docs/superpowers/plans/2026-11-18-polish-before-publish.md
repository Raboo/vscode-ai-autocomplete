# Polish Before Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faster and better completions on local servers, a way to see why no suggestion appeared, and the last naming and presentation work before the first Marketplace publish.

**Architecture:** Each task is independent and small. Pure logic stays outside `vscode`-importing files (AGENTS.md allowlist) and is unit-tested.

**Source:** the owner asked (2026-11-18) to work through the idea list from the pre-publish review: two llama-server slots, "why no suggestion" and local stats, prefetch and warm-up, better completion context, renaming `fim.*`, an icon, a walkthrough, then a smarter Next Edit. Branch `feat/polish`, stacked on `feat/local-models` (PR #17).

## Global Constraints

- No telemetry: stats stay in memory in this window and are never sent or persisted.
- Runtime dependencies stay `diff` and `jsonc-parser`.
- Commits: Conventional Commits, no Co-Authored-By or other trailer; stage by explicit path.
- Prompt and completion text are logged only with `debug.logPrompts`.

---

### Task 1: Two llama.cpp slots, one per feature

- [x] The local helper starts llama-server with `-np 2` and `-c` = 2 × the recipe's context (each slot keeps the recipe's context).
- [x] The llama.cpp backend reads `total_slots` from `/props` (with the model detection it already does); when it is 2 or more, FIM requests (`/infill`, `/completion` for completions) send `id_slot: 0` and Next Edit raw requests send `id_slot: 1`. With 1 slot or unknown, no `id_slot` is sent (a user's own `-np 1` server keeps working).
- [x] Unit tests: args contain `-np 2` and the doubled context; bodies carry `id_slot` only with 2+ slots; Next Edit uses slot 1.
- [x] Commit: `feat: separate llama.cpp slots for completions and Next Edit`

### Task 2: "Why no suggestion?" and local stats

- [x] A ring of the last 20 completion outcomes per window, each a fixed reason without code text: skipped (with the gate reason: mid-word, suggest widget open, multi-cursor, excluded file, disabled language, snoozed, off), cache hit, joined a running request, shown (chars, ms), empty answer, filtered (which rule), error (fixed text), cancelled.
- [x] Command **AI Autocomplete: Why No Suggestion?** (also in the status bar menu, Help group) shows the latest outcomes for the active file in a quick pick, newest first, with the time.
- [x] Status bar tooltip adds: requests and shown counts this session, accepted count, median latency of the last 20 answered requests.
- [x] Unit tests for the ring and the stats; manifest test for the command.
- [x] Commit: `feat: Why No Suggestion command and session stats in the tooltip`

### Task 3: Warm-up and prefetch for local llama.cpp

- [ ] Warm-up: when a document becomes active and the completion backend is llama.cpp on a loopback host, send one `/infill` with `n_predict: 0` and the current window (debounced to once per document per 30 s), so the prompt cache is filled before the first keystroke.
- [ ] Prefetch: after a completion is accepted (the `accepted` command), request the completion at the new cursor position for the same document and store it in the cache, without showing anything; only for loopback llama.cpp backends; skipped when another request is running.
- [ ] Unit tests for the decisions (loopback only, rate limits); integration test on the mock: after accepting, the next trigger is a cache hit.
- [ ] Commit: `feat: warm up and prefetch on local llama.cpp`

### Task 4: Better completion context

- [ ] Extra-context chunks are ranked by token overlap (Jaccard over identifier tokens) with the lines around the cursor; the chosen chunks keep their existing stable order in the prompt.
- [ ] The last 3 edit hunks of the current file and other workspace files from Next Edit's history (when Next Edit tracking is on, else none) are added as one extra-context entry named `recent-edits.diff`, within the existing extra-context budget, placed last (most volatile).
- [ ] Unit tests for ranking and the budget; existing prompt-stability tests still pass.
- [ ] Commit: `feat: rank extra context by similarity and include recent edits`

### Task 5: Rename `fim.*` settings to `completions.*`

- [ ] Setting keys `aiAutocomplete.fim.*` become `aiAutocomplete.completions.*`; backend fields `fimModel`, `fimMode` and `fim` become `model`, `mode` and `completions` (`nextEditModel` stays).
- [ ] On activation, a one-time migration copies old keys to new ones at every level they are set (user, workspace, folder) and removes the old ones, then logs what moved; backend entries in user settings are rewritten. The reader still accepts old names (with a deprecation note in the problems list) until 1.0.
- [ ] README, AGENTS.md, specs' settings tables and the manifest follow.
- [ ] Commit: `feat!: rename fim settings to completions`

### Task 6: Icon

- [ ] `images/icon.png` 256×256: a rounded square in a deep blue, a text cursor with a faded ghost-text line after it, drawn with a small CoreGraphics script kept in `scripts/icon/`. `package.json` `icon`, `galleryBanner` `{ color: "#0b1530", theme: "dark" }`, and `.vscodeignore` ships it.
- [ ] Commit: `docs: extension icon`

### Task 7: Get started walkthrough

- [ ] `contributes.walkthroughs` "Get started with AI Autocomplete": set up a local model (button runs Set Up Local Model) or connect a server (opens the Backends page); see a completion (image `images/completion.png`); try Next Edit (image `images/next-edit.png`, button Select Next Edit Backend); privacy (local only setting, excluded files).
- [ ] The first-run notice gets a third button "Get Started" that opens the walkthrough.
- [ ] Commit: `feat: Get started walkthrough`

### Task 8: Next Edit keeps its suggestion while you type it

- [ ] A Next Edit result for an older document version is kept when the user's edits since then are a prefix of the suggested change at the same place (typing what the model suggested); its edit is rebased onto the new text. Otherwise it is dropped as today.
- [ ] Unit tests for the rebase; integration test: typing the first letters of the suggestion keeps it.
- [ ] Commit: `feat: Next Edit suggestions survive typing them`

### Finish

- [ ] Final whole-branch review, fix wave, docs (README, ROADMAP row "4b. Polish before publish").
