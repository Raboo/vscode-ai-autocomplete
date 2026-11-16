# LM Studio MLX fixes — design

Date: 2026-11-16. A small fix phase before Phase 4, asked for by the user after the Phase 3c smoke test. The main spec still applies.

## Why

Completions on LM Studio's MLX engine are wrong in two ways, both found live on the user's LM Studio 0.4.28 with `sweep-next-edit-v2-7b-oq4e` (MLX) over streamed `/v1/completions`:

1. **A dropped leading space.** mlx-lm's streaming detokenizer removes one leading space from the first text it emits (`_maybe_trim_space` in `mlx_lm/tokenizer_utils.py`, read only). So `    return` + an answer that should be ` a + b` shows `returna + b`, and an answer meant to start with `    return` on a new line arrives one space short. LM Studio returns no logprobs or tokens, so the text alone cannot tell a dropped space from a real continuation (`u.na` + `me` is correct).
2. **An error instead of an answer.** When generation ends at the token limit while the end of the text partly matches a stop string that starts with a line break, LM Studio ends the stream with `event: error` "Error in iterating prediction stream: StopIteration" (HTTP 400 without streaming), and the buffered text is lost. Varying `max_tokens` showed it exactly: the answer `0\n\nwhile` errors when cut at `0\n\n` and not when cut elsewhere. The extension sends `\n\n\n` as a stop, so any completion that reaches its limit just after a line break fails, and the status bar shows an error and backs off. Seen with `\n\n\n` and `\n\nwhileX`. Not seen with special-token stops: an answer cut at the limit inside `<|cursor|>` (tail `<|`, a partial match of `<|fim_prefix|>` and others) ended normally.

## Goals

- Completions on LM Studio keep their leading space and indentation.
- A completion on LM Studio that reaches its token limit after a line break shows its text instead of an error.

## Non-goals

- Next Edit: Sweep already repairs its first line (Phase 3b), Zeta's answer starts with a marker token, and chatXtab goes over chat.
- The chat route: its answer starts inside `<COMPLETION>`, so the first emitted text is never a space.
- Reporting the bugs upstream (the user may; the design does not depend on a fix).

## Approaches

- **A. Hold back the end of the line, restore at line start (chosen, checked live).** Two rules, by where the cursor is:
  - *The cursor's line has text before the cursor:* the prompt's prefix ends before the line's last non-space character, and that character plus the spaces or tabs after it is "held". The answer then starts with the held text, which is never a space, so nothing is trimmed; the extension strips the held text from the answer. If the answer does not start with it, the model went another way and there is no suggestion. Live, with the qwen template: `return`→` a + b`, `count =`→` 0`, `def area(w,`→` h`, `(u) =>`→` u.name`, `fib(`→`n - 1) + fib(n - 2`, `return `→`a + b`, `u.na`→`me`.
  - *The cursor's line is empty or only indentation:* nothing is held. The trim removes exactly one space and only when the answer starts with one, so an answer that still starts with a space lost one, and one space is added back. An answer that starts with anything else is left alone (at the start of a line, a model does not begin with a lone space before text). Live: `def f(x):\n`→`   return` restored to 4 spaces, `def f(x):\n  `→` return` to 2 more, `def f(x):\n    `→`return` unchanged, blank lines before the cursor unchanged.
  - Holding back a line break does not work: the suffix already starts with one, so the model fills the current line instead (`for item in items:` + held `\n` answered `\r`). Holding back across blank lines fails the same way, so the hold never crosses a line break.
- B. Guess the space back (word char after word char means a space was lost): wrong for mid-word completions such as `u.na`→`me`.
- C. Ask LM Studio which engine runs the model (`/api/v0/models` has `compatibility_type: mlx`) and repair only MLX models. Partly adopted after review: the hold-back is right on any engine (the held text is removed whether or not a space was trimmed), so it applies to every LM Studio model; the line-start rule adds a space, which is wrong on an engine that does not trim, so it applies only to models LM Studio lists as MLX (unknown engine: no space is added).

## Decisions

- **The repair** applies to FIM requests on the `lmstudio` host flavor over the raw template route. With text on the cursor's line, the held text is the match of `/\S[ \t]*$/` on that line; otherwise nothing is held and the line-start rule applies, for a model `/api/v0/models` lists as `mlx` only (listed once per backend, again after 30 s for a model it did not know). The template renders the shortened prefix. The stream repairs the answer before any stop or multi-line rule sees it: it buffers until it has at least as many characters as the held text (chunks can split inside it), then drops the held text and passes the rest on; an answer that does not start with it ends the stream with no suggestion, and the debug log says the answer did not continue the line.
- The Backends page's Test builds its completion with the same `buildFimRequest` and `collectCompletion` as the editor, so the repair lives below those and Test shows repaired text too.
- **Stops:** requests to the `lmstudio` flavor send only stops without whitespace (special tokens such as `<|endoftext|>`); stops with whitespace (`\n\n\n`, Codestral's `\n+++++ `) are applied on the extension's side only, as every stop already is for completions. Next Edit's raw formats keep sending their stops (none contain whitespace).
- A mock-server mode that drops the first leading space, as MLX does, pins the hold-back in an integration test.

## Left to the builder

- Where the repair lives (request building vs the backend's stream), as long as the editor and Test share it.
- Ships as 0.5.1 (`fix:` commits) on a branch off main.
