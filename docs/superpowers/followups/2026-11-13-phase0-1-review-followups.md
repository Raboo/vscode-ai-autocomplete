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

- The status-bar thinking note changes only after a success, or a timeout while the model was thinking. After a model switch on the same backend whose requests fail, the old model's note stays.
- The `kind` argument of `explainUnsupported` is optional, so a caller that leaves it out loses the Mistral text.
- Not covered by integration tests: the thinking note clearing on a model switch; no chat text logged while `logPrompts` is off (needs a `Log` spy); a backend `fim.stop` stopping the chat answer on the client side; the debouncer's settings-change guard.

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
