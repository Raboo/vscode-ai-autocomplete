# Local model helper (Phase 4) — design

> Note: the runtime and server parts (one llama-server per model, per-model backends) are superseded by the router and the Local Models page: see [2026-11-18-local-models-page-design.md](2026-11-18-local-models-page-design.md).

Date: 2026-11-16. Phase 4 of AI Autocomplete; the main spec's "Local model helper" section still applies except where this design narrows it. The user asked for both runtimes in this phase (llama-server and LM Studio) and to proceed without waiting for confirmation.

## Why

Setting up a local model today means picking a model that fits the machine, downloading it, starting a server with the right flags and adding a backend with the right model name. Each step has traps found during Phases 1–3: llama-server's default port is 9931, LM Studio's MLX engine drops spaces, Sweep's 1.5B file is named `…v2.gguf` (which the extension would read as Sweep v2), and Zeta does Next Edit only. The helper turns that into one command.

## Goals

- **AI Autocomplete: Set Up Local Model...** (also in the status bar menu and on the Backends page) picks a runtime, a recipe and a use, downloads the model with progress, starts it, adds the backend, selects it and runs the Backends page's Test.
- Recipes are data: model, file, size, checksum, licence, memory hint, context size, uses, model name.
- Both runtimes: **llama-server** (a process the extension starts and stops) and **LM Studio** (through its `lms` CLI; LM Studio keeps running on its own).
- A llama-server backend the helper created starts again with VS Code when it is selected.

## Non-goals

- Installing llama.cpp or LM Studio (the helper shows how).
- MLX models: the recipes are GGUF files, which both runtimes run (LM Studio on its llama.cpp engine). LM Studio users can still add MLX models by hand.
- Remote windows: the helper runs only where VS Code's UI runs (it says so in a remote window).
- Zeta 2.1 and Sweep v2 7B: no official GGUF (only community quantisations); they stay a manual setup for now.

## Approaches

- **A. The extension downloads the GGUF file itself, then hands it to the runtime (chosen).** One downloader (HTTPS from Hugging Face at a pinned revision, with progress, resume and a sha256 check) stores files in the extension's global storage. llama-server runs it with `-m <file>`; LM Studio gets it with `lms import --hard-link`, so one copy on disk serves both.
- B. Let each runtime download (`llama-server -hf`, `lms get`): llama-server prints progress only to a terminal (read in `common/download.cpp`), so a spawned server downloads silently for minutes; `lms get` picks a variant itself. Two code paths, no checksum.
- C. llama-server only, LM Studio later: the user asked for both.

## Decisions

- **Recipes** (`src/local/recipes.ts`, data; each pinned to a Hugging Face revision, file name, size and sha256, all read from the Hugging Face API on 2026-11-16):
  | Recipe | Repo @ revision | File | Bytes | sha256 | Uses | Model name |
  | --- | --- | --- | --- | --- | --- | --- |
  | Sweep Next Edit 1.5B (default) | `sweepai/sweep-next-edit-1.5B` @ `409016591c6c1a94f545f22328a85a3516118f34` | `sweep-next-edit-1.5b.q8_0.v2.gguf` | 1537269856 | `1321ea5e5d7529e60f9770c6a0b3a965f89542d16cf4ae51bab267f6a88150da` | completions, Next Edit | `sweep-next-edit-1.5b` |
  | Qwen2.5-Coder 1.5B | `ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF` @ `8be1b8a895a84beea772817caaa71eba6b6e0d07` | `qwen2.5-coder-1.5b-q8_0.gguf` | 1646573056 | `29871c94d15727a6e243f79a37113d4ae625a6215b5e800bf41a23af2da32832` | completions | `qwen2.5-coder-1.5b` |
  | Qwen2.5-Coder 3B | `ggml-org/Qwen2.5-Coder-3B-Q8_0-GGUF` @ `9c1de162ae417c9c3aacde97c729c4128de047d8` | `qwen2.5-coder-3b-q8_0.gguf` | 3285476160 | `a522a906e299ed34db738b9626b2cd0da9e446c14674468a22fc2eae3dbd344d` | completions | `qwen2.5-coder-3b` |
  | Qwen2.5-Coder 7B | `ggml-org/Qwen2.5-Coder-7B-Q8_0-GGUF` @ `bca77e0a8c88fc224882bcc404170c3ef17efacc` | `qwen2.5-coder-7b-q8_0.gguf` | 8098525600 | `0ef48dc94a3c551a6736ac2601de38413dc9aa9318534b16e8baee08290a4aaf` | completions | `qwen2.5-coder-7b` |
  | Mellum 4B | `JetBrains/Mellum-4b-base-gguf` @ `7000183cb129702bb2b66485c11f6141771dd6a8` | `mellum-4b-base.Q8_0.gguf` | 4274519360 | `f8a8ae8f8b02cd992716e8849fe0424184bc7a26c2b829131ed558567307c5b2` | completions | `mellum-4b-base` |

  All Apache-2.0; context 8192 for each. The Sweep model name never contains "v2": the extension would pick the Sweep v2 prompt layout for it. The download URL is `https://huggingface.co/<repo>/resolve/<revision>/<file>`; it redirects to Hugging Face's CDN and answers ranges with 206 (checked).
  - Memory hint: a recipe whose file is more than 40% of the machine's memory is marked "may not fit" (the user's 18 GB machine sees 7B marked).
- **Runtimes:** found on PATH or the usual places (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.lmstudio/bin`, LM Studio's home from `~/.lmstudio-home-pointer` + `/bin`); `aiAutocomplete.local.llamaServerPath` and `aiAutocomplete.local.lmsPath` (machine scope, read from `globalValue`) override. Missing runtimes are listed with how to install them (`brew install llama.cpp`, lmstudio.ai). Processes start with an argument array, never a shell.
- **llama-server:** `-m <file> --alias <model name> --host 127.0.0.1 --port <free port> -c <slots × context> -ngl 99 -fa on -np <slots> --cache-reuse 256 --no-webui`, with 2 slots when the recipe's `uses` includes `nextEdit` and 1 otherwise. Each slot has the recipe's context; with two, the llama.cpp backend sends `id_slot: 0` for completions and `id_slot: 1` for Next Edit (when `/props` reports `total_slots` of exactly 2; a failed request forgets the count until it is read again), so neither evicts the other's prompt cache. Its output goes to the log at debug. Ready when `GET /health` answers 200 (polled, 2 min deadline). The backend is `local-<recipe>` (kind `llamacpp`, `http://127.0.0.1:<port>`). It starts when that backend is selected for completions or Next Edit (at activation, or when a settings change selects it) and stops when a settings change deselects or removes it; a change that keeps the selection starts and stops nothing. The port is kept, or a new free one is written to the backend if something else holds it. Windows share one server: before starting, a window probes the saved port (`/health` 200 and `/v1/models` or `/props` naming the alias; a 503 there is a server still loading, which it waits for) and adopts a server it finds instead of starting one. A window stops only the servers it started, when it closes; a window that adopted a server checks it every 15 s and starts its own when it is gone. Managed servers are recorded in global state (backend id, recipe, file, port, and the pid of the process serving it), not in settings.
- **LM Studio:** `lms import --hard-link -y --user-repo <repo> <file>` (skipped when `lms ls --json` already lists it), `lms server start` when `lms server status` says it is off, `lms load <model key> -c <context> --identifier <model name> -y`. The backend is `local-<recipe>-lmstudio` (kind `openai`, host flavor `lmstudio`, `http://127.0.0.1:<LM Studio port>/v1`). LM Studio keeps the model loaded on its own; the extension never stops LM Studio.
- **Backend:** written to user settings like the Backends page does, with `use` from the recipe, the model name as `model` / `nextEditModel`, and selected for each use; then the Test runs and its result shows in the notification. An existing backend with that id is replaced only after a yes.
- **Download:** to `<globalStorage>/models/<repo>/<file>`, resumed with HTTP Range from a `.part` file, verified by sha256 before use (a mismatch deletes the file and fails), cancellable from the progress notification. Redirects are followed only to `https:` URLs. Disk space is checked first (file size + 10%, `fs.statfs`). The download is the only request the helper sends outside the machine, and the notification names the host (huggingface.co). A file already present with the right size and checksum is not downloaded again.
- **Testing:** the pure modules are unit-tested with injected `spawn`/`exec`, clock, file system and a local HTTP server. The integration test drives the command against a fake `llama-server` (a Node script set through `aiAutocomplete.local.llamaServerPath` that answers `/health` and `/infill`) and a test recipe served from the mock server, injected through the extension's test API (`activate()` already returns test hooks).
- **Commands:** **Set Up Local Model...**, **Stop Local Models** (this window's llama-server processes, and by pid the recorded ones other windows run when they still serve their alias; it clears the recorded pids first, so no window starts them again until a selection change or the next start), **Remove Downloaded Models...** (pick files to delete; LM Studio's hard links keep their data).
- `vscode`-facing code lives in `src/local/vscode/`; recipes, argument building, runtime lookup, port choice, progress and checksum handling are pure and unit-tested.

## Left to the builder

- Wording of the pickers and notifications.
- How the free port is found (bind to port 0 and close, or try from 8012 up).
- The health-poll interval.
