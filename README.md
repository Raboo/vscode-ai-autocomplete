# AI Autocomplete

[![CI](https://github.com/Raboo/vscode-ai-autocomplete/actions/workflows/ci.yml/badge.svg)](https://github.com/Raboo/vscode-ai-autocomplete/actions/workflows/ci.yml)

Autocomplete only: fast ghost-text code completion for VS Code, with no chat, no agents and no telemetry. It is self-hosted first, working with llama.cpp, LM Studio and vLLM, and it also supports Mistral Codestral. OpenRouter support follows later.

**Status: pre-release.**

## Getting started

### 1. Run a model with llama.cpp

```sh
brew install llama.cpp
llama-server --fim-qwen-3b-default --port 8012
```

On Linux and Windows, download a build from the [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) instead. The `--fim-qwen-3b-default` preset downloads Qwen2.5-Coder 3B the first time it runs.

### 2. Point the extension at it

Open your user settings (**Preferences: Open User Settings (JSON)**) and add:

```jsonc
"aiAutocomplete.backends": [
  { "id": "local", "kind": "llamacpp", "baseUrl": "http://127.0.0.1:8012" }
],
"aiAutocomplete.fim.backend": "local"
```

Start typing and suggestions appear as ghost text; press `Tab` to accept one. To ask for a suggestion yourself, press `Alt+\` (`Option+\` on macOS), VS Code's shortcut for **Trigger Inline Suggestion**.

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

You can list several backends and switch between them with **AI Autocomplete: Select Backend**.

### Keep requests on your machine

```jsonc
"aiAutocomplete.privacy.localOnly": true
```

With this on, requests go only to backends on loopback or private-network addresses. Anything else is blocked and the status bar shows an error.

### Chat-only models

Strata and the Qwen3.8 models it serves are chat-only, so this release cannot complete with them: it needs a coder model with fill-in-the-middle support, like those listed above. Fill-in-the-middle through a chat prompt arrives in v0.2.

## Privacy

- No telemetry. The extension sends nothing except completion requests to the backend you configure.
- Your code (the text around the cursor, plus snippets of other open or recently edited files while `aiAutocomplete.fim.extraContext` is on) goes only to that backend.
- API keys live in VS Code's secret storage, never in settings files.
- Endpoint settings (`aiAutocomplete.backends`, `aiAutocomplete.modelOverrides`, `aiAutocomplete.debug.logPrompts`) are read from your user settings only. A workspace's `.vscode/settings.json` cannot redirect your code to another host. It can pick which of your backends to use (`aiAutocomplete.fim.backend`), but only from the ones you defined.
- A workspace can turn `aiAutocomplete.privacy.localOnly` on, but not off.
- Files matching `aiAutocomplete.fim.disableInFiles` (by default `.env`, `.env.*`, `*.pem` and `*.key`) get no completions and are never sent.
- Prompt and completion text is written to the log only when `aiAutocomplete.debug.logPrompts` is on.
- Known limitation: the local-only check resolves the backend's hostname before the request, and the request then does its own lookup. It guards against a misconfigured `baseUrl`, not against a hostile DNS server that answers differently the second time. Use an IP address in `baseUrl` if that matters to you.

## License

Apache-2.0. See `LICENSE`.

## Credits & forks

Forks and redistributions must keep the `NOTICE` file (Apache-2.0 §4(d)). Please also credit the original project and its author, Elias Abacioglu.
