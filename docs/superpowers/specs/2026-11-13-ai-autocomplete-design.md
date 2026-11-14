# AI Autocomplete — a lean FIM + Next Edit extension for VS Code

## Context

Elias Abacioglu wants a VS Code extension that **only** does AI autocomplete, and does it very well:
ghost-text fill-in-the-middle (FIM) and Next Edit Suggestions (NES). No chat, no agents.

Why it is needed (user's words, summarized):
- Copilot's extension can't use any other service for completions.
- Kilo Code only allows Mercury/Mistral (and on 2026-11-12 removed Mercury and Next Edit; it is now Codestral-only).
- Predicte only supports Mistral.
- Reasoning models break autocomplete: they are slow, or `<think>` text leaks into suggestions.
- The other tools are bloated with agent/chat features.

Primary use is **self-hosted** FIM and Next Edit with llama.cpp, LM Studio or Strata on sensitive projects.
Secondary: Mistral Codestral (free key) on open-source projects, and occasionally OpenRouter.
Copilot is a later, non-committed phase.

The working folder `/Users/raboo/ai/autocomplete` is empty. There is no existing code to reuse locally.

Facts about Strata (github.com/Niko1221/Strata, MIT, built on llama.cpp) that shape the design:
- It serves Qwen3.8-Flash-Next (125B total / 6B active).
- It exposes **chat only**: `/v1/chat/completions`, `/v1/messages`, `/v1/responses`. There is no `/v1/completions`, `/infill` or raw `prompt`, so **no FIM**.
- Thinking defaults to `high`. Turn it off with `reasoning_effort:"none"` or `chat_template_kwargs:{enable_thinking:false}`. Reasoning streams as `reasoning_content`.
- Default non-thinking sampling includes `presence_penalty 1.5`, which is bad for code, so we must send 0.
- Published time to first token is about 4 s for a 4K prompt on an RTX 5070.

So on Strata, Next Edit is **borderline** and ghost-text FIM is **not viable**. The plan keeps Qwen3.8/Strata as the first Next Edit experiment, but builds the small dedicated models right after it.

## Decisions already made by the user

| Topic | Decision |
|---|---|
| License | **Apache-2.0 + NOTICE** naming Elias Abacioglu as original author |
| Name | Display name **"AI Autocomplete"**, extension id `raboo.ai-autocomplete`, settings prefix `aiAutocomplete.*` |
| Repo | **Fresh code in a new repo `Raboo/vscode-ai-autocomplete`**. The existing `Raboo/ai-autocomplete` (a fork of fsiovn's extension) stays untouched. |
| Distribution | **GitHub Releases (.vsix) first**. VS Code Marketplace and Open VSX later, with a guide to creating the accounts. |
| NES display | **Hybrid**: native Copilot-style UI via the proposed `inlineCompletionsAdditions` API when the user opts in, with a decoration-based fallback. Pure insertions at the cursor always use ghost text. Build the native renderer first. |
| First NES backend | **Qwen3.8-Flash-Next on Strata through a chat prompt** (thinking off, small context, tuned sampling). Small dedicated models (Zeta 2.1, Sweep, Mellum, Granite) on llama.cpp/LM Studio come next. |
| Local model helper | **Wanted**: recommend 2–3 local models with tuned launch arguments, and optionally download and start them as a background process. |

## Goals, non-goals, anti-goals

- **Goals**
  - Fast, accurate FIM ghost text for any OpenAI-compatible server, llama.cpp `/infill`, and Mistral Codestral.
  - Next Edit suggestions from self-hosted models.
  - Thinking/reasoning reliably switched off, or stripped, per model family and per host.
  - Per-model sampling presets for FIM and for Next Edit, each overridable by the user.
  - Provider chosen per workspace, with a "local only" lock for sensitive repos.
- **Non-goals**
  - Chat, agents, commit messages, or a webview beyond the Backends page (see `2026-11-14-backend-manager-design.md`).
  - VS Code for the Web; the extension is desktop-only because it spawns processes and talks to localhost.
  - A dedicated Mercury adapter: Inception shuts the Mercury API down on 2026-12-28 (verified on docs.inceptionlabs.ai).
- **Anti-goals** (failure even if it "works")
  - Any telemetry, or code sent anywhere the user didn't configure.
  - A workspace's `.vscode/settings.json` being able to redirect code to another endpoint.
  - Latency regressions from heavy context gathering, or from a model that silently thinks.
  - Bloat: large dependency trees, or vendoring Continue's whole core (tree-sitter wasm, sqlite).

## Approaches considered for Next Edit display (user picked A)

- **A. Hybrid** (chosen). Native NES UI through the proposed `inlineCompletionsAdditions` API (`isInlineEdit`, multi-line `range`, `showRange`, `displayLocation`/`jumpToPosition`) when the user opts in. Otherwise a decoration preview: strikethrough on removed text, an `after:` decoration with the new text, a "Tab to jump/apply · Esc" hint, and Tab/Esc bound through a context key.
  - Trade-off: two renderers to maintain, and the proposal can change between VS Code releases.
  - Opt-in: `"enable-proposed-api": ["raboo.ai-autocomplete"]` in `~/.vscode/argv.json` plus a restart. A command writes this for the user.
  - Precedent: `ali50m.xnes` ships this way on the Marketplace.
- **B. Decorations only.** Works everywhere with no flags, but looks rough for multi-line rewrites.
- **C. Proposed API only.** Least code, but Next Edit is off for anyone without the opt-in.

Proposed-API mechanics:
- `package.json`: `"enabledApiProposals": ["inlineCompletionsAdditions"]`. The proposal file has no `// version:` header (checked on `main`), so no `@N` suffix is needed.
- Packaging: `vsce package --allow-proposed-apis inlineCompletionsAdditions`; plain `vsce package` refuses.
- Pin the `.d.ts` from the **git tag matching `engines.vscode`** (e.g. `release/1.146` or tag `1.146.0`), not from `main`, which can declare fields the Stable runtime lacks. Latest Stable is 1.146.0. A CI job against Insiders catches proposal drift.
- **Opt-in command**:
  - edits `argv.json`, which is JSONC, with `jsonc-parser` (MIT, Microsoft) so comments are preserved;
  - the path depends on `vscode.env.appName`: `~/.vscode/argv.json`, `~/.vscode-insiders/argv.json`, or `~/.vscode-oss/argv.json` (VSCodium);
  - if the edit fails, it opens `workbench.action.configureRuntimeArguments` with paste instructions;
  - it then offers a restart.

Key API facts (verified in VS Code `main`, 2026-11):
- Stable `InlineCompletionItem.range` must stay on one line. Multi-line insertion at the cursor works.
- Replacing earlier lines, or showing an edit away from the cursor, needs `isInlineEdit`, which is proposed.
- Defining `handleDidShowCompletionItem`, or passing registration `metadata`, **throws** without the proposal. This is used as a runtime probe: try the proposed registration in a `try/catch` and fall back to stable registration.

## Architecture

Stack:
- TypeScript (strict), bundled with esbuild into `dist/extension.js`.
- Runtime dependencies: only `diff` (jsdiff, BSD-3) for line and unified diffs, and `jsonc-parser` (MIT) for the argv.json opt-in.
- HTTP through global `fetch`, with a small in-house SSE parser. No vendor SDKs.
- Tests with vitest for pure modules, and `@vscode/test-electron` for integration.

```
src/
  extension.ts                 activate: config, backends, providers, status bar, commands
  config/
    settings.ts                typed reader + validation; scope rules (see Security)
    secrets.ts                 API keys in SecretStorage, keyed by backend id
    localOnly.ts               loopback/private-range/.local host check
  backends/
    types.ts                   Backend interface: fim() / complete() / chat() → AsyncIterable; capabilities
    http.ts, sse.ts            fetch with AbortSignal, timeouts, SSE parsing, ErrorBackoff
    llamacpp.ts                /infill (input_prefix/suffix/extra, n_predict, t_max_predict_ms, cache_prompt),
                               /completion (raw prompts for NES models), /v1/chat/completions, /props autodetect
    openaiCompat.ts            /v1/completions (raw template OR `suffix`), /v1/chat/completions;
                               host flavors: vllm, sglang, lmstudio, ollama, strata, deepseek, fireworks, together, generic
    mistral.ts                 /v1/fim/completions; codestral.mistral.ai ↔ api.mistral.ai fallback; chat-shaped response
    openrouter.ts              openaiCompat + reasoning:{enabled:false}, models metadata (reasoning.mandatory)
  models/
    presets.ts                 DATA: family regex → FIM template, stops, thinking strategy, sampling {fim, nes}
    templates.ts               FIM template renderers (qwen/repo-level, codestral, deepseek, starcoder, codellama,
                               codegemma, granite-code, granite4, seed-coder, mellum (suffix-first, <filename> ctx), …)
    thinking.ts                request mutation per (family strategy × host flavor); response stripping
    capabilities.ts            learned per (backend, model): rejected params, "thinks anyway", FIM support
  completion/
    provider.ts                InlineCompletionItemProvider (FIM)
    gate.ts                    enabled/language/file globs, multi-cursor, suggest-widget, mid-word skip
    cache.ts                   suggestion history: exact / typed-through / backspace matches
    scheduler.ts               adaptive debounce, in-flight reuse, per-document AbortController
    context.ts                 prefix/suffix windowing, char-based token budget, extra-context ring buffer
    filters.ts                 streaming stop rules
    postprocess.ts             final cleanup and duplicate checks
    hole-filler.ts             chat prompt for models without FIM (own wording)
  nextEdit/
    history.ts                 edit-diff history + recently viewed snippets
    region.ts                  editable region around the cursor
    trigger.ts                 when to request (after edits / cursor moves), cooldowns
    formats/                   chatXtab.ts (first), zeta21.ts, sweep.ts, instinct.ts — buildPrompt()/parse()
    diff.ts                    old vs new region → minimal edit; classify insertion-at-cursor vs inline edit
    render/native.ts           proposed-API InlineCompletionItem(isInlineEdit…)
    render/decorations.ts      fallback preview + Tab/Esc keybindings via context key
  local/
    recipes.ts                 DATA: curated local models + llama-server / lms launch args
    manager.ts                 detect llama-server/lms, spawn, health-poll, stop; download progress
  ui/
    statusBar.ts               state, snooze, quick switch, "model is thinking" warning
    log.ts                     OutputChannel; prompts logged only if aiAutocomplete.debug.logPrompts
  types/vscode.proposed.inlineCompletionsAdditions.d.ts   pinned copy (via `npx @vscode/dts dev`)
test/unit/…, test/integration/… (mock llama.cpp/OpenAI server)
```

### Backends and how a FIM request is routed

For each backend+model, the first route that works is used, and the result is remembered in `capabilities.ts`:

1. **Native FIM**:
   - llama.cpp `/infill`, which applies the model's own FIM tokens and repo-level `input_extra` context;
   - Mistral `/v1/fim/completions`;
   - `/v1/completions` with `suffix` (DeepSeek beta, Ollama, SiliconFlow).
2. **Raw template** on `/v1/completions`, using a client-side template from `templates.ts` (vLLM, LM Studio, Fireworks, Together, Strata if it has completions).
3. **Chat hole-filler** for models without FIM (OpenRouter chat models, general instruct models), with thinking switched off.

Expectation: the fast FIM path is a **coder model on llama.cpp `/infill`** (or Codestral). General models such as Qwen3.5/3.6/3.8 have FIM tokens in the tokenizer, but FIM isn't documented, so pointing FIM at Qwen3.8 on Strata lands on the chat hole-filler (route 3), which is slower. Qwen3.8 is the planned **Next Edit** model. A `fimMode: auto | native | template | chat` override per backend lets the user try raw-template FIM on Qwen3.8 anyway.

### Thinking control (`models/thinking.ts`)

There is no universal switch, so this is a table, not scattered `if`s.

- **Model family strategy (`presets.ts`)**: each family declares one of
  - `none` (coder/instruct-only checkpoints);
  - `templateKwarg:enable_thinking` (Qwen3/3.5/3.8, GLM, Granite 4.2, Nemotron 3.5);
  - `templateKwarg:thinking` (DeepSeek V3.1/3.2 open weights, Kimi);
  - `vendorThinkingDisabled` (DeepSeek API, Z.ai, Moonshot, MiniMax M3);
  - `reasoningEffortNone` (GPT-5.x, Mistral Small 4, Gemini 2.5 Flash);
  - `systemSoftSwitch:/no_think` (Qwen3-2504, Nemotron Nano v2);
  - `cannotDisable` (gpt-oss, MiniMax M2.x, GLM-5.3, Gemini 3+, Kimi K3).
- **Host flavor envelope**:
  - llama.cpp, vLLM and SGLang → `chat_template_kwargs` plus `reasoning_effort:"none"`;
  - Strata (verified in its DETAILS.md) → `reasoning_effort:"none"` plus `chat_template_kwargs:{enable_thinking:false}`, and always send explicit sampling (`presence_penalty:0`) to override its chat defaults;
  - Ollama → `think:false` or `reasoning_effort:"none"`;
  - OpenRouter → `reasoning:{enabled:false}`;
  - vendor APIs → `thinking:{type:"disabled"}`.
- **Learning**: if a host returns 400 for a parameter, retry once without it and remember that per (backend, model). If reasoning still shows up, flag it.
- **Stripping, always on**:
  - ignore the `reasoning_content`, `reasoning`, `reasoning_details` and `thinking` fields;
  - strip `<think>…</think>`, `<seed:think>…</seed:think>`, and Gemma 4's empty `<|channel>thought…<channel|>`;
  - keep only the text after the last `</think>`;
  - discard the result if reasoning is unclosed and `finish_reason` is `length`.
- **`cannotDisable` models** get a one-time warning saying they are a poor fit, and the status bar shows the observed latency.
- Hosts that reject sampling parameters (Kimi, Claude Sonnet 5, MiniMax M3) get a `samplingParams: "omit"` preset.

### Sampling presets (defaults; every value can be overridden per model through `aiAutocomplete.modelOverrides`)

| Use | Defaults |
|---|---|
| FIM, coder models | temperature 0.1 (Codestral 0.2; Qwen-Coder greedy-ish 0–0.1), top_p 0.95, top_k 40 where supported, max_tokens 128 (single-line 48), model FIM tokens + `\n\n\n` as stops, llama.cpp `t_max_predict_ms` 500, `cache_prompt: true` |
| FIM, chat hole-filler | temperature 0.1–0.2, max_tokens 160, stop `</COMPLETION>` |
| NES, dedicated models (Zeta/Sweep/Instinct) | greedy (temperature 0), max_tokens ≈ editable-region size × 1.5 + margin, format-specific end markers |
| NES, chat models (Qwen3.8 etc.) | thinking off; temperature 0.2, top_p 0.8, top_k 20, **presence_penalty 0** (the model card's 0.7 / 1.5 values are chat settings that penalise repeated brackets and indentation); max_tokens ≈ region size × 1.5 |
| NES, Sweep (1.5B / v2 7B) | temperature 0; max 512 (1.5B) / 1024 (7B); stop `<\|file_sep\|>`, `</s>` (1.5B) or `<\|endoftext\|>`, `<\|file_sep\|>` (v2) |
| NES, Zeta 2.1 | temperature 0.2, max_tokens 256–512; stop `<[end▁of▁sentence]>` only. Never stop on `<\|marker_2\|>`, which cuts off multi-block edits. |

Mistral rule: set either `temperature` or `top_p`, not both. The `mistral` backend preset therefore omits `top_p`. Twinny notes that some hosted completion endpoints reject more than 4 stop sequences, so the stop list is capped per backend.

### FIM pipeline (`completion/`)

1. **Gate** (skip the request when any of these hold):
   - disabled or snoozed;
   - language or glob excluded;
   - multiple cursors;
   - a suggest-widget item is selected;
   - the cursor is mid-word (configurable).
2. **Cache** lookup over the last ~50 suggestions: exact match, typed-through (prefix grew by text that matches the suggestion), or backspace.
3. **Scheduler**:
   - leading-edge request, then an adaptive trailing debounce (the average of recent latencies, clamped to 50–600 ms; local backends start lower);
   - join an in-flight request when the new prefix extends its prefix and the suffix is the same;
   - otherwise abort the old request.
4. **Context**:
   - prefix/suffix line windows within a character budget;
   - an extra-context ring buffer of chunks from recently edited and viewed files, which maps to `/infill` `input_extra` or to repo-level template headers and keeps llama.cpp's KV-cache reuse high;
   - optional clipboard.
5. **Stream filters**:
   - stop tokens;
   - stop when the output starts reproducing the suffix;
   - stop at repeating lines;
   - stop at a line similar to the next existing line;
   - single-line vs multi-line (`auto | always | never`);
   - a time cap ("show what we have at X ms").
6. **Postprocess**:
   - drop blank results;
   - drop if it repeats the previous line;
   - drop if it duplicates the suffix or the end of the prefix;
   - strip code fences and thinking text;
   - replace the rest of the line when the model re-typed it.
7. **Return** the item with a `command` that records acceptance in local stats only. After an accept, optionally fire a speculative next request.

### Next Edit pipeline (`nextEdit/`)

- **History**:
  - snapshot each file on open;
  - create a unified diff after ~1.5 s idle and keep the last 5 diffs (oldest first, merged per area);
  - flush right before each request;
  - keep up to 5 recently viewed snippets of ~20 lines.
- **Trigger**:
  - after an edit pause;
  - on cursor moves within 10 s of the last edit;
  - cooldown after a rejection.
- **Region**: cursor −5/+10 lines, capped at ~25; each format can override this.
- **Context budget** (`aiAutocomplete.nextEdit.contextBudget`, default ~1500 tokens for the current file, ~1000 for diff history and ~1000 for snippets): the current file is clipped in 10-line pages around the region, the way Copilot does it. The whole file is **not** sent, which suits the user's small-context Qwen3.8 setup.
- **Formats** (each provides `buildPrompt(ctx)` and `parse(text, ctx)` returning the new region text, or "no change"):
  1. **chatXtab** (first): a system prompt plus one user message using the Copilot/Mercury tags `<|recently_viewed_code_snippets|>`, `<|current_file_content|>`, `<|code_to_edit|>…<|cursor|>…<|/code_to_edit|>`, `<|edit_diff_history|>`. The answer is the rewritten region in a ``` fence, or `NO_CHANGE`. A missing closing fence means the output was truncated, so it is dropped.
     - Section order runs from most stable to most volatile (snippets → clipped file → diff history → editable region with cursor last) so that Strata's and llama.cpp's prefix caches reuse the start of the prompt between keystrokes.
  2. **sweep**: raw `/completion` on llama.cpp.
     - Sections: `<|file_sep|>{path}` context files, `<|file_sep|>{file}.diff` with `original:`/`updated:` blocks, `original/{file}`, `current/{file}`, then generation after `<|file_sep|>updated/{file}`.
     - v2 7B adds `:start:end` line ranges, the `<|cursor|>` marker, a ±10-line window, and a prefill up to the cursor line.
     - Sources: the model's `run_model.py` and `inference.py` on Hugging Face.
  3. **zeta21**: suffix-first layout.
     - `<[fim-suffix]>after<[fim-prefix]><filename>related…<filename>edit_history(diff)<filename>target before<|marker_1|>…<|user_cursor|>…<|marker_N|><[fim-middle]>`.
     - The output is the region between the first and last marker that it echoes back; the same marker number at both ends means no edit.
     - Blocks are 6–16 lines; prompt budget ~4K; at most 6 edit events.
     - Implement from the model card. Check the license of Zed's `zeta_prompt` crate before porting any code, because parts of Zed are GPL.
  4. **instinct**: optional.
- **Diff and classify**:
  - trim identical leading and trailing lines;
  - if the change is a pure insertion at the cursor, show it as ghost text;
  - otherwise it is an inline edit, shown with the native renderer when the proposal is available and with decorations if not.
  - Before applying, check that the original text hasn't drifted.
  - After an accept, chain the next prediction (re-trigger after ~60 ms) so repeated Tabs walk through a refactor.
- **Arbitration with FIM**: one registered provider returns a fresh NES result for the current document version if there is one, otherwise the FIM result. While the user is typing mid-line, FIM wins.

### Settings and security

| Setting | Scope / notes |
|---|---|
| `aiAutocomplete.backends` | **machine** scope: `[{id, kind, baseUrl, hostFlavor?, fimModel?, nextEditModel?, fimMode?, headers?}]`. Keys go in SecretStorage through the "Set API key" command. A workspace can never add or edit endpoints. Machine scope keeps `localhost` endpoints from syncing into remote/SSH windows, where `localhost` is a different machine. |
| `aiAutocomplete.fim.backend`, `aiAutocomplete.nextEdit.backend` | Workspace-overridable, but only to choose among configured backend ids. |
| `aiAutocomplete.privacy.localOnly` | Workspace-settable (it can only restrict). Refuses non-loopback, non-private backends, and shows a lock icon in the status bar. |
| `aiAutocomplete.fim.*` | `enabled`, `debounceMs`, `multiline`, `maxTokens`, `prefixLines`/`suffixLines`, `extraContext`, `disableInLanguages`, `disableInFiles` |
| `aiAutocomplete.nextEdit.*` | `enabled`, `format` (`auto`, `chatXtab`, `zeta21`, `sweep`, `instinct`), region size, history size, `display` (`auto`, `native`, `decorations`) |
| `aiAutocomplete.modelOverrides` | machine scope: regex → `{fimTemplate, stop, sampling, extraBody, thinking}` |

- **Status bar**: idle, loading, error, snoozed, local-lock, and a "thinking" warning. Clicking it opens a quick pick to toggle, snooze, switch backend, show the log, or set up a local model.
- **Telemetry**: none.

### Local model helper (`local/`)

- **Command** "AI Autocomplete: Set up local model":
  - shows curated recipes (FIM and NES), each with a RAM/VRAM hint;
  - detects `llama-server` (or `lms`), and if it is missing shows install hints (brew, winget, releases);
  - spawns `llama-server -hf <repo>:<quant> …preset flags` as a managed child process; llama.cpp downloads and caches the model itself;
  - streams its output to the log, parsing download progress for a progress notification;
  - polls `/health`;
  - registers a `local-…` backend automatically.
- Options: stop the server when VS Code closes, or keep it running.
- Binary detection: `llama-server`, or the newer unified `llama serve`. Always pass `--port`, because llama.cpp's default port changed to 9931.
- The `-hf` cache lives in `LLAMA_CACHE`, then the HF hub cache, otherwise `~/.cache/huggingface/hub`.
- LM Studio alternative: `lms get` / `lms load --context-length … --identifier …` / `lms server start --port 1234`, using raw-prompt `/v1/completions`.

Initial recipes (`local/recipes.ts`; flags verified against the llama.cpp server README and `arg.cpp`). Common flags: `-fa on -ngl all -np 1 -b 1024 -ub 1024 --cache-reuse 256`.

| Purpose | Model | Command core | Endpoint / format | Hint |
|---|---|---|---|---|
| FIM (default) | Qwen2.5-Coder 3B Q8_0 (1.5B / 7B variants) | `--fim-qwen-3b-default --port 8012` | `/infill`, repo-level | ≥16 GB; 1.5B for weak machines |
| FIM (alt) | JetBrains Mellum-4b-base Q8_0 (official GGUF) | `-hf JetBrains/Mellum-4b-base-gguf:Q8_0 -c 8192` | `/completion`, suffix-first `mellum` template | 8K context |
| FIM (big machine) | Qwen3-Coder-30B-A3B Q8_0 | `--fim-qwen-30b-default` | `/infill` | 64 GB Mac |
| NES (default) | Sweep next-edit 1.5B Q8_0 (official GGUF) | `-hf sweepai/sweep-next-edit-1.5B:Q8_0 -c 8192` | `/completion`, `sweep` format | tiny, fast |
| NES (alt) | Zeta 2.1 Q8_0 (community GGUF `adilkairolla/zeta-2.1-GGUF`) | `-hf adilkairolla/zeta-2.1-GGUF:Q8_0 -c 8192` | `/completion`, `zeta21` format | 136 ms median in Zed |
| NES (bigger) | Sweep next-edit v2 7B (community GGUF) | quant tag to verify | `/completion`, `sweep` v2 | 32K context |

Each recipe also maps to a model preset (template, stops, sampling), so a backend created by the helper works with no further setup.

Each recipe carries `official: boolean`. Community quants (Zeta 2.1, Sweep v2 7B) are labeled "community quant, not official" in the quick pick, never become the default, and the user can override their HF repo per recipe. Only official GGUFs (ggml-org Qwen2.5-Coder, JetBrains Mellum, Sweep 1.5B) can be defaults.

### Code reuse with attribution (port selectively, never vendor wholesale)

| Source (license) | What to port |
|---|---|
| Continue (Apache-2.0), commit `5522c6f` | `core/autocomplete/templating/AutocompleteTemplate.ts` (templates and stop tokens; fix its qwen/deepseek quirks); `filtering/streamTransforms/*`, `lineStream.ts` (stop rules); `postprocessing/index.ts`; `classification/shouldCompleteMultiline.ts`; `extensions/vscode/src/autocomplete/completionProvider.ts` (`processSingleLineCompletion`) |
| Kilo Code (MIT on main; Apache-2.0 legacy) | `packages/kilo-vscode/src/services/autocomplete/classic-auto-complete/{inline-utils.ts, contextualSkip.ts, uselessSuggestionFilter.ts, AutocompleteInlineCompletionProvider.ts}`, `ErrorBackoff.ts`, `kilo-gateway/src/mistral-fim-endpoint.ts`. NES at commit `cf41438`: `next-edit/{editHistoryTracker,editableRegion,NextEditSuggestionManager,NextEditInlineCompletionProvider}.ts` and the `docs/nes-examples/` test corpus. |
| Copilot (MIT, `microsoft/vscode/extensions/copilot`) | xtab tags (`src/extension/xtab/common/tags.ts`), trigger heuristics (`inlineEdits/vscode-node/inlineEditTriggerer.ts`), diff-history format |
| llama.vscode (MIT) | `/infill` parameters, ring-buffer extra context, warm-up requests |

- **Don't copy** Continue's hole-filler prompt: it comes from VictorTaelin/AI-scripts and its license is unverified. Write our own.
- **Attribution in ported files**: a header naming the upstream file and its license.
- **`THIRD_PARTY_NOTICES.md`**: lists each upstream project with its license text.

### License files

- `LICENSE`: the Apache-2.0 text.
- `NOTICE`:
  - "AI Autocomplete — Copyright 2026 Elias Abacioglu. Originally created by Elias Abacioglu (https://github.com/Raboo/vscode-ai-autocomplete)."
  - Third-party credits.
  - Apache-2.0 §4(d) requires derivative distributions to keep this file.
- `README.md`: a "Credits & forks" section asking forks to keep NOTICE and credit the original project.
- `package.json`: `"license": "Apache-2.0"`, `author: Elias Abacioglu`.
- An "About" command shows NOTICE.

## Phases (each ends with a tagged .vsix on GitHub Releases)

After this plan is approved, the next step is a detailed implementation plan (superpowers:writing-plans) for Phase 0–1, starting from this design. Then implementation. `gh repo create` gets its own confirmation when it runs.

0. **Scaffold** (in `/Users/raboo/ai/autocomplete`):
   - `git init`, `package.json`, tsconfig, esbuild, eslint, vitest;
   - LICENSE, NOTICE, THIRD_PARTY_NOTICES, README;
   - CI: lint, typecheck and tests on every push and PR;
   - commit the approved design to `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md`.
   - Create **public** `Raboo/vscode-ai-autocomplete` with `gh repo create`, confirming with the user just before.
   - **GitHub automation** (added 2026-11-13 at the user's request: "as fully automated on GitHub as possible"):
     - releases through release-please: Conventional Commits on `main` → a release PR that bumps the version and writes `CHANGELOG.md` → merging it tags the release, and a job attaches the .vsix;
     - Dependabot (chosen over Renovate because it needs no app install) for npm devDependencies and GitHub Actions, with patch/minor updates auto-merged once CI passes; `typescript` and `@types/vscode` are held at their pinned ranges;
     - CodeQL code scanning; all actions pinned by commit SHA with least-privilege permissions;
     - the repo settings these need (auto-merge, a `main` ruleset requiring the CI checks with an admin bypass, Actions allowed to open PRs, Dependabot alerts and fixes) kept in a script, applied only after the user confirms.
   - **AI-session handoff** (added 2026-11-13 at the user's request): `AGENTS.md` holds the rules and workflow for any AI agent, `CLAUDE.md` imports it, and `docs/ROADMAP.md` tracks phase status, so a fresh session can continue the work from the repo alone.
1. **FIM core** (v0.1): llama.cpp `/infill`, openaiCompat (completions with template or `suffix`), Mistral/Codestral; coder-family presets; the full FIM pipeline; status bar; backend settings with SecretStorage keys; `localOnly`.
2. **Chat path and thinking control** (v0.2): hole-filler; `thinking.ts` and capability learning; OpenRouter backend; presets for Qwen3/3.5/3.8, DeepSeek, GLM, Kimi, MiniMax, Gemma, Granite, Nemotron, gpt-oss, Mistral; Strata host flavor.
3. **Next Edit** (v0.3):
   - history, region, trigger;
   - the **chatXtab** format (tested with Qwen3.8-Flash-Next on Strata, measuring latency);
   - the native renderer with the proposed-API probe and an "Enable native Next Edit UI" command that edits argv.json;
   - then the **sweep** format (Sweep 1.5B is the fast local default), then **zeta21**, then the decoration fallback.
4. **Local model helper** (v0.4): recipes, the llama-server/lms manager, download progress, automatic backend registration.
5. **Publishing and Copilot** (later):
   - `docs/PUBLISHING.md` account guide: Azure DevOps PAT with Marketplace (Manage) scope → publisher `raboo` → `vsce login`; Eclipse account → Open VSX publisher agreement → token → `npx ovsx create-namespace raboo`;
   - Marketplace and Open VSX release jobs (display-name uniqueness to be checked then);
   - a Copilot spike using the official `@github/copilot-language-server` sidecar. This is not committed.

## Verification

- **Unit (vitest)**:
  - template rendering and stop tokens per family;
  - stream filters and postprocess cases;
  - cache matching;
  - thinking request bodies for each (family × host), checked against golden files;
  - reasoning stripping: tags, orphan `</think>`, unclosed with `length`, Gemma channel;
  - NES prompt builders (golden files) and response parsing;
  - region diff and classification;
  - the `localOnly` host check;
  - settings-scope enforcement.
- **Integration (`@vscode/test-electron`, xvfb in CI)**:
  - a mock HTTP server emulating `/infill`, `/v1/completions`, `/v1/chat/completions` (SSE) and `/v1/fim/completions`;
  - open a document, trigger `editor.action.inlineSuggest.trigger`, and assert the item text;
  - the proposed-API probe, run as **two launches**: one with `--enable-proposed-api raboo.ai-autocomplete`, where the native path is used, and one without, which must fall back cleanly.
- **Manual E2E (each phase)**:
  - `llama-server -hf` with a small Qwen2.5-Coder and `--fim-qwen-1.5b-default` → ghost text in TS and Python files; check latency in the log.
  - Codestral with the free key: the endpoint fallback works.
  - An OpenRouter thinking-capable model: no `<think>` leaks and the latency is sane.
  - `llama-server -hf sweepai/sweep-next-edit-1.5B:Q8_0` → Next Edit after a rename edit suggests the next occurrence (Kilo's `docs/nes-examples` scenarios as a checklist).
  - Qwen3.8-Flash-Next on Strata through chatXtab NES (check that no reasoning leaks and the log shows presence_penalty 0):
    - VS Code Insiders, or Stable with the argv.json opt-in: the native UI appears;
    - without the opt-in: decorations and Tab/Esc work.
  - `localOnly` blocks the Codestral backend in a sensitive workspace.
- **Release**: tag `v0.1.0` → the CI-built .vsix installs with `code --install-extension`.

## To verify during implementation (unverified in research)

- Mistral FIM **streaming** delta shape. Only the non-streaming `choices[0].message.content` was confirmed; check `delta.content` before relying on it.
- `codestral.mistral.ai` (the free personal-key endpoint) is live, but its current terms weren't confirmed. The user should check them before depending on the free tier.
- OpenRouter `/api/v1/completions` and `suffix` support.
- LM Studio's per-request thinking toggle.
- Whether Sweep 1.5B's prompt uses a cursor marker. Its layout is otherwise known from `run_model.py`.
- The license of Zed's `zeta_prompt` crate (GPL risk), and whether `zed-zeta-bindings` can be used as a reference.
- Granite 4.1 FIM token order, and llama.cpp support for Mellum2.
- Whether llama.cpp's `--spm-infill` lets Mellum (suffix-first) use `/infill` with `input_extra`, which would be cheaper than a hand-built `/completion` prompt.
- Whether `llama serve` and `llama-server` are aliases in the user's installed llama.cpp build.
- Strata on Apple Silicon (the user's hardware may differ): measure time to first token for the chatXtab prompt at 2K and 4K tokens.
- Licenses in THIRD_PARTY_NOTICES: Kilo's NES code at `cf41438` is under the repo's **MIT** license (Apache-2.0 applied only to the archived `kilocode-legacy`).

## Left to the builder (sensible calls, marked as such)

- Exact debounce constants, and the cache size.
- Character-to-token budget ratio (~3.5 chars per token).
- The wording of the chat prompts.
- Recipe RAM thresholds.
- The minimum VS Code `engines` version: the lowest that supports the pinned proposal file. Track Insiders in CI for proposal drift.
