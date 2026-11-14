# AI Autocomplete

[![CI](https://github.com/Raboo/vscode-ai-autocomplete/actions/workflows/ci.yml/badge.svg)](https://github.com/Raboo/vscode-ai-autocomplete/actions/workflows/ci.yml)

Autocomplete only: fast ghost-text code completion for VS Code, with no chat, no agents and no telemetry. It is self-hosted first, working with llama.cpp, LM Studio and vLLM, and it also supports Mistral Codestral. OpenRouter support follows later.

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

Fields: `template`, `contextTokens` (default 4700), `prefixLines`, `suffixLines`, `extraContext` (can only switch it off), `multiline`, `maxTokens`, `temperature`, `topP`, `topK`, `debounceMs`, `timeoutMs`, `stop`, `extraBody`. A backend can also set `fimMode` and `headers` at the top level.

A value is taken from the first of these that sets it: the backend's `fim` object, a matching `aiAutocomplete.modelOverrides` entry, the general `aiAutocomplete.fim.*` settings, then the built-in preset for the model. Three fields work differently: the backend's `stop` sequences are added to the preset's and the override's, not used instead of them; its `extraBody` is merged over the override's; and its `extraContext` can only switch extra context off: it cannot turn it on while `aiAutocomplete.fim.extraContext` is off.

### Keep requests on your machine

```jsonc
"aiAutocomplete.privacy.localOnly": true
```

With this on, requests go only to backends on loopback or private-network addresses. Anything else is blocked and the status bar shows an error.

### Chat-only models

Strata and the Qwen3.8 models it serves are chat-only, so this release cannot complete with them: it needs a coder model with fill-in-the-middle support, like those listed above. Fill-in-the-middle through a chat prompt arrives in v0.2.

## Privacy

- No telemetry. The extension sends nothing except completion requests to the backend you configure.
- Your code (the text around the cursor, plus snippets of other open or recently edited files while `aiAutocomplete.fim.extraContext` is on) goes only to that backend. Extra context comes only from files in your workspace (or new, unsaved files) that completions are allowed in (not from files matching `aiAutocomplete.fim.disableInFiles` or in a language listed in `aiAutocomplete.fim.disableInLanguages`).
- Requests never follow HTTP redirects, so a server cannot forward your code to another host.
- With a Mistral backend on `codestral.mistral.ai` or `api.mistral.ai`, a 401 or 403 answer is retried once on the other Mistral host, with the same request and key.
- API keys live in VS Code's secret storage, never in settings files.
- Endpoint settings (`aiAutocomplete.backends`, `aiAutocomplete.modelOverrides`, `aiAutocomplete.debug.logPrompts`) are read from your user settings only. A workspace's `.vscode/settings.json` cannot redirect your code to another host. It can pick which of your backends to use (`aiAutocomplete.fim.backend`), but only from the ones you defined.
- A workspace, or any folder of a multi-root workspace, can turn `aiAutocomplete.privacy.localOnly` on, but not off.
- Files matching `aiAutocomplete.fim.disableInFiles` (by default `.env`, `.env.*`, `*.pem` and `*.key`) get no completions and are never sent. A workspace can add patterns to this list but cannot remove the ones from your user settings.
- Prompt and completion text is written to the log only when `aiAutocomplete.debug.logPrompts` is on.
- Known limitation: the local-only check resolves the backend's hostname before the request, and the request then does its own lookup. It guards against a misconfigured `baseUrl`, not against a hostile DNS server that answers differently the second time. Use an IP address in `baseUrl` if that matters to you.

## License

Apache-2.0. See `LICENSE`.

## Credits & forks

Forks and redistributions must keep the `NOTICE` file (Apache-2.0 §4(d)). Please also credit the original project and its author, Elias Abacioglu.
