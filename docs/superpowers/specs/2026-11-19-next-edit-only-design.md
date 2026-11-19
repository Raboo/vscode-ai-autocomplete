# Next Edit without a completion backend — design

Date: 2026-11-19. The owner approved the ideas and asked to implement and release them: "go ahead and implement your ideas, release when done testing".

## Why

A Next Edit model such as Zeta 2.1 also predicts code at the cursor, and insertions there already show as ghost text. The owner wants to turn completions off and run on Zeta alone. Today that works, but it feels slower than completions:

- Next Edit waits 400 ms after typing.
- Only completions warm up the local server's prompt cache.
- "Why No Suggestion?" and the session stats only see completions.

Zeta also has no recipe in the Local Models page.

## Goals

- With completions off (or no completion backend selected), Next Edit asks sooner, warms up local llama.cpp, and is explained by "Why No Suggestion?" and the stats.
- Zeta 2.1 is offered on the Local Models page.
- Measure Zeta, Sweep 1.5B and Qwen2.5-Coder on the owner's machine and document the numbers.

## Non-goals

- Changing Zeta's prompt format: Zeta gaps found in Zed's bindings are reported to the owner separately.
- Changing anything while completions are on.

## Approaches

- **A. Automatic "Next Edit only" behaviour when completions are off (chosen).** There's no new setting. The extension already knows when completions are off.
- B. A `nextEdit.pauseMs` setting. It's one more knob, and the right value follows from whether completions are on.

## Decisions

- **Pause:** with completions off, disabled, or without a backend (`!s.enabled || !s.fim.enabled || s.fim.backendId === undefined`), the Next Edit edit pause is 150 ms instead of 400 ms. Everything else in the trigger rules stays: cooldowns, chaining, and keeping a suggestion while the user types it.
- **Warm-up:** with completions off and a Next Edit backend that is llama.cpp on a loopback host, using a raw format (`zeta21` or `sweep`), the extension sends the Next Edit prompt for the cursor with `n_predict: 0` (`cache_prompt` as usual, the Next Edit slot):
  - when a document becomes active;
  - after an accepted Next Edit;
  - at most once per document per 30 s (the completions warm-up rules and limiter, reused).
  - Nothing is shown, and no history entry is recorded.
- **Outcomes:** Next Edit requests record outcomes in the same ring as completions, labelled "Next Edit". They record:
  - skipped, with the reason (the existing "not asked" reasons);
  - shown (chars, ms);
  - no change;
  - filtered (which rule);
  - error (fixed text);
  - cancelled.

  "Why No Suggestion?" lists both features newest first. The tooltip stats count Next Edit requests, shown and accepted next to completions, and the median latency covers both features' answered requests. No code text is recorded, as today.
- **Zeta recipe:** "Zeta 2.1 (community quant)":
  - repo `mradermacher/zeta-2.1-i1-GGUF` at `92c5ffc501a76d9c92bd04c0022cebfffa461dc8`, file `zeta-2.1.i1-Q4_K_M.gguf`, 5071410336 bytes, sha256 `216ddb5722a49f9ff49b21a050c4db3c801ef6f34e4bd1702d5db43e3325b076`;
  - Apache-2.0, uses Next Edit only, model name `zeta-2.1` (matches `/zeta/i`, so `nextEdit.format: auto` picks `zeta21`), context 8192.
  - A recipe gets an optional `note` that the page shows next to the label ("community quant, not official"). It is never the first-run default.
- **Measurement:** a dev script under `scripts/bench/` runs the extension's own request code against a running llama-server. It covers the same prompts for Zeta (Next Edit), Sweep 1.5B (Next Edit and completion) and Qwen2.5-Coder 1.5B (completion), and prints the median and p90 time to the first and last token. The README's "Choosing a model" gets the owner's numbers.

## Left to the builder

- Where the outcome label lives (a `feature` field on the outcome).
- The bench script's exact prompts (a few realistic edits from this repo).
