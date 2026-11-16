# AI Autocomplete

[![CI](https://github.com/Raboo/vscode-ai-autocomplete/actions/workflows/ci.yml/badge.svg)](https://github.com/Raboo/vscode-ai-autocomplete/actions/workflows/ci.yml)

Autocomplete only: fast ghost-text code completion for VS Code, with no chat, no agents and no telemetry. It is self-hosted first, working with llama.cpp, LM Studio and vLLM, and it also supports Mistral Codestral, Strata and OpenRouter.

**Status: pre-release.**

## Getting started

### 1. Run a model with llama.cpp

llama.cpp is the example here. The extension also works with LM Studio, Ollama, vLLM, SGLang and other servers with an OpenAI-compatible `/v1/completions` endpoint, and with the hosted Mistral Codestral, DeepSeek, Fireworks and Together APIs.

```sh
brew install llama.cpp
llama-server --fim-qwen-3b-default --port 8012
```

On Linux and Windows, download a build from the [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) instead. The `--fim-qwen-3b-default` preset downloads Qwen2.5-Coder 3B the first time it runs.

### 2. Point the extension at it

Run **AI Autocomplete: Manage Backends** from the Command Palette. The status bar menu, the **Add Backend** button of the "no backends configured" notification and the link in the `aiAutocomplete.backends` setting open the same page. The Backends page lists your backends and lets you add one, pick its model from the server's list, set a key, test the connection and tune its completion settings. Saving a backend from the page rewrites the whole `aiAutocomplete.backends` array in your user settings, so comments inside that array are lost. The test sends a built-in sample, never your code.

Or edit the settings by hand. Open your user settings (**Preferences: Open User Settings (JSON)**) and add:

```jsonc
"aiAutocomplete.backends": [
  { "id": "local", "kind": "llamacpp", "baseUrl": "http://127.0.0.1:8012" }
],
"aiAutocomplete.fim.backend": "local"
```

Start typing and suggestions appear as ghost text; press `Tab` to accept one. To ask for a suggestion yourself, press `Alt+\` (`Option+\` on macOS), VS Code's shortcut for **Trigger Inline Suggestion**.

If the server is not running yet, the status bar shows an error and the extension retries on its own after a while. Run **AI Autocomplete: Retry Now** (also in the status bar menu) to retry at once.

Backends go in your user settings only; see [Privacy](#privacy) for why.

### Other backends

**Mistral Codestral:**

```jsonc
"aiAutocomplete.backends": [
  { "id": "codestral", "kind": "mistral", "baseUrl": "https://codestral.mistral.ai", "fimModel": "codestral-latest" }
],
"aiAutocomplete.fim.backend": "codestral"
```

Then run **AI Autocomplete: Set API Key** from the Command Palette, pick `codestral` and paste your key.

**LM Studio or vLLM** (OpenAI-compatible `/v1/completions`):

```jsonc
"aiAutocomplete.backends": [
  { "id": "lmstudio", "kind": "openai", "baseUrl": "http://127.0.0.1:1234/v1", "fimModel": "qwen2.5-coder-3b" }
],
"aiAutocomplete.fim.backend": "lmstudio"
```

Set `fimModel` to the model name the server lists. It must be a coder model with a fill-in-the-middle template: Qwen2.5-Coder, Codestral, DeepSeek-Coder, StarCoder, Code Llama, CodeGemma, Granite, Seed-Coder or Mellum. vLLM listens on port 8000 by default, so its `baseUrl` is usually `http://127.0.0.1:8000/v1`.

The extension recognises LM Studio and Ollama only by their default ports (1234 and 11434). For any other self-hosted server, such as vLLM on port 8000, add `"hostFlavor": "vllm"` (or `"lmstudio"`, `"ollama"`) to the backend. Without it the server is treated as a hosted API: `top_k` is not sent and only the first 4 stop sequences are sent.

```jsonc
{ "id": "vllm", "kind": "openai", "baseUrl": "http://127.0.0.1:8000/v1", "hostFlavor": "vllm", "fimModel": "Qwen/Qwen2.5-Coder-7B" }
```

You can list several backends and switch between them with **AI Autocomplete: Select Backend**.

### Per-backend settings

Each backend can carry a `fim` object with its own completion settings. The Backends page edits the same fields.

```jsonc
{ "id": "local", "kind": "llamacpp", "baseUrl": "http://127.0.0.1:8012",
  "fim": { "contextTokens": 8000, "temperature": 0.1, "multiline": "auto" } }
```

Fields: `template`, `contextTokens` (default 4700), `prefixLines` (lines before the cursor; the window starts on a multiple of a quarter of this value so the prompt start stays stable (unless the `contextTokens` budget cuts it), so it can hold up to `prefixLines + step − 1` lines, with `step` being `prefixLines / 4` rounded down and at least 1), `suffixLines`, `extraContext` (can only switch it off), `multiline`, `maxTokens`, `temperature`, `topP`, `topK`, `debounceMs`, `timeoutMs`, `stop`, `extraBody`, `thinking`. A backend can also set `fimMode` and `headers` at the top level.

A value is taken from the first of these that sets it: the backend's `fim` object, a matching `aiAutocomplete.modelOverrides` entry, the general `aiAutocomplete.fim.*` settings, then the built-in preset for the model. Three fields work differently: the backend's `stop` sequences are added to the preset's and the override's, not used instead of them; its `extraBody` is merged over the override's; and its `extraContext` can only switch extra context off: it cannot turn it on while `aiAutocomplete.fim.extraContext` is off.

### Keep requests on your machine

```jsonc
"aiAutocomplete.privacy.localOnly": true
```

With this on, requests go only to backends on loopback or private-network addresses. Anything else is blocked and the status bar shows an error.

### Chat models (Strata, OpenRouter, general instruct models)

A model with no fill-in-the-middle support, such as a general instruct or chat-only model, completes through a chat prompt. It is slower than FIM. Chat models must be able to turn thinking off: autocomplete waits 5 s for an answer, and a model that reasons first cannot give one. With `fimMode` on `auto`, a chat model uses the chat prompt automatically, and so does a server that has no raw completions endpoint. Set the prompt mode to `chat` on the Backends page to force it.

Thinking is turned off per model family and server. The Thinking dropdown on the Backends page (the `thinking` field of the backend's `fim` object) overrides what the extension picks. Reasoning text is never shown.

A model that cannot turn thinking off (gpt-oss, DeepSeek R1 and similar, or an OpenRouter model that must reason) is not used: the model list tags it `chat prompt, cannot turn thinking off`, the Test fails, and the status bar shows `cannot turn thinking off`. A model that keeps thinking although thinking was asked off fails the same way, and the status bar shows `keeps thinking`. For a model that keeps thinking, **Retry now**, a passing Test or a changed API key lets the extension try it again; a settings change clears everything it learned.

When a model keeps thinking, **Test connection** tries the other thinking switches on a sample and suggests one that works ("choose ... as the Thinking switch"). On Strata, DeepSeek, Ollama and OpenRouter the server decides how thinking is turned off, so only the `/no_think` switch is tried.

Every request has a 5 s deadline. Set the backend's Timeout (`timeoutMs`) to change it.

With the cursor after only indentation, a chat model often types the indentation again; the extension drops it when the rest of the answer lines up with it.

**Strata** serves chat only. Strata's default address is `http://127.0.0.1:8080/v1`:

```jsonc
{ "id": "strata", "kind": "openai", "hostFlavor": "strata", "baseUrl": "http://127.0.0.1:8080/v1" }
```

On Strata the extension pins the unchanged start of the prompt so Strata can reuse its cache between keystrokes. Measured on a test Strata server (Qwen3.8, 2026-11-15), a 1750-token prompt took 3.6 s without the pin and 0.9 s with it (1691 tokens reused). The first request of a file still reads the whole prompt (about 4 s there), so on a large file the first suggestion can miss the 5 s deadline: raise the backend's Timeout on the Backends page.

**OpenRouter:** run **AI Autocomplete: Set API Key** and paste your key. Without a key no code is sent (the model list still loads; it needs no key). A model that must reason on OpenRouter is noticed on its first request (the server rejects turning reasoning off) and then treated like one that cannot turn thinking off. OpenRouter completes through the chat prompt only, because a raw FIM prompt reaches the model only with some of the providers OpenRouter picks. An "Other OpenAI-compatible" backend pointed at `openrouter.ai` follows the same rules.

```jsonc
{ "id": "openrouter", "kind": "openai", "hostFlavor": "openrouter", "baseUrl": "https://openrouter.ai/api/v1", "fimModel": "z-ai/glm-5" }
```

**LM Studio:** when the status bar says the model keeps thinking, turn thinking off in LM Studio; the extension cannot switch it per request there. For a model from LM Studio's catalog, switch off **Enable Thinking** in its settings. For a model downloaded from Hugging Face, add `{%- set enable_thinking = false %}` as the first line of its prompt template (My Models → the model's settings → Prompt Template).

**Other autocomplete extensions** (for example Predicte, Kilo Code or Continue) can show their own ghost text or take the `Tab` key, so `Tab` may indent or insert their suggestion instead. Turn their autocomplete off while you use this one.

## Next Edit

Next Edit suggests the edit you are likely to make next. After you change code, for example rename a parameter, the extension asks a model to rewrite a small region around the cursor (by default 5 lines above, 10 below) and shows the result. It is off until you choose a backend, so completion-only users send no extra requests.

**Turn it on:** run **AI Autocomplete: Select Next Edit Backend** and pick a backend. To use a different model than the completions, set **Next Edit model** on the Backends page (`nextEditModel`); otherwise the backend's completion model is used. When the server lists several models, set `nextEditModel`, so the extension does not have to guess which one to use. A Next Edit backend, like a completion backend, can be picked per workspace only from the backends in your user settings. `aiAutocomplete.nextEdit.enabled` switches it off again. **AI Autocomplete: Snooze Completions** pauses Next Edit too; **AI Autocomplete: Toggle Completions** turns off completions only.

**Formats:** `aiAutocomplete.nextEdit.format` (default `auto`) picks the prompt and answer format. In `auto` the model's name decides: a name with `zeta` gets Zeta 2.1, a name with `sweep` gets Sweep, any other model gets `chatXtab`.

| Format | Fits | Route |
| --- | --- | --- |
| `sweep` | Sweep next-edit 0.5B, 1.5B and v2-7B | raw completions (llama.cpp `/completion`, or `/v1/completions` on LM Studio and others) |
| `zeta21` | Zeta 2.1 | raw completions |
| `chatXtab` | chat models such as Qwen3.8 on Strata | chat |

Sweep 0.5B and 1.5B use Sweep's first prompt layout; a model name with `v2` or `7b` uses the v2 layout. Which layout the 0.5B and 1.5B GGUF files answer best is not settled yet. To force v2, set the format to `sweep` and use a model name that contains `v2`.

Sweep and Zeta need a server with a raw completions route, so they do not work on Strata. The format setting is global, and `auto` reads the Next Edit model's name: if you run a Zeta model next to a completion model, name the Zeta model in the backend's `nextEditModel`. Sweep always uses its trained window of 10 lines above and below the cursor; the region settings below do not change it.

A file that contains one of a format's special strings (for example `<|file_sep|>` for Sweep, `<|marker_1|>` or `<[fim-suffix]>` for Zeta) gets no Next Edit request in that format, because the model would read the text as control tokens. This repo's own sources are such files. The log says why nothing was asked.

**What shows without the opt-in:** an edit that is a pure insertion at the cursor shows as ghost text. Any other edit (a change on another line, a replacement) shows as decorations: the old text that changes gets a red background, the new text of each line shows after it, extra new lines are counted as "(+N lines)", and a hint on the cursor line says what `Tab` does.

**Display:** `aiAutocomplete.nextEdit.display` (default `auto`) chooses between the two views for edits that are not ghost text. `auto` uses the native view when the opt-in is active and decorations otherwise. `native` shows inline edits only with the opt-in (nothing otherwise, with the one-time notice). `decorations` always uses decorations. The native view is the better one: it draws the diff the way VS Code draws its own suggestions. Decorations work in any VS Code with no setup.

With a decoration showing:

- `Tab` moves the cursor to the edit when it is away from the cursor line; a second `Tab` applies it. When the edit is at the cursor line, one `Tab` applies it.
- `Esc` dismisses it, and nothing shows again for 5 s.
- `Tab` keeps its normal job when something else wants it: accepting ghost text, a native inline edit or a suggest-widget item, moving through snippet placeholders, and indenting a selection or multiple cursors. `Esc` keeps its normal job with multiple cursors, ghost text, the suggest widget or snippet mode.
- Any change to the file, a switch to another editor, snooze or a new result clears the decoration. `Tab` never applies an edit to text that changed.

**Native inline edits:** run **AI Autocomplete: Enable Native Next Edit UI**, then quit and reopen VS Code (not just reload the window). The command adds this extension to `enable-proposed-api` in VS Code's `argv.json`. It keeps the comments in that file; if the file is malformed it is left alone and VS Code's runtime-arguments file opens with instructions to paste. Until you opt in, VS Code logs an error that the extension declares a proposed API it may not use. That is expected.

With the opt-in (and `display` on `auto` or `native`), an edit away from the cursor shows as an inline edit. `Tab` jumps to it and `Tab` again accepts it. `Esc` dismisses it, and nothing shows again for 5 s. After you accept, the next suggestion is requested at once, so repeated `Tab` walks through a refactor.

**When it asks:** 400 ms after you stop typing, when completions had nothing to show for that version of the file; and when you move the cursor within 10 s of an edit (not twice on the same line within 5 s). Completions win while you type. With VS Code's default `editor.quickSuggestions`, the word suggestion list can take the request that follows typing; Next Edit then asks on your next cursor move. It does not ask when the region holds a line starting with ```` ``` ```` (a Markdown code block) or is very long (minified code). Files that completions may not use (`aiAutocomplete.fim.disableInFiles`, `fim.disableInLanguages`, files outside the workspace) never get a Next Edit request.

**What is sent:** the 10-line pages of the current file around the region, the region itself with the cursor marked, and the current file's recent edits as diffs. Those diffs always go to the Next Edit backend. Snippets and diffs of your other files go only while `aiAutocomplete.fim.extraContext` is on.

**Settings:**

| Setting | Default | Limits |
| --- | --- | --- |
| `aiAutocomplete.nextEdit.format` | `auto` | `auto`, `chatXtab`, `sweep`, `zeta21` |
| `aiAutocomplete.nextEdit.display` | `auto` | `auto`, `native`, `decorations` |
| `aiAutocomplete.nextEdit.regionLinesAbove` | 5 | 0 to 20 |
| `aiAutocomplete.nextEdit.regionLinesBelow` | 10 | 0 to 40 |
| `aiAutocomplete.nextEdit.historySize` | 5 | 0 to 10 recent edit diffs |
| `aiAutocomplete.nextEdit.contextBudget` | 3500 | 1000 to 16000 tokens, split between the file (3/7), the edit history (2/7) and recently viewed snippets (2/7) |

A value outside its limits is ignored, and a warning names it. The region settings apply to `chatXtab` and `zeta21`, not to Sweep.

**Status bar menu:** the menu has two Next Edit entries. **Enable native Next Edit UI...** appears until the native view is active (it runs the opt-in command above; after a successful opt-in it stays until VS Code restarts). **Settings...** opens the Settings page filtered to this extension.

**Troubleshooting:** the output channel shows timings, status codes and sizes only at the Debug log level. Run **Developer: Set Log Level...**, pick AI Autocomplete, then Debug. Prompt and answer text appears only with `aiAutocomplete.debug.logPrompts`, which belongs in your User settings (workspace values are ignored). When nothing shows, the Debug log says why a request was not asked (a reserved string, a region that is too long, a fence line) or what the model answered.

**Deadline:** `aiAutocomplete.nextEdit.timeoutMs` (default 10000, 500 to 60000). Next Edit runs in the background, so it waits longer than completions. Failures are logged and shown once per backend and kind as a notification with **Show Log**, not in the status bar. A Next Edit failure also pauses completions on the same backend for the usual retry time. A chat model must be able to turn thinking off, as for chat completions. Sweep and Zeta are not chat models, so this does not apply to them; an answer that is cut at its token limit is dropped.

## Privacy

- No telemetry. The extension sends nothing except completion requests to the backend you configure.
- Next Edit, when you choose a backend for it, sends the region around the cursor, clipped pages of the current file and the current file's recent edits to that backend; see [Next Edit](#next-edit).
- Your code (the text around the cursor, plus snippets of other open or recently edited files while `aiAutocomplete.fim.extraContext` is on) goes only to that backend. Extra context comes only from files in your workspace (or new, unsaved files) that completions are allowed in (not from files matching `aiAutocomplete.fim.disableInFiles` or in a language listed in `aiAutocomplete.fim.disableInLanguages`).
- OpenRouter forwards your code to the model's provider. The extension sends no attribution headers to it.
- Requests never follow HTTP redirects, so a server cannot forward your code to another host.
- With a Mistral backend on `codestral.mistral.ai` or `api.mistral.ai`, a 401 or 403 answer is retried once on the other Mistral host, with the same request and key.
- API keys live in VS Code's secret storage, never in settings files.
- Endpoint settings (`aiAutocomplete.backends`, `aiAutocomplete.modelOverrides`, `aiAutocomplete.debug.logPrompts`) are read from your user settings only. A workspace's `.vscode/settings.json` cannot redirect your code to another host. It can pick which of your backends to use (`aiAutocomplete.fim.backend`), but only from the ones you defined.
- A workspace, or any folder of a multi-root workspace, can turn `aiAutocomplete.privacy.localOnly` on, but not off.
- Files matching `aiAutocomplete.fim.disableInFiles` (by default `.env`, `.env.*`, `*.pem` and `*.key`) get no completions and are never sent. A workspace can add patterns to this list but cannot remove the ones from your user settings.
- Prompt and completion text, reasoning text and server error bodies are written to the log only when `aiAutocomplete.debug.logPrompts` is on.
- Known limitation: the local-only check resolves the backend's hostname before the request, and the request then does its own lookup. It guards against a misconfigured `baseUrl`, not against a hostile DNS server that answers differently the second time. Use an IP address in `baseUrl` if that matters to you.

## License

Apache-2.0. See `LICENSE`.

## Credits & forks

Forks and redistributions must keep the `NOTICE` file (Apache-2.0 §4(d)). Please also credit the original project and its author, Elias Abacioglu.
