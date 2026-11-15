# Phase 2 revisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change Phase 2 (branch `feat/chat-thinking`) as the user asked after reviewing it: models that cannot stop thinking fail instead of getting more time, every route has a 5 s default deadline, the Thinking switch is a readable dropdown that the connection test helps fill in, OpenRouter stays on the chat route with the evidence recorded, and two prompt-cache improvements learned from Twinny.

**Architecture:**
- Thinking becomes a hard failure. A chat request aborts on the first sign of reasoning and throws `ThinkingError`. The provider records the model as thinking and stops asking it until the user retries, passes a test or changes settings.
- The connection test fails such a model and tries the other thinking switches, suggesting the first one that works.
- The prefix window starts on fixed line steps, and extra context keeps a stable order, so llama.cpp's and Strata's prompt caches keep the prompt start.

**Tech Stack:** unchanged (TypeScript ~6.0.3, esbuild, vitest, `@vscode/test-cli`). No new dependencies.

**Spec:**
- `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md` (Phase 2 sections) and `docs/superpowers/specs/2026-11-14-backend-manager-design.md`.
- The Phase 2 plan, `docs/superpowers/plans/2026-11-15-phase2-chat-thinking.md`, for context.
- **The user's decisions of 2026-11-15 override both specs where they conflict:**
  - "Models that can't stop thinking should fail instead of extending deadline, this should be caught when testing the connection";
  - "for unknown model families there should be a dropdown for different methods of disabling thinking";
  - "A configurable deadline should be defaulted at 5 seconds";
  - OpenRouter support is the assistant's judgment call. **Ruling: keep it, chat route only** (evidence in Task 4).

**Branch:** `feat/chat-thinking` (continue on it; never push from a task).

## Global Constraints

- Everything in the Phase 2 plan's Global Constraints still holds: the `vscode` import allowlist; privacy and logging rules; page rules; zero runtime dependencies; commit rules.
- A git-ignored `.env` in the repo root holds the user's test credentials. Never read, log, copy or reference its contents. Tasks test against mocks.
- **Removed:**
  - `REASONING_ALLOWANCE_TOKENS`;
  - `DEFAULT_REASONING_TIMEOUT_MS` and `FimValues.reasoningTimeoutMs`;
  - `DEFAULT_CHAT_TIMEOUT_MS` and `FimValues.chatTimeoutMs`;
  - the `thinksAnyway` allowance;
  - the status-bar thinking note (`thinkingNote`, `StatusBar.setThinking`, the `thinking` dep) and the one-time `cannotDisable` notification (`notify` dep, `warnCannotDisable`).
- **Deadline:** every route, the chat route included, uses `FimValues.timeoutMs`: the backend's `fim.timeoutMs`, else the existing 5000 ms default. The connection test keeps `TEST_TIMEOUT_MS` (30 s) for its first request, because a model may be loading.
- **Status texts, exactly:**
  - `<id>: <model> cannot turn thinking off`, for a `cannotDisable` strategy, including OpenRouter after `effort:"none"` was rejected;
  - `<id>: <model> keeps thinking`, after a `ThinkingError`.
  - Both carry the action `{ command: 'aiAutocomplete.manageBackends', args: [{ focus: <id> }] }`.
- **Log texts (once per backend and model, warn), exactly:**
  - `model "<model>" cannot turn thinking off: autocomplete needs a model that answers without thinking; choose another model in AI Autocomplete: Manage Backends`;
  - `backend "<id>": <model> keeps thinking with the "<label>" thinking switch: choose another switch or another model in AI Autocomplete: Manage Backends`.
- `PROBE_TIMEOUT_MS = 10000`. `THINKING_PROBES` is every strategy except `none` and `cannotDisable`, in `THINKING_STRATEGIES` order.

## Review Focus

1. **An empty think block is not thinking.** With thinking off, Qwen3 templates prefill `<think>\n\n</think>\n\n`, and some servers stream it in `content`. Content `<think>\n\n</think>\n\n<COMPLETION>a + b;` completes as `a + b;` with no `ThinkingError`.
   - Tests: `an empty think block does not fail the request` (Task 1, `stream.test.ts`) and the Strata integration test (Task 1).
2. **Reasoning that arrives only inline.** A server that does not split reasoning out sends `<think>Let me` in `content`. This is a `ThinkingError` just like a `reasoning` event.
   - Test: `an inline think opener with text fails fast` (Task 1).
3. **Recovery.** After `keeps thinking`, "Retry now", a passing connection test or an API-key change lets the next trigger send a request again.
   - Test: `forgetLearned clears thinks` (Task 1) and the integration test `a model that keeps thinking fails, and Retry now asks again` (Task 1).
4. **The stepped prefix window** never exceeds `maxPrefixChars`, and always keeps the whole cursor line up to the cursor.
   - Tests: `stepped window respects the char cap` and `stepped window keeps the cursor line` (Task 3).
5. **The stable extra-context order** survives a smaller budget. Earlier picks keep their relative order, and the ones that no longer fit are dropped from the end, not reshuffled.
   - Test: `pick keeps earlier picks in order when the budget shrinks` (Task 3).

---

### Task 1: Thinking fails fast; one 5 s deadline

**Files:**
- Modify:
  - `src/completion/{effective,route,stream,provider}.ts`, `src/models/capabilities.ts`;
  - `src/ui/{statusBar,statusModel}.ts`, `src/extension.ts` (remove the thinking note and the notification);
  - `test/integration/fim.test.ts`.
- Test:
  - `test/unit/{effective,route,stream,capabilities,statusModel}.test.ts`, plus any unit test that asserts a removed value;
  - `test/integration/fim.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  // route.ts
  export type NoRoute = 'mode' | 'template' | 'thinking';
  /** True when the chat route must not be used for this model: a cannotDisable strategy (after chatThinking), or a model learned to keep thinking. */
  export function thinkingBlocked(strategy: ThinkingStrategy, flavor: HostFlavor, learned: Learned): 'cannotDisable' | 'keepsThinking' | undefined;
  // stream.ts
  export class ThinkingError extends Error {}   // name 'ThinkingError'
  // collectCompletion(backend, planned, acc, ctl, opts?: { failOnThinking?: boolean })
  //   with failOnThinking, the first reasoning event, or a think opener followed by any non-whitespace reasoning text, aborts ctl and throws ThinkingError
  // capabilities.ts
  // Learned: { rejected; failedRoutes; thinks: boolean }   (thinkingMs removed)
  // sawThinking(backendId, model): boolean   // true the first time
  // forgetLearned(backendId): void           // replaces forgetRoutes: clears failedRoutes and thinks, keeps rejected fields
  ```
- `buildChatRequest` no longer takes `thinksAnyway`. `maxTokens` is the FIM budget plus `CHAT_OVERHEAD_TOKENS`, and `timeoutMs` is `fim.timeoutMs`.

**Behaviour:**
- **Provider, before sending:** when the planned route is `chat` and `thinkingBlocked(...)` returns a reason, the provider reports the matching status text and action, logs once, and returns `[]` without a request. `forgetLogged()` resets that log line as it does today.
- **Provider, on the chat route:** it calls `collectCompletion(..., { failOnThinking: true })`.
- **Provider, on a `ThinkingError`:**
  - `capabilities.sawThinking`;
  - status `keeps thinking` with the action;
  - the warn log once;
  - no `recordBackendFailure`: this is configuration, and the next request is blocked anyway;
  - nothing is cached.
- **Recovery:** "Retry now", `onTestPassed` and the API-key change call `forgetLearned`. `rebuild()` still clears all capabilities.
- **OpenRouter** keeps `EFFORT_NONE_REJECTED`. After the rejection, `chatThinking` returns `cannotDisable`, so `thinkingBlocked` returns `'cannotDisable'`.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // stream.test.ts
  test('a reasoning event fails fast with ThinkingError and aborts', () => { /* events: reasoning 'hm', content '<COMPLETION>a' → rejects ThinkingError; ctl.signal.aborted */ });
  test('an inline think opener with text fails fast', () => { /* content '<think>Let me' → ThinkingError */ });
  test('an empty think block does not fail the request', () => { /* content '<think>\n\n</think>\n\n<COMPLETION>a + b;' then finish 'stop' → text 'a + b;' */ });
  test('without failOnThinking the old behaviour holds', () => { /* reasoning then content → text returned, thinking true */ });
  // route.test.ts
  test('thinkingBlocked', () => { /* cannotDisable → 'cannotDisable'; openrouter + rejected EFFORT_NONE_REJECTED → 'cannotDisable'; learned.thinks → 'keepsThinking'; otherwise undefined */ });
  test('chat requests use the FIM deadline and no allowance', () => { /* buildChatRequest(...).timeoutMs === fim.timeoutMs (5000 by default); maxTokens === budget + CHAT_OVERHEAD_TOKENS for every strategy */ });
  // capabilities.test.ts
  test('forgetLearned clears thinks and failed routes, keeps rejected fields', () => {});
  // effective.test.ts: rewrite the chatTimeoutMs/reasoningTimeoutMs assertions to "timeoutMs is 5000 by default and backend fim.timeoutMs replaces it".
  ```
- [ ] **Step 2: Run** `npx vitest run test/unit/stream.test.ts test/unit/route.test.ts test/unit/capabilities.test.ts test/unit/effective.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Remove the values listed under Global Constraints "Removed", and update every unit test that asserts them.
- [ ] **Step 4: Rewrite the integration tests** in `test/integration/fim.test.ts`:
  - **`a model that keeps thinking fails, and Retry now asks again`:** the mock is a Strata-flavored backend with `chat: { reasoning: ['Let me think.'] }`.
    - The first trigger sends one chat POST, shows no ghost text (check with `commit()`), and the status includes `keeps thinking`.
    - The second trigger sends no POST.
    - After `aiAutocomplete.retry`, a trigger sends one POST.
  - **`a model that cannot turn thinking off sends nothing`:** alias `gpt-oss-20b` on a Strata-flavored backend. A trigger sends no POST, and the status includes `cannot turn thinking off`.
  - **Remove** the "thinks anyway still completes", "notify once" and "thinking until the timeout, then the allowance" tests.
  - **Keep** `ghost text from a chat model on Strata, thinking off`, and give its mock content the prefilled empty block `<think>\n\n</think>\n\n<COMPLETION>a + b;` (Review Focus 1).
- [ ] **Step 5: Run the full check and** `npm run test:integration`. Expected: PASS.
- [ ] **Step 6: Commit.** `fix: models that keep thinking fail fast; one 5 s deadline`.

### Task 2: Connection test and the Thinking dropdown

**Files:**
- Modify: `src/manage/{protocol,form,pageState,connectionTest}.ts`, `src/webview/backends/render.ts`, `test/integration/backends.test.ts`.
- Test: `test/unit/{form,pageState,connectionTest,render}.test.ts`.

**Interfaces:**
- Consumes: `thinkingBlocked`, `ThinkingError`, `collectCompletion(..., { failOnThinking })` (Task 1); `thinkingFields`, `THINKING_STRATEGIES`.
- Produces:
  ```ts
  // form.ts
  export const THINKING_LABELS: Record<ThinkingStrategy, string>;
  // protocol.ts: FieldView gains optionLabels?: Record<string, string>   (value → label; render.ts uses it for <option> text)
  // connectionTest.ts
  export const PROBE_TIMEOUT_MS = 10000;
  ```
- `THINKING_LABELS`, exactly:
  - `none`: `Model doesn't think (send nothing)`
  - `templateKwarg:enable_thinking`: `enable_thinking: false (Qwen3, GLM, Gemma 4, Nemotron 3)`
  - `templateKwarg:thinking`: `thinking: false (DeepSeek V3.1/V3.2, Kimi K2.5, Granite 3.3)`
  - `templateKwarg:thinking_mode=disabled`: `thinking_mode: disabled (MiniMax M3)`
  - `templateKwarg:thinking_budget=0`: `thinking_budget: 0 (Seed-OSS)`
  - `reasoningEffortNone`: `reasoning_effort: none (Mistral Small 4, OpenAI-style APIs)`
  - `systemSoftSwitch:/no_think`: `/no_think in the system prompt (Nemotron Nano v2, early Qwen3)`
  - `vendorThinkingDisabled`: `thinking: {type: disabled} (DeepSeek, Z.ai, Moonshot APIs)`
  - `cannotDisable`: `Can't be turned off (completions disabled)`

**Behaviour:**
- **Connection test, model step:** when the planned route is `chat` and `thinkingBlocked` (with an empty `Learned`) returns `'cannotDisable'`, or the model is in `info.thinkingMandatory`, the step is `fail`. Its text is `Model <m> cannot turn thinking off`, its hint is `autocomplete needs a model that answers without thinking; choose another model`, and the test stops there.
- **Completion on the chat route:** it runs with `failOnThinking`. On a `ThinkingError`:
  - there is no completion step;
  - the `thinking` step is `fail`, with text `<m> keeps thinking with the "<label>" switch`;
  - then the **probe** runs.
- **The probe:**
  - unless the flavor is `openrouter` (every switch sends the same field there), try each strategy in `THINKING_PROBES` except the current one, in order;
  - each try is a chat request built with that strategy, sent with `failOnThinking` and `timeoutMs: PROBE_TIMEOUT_MS`;
  - stop at the first one that returns text without a `ThinkingError`. The hint is then `choose "<label>" as the Thinking switch`;
  - if none works, the hint is `no thinking switch turned it off; choose another model`;
  - the probe never changes settings.
- **Page:**
  - The Thinking select shows `THINKING_LABELS` (through `optionLabels`); the values stay the strategy ids.
  - The model tag is `chat prompt, cannot turn thinking off`, where it was `always thinks`.
  - The route warning is `This model cannot turn thinking off; completions are disabled`.
  - `formWarnings` uses `<model> cannot turn thinking off; completions are disabled`.
  - Timeout shows `values.timeoutMs` on every route.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // connectionTest.test.ts
  test('a cannotDisable model fails at the model step', () => { /* chat family with thinking cannotDisable → model fail 'Model x cannot turn thinking off'; no completion step */ });
  test('a mandatory-reasoning OpenRouter model fails at the model step', () => {});
  test('a model that keeps thinking fails the thinking step and the probe suggests a switch', () => {
    // fake streamChat: reasoning unless req.thinking has reasoning_effort 'none' → thinking fail '<m> keeps thinking with the "enable_thinking: false (…)" switch',
    //   hint 'choose "reasoning_effort: none (…)" as the Thinking switch'; probes stop at the first success
  });
  test('the probe reports when no switch works', () => {});
  test('OpenRouter skips the probe', () => {});
  // form.test.ts
  test('the Thinking field carries readable labels', () => { /* optionLabels['reasoningEffortNone'] === THINKING_LABELS.reasoningEffortNone */ });
  test('the chat route shows the 5 s deadline', () => {});
  // render.test.ts
  test('select options use optionLabels and escape them', () => {});
  // pageState.test.ts: the tag and warning texts above.
  ```
- [ ] **Step 2: Run** the focused tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Rewrite the integration test** `testForm on Strata runs the chat route and reports thinking`:
  - the mock answers with reasoning unless the body has `reasoning_effort: 'none'`;
  - the steps are reach ok, model ok, then thinking fail with the probe hint naming `reasoning_effort: none`.
- [ ] **Step 5: Run the full check and** `npm run test:integration`. Expected: PASS.
- [ ] **Step 6: Commit.** `feat: the connection test fails thinking models and suggests a thinking switch`.

### Task 3: Prompt-cache-friendly context

These ideas come from Twinny (MIT), `src/extension/utils.ts` `prefixWindowStep` and `src/extension/completion/stable-context.ts` @ `48e5ee52e2c8690ff84680096625949c1fce55e3`. They are written from the description; no code is copied, so no attribution header is needed.

**Files:**
- Modify: `src/completion/context.ts`.
- Test: `test/unit/context.test.ts`.

**Behaviour:**
- **`buildFimWindow`:**
  - `step = max(1, floor(prefixLines / 4))`;
  - `startLine = max(0, floor((cursorLine - prefixLines) / step) * step)`, so the window holds between `prefixLines` and `prefixLines + step - 1` lines before the cursor line;
  - while the prefix exceeds `maxPrefixChars`, `startLine` moves forward by whole steps, never past `cursorLine`;
  - if the cursor line alone is over the cap, keep today's char cut at that point.
- **`ExtraContextRing`:**
  - `add()` with the same path and identical text as an existing chunk keeps that chunk's position;
  - `pick()` remembers the keys (`path:startLine`) it returned last time. Those that are still eligible and fit come first, in the same order. New chunks are appended newest-last, while the budget lasts;
  - the result keeps that order instead of being re-sorted.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  test('the window start moves in steps', () => { /* prefixLines 8 (step 2): cursor lines 20 and 21 → same startLine 12; line 22 → 14 */ });
  test('stepped window respects the char cap', () => {});
  test('stepped window keeps the cursor line', () => {});
  test('re-adding identical text keeps the chunk position', () => {});
  test('pick keeps earlier picks first and appends new ones', () => {});
  test('pick keeps earlier picks in order when the budget shrinks', () => {});
  ```
  Then update the existing `context.test.ts` window assertions that assumed `startLine = cursorLine - prefixLines`.
- [ ] **Step 2: Run** `npx vitest run test/unit/context.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full check and** `npm run test:integration`. Expected: PASS.
- [ ] **Step 5: Commit.** `perf: keep the prompt start stable for server prompt caches`.

### Task 4: Docs

**Files:** `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md`, `docs/superpowers/specs/2026-11-14-backend-manager-design.md`, `README.md`, `AGENTS.md` (only if a rule changed), `docs/ROADMAP.md`, `docs/superpowers/followups/2026-11-13-phase0-1-review-followups.md`, `docs/superpowers/plans/2026-11-15-phase2-chat-thinking.md` (Publish step 4).

- [ ] **Step 1: Update the docs.**
  - **Main spec, "Thinking control" and "Sampling presets":**
    - `cannotDisable` models and models that keep thinking fail, with the status texts and the recovery from Task 1. The user's decision of 2026-11-15 replaces the "one-time warning … observed latency" design and the reasoning allowance.
    - One 5 s default deadline, configurable per backend.
  - **Main spec, OpenRouter (verified 2026-11-15):**
    - OpenRouter's FAQ names `/api/v1/completions` ("OpenAI spec … any model with the same request/response format"). openapi.json has no schema for it, and every listed model advertises it. No metadata says whether a raw `prompt` or `suffix` reaches the model.
    - Live test on 2026-11-15 with the `add(a, b)` sample:
      - `qwen/qwen3-coder` (provider DeepInfra) honoured raw Qwen FIM tokens;
      - `qwen/qwen-2.5-coder-32b-instruct` (Cloudflare) wrapped the prompt in a chat turn;
      - `mistralai/codestral-2508` (Mistral) ignored `suffix` and answered as a chat model, also with raw `[SUFFIX]…[PREFIX]` tokens.
    - So raw FIM depends on the provider OpenRouter picks. **Decision: OpenRouter uses the chat route only.**
    - Twinny's raw-prompt approach (PR #495) is noted, with its maintainer's doubts (#455).
  - **Main spec, "FIM pipeline" step 4:** the stepped window and the stable extra-context order (Task 3), with the Twinny credit as an idea source.
  - **Backends page spec:** the Thinking dropdown labels, the model-step and thinking-step failures, the probe, and the tag and warning texts.
  - **README:**
    - chat models must be able to turn thinking off;
    - the Thinking dropdown and the Test suggestion;
    - the 5 s deadline.
  - **ROADMAP:** add the Phase 2 manual checks from Step 2 below.
  - **Follow-ups**, under "Twinny ideas (2026-11-15, Twinny @ 48e5ee52)", one line each, not done here:
    - complete while the suggest widget is open (needs a spec decision);
    - prefetch the next line for local servers;
    - recent-edit hunks as context, designed with the Phase 3 edit-history tracker;
    - warm-up request for local servers;
    - structural stop rules;
    - bounded LSP definitions and signature help;
    - test chat-wrapped FIM for Qwen3-Coder;
    - Twinny's secret shield for hosted providers.
- [ ] **Step 2: Update Phase 2 Publish step 4** in `docs/superpowers/plans/2026-11-15-phase2-chat-thinking.md`:
  - **OpenRouter mandatory-reasoning models:** now *fail clearly*. The page tags them `cannot turn thinking off`, Test fails, and the status bar shows `cannot turn thinking off`.
  - **A model that keeps thinking:** Test suggests a working switch.
  - **Remove** the "slow but works" expectations.
- [ ] **Step 3: Commit.** `docs: thinking models fail fast, 5 s deadline, OpenRouter evidence, Twinny ideas`.
