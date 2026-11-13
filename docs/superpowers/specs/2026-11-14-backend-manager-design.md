# Backend manager page: design

Status: approved layout and fields (2026-11-14). It extends the main design in `2026-11-13-ai-autocomplete-design.md`; where the two differ, this one wins for backend management.

## Intent

Today a backend can only be added by editing `aiAutocomplete.backends` in settings.json, and VS Code's Settings page cannot edit that list (it shows "Edit in settings.json"). The user wants to:

- add, edit, remove and test backends from a page reachable from the status-bar menu and from the extension's Settings page;
- check with one button that a backend is reachable **and** that a completion actually comes back;
- tune each backend's completion behaviour on the same page: context size, lines before and after the cursor (the FIM prefix and suffix lines), temperature and the other sampling and timing values, with today's defaults already filled in.

The first real use exposed the gap: LM Studio serving `randmaru/zeta-2.1-mlx` logged `model randmaru/zeta-2.1-mlx has no FIM route; chat FIM arrives in v0.2`. Zeta 2.1 is a Next Edit model (a fine-tune of ByteDance Seed-Coder-8B-Base, Apache-2.0). No built-in preset matches "zeta", so no FIM template was chosen and nothing was sent. The message pointed at the wrong fix, appeared only in the log, and settings.json was the only place to repair it.

## Goals

1. A **Backends page** (webview editor tab) with one card per backend (layout "B" from the mockups).
2. Add, edit, remove, choose for completions, set or clear the API key, and test, all from the page.
3. **Test connection**: reachability, model and route, a real sample completion, and a context-window check, reported step by step in the card.
4. **Per-backend completion settings**, every field prefilled with the value in use today.
5. Clear feedback when a model has no FIM template: reworded log line, status-bar state, a test-result explanation, and a template dropdown to fix it.

## Non-goals

- Editing the general settings (`fim.enabled`, `privacy.localOnly`, `fim.disableInLanguages`, `fim.disableInFiles`, `fim.skipMidWord`, `debug.logPrompts`) on the page. They stay on VS Code's Settings page, which the page links to.
- Editing `aiAutocomplete.modelOverrides` on the page. Its values still apply and show up as defaults.
- Next Edit fields (Phase 3), the chat route, and the OpenRouter and Strata server types (Phase 2).
- Running or downloading local models (Phase 4).

## Anti-goals (failure even if it works)

- The page weakens the machine-scope rule: it must read backends from `globalValue` only and write them only to user (Global) settings.
- An API key reaches the webview: the page only learns whether a key is stored.
- Server-supplied text (model names, error bodies) is inserted into the page as HTML.
- A test or a model-list request sends the user's code, or ignores `privacy.localOnly`.
- The page makes network requests by merely being opened.
- A runtime dependency or a UI framework is added.

## Approaches considered

- **A. Step-by-step pickers plus command links on the Settings page.** Small, and fits the original spec, but every edit is a sequence of input boxes and there is no place to see and tune all of a backend's values at once.
- **B. A webview page with forms and buttons (chosen by the user).** More code and a second editing surface beside settings.json, but it allows a real form, a Test button with results in place, and per-backend tuning with visible defaults.

Within B the user compared two layouts and chose **cards in one column** over a list-plus-detail split.

This reverses the main design's non-goal "a settings webview". That non-goal now reads: no webview beyond the Backends page.

## The page

**Opening it:**

- Command **AI Autocomplete: Manage Backends** (`aiAutocomplete.manageBackends`).
- Status-bar menu entry "Manage backends...", placed first while no backend is configured.
- The "no backends configured" notification gets an "Add Backend" button. It opens the page with a new card already in edit mode.
- A command link at the top of the `aiAutocomplete.backends` setting description: `[Manage backends](command:aiAutocomplete.manageBackends)`. VS Code's settings editor opens description links with `allowCommands: true` (checked in `settingsTree.ts`).
- When a model has no template, clicking the status bar opens the page with that backend's card expanded.

There is one page at a time. Opening it again reveals the existing tab.

**Header line:**

- "Backends", then the general state for this window: completions on or off, and "Local only: on/off in this workspace".
- A "General settings..." link opens the Settings page filtered to the extension (`@ext:raboo.ai-autocomplete`).
- The "+ Add backend" button.

**Collapsed card:**

- A status dot:
  - grey: not tested this session;
  - green: last test passed;
  - yellow: a warning, such as no template;
  - red: last test failed;
  - lock: blocked here by local-only.
- Id, and an "in use" badge on the backend this window completes with.
- Server type, URL, model, and "API key set" when one is stored.
- One line for an offline warning that needs no network, such as "No completion template for this model" or "not used here (local only)".
- Buttons: Test, Edit, "Use for completions" (hidden on the in-use card), Remove (asks to confirm).

**Edit form** (inside the card; "Add backend" opens the same form on a new card):

- **Connection:**
  - Server type: a dropdown, see the table below.
  - Name, which becomes the backend id: lowercase letters, digits and dashes, unique. It is prefilled from the server type (`lmstudio`, then `lmstudio-2`).
  - URL, prefilled from the server type.
  - Model: a combo box. It lists what the server reports, plus free text, plus "auto-detect" (empty), with a "reload list" link. Each listed model is tagged "ready" when it has a FIM route, or "no completion template" when it doesn't.
  - API key: a password field shown for hosted server types. Its placeholder is "stored" when a key exists. Leaving it empty keeps the stored key, and a "Remove key" link deletes it.
- **Prompt:** template (dropdown of every template id, default from the model's preset), prompt mode (`fimMode`), multi-line.
- **Context:** context size (tokens), lines before cursor, lines after cursor, use other open files.
- **Generation:** temperature, top P, top K, max tokens, wait after typing (ms), timeout (ms).
- **Advanced** (collapsed): stop sequences (one per line), extra HTTP headers (`Name: value` per line), extra request body (JSON).
- **Buttons:** Test connection, Save, Cancel, Remove backend.

**How defaults show:**

- **Wait after typing** defaults to "auto (adaptive)", which is today's `fim.debounceMs: null`. The field shows "auto" with the starting delay as a hint: 75 ms for local backends, 250 ms for hosted ones. A number stores a fixed delay (the Debouncer's `fixedMs`), and clearing the field returns to auto. *(Builder's call.)*
- **The model is unknown** when it is set to auto-detect and has not been detected this session. The form then shows the generic preset's defaults, with the note "model not detected yet: Test or reload the list to detect it". The "no completion template" warning (card line, yellow dot, status bar) appears only for an explicit `fimModel`, or for a model the completion path or a test detected this session. The provider's detected-model cache is exposed read-only for this, so the page never fetches on open. *(Builder's call.)*

- Every field shows the value that would be used if the backend set nothing. A grey "default" marks it, and a hint names where the value comes from: the built-in preset for this model, your model overrides, or your settings.
- A field the user changes gets a blue "changed · reset" marker. Only changed fields are saved.
- Changing the model or server type re-computes the defaults of the untouched fields.
- The extension computes defaults with the same functions the completion path uses, never with a copy.

**Server types** (prefills; the stored config uses the existing `kind` and `hostFlavor`):

| Server type | kind / hostFlavor | Default URL | Key |
|---|---|---|---|
| llama.cpp | llamacpp / – | `http://127.0.0.1:8012` | no |
| LM Studio | openai / lmstudio | `http://127.0.0.1:1234/v1` | no |
| Ollama | openai / ollama | `http://127.0.0.1:11434/v1` | no |
| vLLM | openai / vllm | `http://127.0.0.1:8000/v1` | optional |
| SGLang | openai / sglang | `http://127.0.0.1:30000/v1` | optional |
| Mistral Codestral | mistral / – | `https://codestral.mistral.ai` (model `codestral-latest`) | yes |
| DeepSeek | openai / deepseek | `https://api.deepseek.com/beta` | yes |
| Fireworks | openai / fireworks | `https://api.fireworks.ai/inference/v1` | yes |
| Together | openai / together | `https://api.together.xyz/v1` | yes |
| Other OpenAI-compatible | openai / generic | empty | optional |

When an existing entry has a `kind`/`hostFlavor` pair the table doesn't list, its card shows "Other OpenAI-compatible" and the pair is kept unchanged on save.

## Per-backend settings

**Storage:**

- The values are stored in the backend entry under a new optional `fim` object:
  ```json
  { "id": "lmstudio", "kind": "openai", "hostFlavor": "lmstudio", "baseUrl": "http://127.0.0.1:1234/v1",
    "fimModel": "randmaru/zeta-2.1-mlx",
    "fim": { "template": "seed-coder", "temperature": 0.05 } }
  ```
- Keys of `fim`: `template`, `contextTokens`, `prefixLines`, `suffixLines`, `extraContext`, `multiline`, `maxTokens`, `temperature`, `topP`, `topK`, `debounceMs`, `timeoutMs`, `stop`, `extraBody`.
- `fimMode` and `headers` stay where they are, at the top level of the entry.
- The `package.json` schema documents `fim`, so settings.json gets completion and validation.
- `parseSettings` validates `fim`. It keeps the valid keys and reports each dropped one, the way `modelOverrides` problems are reported.

**Precedence**, highest first:

1. the backend's `fim` value;
2. a matching `modelOverrides` entry (template, stop, sampling, extraBody);
3. the general settings: `fim.prefixLines`, `fim.suffixLines`, `fim.maxTokens`, `fim.multiline`, `fim.debounceMs`, with normal VS Code precedence;
4. the built-in preset or constant.

The existing rule still holds: a `maxTokens` from levels 1 or 2 replaces `fim.maxTokens`, and single-line completions stay capped at 48.

**Exceptions to that precedence:**

- **`extraContext` is restrict-only:** other files are used only if the backend's value is true (the default) **and** `fim.extraContext` resolves to true. When the general setting is off, the checkbox is disabled and says so.
- **`stop`:** the backend's list is added to the preset's stops (the same merge as `modelOverrides`), not used instead of them. Hosted flavors send only the first 4, and the form warns when the merged list is longer.
- **`extraBody`:** merged over the `modelOverrides` value.

**Context size:**

- `contextTokens` is the total prompt budget, converted at 3.5 characters per token.
- The default is 4,700 tokens, split by characters:
  - 50% for the prefix (8,225);
  - 15% for the suffix (2,468);
  - 35% for extra context from other files (5,758).
- This replaces today's fixed caps of 8,000, 2,500 and 6,000 characters.
- Lines before and after stay an extra cap on top of the budget.

**Timeout:** `timeoutMs` replaces the fixed 5,000 ms request timeout for that backend.

**Validation:**

| Field | Valid values |
|---|---|
| temperature | 0–2 |
| topP | greater than 0, up to 1 |
| topK | integer, 0 or more |
| maxTokens | integer, 1–4096 |
| prefixLines, suffixLines | integer, 0–10000 |
| contextTokens | integer, 256–131072 |
| debounceMs | integer, 0–2000 |
| timeoutMs | integer, 500–60000 |

The form shows the error next to the field and blocks Save; parsing the stored settings drops out-of-range values with a reported problem.

**Fields that don't apply** are disabled, with a hint:

- Top K for hosted flavors, where it isn't sent;
- Template when the route is native;
- Top P for Mistral, where it is shown as "not sent while temperature is set".

## Test connection

The test runs in the extension, never in the webview. It uses the form's **unsaved** values and the key typed in the form, or the stored key if none was typed. It builds a throwaway backend from them, so the live backend and its backoff are untouched.

**Steps,** each reported as ✓, ! or ✗ with a duration:

1. **Reach the server.**
   - Request: `GET /props` for llama.cpp, `GET {baseUrl}/models` for OpenAI-compatible servers, and for Mistral a minimal FIM request to the configured endpoint (the codestral → api fallback included).
   - Failures map to a fix hint:

   | Failure | Hint |
   |---|---|
   | connection refused | "is the server running?" |
   | DNS | — |
   | timeout | — |
   | 401/403 | "check the API key" |
   | 404 | "check the URL; OpenAI-compatible servers usually end in /v1" |
   | 3xx | "redirects are not followed" |

2. **Model and route.**
   - The model is the form's model, or the detected one.
   - The step reports the model, the template and the route (native or template).
   - When there is no route, it says what to change ("pick a coder model, or choose a template; seed-coder fits Zeta 2.x") and stops here with a warning.
3. **Sample completion.**
   - It sends a built-in TypeScript snippet (`function add(a: number, b: number): number {` / `  return ` / `}`) through the same request builder and stream filters as real completions, with the form's sampling.
   - It passes when the text is not empty, and reports time to first token, total time and the text (up to 80 characters).
   - The test waits up to 30 s, because a first request can load the model (LM Studio JIT loading). A completion slower than the backend's timeout gets a warning: "slower than the X ms timeout; run the test again if the model was loading".
4. **Context window,** where the server reports one:
   - llama.cpp: `/props` `default_generation_settings.n_ctx`;
   - LM Studio: `/api/v0/models` `loaded_context_length`;
   - vLLM: `/v1/models` `max_model_len`;
   - Ollama: `/api/show`.

   The step warns when context size plus max tokens is larger. When the server reports nothing, the step is skipped silently.

**Rules:**

- Test and "reload list" obey `privacy.localOnly` of the current window: a non-local URL is refused with "local only is on in this workspace", the same rule as completions.
- The model list comes from a new `listModels(signal)` method on each backend. It shares its request code with `detectModel`, which becomes "the only listed model", and keeps `redirect: 'manual'` and the short timeout.
- The sample completion text is shown in the card. The log gets timings and statuses. The text goes to the log only when `debug.logPrompts` is on, as for real completions.
- When a test of the in-use backend passes, its backoff is reset, as **Retry Now** does.
- Results live only in memory for the session. Nothing is persisted.

## Saving

- Save writes the whole `aiAutocomplete.backends` array to user (Global) settings.
  - It starts from a fresh read of `globalValue`, replaces or appends only the edited entry by id, and keeps every other entry and every unknown field verbatim.
  - VS Code rewrites the array, so comments inside it are lost; the README says so.
- Renaming a backend id:
  - moves its stored API key to the new id;
  - updates a user-level `fim.backend` that names the old id;
  - warns if a workspace-level `fim.backend` still does.
- Remove deletes the entry and its stored key after confirmation.
- "Use for completions" writes `fim.backend` with the same target rule as **Select Backend**: the workspace when a folder is open, otherwise user settings.
- A settings change made outside the page re-renders the cards that are not being edited. A card in edit mode keeps its form, and Save merges onto the fresh read.

## Webview implementation

**Host side:**

- `src/ui/backendsPanel.ts` creates the panel with `vscode.window.createWebviewPanel`, owns the message handling, and calls pure modules for everything else.
- Panel options: scripts enabled, `localResourceRoots` limited to `dist/webview`, and no `retainContextWhenHidden`. Page state is re-sent when the panel becomes visible.
- CSP: `default-src 'none'; script-src 'nonce-…'; style-src ${cspSource} 'nonce-…'; img-src ${cspSource}; font-src ${cspSource}`.

**Page side:**

- `src/webview/backends/` is plain TypeScript with no framework.
- esbuild bundles it as a second entry point into `dist/webview/backends.js` (browser platform, IIFE), with one CSS file.
- Styling uses VS Code's theme CSS variables, so the page follows light, dark and high-contrast themes.
- It uses Unicode symbols, not codicons: the codicon font would be a new dependency.

**Protocol:** a typed message protocol in a pure module shared by both sides.

**Rendering:**

- State-to-HTML render functions are pure, escape every string, and are unit-tested in vitest's node environment.
- Event wiring stays thin.

**Pure, unit-tested logic,** with no `vscode` imports:

- form to config and config to form;
- default resolution with sources;
- validation;
- server-type prefills;
- id suggestion;
- the connection-test orchestrator, against a fake backend and fake fetch;
- merging an edited entry into the raw array.

**Rules and packaging:**

- AGENTS.md's import allowlist already covers `src/ui/*`.
- The webview code gets the DOM lib through its own tsconfig, or an override, so `src/` keeps no DOM types.
- `.vscodeignore` and the package test must include `dist/webview/*`.

**Integration test:**

- The command opens one panel, and a second call reveals the same one.
- Feeding the host's message handler a save message writes the expected entry to user settings.
- A test message against the mock server returns three passing steps.

## Model with no template

- **Log line** (once per backend and model): `model "<id>" has no FIM template (not a known code-completion model): pick a coder model, or choose a template for it in AI Autocomplete: Manage Backends`.
- **`fimMode: "chat"` keeps its own message:** "chat FIM arrives in v0.2".
- **Status bar:** shows `<backend>: no completion template` as an error state. Clicking it opens the page at that card.
- **Elsewhere:** the model list tags such models, and the Template dropdown fixes them.
- **No built-in preset for Zeta.** As a FIM model its quality is unknown, and Phase 3 supports it properly as a Next Edit model. The test step's hint names seed-coder as the template to try.

## Release

This work lands on `main` before the open release PR #1 is merged, so it ships in v0.1.0. The release stays on hold until the user has tried the page.

## Left to the builder

- Wording of hints and messages beyond those quoted above.
- The exact card and form CSS, within the approved mockup `2026-11-14-backend-manager-mockup.html` (beside this file; a static picture with sample values, not code to reuse).
- Whether "reload list" also runs automatically when the URL or server type changes, debounced and still subject to local-only.
- The order of the menu entries other than "Manage backends..." placed first when no backend exists.
- How a Mistral backend lists models (a fixed list with `codestral-latest`, or its `/v1/models` when the key allows it).
- The ROADMAP and main-spec edits that record this work.
