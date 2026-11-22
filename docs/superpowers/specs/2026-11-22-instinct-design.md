# Instinct Next Edit format — design

Approved by the owner on 2026-11-22 (short design, one sensible way).

## Intent

Support Continue's open Next Edit model **Instinct** (`continuedev/instinct`, Apache-2.0, a Qwen2.5-Coder-7B fine-tune) as a fourth Next Edit format, and offer its official GGUF (`continuedev/instinct-GGUF`, Q4_K_M) in the local model helper. It is another strong local Next Edit model to compare with Zeta 2.1 and Sweep.

## Goals, non-goals, anti-goals

- Goals: an `instinct` format that reproduces the prompt the model was trained on; `auto` picks it for model ids containing `instinct`; an `instinct-7b` recipe.
- Non-goals: completions with Instinct (unverified; the recipe is Next Edit only); Continue's full-file-diff region strategy.
- Anti-goals: a prompt that drifts from the training format (the model degrades silently); unattributed copying of Continue's text.

## Approaches

1. **New chat format** (chosen): Instinct is a ChatML chat model, so it rides the existing chat route (llama.cpp, Ollama `nate/instinct`, vLLM, SGLang, LM Studio) with its own messages and parser.
2. Raw completion with a hand-built ChatML prompt: works on llama.cpp only, and duplicates what the server's chat template already does. Rejected.
3. Reuse chatXtab with a different system prompt: the section layout and answer shape differ, so the model would be off its training format. Rejected.

## The format (source of truth: the training data `continuedev/instinct-data` @ `e557e3ed`, plus Continue `core/nextEdit` @ `5522c6f`)

Where Continue's runtime code and its training data differ, the training data wins.

- **System message**: Continue's `INSTINCT_SYSTEM_PROMPT` as it appears in the training data: "…Your role as an AI **assistant** is to help…" (the runtime constant says "agent"), ending with `"\n\n"`. Copied verbatim, with attribution.
- **User message**, in this order:
  ```
  Reference the user excerpt, user edits, and the snippets to understand the developer's intent. Update the editable region of the user excerpt by predicting and completing the changes they would have made next. This may be a deletion, addition, or modification of code.

  ### Context:

  <|context_file|> `path/a.ts`
  <|snippet|>
  snippet text

  <|context_file|> `path/b.ts`
  <|snippet|>
  snippet text

  ### User Edits:

  User edited file "path/c.ts"

  ```diff
  @@ -154,10 +154,11 @@
   context
  +added
  ```

  User edited file "path/c.ts"

  ```diff
  …
  ```

  ### User Excerpt:
  "path/current.ts"

  …window lines above…
  <|editable_region_start|>
  region lines, with <|user_cursor_is_here|> inserted at the cursor
  <|editable_region_end|>
  …window lines below…
  ```
  The message ends with the last window line followed by `"\n\n"`. Edits are newest first. Each edit body is our `DiffEntry.contextText` (real hunk headers, 3 context lines; the training data has 5, which the builder may match if `history.ts` can produce it cheaply). Snippets are our recently viewed `Snippet`s. An empty Context or User Edits section keeps its heading.
- **Region**: 1 line above and 5 below the cursor (Continue's `topMargin: 1, bottomMargin: 5`), fixed, ignoring `regionLinesAbove/Below` like Zeta. **Window**: 25 lines above and below the cursor, further clipped by the file budget.
- **Answer**: the region's new lines, raw (no fence, no tags, no cursor marker), ended by the model's end-of-turn. Parser: strip `<|user_cursor_is_here|>`, drop lines that are only a region tag, unwrap a single surrounding ``` fence if present; an empty answer is `invalid` (`empty`). The answer is used once the stream finishes (`done` never ends it early).
- **Reserved strings**: an input containing any of the five Instinct tags (`<|editable_region_start|>`, `<|editable_region_end|>`, `<|user_cursor_is_here|>`, `<|context_file|>`, `<|snippet|>`) in file, history or snippets is refused or skipped (snippets), like the other formats.
- **stableChars**: the user message up to the end of the Context section (snippets change rarely; edits change with every edit).

## Other changes

- `FormatId` and `NEXT_EDIT_FORMATS` gain `instinct`; `package.json` enum and description; `formatIdFor` picks it for `/instinct/i` (checked before Zeta and Sweep); `nextEditFormatLabel` says "Instinct format".
- `presets.ts`: an `instinct` row (`/instinct/i`, no thinking), before `qwen-coder`.
- Recipe `instinct-7b`: label "Instinct 7B", repo `continuedev/instinct-GGUF`, revision `c3f24799cc492d3252505628f49760f2fe133f43`, file `instinct-Q4_K_M.gguf`, 4683073376 bytes, sha256 `65eff06597c533456ac031479f31175e894e9e6ff79a562ed4d1f859f154af29`, Apache-2.0, uses `['nextEdit']`, model name `instinct`, context 8192, placed after `zeta-2.1`, never the default, no note (it is official).
- Attribution: `formats/instinct.ts` starts with `// Portions adapted from Continue core/nextEdit @ 5522c6f44ca0ac3528b37244818fbfa39b5af470 (Apache-2.0). Copyright Continue Dev, Inc.`; `THIRD_PARTY_NOTICES.md` names those files for Continue. AGENTS.md's ban on Continue's hole-filler prompt is unaffected (that prompt's licence is unverified; this one is Continue's own Apache-2.0 text).
- Docs: README formats table, recipes table, the benchmark row (measured by the owner or with `scripts/bench/latency.ts`), AGENTS.md layout line.

## Left to the builder

Matching 5 context lines in diffs; how many history entries (budget-driven via `newestThatFit`); test fixture contents.
