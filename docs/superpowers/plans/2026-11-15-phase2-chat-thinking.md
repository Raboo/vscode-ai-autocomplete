# Phase 2: Chat path and thinking control (v0.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ghost-text completion from chat-only and general instruct models through our own chat "hole-filler" prompt, with thinking switched off per model family and host, and reasoning always stripped. It covers Qwen3.8 on Strata, OpenRouter models, and the Qwen3.x, DeepSeek, GLM, Kimi, MiniMax, Gemma, Granite, Nemotron, gpt-oss and Mistral families on llama.cpp, LM Studio, vLLM, SGLang or Ollama. The result is released as v0.2.0.

**Architecture:**
- **New pure modules, unit-tested with vitest:**
  - `src/models/thinking.ts`: the request fields that turn thinking off for each (family strategy × host flavor), and a streaming reasoning filter;
  - `src/models/capabilities.ts`: what a server rejected or did this session, per backend and model (rejected fields, missing routes, "thinks anyway");
  - `src/backends/chat.ts`: the OpenAI-style `/chat/completions` stream, with one retry without fields the server rejects; the llama.cpp and OpenAI-compatible backends share it;
  - `src/backends/openrouter.ts`: the OpenAI-compatible backend, chat only, with OpenRouter's model metadata;
  - `src/completion/holeFiller.ts`: the chat prompt (our own wording) and the answer extractor;
  - `src/completion/stream.ts`: one loop that turns any route's stream into completion text, shared by the provider and the connection test.
- **Routing:** `planRoute` gains a third route, `chat`. In `auto` mode the order stays native → template → chat. Chat is picked only for a known chat-model family, or for a server that cannot serve raw completions. A model like Zeta therefore still reports "no completion template".
- **The provider:**
  - plans a route from what the backend offers, minus what it learned;
  - sends the request through `collectCompletion` and records what it learned;
  - shows a "thinking" warning in the status bar for a model that keeps thinking.
- **The Backends page** gets:
  - Strata and OpenRouter server types;
  - a Thinking field;
  - chat-route model tags;
  - a connection test that runs the chat route and reports a model that thinks anyway.

**Tech Stack:** unchanged (TypeScript ~6.0.3, esbuild, vitest, eslint, `@vscode/test-cli`). No new dependencies.

**Spec:**
- `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md`: Phase 2, plus the sections "Backends and how a FIM request is routed", "Thinking control", "Sampling presets", "FIM pipeline" and "Settings and security".
- `docs/superpowers/specs/2026-11-14-backend-manager-design.md`, for the Backends page.
- Read both. Where research changed the spec, the change is marked **(research)** below and recorded in the spec by Task 11.

**Branch:** a local branch `feat/chat-thinking`, created from `main`. Tasks never push. The Publish section does that, after the user says yes.

## Global Constraints

- **Imports and dependencies:**
  - Only these files may `import 'vscode'`: `src/extension.ts`, `src/log.ts`, `src/config/vscodeSettings.ts`, `src/config/secrets.ts`, `src/completion/provider.ts`, `src/completion/contextTracker.ts` and `src/ui/*`.
  - Every module this plan creates is pure.
  - Zero runtime dependencies (`manifest.test.ts` checks).
- **Privacy:**
  - No telemetry. Nothing leaves the machine except requests to a backend the user configured or typed into the page.
  - Machine-scoped settings (`aiAutocomplete.backends`, `aiAutocomplete.modelOverrides`, `aiAutocomplete.debug.logPrompts`) are read from `globalValue` only.
  - These are logged only when `aiAutocomplete.debug.logPrompts` is true:
    - prompt text, including the chat messages;
    - completion text;
    - **reasoning text**;
    - **server error bodies**.
  - A 400/422 body may be *matched* against field names to learn what a server rejects (Task 3), and an Ollama 400 body against "does not support insert" (Task 6). It is never logged or shown otherwise.
  - Always fine to log at debug level: timings, status codes, sizes, route names, model ids, and the names of fields we dropped.
  - OpenRouter's attribution headers (`HTTP-Referer`, `X-Title`) are never sent. They are optional ("Optional. Site URL for rankings", openrouter.ai/docs/api_reference/authentication).
  - A git-ignored `.env` in the repo root holds the user's test credentials. Never read, log, copy or reference its contents; tasks test against mocks.
- **Backends page:**
  - It never receives an API key.
  - Server-supplied text (model ids, error bodies) is HTML-escaped before it reaches the page.
  - Error text shown in the page is fixed text.
- **Anti-goal from the spec:** never copy Continue's hole-filler prompt. It comes from VictorTaelin/AI-scripts, whose license is unverified.
  - Our prompt (Task 5) is our own wording and has no few-shot examples.
  - It contains none of the strings `HOLE FILLER`, `{{FILL_HERE}}`, `<QUERY>` or `TASK:`. A test pins this.
  - Only the `<COMPLETION>` wrapper and the `</COMPLETION>` stop come from the spec ("FIM, chat hole-filler … stop `</COMPLETION>`").
- **Upstream code:**
  - This plan adapts no upstream code. If an implementer does adapt some, the AGENTS.md attribution header and `THIRD_PARTY_NOTICES.md` rule applies.
  - Never run upstream code.
- **Network:** every request uses `redirect: 'manual'`, and a 3xx is an `HttpError` (as today).
- **Out of scope, on purpose:**
  - **The `mistral` kind stays FIM only.** Its `routes().chat` is false, so prompt mode `chat` on it reports `prompt mode "chat" does not work with this server`. The Mistral family presets apply when those models are served elsewhere.
  - **No new host flavors for the Z.ai, Moonshot or MiniMax APIs.** The spec's flavor list does not name them. Users reach those models through OpenRouter, or through an "Other OpenAI-compatible" backend with Thinking switch `vendorThinkingDisabled` (`thinking: {type: "disabled"}`).
  - **LM Studio's native `/api/v1/chat`** (which has `reasoning: "off"`) is not used. LM Studio stays on `/v1/chat/completions`, and Task 11 records the gap.
- **Exact values:**

  | Name | Value | Lives in |
  |---|---|---|
  | `CURSOR_MARKER` | `<\|cursor\|>` | `holeFiller.ts` |
  | `COMPLETION_OPEN` / `COMPLETION_CLOSE` | `<COMPLETION>` / `</COMPLETION>` | `holeFiller.ts` |
  | `CHAT_OVERHEAD_TOKENS` | `32`. Chat `max_tokens` = the FIM budget + 32, where the FIM budget is `maxTokens` multi-line and `min(maxTokens, 48)` single-line. That is 160 / 80 at the defaults (the spec's "max_tokens 160") | `route.ts` |
  | `REASONING_ALLOWANCE_TOKENS` | `1024`, added for the `cannotDisable` strategy | `route.ts` |
  | `DEFAULT_CHAT_TIMEOUT_MS` | `15000`. A backend's `fim.timeoutMs` replaces it, as it replaces the 5000 ms FIM timeout | `effective.ts` |
  | Chat stops | `['</COMPLETION>', ...backend fim.stop]`, deduplicated. The FIM stops (`'\n\n\n'`, FIM tokens) and override stops are not used. Hosted flavors send the first 4 | `route.ts` |
  | `presence_penalty` | `0` on every chat request, unless the family's `samplingParams` is `omit` | `route.ts` |
  | `CHAT_SAMPLING` (chat families) | temperature 0.2, top_p 0.8, top_k 20, maxTokens 128 | `presets.ts` |
  | Field-retry statuses | 400 and 422. One retry, learned only if the retry succeeds | `chat.ts` |
  | Route-missing answers | 404, 405 or 501; or a 400 whose body contains `does not support insert` (Ollama). A 404 whose body mentions `model` (case-insensitive, e.g. Ollama's `model "x" not found`) does not count. A route is learned as missing only when another route remains. `auto` mode only, never counted toward backoff | `capabilities.ts` |

- **Verified host facts.** Every task relies on these, so they are listed once here. Sources were read on 2026-11-15 at these commits: llama.cpp `5c008e0`, vLLM `a16bfee`, SGLang `7b5fb39`, Ollama `a5864fc`, Strata `13eedf5`, LM Studio docs `8c7159b`. Live checks were made on the user's Strata endpoint (credentials in the git-ignored `.env`).
  - **llama.cpp:**
    - `chat_template_kwargs` per request ("For example: `{"enable_thinking": false}`", tools/server/README.md). `enable_thinking` must be a JSON boolean; a string is an error.
    - Jinja is on by default.
    - `reasoning_effort: "none"` sets `enable_thinking=false` for the template.
    - Reasoning streams as `delta.reasoning_content` (default `--reasoning-format`).
    - `/infill` on a model without FIM tokens answers **501** ("Infill is not supported by this model").
    - A prompt over the context size answers **400** (`exceed_context_size_error`).
    - `/props` has no "supports thinking" flag.
  - **vLLM:**
    - `chat_template_kwargs` is a free dict.
    - `reasoning_effort` is `Literal["none","minimal","low","medium","high","xhigh","max"]`, and `"none"` sets only `enable_thinking=false` (docs/features/reasoning_outputs.md).
    - Reasoning streams as **`delta.reasoning`**. "`reasoning` used to be called `reasoning_content`", and the old field was removed in v0.16.0.
    - Unknown request fields are ignored (`extra="allow"`).
  - **SGLang:**
    - `reasoning_effort: "none"` sets both `thinking` and `enable_thinking` to false.
    - Reasoning streams as `delta.reasoning_content`.
  - **Strata (live, and DETAILS.md):**
    - `reasoning_effort: "none"` and `chat_template_kwargs: {enable_thinking: false}` each turn thinking off. Without them it thinks at effort high, and reasoning streams as `reasoning_content`.
    - Non-thinking defaults are "0.7, 0.8, 20 with presence_penalty 1.5"; the request's own values win.
    - It has no `/v1/completions`: live, `POST /v1/completions` answered 404 `{"error": {"message": "not found"}}`.
    - It listens on `http://127.0.0.1:8080` by default. The key is optional ("A key is recommended, not required").
    - An unknown request field was accepted (live).
    - Time to first token (live, 152-token prompt): about 2.5 s cold, and 0.23 s with 145 tokens served from its prefix cache. With default thinking, the first answer token came after 3.8 s.
  - **Ollama:**
    - `/v1/chat/completions` takes `reasoning_effort`, and "`"none"` requests `false`". GPT-OSS maps `"none"` to `"low"` "because GPT-OSS cannot disable thinking".
    - `think` is not a chat-completions field.
    - Reasoning streams as `delta.reasoning`.
    - `/v1/completions` supports `suffix`. A model whose template lacks it answers **400** "… does not support insert".
  - **LM Studio:**
    - The 0.4.8 release notes add `reasoning_effort` to `/v1/chat/completions`, with values undocumented.
    - `chat_template_kwargs` is reported ignored there (lmstudio-bug-tracker #1990, open).
    - Reasoning arrives in `reasoning_content`, or `reasoning` for gpt-oss.
    - **Unverified:** whether any per-request field turns thinking off.
  - **OpenRouter:**
    - `reasoning: {effort: "none"}` "Disables reasoning entirely" (research: the spec said `reasoning:{enabled:false}`, which the docs show only as a mapping target).
    - Models whose `/api/v1/models` entry has `reasoning.mandatory: true` reject `effort: "none"`; 145 of the 471 models listed today do.
    - Reasoning streams as `delta.reasoning` and `delta.reasoning_details`. Unsupported parameters are ignored unless `require_parameters` is set. Errors after streaming starts arrive as an SSE `error` event with status 200.
    - `GET /api/v1/models` needs no key and lists `context_length` and `reasoning{mandatory,…}`.
    - `POST /api/v1/completions` answers (401 without a key) but is missing from the documentation and from openapi.json, which also never mentions `suffix`. **We do not send code to it.**
  - **DeepSeek API:**
    - `deepseek-chat` and `deepseek-reasoner` were discontinued on 2026-07-24. The current models are `deepseek-flash` and `deepseek-v4-pro`, and both think by default.
    - `thinking: {type: "disabled"}` turns thinking off.
    - Reasoning streams as `reasoning_content`.
    - FIM (`/beta/completions` with `suffix`) is "Non-thinking mode only".
  - **Mistral API:** thinking arrives as `delta.content` *lists* with `{type: "thinking"}` chunks (docs.mistral.ai, reasoning).
- **Commits:**
  - Subjects follow Conventional Commits. Each task's commit step gives the message.
  - Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Nobody edits `CHANGELOG.md` or `version` by hand.
- **Commands:**
  - Each task runs `npm run lint && npm run typecheck && npm run build && npm test` before committing (`npm test` needs the build).
  - Tasks 8, 9 and 10 also run `npm run test:integration`.
- **Keeping docs current:** `AGENTS.md` and `docs/ROADMAP.md` stay current when a task changes what they describe. Task 11 does the bulk.

## Review Focus

1. **Reasoning that leaks as plain content, ending in a bare closing tag.** Example: `I should add them.</think><COMPLETION>a + b;`, as Qwen3-Thinking-2507 or any template that prefills `<think>` produces when the server does not split reasoning out. The ghost text is `a + b;`. Tests: `a bare closing tag drops everything before it` (Task 2) and `text before <COMPLETION> never reaches the answer` (Task 5).
2. **The model re-types the start of the cursor line.** Example: cursor after `  return `, answer `return a + b;`. The ghost text is `a + b;`. Test: `drops a re-typed line prefix` (Task 5).
3. **Reasoning still open when the stream ends with `finish_reason: "length"`.** This is a model that thinks anyway and runs out of tokens. Nothing is shown, the model is flagged as thinking, and no partial reasoning appears. Tests: `unclosed reasoning at length is discarded` (Task 2) and `an unclosed think at length yields no text and flags thinking` (Task 7).
4. **A 400 for a prompt longer than the server's context** (llama.cpp `exceed_context_size_error`). It is retried at most once without the optional fields, nothing is learned, and the failure counts once toward backoff. Test: `a 400 the retry does not fix teaches nothing` (Task 3).
5. **OpenRouter's model list** (about 470 ids; a server may list one named `constructor`):
   - completion-time detection makes no request;
   - the page tags each model from the one list request;
   - the context step reads own properties only.

   Tests: `detectModel makes no request` and `listModels keeps inherited-looking ids as data` (Task 4), and `context step ignores inherited keys` (Task 9).

---

## File map

```
src/types.ts                          + ThinkingStrategy; BackendFimSettings.thinking; ModelOverrideBody.thinking
src/config/settings.ts                + FIM_MODES, MULTILINE, THINKING_STRATEGIES (exported); thinking parsing; "true" localOnly
src/models/presets.ts                 family presets (chat, thinking, samplingParams); override-stop fix
src/models/thinking.ts                NEW thinkingFields, ReasoningFilter, stripThinking
src/models/capabilities.ts            NEW Capabilities, usableRoutes, isRouteMissing
src/backends/types.ts                 RouteCaps, routes(), streamChat, ChatRequest, ChatEvent, ServerInfo.thinkingMandatory
src/backends/chat.ts                  NEW chatBody, rejectedFields, streamOpenAiChat
src/backends/{llamacpp,openaiCompat,mistral}.ts   routes(), streamChat
src/backends/openrouter.ts            NEW OpenRouterBackend
src/backends/index.ts                 createBackend picks OpenRouterBackend
src/completion/effective.ts           + chat, thinking, samplingParams, chatTimeoutMs, backendStop; FimField 'thinking'
src/completion/holeFiller.ts          NEW prompt and answer extractor
src/completion/route.ts               chat route, RouteCaps input, buildChatRequest, reworded no-route texts
src/completion/filters.ts             CompletionAccumulator.replace
src/completion/stream.ts              NEW collectCompletion (shared loop, "show complete lines" on timeout)
src/completion/postprocess.ts         strips reasoning text (FIM routes)
src/completion/provider.ts            chat route, learning, thinking note, settings-change guard
src/manage/{protocol,serverTypes,form,pageState,connectionTest}.ts   Strata/OpenRouter, Thinking field, chat tags, thinking step
src/webview/backends/render.ts        Thinking field in the Prompt section
src/ui/{statusBar,statusModel}.ts      thinking note
src/ui/backendsPanel.ts               model tags from thinkingMandatory
src/extension.ts                      Capabilities, thinking and notify wiring
package.json                          fim.thinking and modelOverrides.thinking schema
test/unit/*.test.ts  test/unit/fixtures/thinking-fields.json (NEW)
test/integration/{mockServer.ts,fim.test.ts,backends.test.ts}
README.md  AGENTS.md  docs/ROADMAP.md  the main spec  docs/superpowers/followups/2026-11-13-phase0-1-review-followups.md
```

**Progress tracking (for the controller and for later AI sessions):** after a task passes review, the controller ticks that task's `- [ ]` boxes in this file and commits it as `docs(plan): mark Task N complete`. A fresh session can therefore see progress from the committed plan and from `git log` commit subjects, which match each task's commit step.

**Before Task 1 (controller):** done on 2026-11-15.
- `docs/roadmap-v0.1.0` was merged as PR #4, so `feat/chat-thinking` starts from `main` with it.
- The plan is saved here and committed as `docs(plan): Phase 2 chat path and thinking control`, with the ROADMAP Phase 2 row's Plan cell linking it and `.env` added to `.gitignore` (local test credentials live there).
- Rulings on the plan writer's open questions: OpenRouter is chat only (its `/api/v1/completions` is undocumented); the chat route's default timeout is 15 s; the per-backend Thinking switch stays.

---

### Task 1: Thinking strategies, family presets and effective values

**Files:**
- Modify: `src/types.ts`, `src/models/presets.ts`, `src/config/settings.ts`, `src/completion/effective.ts`, `src/manage/form.ts` (import the value lists only), `package.json`.
- Test: `test/unit/presets.test.ts` (also rewrite L42-47: the `overridden` `toEqual` gains `thinking: false`), `test/unit/settings.test.ts`, `test/unit/effective.test.ts`, `test/unit/manifest.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  // src/types.ts
  export type ThinkingStrategy = 'none' | 'templateKwarg:enable_thinking' | 'templateKwarg:thinking' | 'templateKwarg:thinking_mode=disabled'
    | 'templateKwarg:thinking_budget=0' | 'reasoningEffortNone' | 'systemSoftSwitch:/no_think' | 'vendorThinkingDisabled' | 'cannotDisable';
  // BackendFimSettings gains thinking?: ThinkingStrategy; ModelOverrideBody gains thinking?: ThinkingStrategy

  // src/config/settings.ts (FIM_MODES and MULTILINE become exported; form.ts imports them instead of its own copies)
  export const FIM_MODES: readonly FimMode[]; export const MULTILINE: readonly Multiline[];
  export const THINKING_STRATEGIES: readonly ThinkingStrategy[];   // the order of the type above
  export const HOST_FLAVORS: readonly HostFlavor[];                // today's private FLAVORS list, exported (Task 2's golden test)

  // src/models/presets.ts
  export type SamplingParams = 'send' | 'omit';
  export const CHAT_SAMPLING: Sampling;   // { temperature: 0.2, topP: 0.8, topK: 20, maxTokens: 128 }
  // ResolvedPreset gains: chat: boolean; thinking: ThinkingStrategy; samplingParams: SamplingParams; overridden.thinking: boolean

  // src/completion/effective.ts
  export const DEFAULT_CHAT_TIMEOUT_MS = 15000;
  // FimField gains 'thinking'. FimValues gains:
  //   chat: boolean; thinking: ThinkingStrategy; samplingParams: SamplingParams;
  //   chatTimeoutMs: number   (backend fim.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS)
  //   backendStop: string[]   (the backend's own fim.stop, [] when unset)
  // sources.thinking: 'backend' | 'modelOverride' | 'preset'
  ```

**What the strategy ids mean** (Task 2 turns them into request fields):
- `templateKwarg:<name>`: the template variable `<name>` is set to `false`.
- `templateKwarg:<name>=<value>`: it is set to `<value>`, as a number when the value is numeric, else as a string.
- `reasoningEffortNone`: `reasoning_effort: "none"`.
- `systemSoftSwitch:/no_think`: `/no_think` is appended to the system message.
- `vendorThinkingDisabled`: `thinking: {type: "disabled"}`.
- `cannotDisable`: the lowest effort is requested, and the user is warned.
- `none`: no field is sent (the model does not think).

**Presets.** Coder rows stay first and unchanged, except for the Granite 4.2 split. The first match wins. Every coder row gets `chat: false`, `thinking: 'none'`, `samplingParams: 'send'`. Every family row below gets `chat: true`, `CHAT_SAMPLING` and no FIM template, unless the row says otherwise. Rows are inserted after `mellum` and before `generic`, in this order:

| id | regex (flag `i`) | thinking | notes and source (template or card, research 2026-11-15) |
|---|---|---|---|
| `granite4-thinking` | `/granite[-_ ]?4\.2/` | `templateKwarg:enable_thinking` | goes **before** `granite4`; keeps `fimTemplate: 'granite4'`, `chat: false`, coder sampling. Card: "Non-thinking \| `enable_thinking=False`" |
| `deepseek-r1` | `/deepseek.*(r1\|reasoner)/` | `cannotDisable` | must precede the Qwen rows (`DeepSeek-R1-0528-Qwen3-8B`) |
| `deepseek-v4` | `/deepseek.*(v4\|flash)/` | `templateKwarg:enable_thinking` | V4.1 template: "thinking=true/false and enable_thinking=true/false are accepted as aliases" |
| `deepseek-v3` | `/deepseek.*v3\.[12]/` | `templateKwarg:thinking` | V3.1 tpl: `{% if not thinking is defined %}{% set thinking = false %}` |
| `deepseek` | `/deepseek/` | `none` | older V3 and chat models |
| `qwen3-thinking` | `/qwen3.*thinking/` | `cannotDisable` | card: output "contain[s] only `</think>`" |
| `qwen3-instruct-2507` | `/qwen3-.*2507/` | `none` | card: "supports only non-thinking mode" |
| `qwen3.8-2.4t` | `/qwen3\.8.*2\.4t/` | `cannotDisable` | tpl: `raise_exception('Disabling thinking is not supported.')` |
| `qwen3` | `/qwen[-_ ]?3/` | `templateKwarg:enable_thinking` | Qwen3 hybrid, 3.5, 3.6, 3.8 (incl. Flash-Next); tpl prefills `<think>\n\n</think>\n\n` |
| `glm-5.3` | `/glm[-_ ]?5\.3/` | `cannotDisable` | tpl always opens `<think>`; Z.ai: "forced thinking and cannot be disabled" |
| `glm` | `/glm/` | `templateKwarg:enable_thinking` | 4.5 to 5.2 |
| `kimi-thinking` | `/kimi.*(k2.*thinking\|k2\.7\|k3)/` | `cannotDisable` | `samplingParams: 'omit'`; K3 "always has thinking enabled"; API: temperature "Fixed … passing any other value returns an error" |
| `kimi-k2.5` | `/kimi.*k2\.[56]/` | `templateKwarg:thinking` | `omit`; card: `{"chat_template_kwargs": {"thinking": False}}` |
| `kimi` | `/kimi/` | `none` | `omit`; K2-Instruct |
| `minimax-m3.1` | `/minimax.*m3\.1/` | `cannotDisable` | `omit`; API: "thinking cannot be disabled" |
| `minimax-m3` | `/minimax.*m3/` | `templateKwarg:thinking_mode=disabled` | `omit`; tpl kwarg `thinking_mode`, delimiters `<mm:think>` |
| `minimax` | `/minimax/` | `cannotDisable` | `omit`; M2 to M2.7 tpl always opens `<think>` |
| `gemma4` | `/gemma[-_ ]?4/` | `templateKwarg:enable_thinking` | tpl default false; prefills `<\|channel>thought\n<channel\|>` |
| `gemma` | `/gemma/` | `none` | Gemma 3 (`codegemma` matched earlier) |
| `granite3.3` | `/granite[-_ ]?3\.3/` | `templateKwarg:thinking` | default off; explicit `false` |
| `granite` | `/granite/` | `none` | other Granite chat models |
| `nemotron-nano-v2` | `/nemotron.*nano.*v2/` | `systemSoftSwitch:/no_think` | tpl: `{%- elif '/no_think' in content -%}` |
| `nemotron` | `/nemotron/` | `templateKwarg:enable_thinking` | Nemotron 3 and 3.5 |
| `gpt-oss` | `/gpt-oss/` | `cannotDisable` | effort low / medium / high only |
| `mistral-large-4` | `/mistral[-_ ]?large[-_ ]?4/` | `cannotDisable` | tpl: `reasoning_effort must be one of "low", "medium", "high"` |
| `mistral-reasoning` | `/mistral[-_ ]?(small[-_ ]?4\|small[-_ ]?2603\|medium[-_ ]?3[.-]5)/` | `reasoningEffortNone` | API: `"none"` "thinks minimally and the thinking chunk is omitted" |
| `mistral` | `/magistral\|ministral\|devstral\|mistral/` | `none` | Magistral reasons only with its system prompt, which we never send |
| `seed-oss` | `/seed[-_ ]?oss/` | `templateKwarg:thinking_budget=0` | card: "setting any budget below 512 to this value [0]" |
| `generic` (existing) | `/.*/` | `templateKwarg:enable_thinking` | `chat: false`; the best-effort default for unknown models: templates that do not use the variable ignore it |

**Fold-ins from the follow-ups:**
- `resolvePreset` keeps the stops of an earlier override when a later override sets `fimTemplate`.
- A string `"true"` for `privacy.localOnly` counts as on, and is reported as a problem: `aiAutocomplete.privacy.localOnly: expected true or false; "true" read as true`.
- `form.ts` uses the exported `FIM_MODES` and `MULTILINE`.

- [x] **Step 1: Write the failing tests.**
  ```ts
  // presets.test.ts
  test.each([
    ['Qwen3.8-Flash-Next', 'qwen3', 'templateKwarg:enable_thinking', true], ['qwen3.8-flash-next-iq3_s', 'qwen3', 'templateKwarg:enable_thinking', true],
    ['Qwen3-30B-A3B-Thinking-2507', 'qwen3-thinking', 'cannotDisable', true], ['Qwen3-30B-A3B-Instruct-2507', 'qwen3-instruct-2507', 'none', true],
    ['Qwen3.8-2.4T-A95B', 'qwen3.8-2.4t', 'cannotDisable', true], ['Qwen3-Coder-30B-A3B-Instruct', 'qwen-coder', 'none', false],
    ['DeepSeek-R1-0528-Qwen3-8B', 'deepseek-r1', 'cannotDisable', true], ['deepseek-flash', 'deepseek-v4', 'templateKwarg:enable_thinking', true],
    ['DeepSeek-V3.1-Terminus', 'deepseek-v3', 'templateKwarg:thinking', true], ['GLM-5.3-Flash', 'glm-5.3', 'cannotDisable', true],
    ['glm-4.6', 'glm', 'templateKwarg:enable_thinking', true], ['moonshotai/kimi-k3', 'kimi-thinking', 'cannotDisable', true],
    ['Kimi-K2.6', 'kimi-k2.5', 'templateKwarg:thinking', true], ['Kimi-K2-Instruct-0905', 'kimi', 'none', true],
    ['MiniMax-M3', 'minimax-m3', 'templateKwarg:thinking_mode=disabled', true], ['MiniMax-M3.1-Flash', 'minimax-m3.1', 'cannotDisable', true],
    ['MiniMax-M2.5', 'minimax', 'cannotDisable', true], ['gemma-4-31B-it', 'gemma4', 'templateKwarg:enable_thinking', true],
    ['gemma-3-27b-it', 'gemma', 'none', true], ['granite-3.3-8b-instruct', 'granite3.3', 'templateKwarg:thinking', true],
    ['granite-4.2-8b', 'granite4-thinking', 'templateKwarg:enable_thinking', false], ['granite-4.1-3b', 'granite4', 'none', false],
    ['NVIDIA-Nemotron-Nano-9B-v2', 'nemotron-nano-v2', 'systemSoftSwitch:/no_think', true],
    ['NVIDIA-Nemotron-3-Nano-30B-A3B-BF16', 'nemotron', 'templateKwarg:enable_thinking', true], ['gpt-oss-20b', 'gpt-oss', 'cannotDisable', true],
    ['Mistral-Large-4-1T-A52B', 'mistral-large-4', 'cannotDisable', true], ['Mistral-Small-4-119B-2603', 'mistral-reasoning', 'reasoningEffortNone', true],
    ['Devstral-Small-2-24B-Instruct-2512', 'mistral', 'none', true], ['Seed-OSS-36B-Instruct', 'seed-oss', 'templateKwarg:thinking_budget=0', true],
    ['codestral-latest', 'codestral', 'none', false], ['my-model', 'generic', 'templateKwarg:enable_thinking', false],
  ])('%s → %s, %s, chat %s', (model, id, thinking, chat) => { /* resolvePreset(model, {}) has id, thinking, chat */ });
  test('chat families use CHAT_SAMPLING and no template; kimi and minimax omit sampling', () => {});
  // rewrite the existing 'general Qwen gets no FIM template': 'Qwen3.8-Flash-Next' → id 'qwen3' (was 'generic'),
  //   fimTemplate still undefined, suffixFirst false, stop still ['\n\n\n']
  test('an override thinking applies and is marked overridden', () => {});
  test('a later override template keeps an earlier override stop', () => {
    // { coder: { stop: ['X'] }, 'qwen2.5': { fimTemplate: 'codestral' } } on 'qwen2.5-coder' → stop ends with 'X'
  });
  // settings.test.ts
  test('backend fim.thinking keeps a known strategy and reports an unknown one', () => {
    // 'off' → problem 'aiAutocomplete.backends[0] ("lm").fim.thinking: unknown thinking switch "off" (use one of none, templateKwarg:enable_thinking, …), ignored'
  });
  test('modelOverrides thinking is parsed like fimTemplate', () => {});
  test('a "true" string for privacy.localOnly counts as on and is reported', () => {});
  // effective.test.ts
  test('chat family values', () => {
    // model 'Qwen3.8-Flash-Next' → chat true, thinking 'templateKwarg:enable_thinking' (source 'preset'),
    //   sampling { temperature: 0.2, topP: 0.8, topK: 20 }, samplingParams 'send', chatTimeoutMs 15000, backendStop []
  });
  test('backend thinking beats an override, which beats the preset', () => {});
  test('backend timeoutMs sets both timeouts; backendStop is only the backend list', () => {});
  // manifest.test.ts
  test('fim.thinking schema enum equals THINKING_STRATEGIES; modelOverrides description names thinking', () => {});
  ```
- [x] **Step 2: Run** `npx vitest run test/unit/presets.test.ts test/unit/settings.test.ts test/unit/effective.test.ts test/unit/manifest.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement.**
  - Add the types, the preset rows and the effective values.
  - Parse `fim.thinking` and `modelOverrides.<re>.thinking` in `settings.ts`.
  - Add `thinking` to the `fim` item schema in `package.json` (`enum` = the strategy ids, description `How thinking is turned off for this backend's model on the chat prompt.`).
  - Extend the `modelOverrides` `markdownDescription` to list `thinking`.
- [x] **Step 4: Run the full check.** Expected: PASS.
- [x] **Step 5: Commit.** `feat: model-family presets with thinking strategies`.

### Task 2: Thinking fields per host, and the reasoning filter

**Files:**
- Create: `src/models/thinking.ts`, `test/unit/thinking.test.ts`, `test/unit/fixtures/thinking-fields.json`.
- Modify: `src/completion/postprocess.ts`, `test/unit/postprocess.test.ts`.

**Interfaces:**
- Consumes: `ThinkingStrategy`, `THINKING_STRATEGIES` (Task 1); `HostFlavor` (existing).
- Produces:
  ```ts
  export const THINKING_FIELDS: readonly string[];   // ['chat_template_kwargs', 'reasoning_effort', 'reasoning', 'thinking']
  export interface ThinkingFields { body: Record<string, unknown>; systemSuffix?: string }
  export function thinkingFields(strategy: ThinkingStrategy, flavor: HostFlavor): ThinkingFields;
  /** Streaming: feed content and reasoning deltas, read `visible` at any time. `visible` can shrink (a bare closing tag). */
  export class ReasoningFilter {
    push(content: string): void;
    reasoning(text: string): void;           // a delta from a separate reasoning field
    end(finishReason?: string): void;
    get visible(): string;
    get thinking(): boolean;                 // non-whitespace reasoning seen, in a field or between tags
  }
  export function stripThinking(text: string, finishReason?: string): { text: string; thinking: boolean };
  ```

**Request fields** (`body`). Here `kw(K, V)` is `chat_template_kwargs: {K: V}`, with `V` as Task 1 defines it. `systemSuffix` is `'/no_think'` for `systemSoftSwitch:/no_think` on every flavor, and absent otherwise.

| Flavor | `none` | `templateKwarg:*` | `reasoningEffortNone` | `systemSoftSwitch` | `vendorThinkingDisabled` | `cannotDisable` |
|---|---|---|---|---|---|---|
| `strata` | both¹ | both¹ | both¹ | both¹ | both¹ | both¹ |
| `openrouter` | `reasoning:{effort:'none'}` | same | same | same | same | `reasoning:{effort:'low'}` |
| `deepseek` | `thinking:{type:'disabled'}` | same | same | same | same | `{}` |
| `ollama` | `reasoning_effort:'none'` | same | same | same | same | `reasoning_effort:'low'` |
| `lmstudio` | `{}` | `kw(K,V)` + `reasoning_effort:'none'` | `reasoning_effort:'none'` | `reasoning_effort:'none'` | `thinking:{type:'disabled'}` | `reasoning_effort:'low'` |
| `llamacpp`, `vllm`, `sglang` | `{}` | `kw(K,V)` + `reasoning_effort:'none'` | `reasoning_effort:'none'` | `{}` | `thinking:{type:'disabled'}` | `reasoning_effort:'low'` |
| `fireworks`, `together`, `mistral`, `generic` | `{}` | `kw(K,V)` | `reasoning_effort:'none'` | `{}` | `thinking:{type:'disabled'}` | `reasoning_effort:'low'` |

¹ Strata: `{ reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } }`. Strata serves only Qwen3.8, and each field alone works (verified live).

Why these rows:
- Ollama maps `"none"` per model, and to `"low"` for gpt-oss.
- OpenRouter documents `effort:"none"`, and silently ignores it for models without reasoning.
- The DeepSeek API's current models all think by default.
- llama.cpp, vLLM and SGLang get the kwarg plus `reasoning_effort:'none'`, as the spec says; the verified facts above show `"none"` sets `enable_thinking=false` on all three. If a 400 names `reasoning_effort`, the Task 3 retry drops only that field.
- LM Studio is unverified, so it gets both the kwarg and the 0.4.8 field. A rejection is learned (Task 3), and the "thinks anyway" check (Task 7) catches the rest.

**Golden file:** `test/unit/fixtures/thinking-fields.json` is written **by hand from the table above**. It is never generated by `thinkingFields`. Shape: `{ "<flavor>": { "<strategy>": { "body": {…}, "systemSuffix"?: "/no_think" } } }`, covering all 12 flavors × 9 strategies. The `templateKwarg:*` cells (4 strategies) of `llamacpp`, `vllm` and `sglang` hold `chat_template_kwargs` and `reasoning_effort: "none"`: 12 cells.

**Stripping rules:**
- **Reasoning blocks** (opener → closer). Everything between them is reasoning:
  - `<think>` → `</think>`;
  - `<seed:think>` → `</seed:think>`;
  - `<mm:think>` → `</mm:think>` (MiniMax M3);
  - `<|channel>thought` → `<channel|>` (Gemma 4);
  - `[THINK]` → `[/THINK]` (Mistral);
  - `<|open|>think<|sep|>` → `<|close|>think<|sep|>` (Kimi K3);
  - `<|channel|>analysis<|message|>` → `<|end|>` (gpt-oss Harmony).
- **Answer markers** removed from the visible text: `<|open|>response<|sep|>`, `<|close|>response<|sep|>`, `<|start|>assistant<|channel|>final<|message|>`, `<|channel|>final<|message|>`, `<|return|>`.
- **A closer with no opener** means a template prefilled the opener. Everything before it is reasoning. Only the text after the **last** closer is kept.
- **Whitespace** that directly follows a closed block is dropped.
- **An unclosed block at `end`:** when `finishReason === 'length'`, `visible` is `''`. Otherwise `visible` is the text before the opener.
- **`thinking` is true** only when reasoning (field or block) has a non-whitespace character. Empty blocks such as `<think>\n\n</think>` and Gemma's `<|channel>thought\n<channel|>` do not count.
- **A partial tag** at the end of the content so far is held back until the next `push` or `end`.
- **`stripThinking(text, finish)`** is `push(text)` then `end(finish)`.
- **`postprocess`** runs `stripThinking` on its input first, so FIM routes strip reasoning too. A result that is blank after stripping is `undefined`.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  test('thinkingFields matches the golden file for every flavor × strategy', () => {
    // Object.keys(fixture) equals HOST_FLAVORS (as sets); for each flavor and each THINKING_STRATEGIES entry: toEqual(fixture[flavor][strategy])
  });
  test('paired tags are removed and flagged', () => {
    // for each opener/closer pair: stripThinking(`${open}Let me see.${close}a + b;`) → { text: 'a + b;', thinking: true }
  });
  test('empty blocks are not thinking', () => {
    // '<think>\n\n</think>\n\na + b;' and '<|channel>thought\n<channel|>a + b;' → { text: 'a + b;', thinking: false }
  });
  test('a bare closing tag drops everything before it', () => {
    // 'I should add them.</think>a + b;' → { text: 'a + b;', thinking: true }; 'x</think>y</think>z' → 'z'
  });
  test('unclosed reasoning at length is discarded', () => {
    // ('a<think>more', 'length') → ''; ('a<think>more', 'stop') → 'a'
  });
  test('tags split across pushes', () => { /* push('<thi'), push('nk>x</th'), push('ink>a + b;') → visible 'a + b;' */ });
  test('reasoning deltas count only when not blank', () => { /* reasoning('  ') → thinking false; reasoning('hm') → true; visible unchanged */ });
  test('answer markers are removed', () => {
    // '<|open|>think<|sep|>hm<|close|>think<|sep|><|open|>response<|sep|>a + b;<|close|>response<|sep|>' → 'a + b;'
  });
  test('plain text passes through', () => { /* 'a + b;' → { text: 'a + b;', thinking: false } */ });
  // postprocess.test.ts
  test('reasoning is stripped before the other rules', () => { /* '<think>x</think>a + b;' → 'a + b;'; '<think>x</think>' → undefined */ });
  ```
- [ ] **Step 2: Run** `npx vitest run test/unit/thinking.test.ts test/unit/postprocess.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `thinking.ts`, the fixture (by hand from the table) and the `postprocess` change.
- [ ] **Step 4: Run the full check.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: thinking-off request fields per host and a reasoning filter`.

### Task 3: Chat transport and route capabilities

**Files:**
- Create: `src/backends/chat.ts`, `test/unit/chat.test.ts`.
- Modify:
  - `src/backends/types.ts`, `src/backends/llamacpp.ts`, `src/backends/openaiCompat.ts`, `src/backends/mistral.ts`;
  - every `supportsNativeFim()` caller, which switches to `routes().native` with no behaviour change: `src/completion/provider.ts` (2), `src/manage/connectionTest.ts` (2), `src/manage/form.ts` (2) and `src/manage/pageState.ts` (1).
- Test: `test/unit/llamacpp.test.ts` (rewrite the `supportsNativeFim` test at L156 to `routes().native`), `test/unit/openaiCompat.test.ts` (L99, same), `test/unit/mistral.test.ts` (L136, same), and in `test/unit/connectionTest.test.ts` the `fake()` backend (it gains `routes()` plus a no-op `streamChat()`, because `FimBackend` requires both and `tsconfig.json` includes `test/unit`) and the two `supportsNativeFim = () => { throw … }` cases.

**Interfaces:**
- Consumes: `THINKING_FIELDS` (Task 2); `postJson`, `HttpError`, `throwIfStreamError`, `parseSse`, `isHostedFlavor` (existing).
- Produces:
  ```ts
  // src/backends/types.ts
  /** nativeChatModels: the native route also serves chat-family models (only DeepSeek's API). */
  export interface RouteCaps { native: boolean; template: boolean; chat: boolean; nativeChatModels: boolean }
  export interface ChatMessage { role: 'system' | 'user'; content: string }
  export interface ChatRequest {
    model?: string; messages: ChatMessage[]; maxTokens: number; stop: string[];
    sampling: { temperature?: number; topP?: number; topK?: number; presencePenalty?: number };
    thinking: Record<string, unknown>;      // merged into the body
    extraBody: Record<string, unknown>; signal: AbortSignal; timeoutMs: number;
    onRejected?(fields: string[]): void;    // called when a retry without these fields succeeded
  }
  export type ChatEvent = { type: 'content'; text: string } | { type: 'reasoning'; text: string } | { type: 'finish'; reason: string };
  // FimBackend: supportsNativeFim() is removed; gains routes(): RouteCaps and streamChat(req: ChatRequest): AsyncIterable<ChatEvent>
  // ServerInfo gains thinkingMandatory?: string[]   (filled by OpenRouter, Task 4)

  // src/backends/chat.ts
  export const SAMPLING_FIELDS: readonly string[];   // ['temperature', 'top_p', 'top_k', 'presence_penalty']
  export const RETRY_STATUSES: readonly number[];    // [400, 422]
  export function chatBody(req: ChatRequest, hosted: boolean): Record<string, unknown>;
  /** The sent optional fields a 400/422 body names (whole word, case-insensitive): 'reasoning' never matches 'reasoning_effort'. */
  export function rejectedFields(bodyText: string, sent: readonly string[]): string[];
  export function streamOpenAiChat(url: string, headers: Record<string, string>, req: ChatRequest, hosted: boolean): AsyncGenerator<ChatEvent>;
  ```

**`chatBody`:**
- Fields: `model` (when set), `messages`, `max_tokens`, `temperature`, `top_p`, `top_k` (not for hosted flavors), `presence_penalty`, `stop`, `stream: true`, then `...thinking`, then `...extraBody`.
- A sampling field is sent only when it is set.
- `stop` is sent only when it is not empty. Hosted flavors send its first 4.

**`streamOpenAiChat`:**
- POSTs `chatBody`. On an `HttpError` with a status in `RETRY_STATUSES`, it retries **once**:
  - The sent optional fields are the thinking fields present plus the sampling fields present.
  - Without the fields `rejectedFields` names. When it names none, without every field in `THINKING_FIELDS` that was sent. There is no retry when there is nothing to drop.
  - When the retry succeeds, it calls `onRejected(dropped)`. When it fails, the retry's error is thrown and nothing is reported.
  - The body text is only matched, never logged.
- **SSE parsing** of `choices[0]`, after `throwIfStreamError`:
  - `delta.content` string → `content`.
  - `delta.content` array: items `{type:'text', text}` → `content`. Items `{type:'thinking', thinking:[{text}]}` → `reasoning` (the Mistral API).
  - `delta.reasoning_content`, `delta.reasoning` and `delta.thinking` (strings) → `reasoning`.
  - `delta.reasoning_details` (non-empty array) → `reasoning`, with the items' `text`/`summary` strings, or `'…'` when they have none (encrypted reasoning is still reasoning).
  - `finish_reason` string → `finish`.

**Routes:**

| Backend | native | template | chat | nativeChatModels | chat URL |
|---|---|---|---|---|---|
| llama.cpp | true | true | true | false | `joinUrl(baseUrl, '/v1/chat/completions')` |
| OpenAI-compatible | flavor `deepseek` or `ollama` | flavor not `strata` | true | flavor `deepseek` | `joinUrl(baseUrl, 'chat/completions')` |
| Mistral | true | false | false | false | `streamChat` throws `Error('Mistral backends serve FIM only')` |

**Fold-ins:**
- The OpenAI-compatible FIM body omits an empty `stop` (follow-up "`stop: []` is always sent").
- OpenAI-compatible `listModels` reads a numeric `meta.n_ctx` into `contextWindows` (Strata's `/v1/models` shape: `"meta":{"n_ctx":262144}`). The connection test's context step then works for Strata. Test: `listModels reads Strata meta.n_ctx`.

- [ ] **Step 1: Write the failing tests** with `startMockHttp`.
  ```ts
  test('posts the chat body and yields reasoning, content and finish events', () => {
    // SSE: {"choices":[{"delta":{"reasoning_content":"hm"}}]}, {"choices":[{"delta":{"content":"<COMPLETION>a"}}]},
    //      {"choices":[{"delta":{"content":" + b;"},"finish_reason":"stop"}]}, [DONE]
    // events: reasoning 'hm', content '<COMPLETION>a', content ' + b;', finish 'stop'
    // body toMatchObject { model: 'm', messages, max_tokens: 160, temperature: 0.2, top_p: 0.8, top_k: 20, presence_penalty: 0,
    //   stop: ['</COMPLETION>'], stream: true, chat_template_kwargs: { enable_thinking: false } }
  });
  test('reads reasoning, reasoning_details and Mistral thinking chunks', () => {
    // also a string delta.thinking 'hm' → { type: 'reasoning', text: 'hm' }
  });
  // openaiCompat.test.ts
  test('the FIM body omits an empty stop', () => { /* stop [] → 'stop' in body is false; stop ['x'] → body.stop ['x'] */ });
  test('hosted flavors drop top_k and keep 4 stops; an empty stop is not sent', () => {});
  test('a 400 naming a field retries once without it and reports it', () => {
    // 1st: 400 {"error":{"message":"Unrecognized request argument supplied: chat_template_kwargs"}}; 2nd: SSE ok
    // → 2 requests; the 2nd body has no chat_template_kwargs; onRejected(['chat_template_kwargs'])
  });
  test('a 400 naming nothing retries without the thinking fields only', () => { /* temperature still sent in the retry */ });
  test('a 400 the retry does not fix teaches nothing', () => {
    // both 400 {"error":{"type":"exceed_context_size_error"}} → throws HttpError 400; exactly 2 requests; onRejected not called
  });
  test('no retry when nothing optional was sent', () => { /* thinking {}, sampling {} → 1 request, HttpError */ });
  test('an SSE error event becomes a StreamError', () => {});
  test('rejectedFields matches whole words only', () => {
    // ('unknown field: reasoning_effort', ['reasoning', 'reasoning_effort']) → ['reasoning_effort']
  });
  // llamacpp / openaiCompat / mistral tests
  test('routes per backend and flavor', () => { /* the table above, incl. strata { false, false, true, false } */ });
  test('chat URLs', () => { /* llama.cpp → /v1/chat/completions; OpenAI-compatible baseUrl …/v1 → /v1/chat/completions */ });
  test('Mistral streamChat throws', () => {});
  ```
- [ ] **Step 2: Run** `npx vitest run test/unit/chat.test.ts test/unit/llamacpp.test.ts test/unit/openaiCompat.test.ts test/unit/mistral.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `chat.ts`, the `routes()` and `streamChat` methods, and the caller switch.
- [ ] **Step 4: Run the full check.** Expected: PASS. The existing route, form, pageState and connectionTest tests keep their assertions unchanged.
- [ ] **Step 5: Commit.** `feat: chat completions transport with rejected-field retry`.

### Task 4: OpenRouter backend

**Files:**
- Create: `src/backends/openrouter.ts`, `test/unit/openrouter.test.ts`.
- Modify: `src/backends/index.ts`.

**Interfaces:**
- Consumes: `OpenAiCompatBackend`, `getJson`, `joinUrl`, `authHeaders` (existing); `RouteCaps`, `ServerInfo`, `streamOpenAiChat` (Task 3); `thinkingFields` (Task 2, in the chat test only).
- `OpenAiCompatBackend` keeps `apiKey`, `headers()`, `fetchModels()` and `flavor` private, so `OpenRouterBackend` declares its own constructor that keeps the key provider and builds its headers with `authHeaders`. `openaiCompat.ts` is not touched.
- Produces:
  ```ts
  export const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
  export class OpenRouterBackend extends OpenAiCompatBackend {
    routes(): RouteCaps;                                   // { native: false, template: false, chat: true, nativeChatModels: false }
    detectModel(signal: AbortSignal): Promise<undefined>;  // no request: about 470 models, the user picks one
    /** GET {baseUrl}/models: ids, context_length → contextWindows, reasoning.mandatory === true → thinkingMandatory. */
    listModels(signal: AbortSignal, timeoutMs?: number): Promise<ServerInfo>;
  }
  // createBackend: kind 'openai' whose inferHostFlavor is 'openrouter' → OpenRouterBackend
  ```
- **No FIM routes** on OpenRouter. `/api/v1/completions` is undocumented (see Global Constraints). Prompt mode `template` or `native` there gets the existing "does not work with this server" message.
- `contextWindows` and `thinkingMandatory` are built only from entries with a string `id`. `contextWindows` is filled with own keys, so an id like `constructor` is plain data.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  test('detectModel makes no request', () => { /* mock server sees 0 requests */ });
  test('listModels reads ids, context windows and mandatory reasoning', () => {
    // data: [{ id: 'a', context_length: 131072, reasoning: { mandatory: false } }, { id: 'b', context_length: 8192, reasoning: { mandatory: true } }, { id: 'c' }]
    // → models ['a','b','c'], contextWindows { a: 131072, b: 8192 }, thinkingMandatory ['b']; path '/api/v1/models' when baseUrl ends in /api/v1
  });
  test('listModels keeps inherited-looking ids as data', () => {
    // { id: 'constructor', context_length: 4096 } → Object.hasOwn(contextWindows, 'constructor') and value 4096; ({}).constructor untouched
  });
  test('chat goes to {baseUrl}/chat/completions with the thinking body passed through and no attribution headers', () => {
    // request built with thinking = thinkingFields('none', 'openrouter').body; path '/api/v1/chat/completions' when baseUrl ends in /api/v1;
    // the mock's body.reasoning toEqual { effort: 'none' } (passthrough, not the test's own literal); requests[0].headers has no 'http-referer' and no 'x-title'
  });
  test('createBackend picks OpenRouterBackend for openrouter.ai and for hostFlavor openrouter', () => {});
  test('routes: chat only', () => {});
  ```
- [ ] **Step 2: Run** `npx vitest run test/unit/openrouter.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the backend and the factory change.
- [ ] **Step 4: Run the full check.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: OpenRouter backend`.

### Task 5: Hole-filler prompt and answer

**Files:**
- Create: `src/completion/holeFiller.ts`, `test/unit/holeFiller.test.ts`.

**Interfaces:**
- Consumes: `TemplateInput` (existing); `ChatMessage` (Task 3).
- Produces:
  ```ts
  export const CURSOR_MARKER = '<|cursor|>';
  export const COMPLETION_OPEN = '<COMPLETION>';
  export const COMPLETION_CLOSE = '</COMPLETION>';
  export const HOLE_FILLER_SYSTEM: string;
  export interface HoleFillerInput extends TemplateInput { languageId: string; multiline: boolean }
  export function holeFillerMessages(i: HoleFillerInput, systemSuffix?: string): ChatMessage[];
  export class HoleFillerAnswer {
    constructor(linePrefix: string);
    /** The answer in `visible` (ReasoningFilter output) so far; `done` once the stream has ended. */
    update(visible: string, done: boolean): string;
  }
  ```

**`HOLE_FILLER_SYSTEM`, exactly:**
```
You complete code inside an editor. The user sends one file, and the marker <|cursor|> shows where the cursor is. Other files from the project may come first, for reference.

Answer with the text to insert at the cursor and nothing else, wrapped as <COMPLETION>text</COMPLETION>.
- Write only new text. Never repeat what is already before or after the cursor.
- Follow the file's language, indentation and naming.
- End where the code after the cursor takes over.
- No explanations and no Markdown code fences.
- If nothing should be inserted, answer <COMPLETION></COMPLETION>.
```
With a `systemSuffix`, the system message is `${HOLE_FILLER_SYSTEM}\n${systemSuffix}`.

**User message, exactly.** The extra files come first and the current file last. That way the part that changes while typing sits at the end, and Strata's and llama.cpp's prefix caches reuse the start: the verified Strata first token was 0.23 s with the start cached, against 2.5 s cold.
```
${extra.map(f => `<file path="${f.path}">\n${f.text}\n</file>\n`).join('')}<file path="${filePath}" language="${languageId}">
${prefix}<|cursor|>${suffix}
</file>
${multiline ? 'Insert the code that belongs at <|cursor|>.' : 'Insert the code that belongs at <|cursor|>, on the cursor line only.'}
```

**Answer rules for `update(visible, done)`:**
1. When `visible` contains `<COMPLETION>`, the answer is the text after its first occurrence, cut at the first `</COMPLETION>`. Servers drop the stop string, so the closing tag is usually absent.
2. Without `<COMPLETION>`: the answer is `''` while streaming. At `done`, it is the whole `visible` minus a trailing `</COMPLETION>` (a model that skipped the opening tag).
3. **Re-typed line prefix:** let `p = linePrefix.trimStart()`. When `p.trim() !== ''` and `answer.trimStart()` starts with `p`, the leading whitespace and `p` are dropped. While streaming, an answer whose `trimStart()` is still a prefix of `p` gives `''`, held until it can be decided.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  test('the prompt is our own wording', () => {
    // HOLE_FILLER_SYSTEM contains '<|cursor|>' and '<COMPLETION>'; it and every message of holeFillerMessages(…) contain none of
    // 'HOLE FILLER', '{{FILL_HERE}}', '<QUERY>', 'TASK:'
  });
  test('messages: system, then user with extra files first and the current file last', () => {
    // input { prefix: 'function add(a: number, b: number): number {\n  return ', suffix: '\n}\n', filePath: 'src/math.ts', repoName: 'r',
    //   extra: [{ path: 'src/util.ts', text: 'export const x = 1;' }], languageId: 'typescript', multiline: true } → the exact user text above
  });
  test('single-line asks for the cursor line only', () => {});
  test('systemSuffix is appended to the system message', () => { /* '/no_think' → system ends with '\n/no_think' */ });
  test('the answer is the text between the tags', () => { /* update('<COMPLETION>a + b;</COMPLETION>', true) → 'a + b;' */ });
  test('text before <COMPLETION> never reaches the answer', () => {
    // update('I think x', false) → ''; update('I think x<COMPLETION>a', false) → 'a'
  });
  test('without the wrapper the whole text counts only at the end', () => { /* ('a + b;', false) → ''; ('a + b;', true) → 'a + b;' */ });
  test('drops a re-typed line prefix', () => {
    // new HoleFillerAnswer('  return '): ('<COMPLETION>return a + b;', true) → 'a + b;'; ('<COMPLETION>ret', false) → '';
    // ('<COMPLETION>a + b;', true) → 'a + b;'; new HoleFillerAnswer('   ') leaves '  x' as '  x'
  });
  test('an empty completion is empty', () => { /* '<COMPLETION></COMPLETION>' → '' */ });
  ```
- [ ] **Step 2: Run** `npx vitest run test/unit/holeFiller.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `holeFiller.ts`.
- [ ] **Step 4: Run the full check.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: chat hole-filler prompt and answer extraction`.

### Task 6: Route planning with a chat route, chat requests and the capability store

**Files:**
- Create: `src/models/capabilities.ts`, `test/unit/capabilities.test.ts`.
- Modify:
  - `src/completion/route.ts`;
  - the callers of the new signatures: `src/completion/provider.ts`, `src/manage/connectionTest.ts`, `src/manage/form.ts`, `src/manage/pageState.ts`.
- Test:
  - `test/unit/route.test.ts`: every `planRoute`, `whyNoRoute` and `explainUnsupported` call changes. `planRoute` takes a `RouteCaps` (cases at lines 50, 130 and 153–160 are rewritten); `whyNoRoute` takes `caps` (L148–157); `explainUnsupported` gains the 5th argument `chatPossible` (calls at L116, L123, L138, L144), and the old text asserted at L125 is replaced;
  - `test/unit/connectionTest.test.ts:93-97`;
  - `test/unit/pageState.test.ts:38-53`.

**Interfaces:**
- Consumes: `RouteCaps`, `ChatRequest` (Task 3); `thinkingFields` (Task 2); `holeFillerMessages`, `HoleFillerInput`, `COMPLETION_CLOSE` (Task 5); `FimValues` (Task 1).
- Produces:
  ```ts
  // src/completion/route.ts
  export type FimRoute = 'native' | 'template' | 'chat';
  export function planRoute(kind: BackendKind, caps: RouteCaps, fim: { fimTemplate?: FimTemplateId; suffixFirst: boolean; chat: boolean }, mode: FimMode): FimRoute | 'unsupported';
  export type NoRoute = 'mode' | 'template';                 // 'chat' is gone
  export function whyNoRoute(caps: RouteCaps, mode: FimMode): NoRoute;
  export function noRouteText(why: NoRoute, mode: FimMode): string;
  export function explainUnsupported(backendId: string, model: string | undefined, mode: FimMode, why: NoRoute, chatPossible: boolean):
    { onceKey: string; log: string; status?: string; action?: StatusAction };
  export const CHAT_OVERHEAD_TOKENS = 32;
  export const REASONING_ALLOWANCE_TOKENS = 1024;
  export interface ChatRequestPlan { fim: FimValues; flavor: HostFlavor; model: string | undefined; input: HoleFillerInput;
    rejected: ReadonlySet<string>; signal: AbortSignal; onRejected?(fields: string[]): void }
  export function buildChatRequest(p: ChatRequestPlan): ChatRequest;
  /** The chat stop rule, shared by buildChatRequest and the Backends page form (Task 9): ['</COMPLETION>', ...backendStop], deduplicated. */
  export function chatStops(fim: Pick<FimValues, 'backendStop'>): string[];

  // src/models/capabilities.ts
  export interface Learned { rejected: ReadonlySet<string>; failedRoutes: ReadonlySet<FimRoute>; thinkingMs?: number }
  export class Capabilities {
    get(backendId: string, model: string | undefined): Learned;
    reject(backendId: string, model: string | undefined, fields: readonly string[]): string[];   // the newly added ones
    failRoute(backendId: string, model: string | undefined, route: FimRoute): boolean;           // true when new
    sawThinking(backendId: string, model: string | undefined, ms: number): boolean;             // true the first time; keeps the latest ms
    clear(): void;
  }
  export function usableRoutes(caps: RouteCaps, failed: ReadonlySet<FimRoute>): RouteCaps;
  /** 404, 405, 501, or a 400 whose body contains "does not support insert" (Ollama). A 404 whose body mentions "model" (case-insensitive) is not a missing route. */
  export function isRouteMissing(err: unknown): boolean;
  ```

**`planRoute`:**

| mode | result |
|---|---|
| `chat` | `caps.chat ? 'chat' : 'unsupported'` |
| `native` | `caps.native ? 'native' : 'unsupported'` |
| `template` | `fimTemplate && caps.template ? 'template' : 'unsupported'` |
| `auto` | 1. `native` when `caps.native`, and not (llama.cpp and `suffixFirst`), and (`!fim.chat` or `caps.nativeChatModels`); 2. else `template` when `fimTemplate && caps.template`; 3. else `chat` when `caps.chat && (fim.chat || !caps.template)`; 4. else `'unsupported'` |

**`whyNoRoute`:** returns `'mode'` when the chosen mode's route is missing from `caps` (`chat` without `caps.chat`, `native` without `caps.native`, `template` without `caps.template`). Otherwise it returns `'template'`.

**Texts:**
- `noRouteText('mode', m)` = `prompt mode "<m>" does not work with this server`.
- `noRouteText('template', …)` = `no completion template`.
- `explainUnsupported`'s template log, exactly (Backends page spec L285 text is kept when `!chatPossible`):
  - `!chatPossible`: `model "<m>" has no FIM template (not a known code-completion model): pick a coder model, or choose a template for it in AI Autocomplete: Manage Backends`;
  - `chatPossible`: `model "<m>" has no FIM template (not a known code-completion model): pick a coder model, choose a template for it, or set the prompt mode to chat in AI Autocomplete: Manage Backends`.
- No text in the code mentions `v0.2` any more.

**`buildChatRequest`:**
- `messages` = `holeFillerMessages(input, thinkingFields(fim.thinking, flavor).systemSuffix)`.
- `thinking` = that `body`, without the keys in `rejected`.
- `maxTokens` = `(input.multiline ? fim.maxTokens : Math.min(fim.maxTokens, 48)) + 32`, plus 1024 for `cannotDisable`.
- `sampling`:
  - `samplingParams === 'omit'` gives `{}`;
  - otherwise it is `fim.sampling` plus `presencePenalty: 0`, without any whose wire name (`temperature`, `top_p`, `top_k`, `presence_penalty`) is in `rejected`.
- `stop` = `chatStops(fim)`, which is `[COMPLETION_CLOSE, ...fim.backendStop]`, deduplicated.
- `extraBody` = `fim.extraBody`, and `timeoutMs` = `fim.chatTimeoutMs`.
- `model`, `signal` and `onRejected` are passed through.

**Callers in this task:**
- They pass `{ ...backend.routes(), chat: false }`, so the chat route stays off until Task 8 (provider) and Task 9 (connection test and page) turn it on and handle it.
- `form.ts` and `pageState.ts` build the routes from `createBackend(cfg, …).routes()`.
- `explainUnsupported` callers pass `chatPossible: false` in this task, because the chat route is still forced off and the log must not advise a mode that fails. Tasks 8 (provider) and 9 (connection test and page) switch it to `backend.routes().chat`.
- Until Task 9, prompt mode `chat` therefore reports `prompt mode "chat" does not work with this server` in the connection test and on the page. The rewritten `connectionTest.test.ts:93-97` and `pageState.test.ts:38-53` cases assert that interim text, and Task 9 changes them again.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  const LLAMA: RouteCaps = { native: true, template: true, chat: true, nativeChatModels: false };
  const LMSTUDIO = { native: false, template: true, chat: true, nativeChatModels: false };
  const OLLAMA = { native: true, template: true, chat: true, nativeChatModels: false };
  const DEEPSEEK = { native: true, template: true, chat: true, nativeChatModels: true };
  const STRATA = { native: false, template: false, chat: true, nativeChatModels: false };
  const MISTRAL = { native: true, template: false, chat: false, nativeChatModels: false };
  test('auto: chat families go to chat, except DeepSeek native FIM', () => {
    // CHAT = { suffixFirst: false, chat: true }: LLAMA, LMSTUDIO, OLLAMA, STRATA → 'chat'; DEEPSEEK → 'native'
  });
  test('auto: coder models keep native/template; unknown models chat only where completions are missing', () => {
    // qwen template on LLAMA → 'native', on LMSTUDIO → 'template'; unknown { chat: false } on STRATA → 'chat', on LMSTUDIO → 'unsupported',
    // on LLAMA → 'native' (Zeta, as today); mellum on LLAMA → 'template'
  });
  test('explicit modes', () => { /* chat on LMSTUDIO → 'chat', on MISTRAL → 'unsupported'; template on STRATA → 'unsupported' */ });
  test('a learned missing route is skipped', () => { /* usableRoutes(LLAMA, new Set(['native'])) → native false; unknown model then → 'unsupported' */ });
  test('a route is learned only when another route remains', () => {
    // coder template on LLAMA with native failed → planRoute(usableRoutes(LLAMA, {native})) is 'template' (learn it);
    // the same on MISTRAL → 'unsupported' (do not learn; the 404 stays an ordinary failure). Task 8 applies the same check.
  });
  test('whyNoRoute and noRouteText', () => { /* whyNoRoute(MISTRAL, 'chat') → 'mode' → 'prompt mode "chat" does not work with this server' */ });
  test('explainUnsupported names the chat mode only when the server can chat', () => {
    // chatPossible false → log is exactly the `!chatPossible` text above (no 'chat'); true → exactly the `chatPossible` text above
  });
  test('buildChatRequest for Qwen3.8 on Strata', () => {
    // single-line: maxTokens 80, stop ['</COMPLETION>'], thinking { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } },
    // sampling { temperature: 0.2, topP: 0.8, topK: 20, presencePenalty: 0 }, timeoutMs 15000; multi-line: maxTokens 160
  });
  test('buildChatRequest: cannotDisable budget, omitted sampling, rejected fields, soft switch, backend stops', () => {
    // gpt-oss on llamacpp multi-line → 1184 and thinking { reasoning_effort: 'low' }; kimi → sampling {};
    // rejected {'chat_template_kwargs','top_k'} → neither sent; nemotron-nano-v2 → system ends with '/no_think';
    // backend stop ['X'] → ['</COMPLETION>', 'X']
  });
  // capabilities.test.ts
  test('learns per backend and model, reports only what is new, and clears', () => {});
  test('sawThinking is true once and keeps the latest latency', () => {});
  test('isRouteMissing', () => {
    // HttpError 404/405/501 → true; 400 with body 'qwen3 does not support insert' → true; 400 'exceed_context_size_error' → false; TypeError → false;
    // 404 with body 'model "x" not found, try pulling it first' → false; 404 with body '{"error":{"message":"not found"}}' → true
  });
  ```
- [ ] **Step 2: Run** `npx vitest run test/unit/route.test.ts test/unit/capabilities.test.ts test/unit/connectionTest.test.ts test/unit/pageState.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the route changes, `buildChatRequest`, `capabilities.ts` and the caller updates.
- [ ] **Step 4: Run the full check.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: chat route planning, chat requests and learned capabilities`.

### Task 7: Collect any route's stream

**Files:**
- Create: `src/completion/stream.ts`, `test/unit/stream.test.ts`.
- Modify: `src/completion/filters.ts`, `test/unit/filters.test.ts`.

**Interfaces:**
- Consumes: `FimBackend`, `FimRequest`, `ChatRequest` (Task 3); `ReasoningFilter` (Task 2); `HoleFillerAnswer` (Task 5); `CompletionAccumulator` (existing).
- Produces:
  ```ts
  // filters.ts
  // CompletionAccumulator gains: replace(text: string): boolean   // sets the raw text and re-applies every rule; true once stopped
  // stream.ts
  export type PlannedRequest = { route: 'native' | 'template'; req: FimRequest } | { route: 'chat'; req: ChatRequest; linePrefix: string };
  export interface Collected { text: string; stoppedEarly: boolean; thinking: boolean; timedOut: boolean }
  /**
   * Streams one request into `acc` and returns `acc.text`. FIM routes push chunks as today (postprocess strips reasoning later).
   * The chat route feeds ReasoningFilter → HoleFillerAnswer → acc.replace(answer). When `acc` stops early, `ctl.abort()` ends the stream.
   * Throws the backend's error, except a TimeoutError after at least one complete line: those lines come back with timedOut true.
   */
  export function collectCompletion(backend: FimBackend, p: PlannedRequest, acc: CompletionAccumulator, ctl: AbortController): Promise<Collected>;
  ```

**Fold-in:** this is the follow-up "the timeout covers the whole stream, so output from a slow stream is thrown away; the 'show what we have' cap is not implemented (Phase 2)". After a `TimeoutError`:
- When `acc.text` contains `\n`, the text up to its last `\n` is returned with `timedOut: true`.
- Otherwise the error is rethrown.

- [ ] **Step 1: Write the failing tests** with fake backends (no HTTP).
  ```ts
  test('a FIM route returns the filtered text', () => { /* chunks ['a + b;\n', 'x'], single-line → { text: 'a + b;', stoppedEarly: true } */ });
  test('chat: reasoning is dropped and the answer extracted', () => {
    // events reasoning 'hm', content '<COMPLETION>a + b;', finish 'stop' → { text: 'a + b;', thinking: true, stoppedEarly: false }
  });
  test('an unclosed think at length yields no text and flags thinking', () => { /* content '<think>long', finish 'length' → text '', thinking true */ });
  test('a bare closing tag resets the answer', () => { /* content 'x<COMPLETION>no', '</think><COMPLETION>a + b;', finish → 'a + b;' */ });
  test('chat stops early once the single line is complete', () => { /* '<COMPLETION>a + b;\nmore' → 'a + b;', ctl.signal.aborted true */ });
  test('a timeout after complete lines keeps them', () => { /* multi-line chunks 'l1\nl2\nl' then throw TimeoutError → { text: 'l1\nl2', timedOut: true } */ });
  test('a timeout before any complete line throws', () => {});
  // filters.test.ts
  test('replace re-applies the rules to the new text', () => {});
  ```
- [ ] **Step 2: Run** `npx vitest run test/unit/stream.test.ts test/unit/filters.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `replace` and `collectCompletion`.
- [ ] **Step 4: Run the full check.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: shared completion stream loop with partial results on timeout`.

### Task 8: The chat route in the provider, learning and the thinking warning

**Files:**
- Modify: `src/completion/provider.ts`, `src/ui/statusBar.ts`, `src/ui/statusModel.ts`, `src/extension.ts`.
- Test: `test/unit/statusModel.test.ts`. The provider is covered by the Task 10 integration tests (including route learning); this task runs the existing ones.

**Interfaces:**
- Consumes: Tasks 2–7; `inferHostFlavor` (existing).
- Produces:
  ```ts
  // FimDeps gains: capabilities: Capabilities; thinking(note: string | undefined): void; notify(message: string): void
  // statusModel.ts
  export function thinkingNote(model: string | undefined, ms: number): string;
  //   → `${model ?? 'the model'} still thinks before answering (last thinking completion ${ms} ms); choose a model that can turn thinking off`
  // StatusBar gains setThinking(note: string | undefined): void
  //   while a note is set: text gets ' $(warning)' appended, the tooltip gets the line `Thinking: <note>`, current() ends with ' [thinking]'
  ```

**Provider behaviour:**
1. **Settings-change guard** (follow-up). After `debouncer.wait` and after model detection, `if (this.d.getSettings() !== s) return [];`.
2. **OpenRouter without a model sends nothing.** OpenRouter documents that "If the `model` parameter is omitted, the user or payer's default is used", so code would go to a model the user never chose. When `model === undefined` and `inferHostFlavor(backend.config) === 'openrouter'`, the provider:
   - reports `{ state: 'error', detail: '<id>: choose a model', action: { command: 'aiAutocomplete.manageBackends', args: [{ focus: id }] } }`;
   - logs once: `backend "<id>": OpenRouter needs a model: choose one in AI Autocomplete: Manage Backends`;
   - returns `[]`.
3. **Route.**
   - `learned = capabilities.get(id, model)`, then `route = planRoute(kind, usableRoutes(backend.routes(), learned.failedRoutes), fim, fimMode)`. The `chat: false` from Task 6 is removed.
   - `explainUnsupported` gets `chatPossible = backend.routes().chat` (Task 6 passed `false`).
4. **Chat request.**
   - It is built with `buildChatRequest`, from:
     - `flavor: inferHostFlavor(backend.config)`;
     - the window input plus `languageId: doc.languageId` and `multiline`;
     - `rejected: learned.rejected`.
   - `onRejected` records the fields with `capabilities.reject`. When fields are new, it logs at info: `backend "<id>": the server rejected <a, b> for <model>; sending without them`.
   - For a `cannotDisable` model, once per backend and model (the notified keys live in their own set, which `forgetLogged()` on a settings change does not clear, so a Save on the page does not notify again), it logs a warn and calls `notify`, exactly: `AI Autocomplete: <model> cannot turn thinking off, so completions will be slow. A coder model, or a model that can turn thinking off, fits autocomplete better.`
5. **Running it.**
   - `run()` uses `collectCompletion` for every route, then `postprocess` as today. The chat route's planned request is `{ route: 'chat', req, linePrefix }`, where `linePrefix` is the cursor line's text before the cursor.
   - The client-side `CompletionAccumulator` uses the request's own stop list, so client and server agree: `fim.stop` on FIM routes (as today) and `req.stop` (the closing tag plus backend stops) on the chat route.
   - The debug line names the route.
   - `timedOut` adds ` (timed out; complete lines shown)`.
   - With `logPrompts`, the chat messages and the raw answer are logged as the FIM prompt is today. Reasoning text is never logged without it.
6. **Thinking.**
   - When `collected.thinking` and `capabilities.sawThinking(...)` is true (the first time), it logs a warn: `backend "<id>": <model> still thinks with thinking off (<ms> ms); completions will be slow`.
   - After every successful request it re-reads `capabilities.get(id, model).thinkingMs` (the `learned` read before the request is stale) and calls `thinking(ms !== undefined ? thinkingNote(model, ms) : undefined)`. Switching to another backend or model therefore clears the warning.
   - The `notify` text uses `This model` when `model` is undefined.
7. **Learning a missing route.** In `failed()`, when `j.mode === 'auto'`, `j.route !== 'chat'`, `isRouteMissing(err)`, and `planRoute` with `j.route` added to the failed routes still returns a route (otherwise the 404 is an ordinary failure with backoff and its HTTP hint):
   - `capabilities.failRoute(...)`;
   - log once: `backend "<id>": no <route> endpoint for <model>; the next request uses the next prompt route`;
   - return `{ state: 'idle' }`, with no `recordBackendFailure`. The Job carries `route` and `mode` for this.

**`extension.ts`:**
- One `Capabilities`. `rebuild()` clears it and calls `status.setThinking(undefined)`.
- `thinking: (n) => status.setThinking(n)`.
- `notify: (m) => void vscode.window.showWarningMessage(m)`.

- [ ] **Step 1: Write the failing test.**
  ```ts
  test('thinkingNote names the model and the latency', () => {
    expect(thinkingNote('Qwen3.8', 950)).toBe('Qwen3.8 still thinks before answering (last thinking completion 950 ms); choose a model that can turn thinking off');
    expect(thinkingNote(undefined, 10)).toMatch(/^the model still thinks/);
  });
  ```
- [ ] **Step 2: Run** `npx vitest run test/unit/statusModel.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the provider, status bar and wiring changes.
- [ ] **Step 4: Run the full check**, then `npm run test:integration`. Expected: all pass; the existing integration tests are unchanged.
- [ ] **Step 5: Commit.** `feat: complete through the chat route with thinking off`.

### Task 9: Connection test and the Backends page

**Files:**
- Modify:
  - `src/manage/protocol.ts`, `src/manage/serverTypes.ts`, `src/manage/form.ts`, `src/manage/pageState.ts`, `src/manage/connectionTest.ts`;
  - `src/webview/backends/render.ts`, `src/ui/backendsPanel.ts`.
- Test: `test/unit/serverTypes.test.ts` (rewrite L6, the exact id list, and L23, where `openrouter` now infers `'openrouter'` instead of `other`), `test/unit/form.test.ts` (rewrite L115, the field order, which gains `thinking`), `test/unit/pageState.test.ts`, `test/unit/connectionTest.test.ts`, `test/unit/render.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces:
  ```ts
  // protocol.ts
  // ServerTypeId gains 'strata' | 'openrouter'; FormField gains 'thinking'; StepId gains 'thinking' (order: reach, model, completion, thinking, context)
  // pageState.ts
  export function modelTag(cfg: BackendConfig, model: string, s: Settings, thinkingMandatory?: boolean): string;
  //   native/template → 'ready'; chat → 'chat prompt', or 'chat prompt, always thinks' when cannotDisable or thinkingMandatory; else the no-route text
  ```

**Server types:**
- `strata` goes after `sglang`: label `Strata`, kind `openai`, flavor `strata`, URL `http://127.0.0.1:8080/v1` (Strata DETAILS.md: "listens on `http://127.0.0.1:8080`"), key `optional`.
- `openrouter` goes after `together`: label `OpenRouter`, kind `openai`, flavor `openrouter`, URL `https://openrouter.ai/api/v1`, key `yes`.

**Form:**
- **`thinking` field:**
  - It goes after `fimMode`, with the label `Thinking switch` and options `THINKING_STRATEGIES`.
  - It is stored as the string `fim.thinking`, like `template`. An unknown value gives the error `unknown thinking switch`.
  - Its default is the model's own strategy, with the source label.
  - When the route is not `chat`, it is disabled with the reason `used only by the chat prompt`.
- **Template field:** disabled on the chat route, with the reason `the chat prompt does not use a template`.
- **Timeout and Stop on the chat route:** `fieldViews` shows `chatTimeoutMs` (15000 unless the backend sets `fim.timeoutMs`) for Timeout and `chatStops(values)` (Task 6: `['</COMPLETION>', ...backendStop]`, not a copy of the rule) for Stop, instead of the FIM values. The "only the first 4 stop sequences are sent" warning counts that list.
- **`formWarnings`** adds `<model> cannot turn thinking off, so completions will be slow` for a chat route with a `cannotDisable` model.
- **Card warning:** `This model cannot turn thinking off`, for a chat-route model with `cannotDisable` (yellow dot).
- **`render.ts`:** the Prompt section is `['template', 'fimMode', 'thinking', 'multiline']`.
- **`backendsPanel.ts`:** `reloadModels` tags each model with `modelTag(cfg, id, s, mandatory.has(id))`, where `mandatory = new Set(info.thinkingMandatory ?? [])`.

**Connection test:**
- **Routes:** `routes()` without the Task 6 `chat: false`; `explainUnsupported` and the page's no-route text get `chatPossible: backend.routes().chat` (Task 6 passed `false`).
- **Model step:**
  - On the chat route its text is `Model <m> (chat prompt)`.
  - For `cannotDisable`, or when `info.thinkingMandatory` lists the model, it is a `warn` with the hint `this model cannot turn thinking off, so completions are slow`.
- **Completion step:**
  - It sends `buildFimRequest` or `buildChatRequest` through `collectCompletion`. The chat request's input is `SAMPLE` plus `languageId: 'typescript'` and `multiline: false`, with `rejected: new Set()` and an `onRejected` that collects the fields. The planned request's `linePrefix` is `'  return '`.
  - The chat request gets `timeoutMs: TEST_TIMEOUT_MS`, as the FIM request does today (`connectionTest.ts` L153; the existing test at `connectionTest.test.ts` L56 asserts it), so a 30 s first model load still passes and the `chatTimeoutMs` comparison means something.
  - The slow warning compares against `chatTimeoutMs` on the chat route.
  - The accumulator's stop list is the request's own, as in the provider: `values.stop` on FIM routes, the chat request's `stop` on the chat route.
- **Thinking step** (chat route only, after the completion step):
  - `ok`, text `Thinking is off`;
  - `warn`, text `the model still thinks with thinking off`, hint `completions take longer; choose a model that can turn thinking off, or set the Thinking switch`, when `collected.thinking`;
  - when fields were rejected, the hint (or an `ok` step's hint) adds `the server rejected <a, b>; they are left out`. Those are our own field names.
- **Context step:** it reads `Object.hasOwn(info.contextWindows, model)` (follow-up "`contextWindows[model]` uses a plain object").

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // serverTypes.test.ts
  test('Strata and OpenRouter types', () => { /* prefills above; serverTypeOf infers openrouter from openrouter.ai; strata only from its flavor */ });
  // form.test.ts
  test('thinking round-trips through fim.thinking and validates', () => {});
  test('fieldViews: thinking default from the model, disabled off the chat route; template disabled on it', () => {});
  test('chat route: Timeout and Stop show the chat values, and the stop warning counts them', () => {
    // OpenRouter backend, default model values: timeoutMs view value 15000, stop view value ['</COMPLETION>'], no '4 stop sequences' warning;
    // backend fim.stop ['a','b','c','d'] → stop view ['</COMPLETION>','a','b','c','d'] and the 'only the first 4 stop sequences are sent' warning
  });
  test('formWarnings flags a chat model that cannot turn thinking off', () => {});
  // pageState.test.ts (replaces the 'chat FIM arrives in v0.2' cases)
  test('modelTag: ready, chat prompt, always thinks, or no route', () => {
    // LM Studio: 'qwen2.5-coder-7b' → 'ready'; 'Qwen3.8-Flash-Next' → 'chat prompt'; 'gpt-oss-20b' → 'chat prompt, always thinks';
    // 'zeta-2.1' → 'no completion template'; ('z-ai/glm-5', mandatory true) → 'chat prompt, always thinks'
  });
  test('card warnings: chat mode works on LM Studio; Mistral chat mode does not; cannotDisable warns', () => {});
  // connectionTest.test.ts (the fake already has routes() and a no-op streamChat() from Task 3; its chat events become configurable)
  test('chat route: reach, model, completion and thinking ok', () => {
    // routes { native: false, template: true, chat: true, nativeChatModels: false }, model 'Qwen3.8-Flash-Next',
    // chat events content '<COMPLETION>a + b;' → steps [reach ok, model ok 'Model Qwen3.8-Flash-Next (chat prompt)',
    //   completion ok 'Test completion in 0 ms: "a + b;"', thinking ok 'Thinking is off']; the chat request's timeoutMs equals TEST_TIMEOUT_MS
  });
  test('a model that thinks anyway gets a thinking warning', () => {});
  test('rejected fields are named in the thinking hint', () => {});
  test('a cannotDisable model warns at the model step and still runs the completion', () => {});
  test('context step ignores inherited keys', () => { /* model 'constructor', contextWindows {} → no context step */ });
  // render.test.ts
  test('the thinking control has id f-thinking in the Prompt section', () => {});
  ```
- [ ] **Step 2: Run** `npx vitest run test/unit/serverTypes.test.ts test/unit/form.test.ts test/unit/pageState.test.ts test/unit/connectionTest.test.ts test/unit/render.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes.
- [ ] **Step 4: Run the full check**, then `npm run test:integration`. Expected: all pass.
- [ ] **Step 5: Commit.** `feat: chat route, thinking and new server types on the Backends page`.

### Task 10: Integration tests for the chat route

**Files:**
- Modify: `test/integration/mockServer.ts`, `test/integration/fim.test.ts`, `test/integration/backends.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  // MockOptions gains: chat?: { reasoning?: string[]; content?: string[]; finish?: string }
  //   default content ['<COMPLETION>a + b;'] (real servers drop the stop string), finish 'stop'.
  // POST /v1/chat/completions answers SSE:
  //   one {"choices":[{"delta":{"reasoning_content":r}}]} per reasoning chunk, one {"choices":[{"delta":{"content":c}}]} per content chunk,
  //   then {"choices":[{"delta":{},"finish_reason":finish}]}, then data: [DONE].
  // MockOptions also gains: infill501?: boolean  (POST /infill answers 501 "Infill is not supported by this model"; POST /completion answers an SSE stream with content 'a + b;')
  //   and rejectField?: string  (POST /v1/chat/completions answers 400 {"error":{"message":"Unrecognized request argument supplied: <field>"}} while the body has that field)
  ```

**Fold-in:** test 1's fixed `await sleep(300)` before `commit()` becomes a poll. A helper `commitWhen(editor, cond)` retries `commit()` every 50 ms until the text matches or 5 s pass. This is the follow-up "Integration test 1 waits a fixed 300 ms".

- [ ] **Step 1: Write the tests.**
  ```ts
  // fim.test.ts
  test('ghost text from a chat model on Strata, thinking off', async () => {
    // mock alias 'qwen3.8-flash-next-iq3_s'; backend { id, kind: 'openai', hostFlavor: 'strata', baseUrl: `${mock.baseUrl}/v1`, fimModel: 'qwen3.8-flash-next-iq3_s' }
    // trigger → a POST /v1/chat/completions arrives; commitWhen → document ends with 'return a + b;'
    // body: stream true, presence_penalty 0, reasoning_effort 'none', chat_template_kwargs.enable_thinking false, stop ['</COMPLETION>'],
    //   messages[0].role 'system', messages[1].content includes '<|cursor|>'
    // no POST to /v1/completions or /infill; status does not include '[thinking]'
  });
  test('a model that thinks anyway still completes and the status bar warns', async () => {
    // mock chat { reasoning: ['Let me think.'] } → document ends with 'return a + b;'; api.status.current() includes '[thinking]'
  });
  test('OpenRouter without a model sends nothing', async () => {
    // backend { id, kind: 'openai', hostFlavor: 'openrouter', baseUrl: `${mock.baseUrl}/v1` } with no fimModel
    // → no POST reaches the mock; status includes 'choose a model'
  });
  test('a missing route is learned silently and the next trigger uses the next route', async () => {
    // llama.cpp backend, coder model 'qwen2.5-coder-1.5b', mock infill501 true
    // 1st trigger → POST /infill arrives (501); status.current() has no error and no ghost text appears
    // 2nd trigger → POST /completion arrives; commitWhen → the document ends with 'a + b;'; no further POST to /infill
  });
  test('a server-rejected thinking field is retried once and left out afterwards', async () => {
    // optional: Strata-flavored backend, mock rejectField 'chat_template_kwargs'
    // 1st trigger → 2 POSTs to /v1/chat/completions, the 2nd without chat_template_kwargs, and ghost text appears
    // 2nd trigger → exactly 1 POST, without chat_template_kwargs
  });
  // backends.test.ts
  test('testForm on Strata runs the chat route and reports thinking', async () => {
    // draft type 'strata', URL `${mock.baseUrl}/v1`, mock alias 'qwen3.8-flash-next-iq3_s' with reasoning ['hm']
    // → steps reach ok, model ok 'Model qwen3.8-flash-next-iq3_s (chat prompt)', completion ok, thinking warn
  });
  ```
- [ ] **Step 2: Run** `npm run test:integration`. Expected: the new tests pass. If one fails, the defect is in Tasks 3–9: fix it there in this task's commit, and say so in the report.
- [ ] **Step 3: Run the full check.** Expected: PASS.
- [ ] **Step 4: Commit.** `test: chat route integration tests`.

### Task 11: Docs and handoff

**Files:**
- Modify: `README.md`, `AGENTS.md`, `docs/ROADMAP.md`, `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md`, `docs/superpowers/specs/2026-11-14-backend-manager-design.md`, `docs/superpowers/followups/2026-11-13-phase0-1-review-followups.md`.

- [ ] **Step 1: Update the docs.**
  - **README:**
    - Line 5: drop "OpenRouter support follows later".
    - Replace "Chat-only models" with **"Chat models (Strata, OpenRouter, general instruct models)"**:
      - general instruct and chat-only models complete through a chat prompt, which is slower than FIM;
      - thinking is turned off per model family and server, the Thinking switch overrides it, and reasoning is never shown;
      - the status bar warns when a model keeps thinking;
      - a Strata example (`kind: openai`, `hostFlavor: strata`, `http://127.0.0.1:8080/v1`) and an OpenRouter example (`https://openrouter.ai/api/v1`, Set API Key);
      - for LM Studio, turning thinking off in the model's settings when the warning appears.
    - Per-backend settings: add `thinking`.
    - **Privacy:**
      - OpenRouter forwards code to the model's provider;
      - no attribution headers are sent;
      - reasoning text is logged only with `debug.logPrompts`.
  - **AGENTS.md:**
    - Layout: `models/thinking.ts`, `models/capabilities.ts`, `completion/holeFiller.ts`, `completion/stream.ts`, `backends/chat.ts`, `backends/openrouter.ts`.
    - Hard rule: reasoning text and server error bodies are logged only with `debug.logPrompts`.
    - Hard rule: the chat prompt is our own wording; never Continue's hole-filler prompt.
  - **ROADMAP:**
    - Phase 2 row: link this plan, status `implemented; v0.2.0 ships after Publish`.
    - Deferred manual checks: add Publish step 4's list.
  - **Backends page spec** (`2026-11-14-backend-manager-design.md`, which wins for backend management), one bullet per item:
    - log line and "chat FIM arrives in v0.2" message (L285-286): the template log now has the `!chatPossible` text and the `chatPossible` variant ("pick a coder model, choose a template for it, or set the prompt mode to chat in AI Autocomplete: Manage Backends");
    - `fim` keys (L130): add `thinking`;
    - Prompt fields (L87): add the Thinking switch;
    - server-types table (L103-116): add Strata and OpenRouter;
    - test steps (L187-216): the chat route and the thinking step;
    - model tags (L85): `chat prompt` and `chat prompt, always thinks`;
    - non-goal (L27): chat route is no longer a non-goal;
    - Timeout and Stop show the chat values on the chat route.
  - **Verified host facts:** every host fact copied into the spec carries `verified 2026-11-15` and its source or commit (for example llama.cpp `5c008e0`, vLLM `a16bfee`, SGLang `7b5fb39`, Ollama `a5864fc`, Strata `13eedf5`, LM Studio docs `8c7159b`), so later sessions know when to recheck.
  - **Main spec:**
    - "Thinking control": OpenRouter → `reasoning:{effort:"none"}`; `cannotDisable` families get `effort:"low"`; a model that rejects `none` is retried without `reasoning` and remembered; the extra strategy ids `templateKwarg:thinking_mode=disabled` and `templateKwarg:thinking_budget=0`; the new delimiters; vLLM's `delta.reasoning`.
    - Family reassignments: Qwen3-2504 (spec L163, `systemSoftSwitch`) uses `templateKwarg:enable_thinking` (row `qwen3`); MiniMax M3 (spec L162, `vendorThinkingDisabled`) uses `templateKwarg:thinking_mode=disabled` (row `minimax-m3`).
    - Architecture tree: L122 `completion/hole-filler.ts` becomes `completion/holeFiller.ts`; L107 `openrouter.ts` sends `reasoning:{effort:"none"}`, not `reasoning:{enabled:false}`.
    - "Backends and how a FIM request is routed": OpenRouter is chat only; chat in `auto` mode is for chat families or servers without raw completions; route learning statuses.
    - "To verify during implementation":
      - **OpenRouter `/api/v1/completions` and `suffix`:** answered. The route exists but is undocumented, and `suffix` is undocumented, so OpenRouter is chat only.
      - **LM Studio's per-request thinking toggle:** still open; Publish step 4 records the result.
      - **Strata time to first token:** partly answered on the user's Strata endpoint (hardware not recorded). A 152-token prompt took about 2.5 s cold and 0.23 s with its start cached. The 2K and 4K measurements are still open.
      - **New open items:**
        - Kimi K3.1-Pro thinking off;
        - the kwarg servers expect for DeepSeek V3.2;
        - Magistral without its system prompt;
        - the Gemma 3 template (gated);
        - the status OpenRouter returns for `effort:"none"` on a mandatory model (the retry covers 400 and 422);
        - unknown-field handling on llama.cpp, SGLang and Ollama (inferred from code).
  - **Follow-ups:**
    - Remove the entries this plan fixed: debouncer settings; `"true"` localOnly; `stop: []`; the whole-stream timeout; `contextWindows` prototype keys; the duplicated `FIM_MODES`/`MULTILINE` (only that clause of the compound entry at L80; the `getJson`/`postJson` duplication and the duplicated hosted check stay); `resolvePreset` override stops; integration test 1's fixed wait.
    - Add whatever the reviews park.
- [ ] **Step 2: Run the full check.** Expected: PASS.
- [ ] **Step 3: Commit.** `docs: chat models, thinking control, OpenRouter and Strata`.

---

## Publish (controller only, after Task 11 and the final review)

These steps create public state on GitHub. **Ask the user once, listing every step, and wait for a yes.** If the user approves only part, do only that part.

1. `git push -u origin feat/chat-thinking`.
2. `gh pr create -R Raboo/vscode-ai-autocomplete --base main --head feat/chat-thinking --title "feat: chat prompt for chat models, thinking control, OpenRouter and Strata" --body <summary ending with the Claude Code line>`.
3. Watch CI with `gh pr checks <n> -R Raboo/vscode-ai-autocomplete --watch`. Expected: `check`, `integration` and `analyze` pass. Fix forward on the branch.
4. **The user's smoke test.** Download the PR's CI `.vsix` with `gh run download <run> -R Raboo/vscode-ai-autocomplete -n vsix -D <dir>`, and install it with `code --install-extension <dir>/ai-autocomplete-*.vsix`. Then the user runs these checks, which also go into ROADMAP "Deferred manual checks":
   - **Strata** (the user's Strata endpoint, credentials in the git-ignored `.env`): add it from the Backends page as type Strata. Test shows:
     - `Model qwen3.8-flash-next-iq3_s (chat prompt)`;
     - a completion;
     - `Thinking is off`.

     Then, in a TypeScript file:
     - ghost text appears, with no reasoning in it;
     - with `debug.logPrompts` on, the log shows the chat request and the completion time, and the request carries `presence_penalty` 0.
   - **OpenRouter**, with the user's key:
     - a model that can turn thinking off (for example `z-ai/glm-5`) gives ghost text with no `<think>` leak and sane latency;
     - in the model list, a mandatory-reasoning model (for example `minimax/minimax-m2.5`) is tagged `chat prompt, always thinks`, and using it shows the one-time warning and the status-bar thinking warning;
     - `privacy.localOnly` blocks OpenRouter.
   - **LM Studio** with a Qwen3.x model in `auto` mode:
     - the chat route is used;
     - whether thinking goes off per request. Record the answer in the spec's "To verify" list.
   - **llama.cpp, no regression:** a coder model (`--fim-qwen-1.5b-default`) still completes through `/infill`.

   Continue only after the user confirms.
5. Merge with `gh pr merge <n> --squash -R Raboo/vscode-ai-autocomplete`. The squash subject is the PR title, which release-please reads. release-please then opens or updates its release PR for **0.2.0** (`bump-minor-pre-major` with a `feat`).
6. `git checkout main && git pull`, then delete the local branch.
7. **Release v0.2.0 needs its own yes from the user.** If granted:
   - `gh pr merge <release-pr> --squash --admin -R Raboo/vscode-ai-autocomplete`. Release PRs get no CI without `RELEASE_PLEASE_TOKEN`, as AGENTS.md notes.
   - Verify with `gh release view v0.2.0 -R Raboo/vscode-ai-autocomplete --json assets --jq '.assets[].name'`. Expected: `ai-autocomplete-0.2.0.vsix`.
   - Record "released in v0.2.0" for Phase 2 in `docs/ROADMAP.md` in a `docs:` commit. Pushing it to `main` needs the user's yes.
