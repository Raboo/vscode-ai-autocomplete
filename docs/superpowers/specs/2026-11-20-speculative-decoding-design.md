# Speculative decoding by default for local models — design

Date: 2026-11-20. The owner asked whether `--spec-type ngram-cache,ngram-simple` helps every model ("If so then it would be a good default") and approved writing it up.

## Why

Measured on the owner's M3 Pro (warm prompt cache, `scripts/bench/latency.ts`), n-gram speculative decoding never slowed the first token and:

- Next Edit: Zeta 2.1 Q4_K_M 8.3 s → 3.5 s per answer; Sweep 1.5B 3.06 s → 0.71 s, same answers.
- Completions (500 ms generation cap): about twice the text in the same time (Sweep 145 → 281 chars, Qwen2.5-Coder 1.5B 148 → 283, Mellum 4B 56 → 103, Qwen2.5-Coder 3B 46 → 116).

`ngram-cache,ngram-simple` was the best of 13 configurations tried on Zeta (`ngram-mod` adds 0.35 s to the first token; `ngram-map-k`/`ngram-map-k4v` gain nothing). Draft-model types are out: no small model shares the recipes' tokenizers in a useful way.

## Goals

- Every model the Local Models router serves uses `spec-type = ngram-cache,ngram-simple` by default.
- A model can override it in its extra arguments (`--spec-type none` turns it off; verified that a model section's `spec-type` overrides `[*]`).
- An older llama-server that does not know `--spec-type` still starts, without it.

## Non-goals

- A setting or page control for it (the extra arguments already cover overrides).
- Draft-model speculation; allowing the refused `model-draft`/`md` flags.
- Remote backends (they are the user's own servers).

## Approaches

- **A. A line in the presets file's `[*]` section when the binary supports it (chosen).** One place, overridable per model, no new setting.
- B. Add it to each recipe's extra arguments: shows up as user-editable text and doesn't reach models the user added.
- C. A new setting: one more knob for something with no measured downside.

## Decisions

- `renderPresets` gets an option `speculative: boolean`; when true, `[*]` adds `spec-type = ngram-cache,ngram-simple` after `cache-reuse = 256`.
- `supportsSpeculative(helpText)` in `router.ts`: true when the help text contains `--spec-type` and `ngram-cache`. `serverPool` already reads `llama-server --help` for `supportsRouter`; it passes the answer to `renderPresets`.
- A model's own `--spec-type` in extra arguments is written in its section as today and wins.
- README: the latency table gets the numbers above and a short "Speculative decoding" note (what it is, that answers don't change for Next Edit, how to turn it off per model).

## Left to the builder

- Where the support flag is stored between the help read and preset rendering.
