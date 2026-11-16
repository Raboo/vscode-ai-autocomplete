# Phase 0–1 review follow-ups

Known issues found by the per-task reviews and the final whole-branch review of the Phase 0–1 plan, and left open on purpose. None blocks v0.1.0. Pick them up when you next touch the area, or fold them into a later phase's plan. Remove an entry when it is fixed.

## Settings

- `fim.disableInLanguages` and `fim.extraContext` keep normal resource precedence. A workspace can therefore widen what the extra-context ring captures, or turn extra context back on. The data still goes only to the user's own backend.
- Numeric settings accept 0, negatives and fractions. Add `integer` and `minimum` to the schema and clamp them in `num()`.
- Problems are reported inconsistently for dropped values (bad `hostFlavor`, non-string headers, non-object `modelOverrides`).
- Defaults live in both `package.json` and the `settings.ts` fallbacks, and no test checks they agree.
- `toggle` writes Global, so a workspace `fim.enabled` value silently overrides it.

## Backends and transport

- An abort with a custom reason is classified as a network failure. Callers must use a plain `abort()`.
- Late in-flight failures count as consecutive. After the circuit expires, a single failure re-opens it.
- Failed model detection (`GET /models`) is not backed off. It probes again on every debounced keystroke while the server is down, or while a server lists several models and the backend sets no `fimModel`.
- `0.0.0.0` and `::` count as not local. This fails safe.
- A `/props` response that is not ok is not cancelled. A missing `res.body` silently ends as an empty completion.
- A user `Authorization` header in a different case is sent alongside the stored key.
- `Content-Type` can be duplicated the same way.
- `extraBody` can override `stream`, `model` and `prompt`. This is a user opt-in.

## Context, filters, provider

- Ring chunk text has no cap. A chunk from a minified file never fits the budget, but it still takes one of the 16 slots until it is evicted.
- `ContextTracker` splits the whole document on every capture.
- In multi-root workspaces, relative paths can collide in the ring.
- One debounce timer is shared across editors.
- The trailing ``` fence is stripped even when there is no leading fence.
- `#` inline comments are not detected.
- `levenshteinRatio` has no length short-circuit, and the whole accumulation is re-split on every push.
- Exceptions in our own code inside `run()` are counted as backend failures.
- A missing API key makes the status flicker.
- `provider.ts` has some 160–190-character lines.
- The "retrying in N s" countdown only refreshes on a keystroke.
- Retry and key changes also clear unrelated errors until the next keystroke.
- Adding or removing a workspace folder triggers a full rebuild.

## Tests

- Integration test 2's `requests.length === 0` is trivially true.
- The cache "newest wins" test does not tell the two orders apart.
- `Debouncer` boundary cases are untested: `elapsed == delay`, and the call time recorded after an abort.
- SSE tests miss three cases: a `\r`|`\n` split across chunks, a UTF-8 character split across chunks, and cancellation on `[DONE]`.
- The action-pin test accepts a pin without the `# vX.Y.Z` comment.

## CI and automation (check at the first push)

- actionlint has never been run, because the Docker daemon was down: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest`.
- CodeQL **default setup** must stay off. While it is on, uploads from the advanced `codeql.yml` workflow are rejected.
- Watch whether Dependabot auto-merges, which use `GITHUB_TOKEN`, trigger the `push` workflows on `main`.
- `setup-github-repo.sh` treats an unknown `-*` argument as the repo. The first `gh` call fails before any write, but the script should reject the argument up front.
- The ruleset lookup can return more than one id. Use `first(...)` and `includes_parents=false`.
- The Dependabot `actions` group has no `update-types: [minor, patch]`, so one major bump holds back the whole group.
- The dry-run output escapes the commas in the topic list (cosmetic).
- There is no `.vscode-test` cache, and the integration tests run against an unpinned `stable` VS Code.

## Backends page (2026-11-14 review)

- Opening the page under `privacy.localOnly` resolves the backends' hostnames via DNS (no HTTP request, no user data).
- Clicking Edit on another card, or a status-bar click that focuses a card, replaces an open draft without asking.
- The page script (`src/webview/backends/main.ts`) has no committed tests: focus restore, key isolation and the hold logic are untested.
- Focus is lost when the focused control disappears or is disabled, and showing the tab again moves focus to the server type.
- A narrow race between a host state and an in-flight `formChanged` can lose an edit.
- Config and secret change events post the state outside the panel's message queue, so a duplicate-name error or a doubled card can flash briefly.
- Page messages without an `id` pass the host's guard, and `remove`/`removeKey` do not check that the id exists.
- The `LOCAL_ONLY` text and the local-only gate are duplicated between `connectionTest.ts` and `backendsPanel.ts`.
- A cancelled test of a new draft keeps its result under the proposed id, and a rename does not move test results or detected models.
- The panel does not post a new state when workspace folders change.
- `backendsPanel.ts` is about 460 lines; split it when next touched.
- `getJson` duplicates `postJson`'s non-ok handling; the hosted check is duplicated in `fieldViews` and `formWarnings`.
- Header names typed on the page are not validated, so a bad name fails as "request failed".
- `.vscode-test.mjs` writes the test profile's settings at import time.
- With a typed template, the Stop field's default follows that template's stops, but its hint still says "built-in preset for this model".
- On llama.cpp, a model with no built-in template (for example Zeta) routes natively in `auto` mode, so the page disables the Template field; choosing seed-coder there means switching the prompt mode to `template` first.
- The model list's tags go stale after a prompt-mode or template change until the list is reloaded.
- When the model is not detected, the "model not detected" message wins over a prompt-mode problem.

## From the v0.1.0 smoke test (2026-11-15)

- The connection test sends a tiny sample prompt, so it can pass while real prompts fail. oMLX (an LM Studio engine) rejects larger prompts with a prefill memory guard when the model barely fits in RAM. A test step with a prompt near the backend's context size would catch this.
- Kilo Code, Continue and other installed autocomplete extensions compete for the same ghost text. Detecting another active inline-completion provider and saying so on the Backends page would save a debugging round.

## From Phase 2 (2026-11-15)

- The connection test's chat sample and thinking step run once; a model that thinks only on longer prompts passes it.
- LM Studio's native `/api/v1/chat` (`reasoning: "off"`) is not used, so thinking cannot be switched off per request there (see the main spec's "To verify").

Parked by the Phase 2 reviews (the final review's fix wave did the rest):

### Thinking control and the reasoning filter

- `THINKING_STRATEGIES` is a hand-kept copy of the `ThinkingStrategy` union, with no type-level check that the two agree.
- On the chat route a bare closing tag still drops everything before it, so a chat answer whose code contains `</think>` (or `[/THINK]`, `<channel|>`) loses the text before it. FIM routes strip only a leading reasoning block.
- FIM routes pass no finish reason. An unclosed reasoning block at the start of FIM output shows nothing and a later opener is kept as code, so this matters only if a FIM model ever reasons mid-output.
- `thinking.test.ts` gaps: `thinking` for an unclosed block, a closer split across pushes inside a block, Harmony's `<|end|>` followed by the final marker, and a bare `[/THINK]`.
- `TAGS.find` relies on no tag being a prefix of another; a comment should say the list must stay prefix-free.

### Chat transport and OpenRouter

- No test covers a 400 that names a field and whose retry also fails.
- The `hosted` flag that `OpenAiCompatBackend.streamChat` passes is untested.
- `HOSTED_MAX_STOPS` is defined twice (`chat.ts` and `openaiCompat.ts`); the FIM and chat limits must stay equal.
- A delta with an empty `reasoning` string and a non-empty `reasoning_details` yields no reasoning event, so the thinking signal is lost.
- `openrouter.test.ts` has no `__proto__` model id case.
- `OpenRouterBackend.detectModel()` takes no `signal` on purpose; a comment should say so.

### Hole filler and the stream loop

- No table-driven test pins that streamed answers only grow (each one a prefix of the next and of the final answer).
- Without an opening tag, a closing tag followed by whitespace (`a + b;</COMPLETION>\n`) stays in the answer.
- `<COMPLETION>` quoted inside leaked reasoning can become the answer. It needs single-line mode, a server that does not split reasoning out, a template that prefills `<think>`, and reasoning that quotes `<COMPLETION>draft` plus a newline. A fix would ignore `<COMPLETION>` before a later bare closer.
- `stoppedEarly` is true for a chat stream that had already finished when the final settle hits a stop rule.

### Routes

- `SAMPLING_WIRE` (`route.ts`) and `SAMPLING_FIELDS` (`chat.ts`) both own the wire names of the sampling fields.
- No test uses llama.cpp's real 501 body (`Infill is not supported by this model`).
- A cast in `route.test.ts` (`as unknown as HoleFillerInput`) hides a missing `filePath`.

### Provider

- The `kind` argument of `explainUnsupported` is optional, so a caller that leaves it out loses the Mistral text.
- Not covered by integration tests: no chat text logged while `logPrompts` is off (needs a `Log` spy); a backend `fim.stop` stopping the chat answer on the client side; the debouncer's settings-change guard.

### Backends page

- The connection test for the mandatory-reasoning `z-ai/glm-5` asserts only `state: 'warn'`; it should assert the text and the hint.
- On the chat route the Stop field's source label names the preset or the overrides, though `</COMPLETION>` comes from neither; it should say built-in.
- A `form.test.ts` fixture is declared with `kind: 'openai'` and then changed to `llamacpp`.

### Integration tests

- The 2500 ms sleep in the 404-mentions-a-model test proves "tried again after backoff" only weakly.
- Backoff is a hard 2 s window. On a slow CI host the second trigger in the no-fallback test could land after it; watch for flakes.
- `commitWhen` returns silently on timeout; its callers assert afterwards.
- The Strata test checks for no `[thinking]` right after the commit, before a late status update could land.

## Twinny ideas (2026-11-15, Twinny @ 48e5ee52)

Not done in the revisions:

- Complete while the suggest widget is open (needs a spec decision).
- Prefetch the next line for local servers.
- Recent-edit hunks as context, designed with the Phase 3 edit-history tracker.
- Warm-up request for local servers.
- Structural stop rules.
- Bounded LSP definitions and signature help.
- Test chat-wrapped FIM for Qwen3-Coder.
- Twinny's secret shield for hosted providers.

## Strata gaps (2026-11-15)

Measured on the user's Strata (no address here):

- No raw-prompt endpoint: `/v1/completions`, `/completion` and `/infill` answer 404.
- Its chat path treats FIM tokens as text.
- It applies `presence_penalty` 1.5 by default, so the extension always sends an explicit value.
- It caps stop strings at 4.
- It has no `t_max_predict_ms`.
- Raw FIM, or the sweep and zeta Next Edit formats, would need a Strata PR first.

## Phase 2 smoke test (2026-11-15)

- LM Studio cannot turn thinking off per request for Hugging Face downloads (spec "To verify"). A raw `/v1/completions` route that sends the chat prompt in the model's chat format, with an empty think block and `<COMPLETION>` already filled in, avoided thinking there (0.8–1.5 s on Qwen3.5-4B) and would need no LM Studio setup.
- Qwen3.5-4B on LM Studio, chat route: at the end of a line it often answers the next line with neither a line break nor indentation, so the suggestion continues the cursor line (the line-break rule needs leading indentation); on an empty line at column 0 it sometimes starts with a line break.

## Phase 2 revisions (2026-11-15)

Parked by the revisions' task reviews and final review (the fix wave did the rest).

### Code

- `NoRoute` has a `'thinking'` variant that `whyNoRoute` never returns, so `noRouteText('thinking')` is dead and untested: use it (for example in `explainUnsupported` or `pageState`) or drop it.
- The `cannotDisable` log reads `model "the model" cannot turn thinking off…` when no model is known, and names no backend although it is logged once per backend.
- `reportThinking` builds a local `outcome` only to return it.
- `Collected.thinking` has no production reader left, and in literal mode `visible` and `thinking` can be garbled for answers that contain tags (only the `logPrompts` debug line shows them): drop `thinking`, or document that it is approximate.
- `inlineThinking` parses the whole raw content again on every chunk (quadratic; negligible at 160 tokens).
- An unnamed 400 on the chat route drops the thinking fields, not the Strata pin (`strata_prefix`): a design note.
- The probe hint "this server turns thinking off one way only" is unreachable (documented in the Backends page spec, harmless).
- The Backends page spec says only the `/no_think` switch is tried on Strata, DeepSeek, Ollama and OpenRouter; when `/no_think` is the current switch, the request without it is tried instead.
- When the character cap cuts the prefix window, its start moves line by line, so server prompt caches miss on each new line in files with long lines; a coarser fallback grid (`step / 2`, …) could keep some of the stability (found in the fix wave).

### Tests

- The keeps-thinking integration test's "second trigger sends no POST" would also pass under a backoff: assert the status has no `retrying in`.
- The `unwrapped … is code` stream test asserts only `toBeDefined`.
- The "5 s deadline" form test pins the chat route only.
- The integration suite no longer runs the Strata-flavor chat connection test: add one asserting the thinking failure and exactly 2 requests.
- No test covers the non-BMP branch of `stableUserChars`.
- No test checks that the user's `extraBody` overrides the Strata pin.
- No integration test covers "a settings change unblocks" or "a passing Test unblocks" a model that keeps thinking; only code reading confirms them (`extension.ts` settings rebuild, `backendsPanel.ts` → `onTestPassed`).

## Phase 3a (2026-11-16)

Left open by the Phase 3a plan, its task reviews and its final review.

- Copilot's replace-to-end-of-line rebase (Ruling 12): an edit that rewrites the rest of the cursor line is dropped as an inline edit instead of being rebased into ghost text.
- No drift check is possible right before VS Code applies a native inline edit (Review Focus 1): between an edit appearing and Tab, VS Code may have shifted its range. Covered only by the smoke test.
- Rejected-edit memory: after Esc, only a 5 s cooldown applies, so the same edit can come back.
- The import-only edit filter: edits that only change import lines are not filtered out.
- Use the proposed `onDidChange` instead of the `inlineSuggest.trigger` command to show a fresh result (Ruling 9). After an explicit trigger (Alt+\) at a document version and cursor, VS Code never shows a later Next Edit result for that same state (it treats the trigger as answered); fixing it needs the `onDidChange` path or a design change.
- A Next Edit state in the status bar (Ruling 8): failures are only logged and notified.
- Test on the Backends page should also test Next Edit (the `nextEditModel`).
- The settings deferred in Ruling 7: `nextEdit.format`, `nextEdit.display`, region size, history size and `nextEdit.contextBudget`.
- `EDIT_ECHO_MS` is a 100 ms time heuristic; a version-based echo check would be sturdier, and a slow CI runner could double-request.
- The shared backoff means a Next Edit timeout pauses FIM on the same backend: decide whether Next Edit should have its own backoff.
- Requests already asked for a version and line are not retried after a dropped result or a failure until the document changes (R16 trade-off).
- The extra-context ring (FIM) has the same "file reopened in a disabled language" gap that Next Edit's history now handles with `forget()`.
- During a backoff caused by a Next Edit failure, FIM goes silent with the status bar idle: FIM's own failure detail is what shows the countdown, and Next Edit records none (final review M3).
- Two workspace folders with the same name still collide: paths carry the folder name (R24), not a unique folder id, so their same-named files share one history snapshot and one snippet.
- A region with a line starting with ```` ``` ```` (a Markdown code block) is not sent (R22): the answer's own fence would close on it. Supporting it needs a longer outer fence, which is a prompt change.
- Pull the controller's eligibility and store-or-drop decisions (version, editor, snooze, cursor, native UI) into pure functions with unit tests; today only the integration tests cover them.

### Smaller review notes (Phase 3a)

- A stream cut off at max tokens right after a bare ```` ``` ```` line counts as closed; treat `finish_reason: length` as truncated (R29).
- If the cursor moves after a ghost result is stored but before VS Code runs the queued trigger, FIM runs once at the new cursor (R30). The ghost-cursor rule, remote eligibility, snooze during a request and the remote-side opt-in path have no automated tests.
- `history.test.ts` "when the merged diff is too large, the edit becomes its own entry" relies on two ~400-edit diffs finishing inside the 50 ms bound; shrink the file if CI ever flakes (R31).
- Unit-test gaps: history merge cancel-out and merge-then-cap paths, top-of-file insertion header; region tests with mixed line lengths and an exact-budget boundary; chatXtab lines after the region, real clipping, several snippets, `stableChars` with exactly 4 lines; classify on an empty file, a file without a trailing newline and the ghost path that starts above the cursor line; caller-abort propagation and a split empty think block in `request.test.ts`; the Backends page placeholder with a blank model.
- `clipAroundRegion` throws on a region past the file end (callers pass matching line counts), and unused budget below the region does not flow back above it.
- `parseChatXtab`'s think-block check duplicates `stream.ts`'s predicate; `runNextEdit` adds its abort listener before its `try`.
- The provider does not guard `itemFor`; a throw there leaves FIM empty for that call.
- argv.json is written in place, without a backup or an atomic rename.
- `useNextEditBackend` repeats `useBackend`'s target rule and `pickBackend`'s lookup; the collapsed backend card does not show `nextEditModel`.
- Integration: "without the proposed API an edit elsewhere is not applied" also passes when nothing is offered; the stale-result test may pass through cancellation; both launches share one user-data dir.

## Phase 3b (2026-11-16)

### Ideas from sr-tream/vscode-nes (AGPL-3.0: ideas only, no code)

Left out of 3b on purpose (Ruling 13). Each would help in the way named.

- Suppression rules (window unfocused, a multi-line selection, a bulk change, snippet mode): fewer wasted requests and no suggestions while the user is doing something else.
- LSP diagnostics in the prompt: the model sees the errors a rename or a type change causes, so it can point at the next fix.
- Splitting disjoint hunks of an answer into a queue: an answer that edits two places shows one edit at a time instead of being dropped or shown as one big rewrite.
- Reusing a request while the user types into its ghost text: no new request per keystroke while the typed text still matches the suggestion.
- A cursor target after accept: Tab lands where the next edit probably is, so repeated Tab walks through a change faster.
- A context-exit retrigger: leaving a string, comment or block asks again at once instead of waiting for the next pause.
- Native `displayLocation` labels and `debounceDelayMs: 0` metadata: VS Code labels the edit and does not delay it, which makes the native view feel faster.

### Parked during execution

- Local integration runs: the user's `~/.vscode/argv.json` (the native opt-in) also enables the proposed API in the test VS Code, so three `main`-launch tests fail locally; CI has no such file. Isolate `.vscode-test.mjs` from `~/.vscode/argv.json`.
- Sweep: the original-window shift test is weak (old and new text are equal at the shifted position); no +20/+21 boundary test; no v2 test that drops a hunk with `<|cursor|>`; the current file path is not checked for reserved strings; an all-blank window gets its blank lines appended to a non-blank answer.
- Zeta: a tail block replaced by one blank line is treated like a deletion; deleting the whole region leaves one empty line; the same marker twice with text between counts as no change, so an insertion answered that way is ignored; no test for a cursor on a block boundary.
- History: after a file is closed and reopened with different text, `previous()` still describes the text before closing; hunk arrays are returned by reference.
- Settings: no manifest test ties `NEXT_EDIT_LIMITS` to the numbers in `package.json`; the region defaults are duplicated with `REGION_ABOVE` and `REGION_BELOW`; at maximum settings a region is 62 lines.
- Controller and tests: no tests for the check after the history flush, or for the `historySize` and region-size wiring; the mock server's events are leaner than real servers'; no test for a caller abort on the completion path.
- Decorations: the hint text goes stale after a manual cursor move (Tab still re-plans correctly); no tests for undo-clears, editor-switch-clears or `pendingEdit().version`; the Tab and Esc `when` clauses do not exclude `parameterHintsVisible` (Esc does not exclude `inlineEditIsVisible` either); the Esc test waits out the 5 s rejection cooldown, which slows the suite.
- Menu: after a successful opt-in, **Enable native Next Edit UI...** stays until VS Code restarts.

### From the final review (Phase 3b)

- A symmetric sanity guard for raw formats: drop answers that delete many non-blank lines while adding none, or are much shorter than the window.
- Sweep v1: an answer that stops early is read as deleting the window's tail.

### From the smoke test (Phase 3b)

- LM Studio's MLX engine drops the leading space of the first generated token on `/v1/completions`, streaming or not (seen 2026-11-16 with Sweep v2 7B and Qwen3.5-4B: `def f(x):\n    return` gives `"x**2"`, `def f(x):\n` gives `"   return x**2"`). Sweep now restores the missing space on its first generated line. Completions on the template route are likely affected too (`total = total +` gave `"1"`): ghost text after a word or at the start of an indented line can lose a space. **Fixed in 0.5.1** (design `docs/superpowers/specs/2026-11-16-lmstudio-mlx-fixes-design.md`): the cause is mlx-lm's `_maybe_trim_space`; LM Studio requests hold back the end of the cursor line, and at line start a leading space is restored. Still open: report it to LM Studio, and skip the hold-back for GGUF models (`/api/v0/models` `compatibility_type`) if the shortened prompt ever shows a quality cost. Also fixed: LM Studio's StopIteration error when generation ends inside a partial `\n\n\n` match.

### From the Phase 4 work

- `test/unit/nextEdit/history.test.ts` "merged diff is too large" failed once in a full run (passes isolated); find the timing dependence.
