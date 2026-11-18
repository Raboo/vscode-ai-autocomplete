# Local Models page and one llama.cpp router — design

Date: 2026-11-18. Replaces the runtime and server parts of `2026-11-16-local-model-helper-design.md` (Phase 4); its recipes, downloader, checksum rules and testing approach still apply except where this design changes them.

## Why

The owner tried the Phase 4 helper (v0.6.0): llama.cpp works well; LM Studio did not (the imported model was not found in LM Studio's library). Two runtimes double the code paths for little gain, so the helper keeps llama.cpp only. oMLX (MLX on macOS) was considered for speed and dropped: for 1.5B–7B models the generation gain is modest, and llama.cpp's prompt reuse, warm-up and slots matter more for completions.

The helper is also a one-shot command today. The owner wants a place to see and control it, like Manage Backends: server status and logs, the downloaded models, an editable model list from Hugging Face, the models folder, start and stop, per-model context, extra arguments and default sampling, and a Hugging Face token. And one server in total, one model in memory by default, with an option to keep several.

## Goals

- **AI Autocomplete: Manage Local Models** opens a page (a webview editor tab, built like the Backends page) with:
  - **Server**: llama-server path and version, status (stopped, starting, running on port N, failed with the last lines), Start / Stop / Restart, "Models in memory" (1 by default), and the server log (last lines on the page, the full log in the output channel).
  - **Models**: one row per model in the list: name, size, uses (Completions, Next Edit), download state (not downloaded, downloading with progress and Cancel, downloaded, checksum failed), load state (unloaded, loading, loaded), and the actions Download, Remove file, Load, Unload, **Use for…** (completions, Next Edit or both), Edit and, for added models, Remove from list. Built-in models can be hidden, not removed.
  - **Per-model settings** (Edit): context size, extra llama-server arguments, and default sampling (temperature, top_p, top_k, max tokens) for completions and for Next Edit.
  - **Add model**: a Hugging Face repo id, then a pick from the repo's `.gguf` files with sizes; then name, uses and context size.
  - **Settings**: models folder (Change…, with an offer to move the existing files), Hugging Face token (Set, Change, Remove; shown only as "set").
- **One llama-server process** in router mode serves every model, loading them on demand, with at most "Models in memory" loaded (least recently used is unloaded first).
- **One backend `local`** points at the router; its `model` is the completions model and its `nextEditModel` the Next Edit model.

## Non-goals

- LM Studio and oMLX in the helper. LM Studio stays a normal backend type on the Backends page.
- Installing or updating llama.cpp (the page shows how: `brew install llama.cpp`, or the releases page).
- Non-GGUF models, multi-file (sharded or multimodal) GGUFs: one `.gguf` file per model.
- Remote windows (as Phase 4: the page says it runs where VS Code's UI runs).
- Browsing or searching Hugging Face from the page; the user types the repo id.

## Anti-goals

- The server listening on anything but 127.0.0.1, or extra arguments that change that.
- The Hugging Face token reaching the page, the log, settings, or any host other than Hugging Face's.
- Model swapping that silently makes completions slow: when completions and Next Edit use different models with one model in memory, the page warns.

## Approaches

- **Page:** A. a separate Local Models page built like the Backends page (chosen by the owner); B. a Local section on the Backends page (that page is already dense); C. VS Code tree view plus settings JSON (editing arguments and the model list by hand is what the owner wants to leave).
- **Server:** A. one llama-server in router mode, which llama.cpp already provides (chosen; the owner's build 12359 has it); B. one process per model as today, with the extension stopping the others to keep one in memory (rebuilds what the router does, and slower swaps); C. one process restarted with `-m` on every model change (no way to keep several loaded).

## Decisions

### Router

- Started as `llama-server --models-preset <presets.ini> --models-max <models in memory> --host 127.0.0.1 --port <port> --no-webui` plus nothing else; per-model settings live in the presets file. Argument array, never a shell (as Phase 4).
- The extension writes `presets.ini` in global storage (not the models folder) from the model list:
  - `version = 1`; a `[*]` section with `ngl = 99`, `fa = on`, `cache-reuse = 256`;
  - one section per downloaded, not hidden model, named by its model name, with `model = <absolute file path>`, `c = <context × slots>`, `np = <slots>` (2 when the model's uses include Next Edit, else 1, as Phase 4), then its extra arguments.
  - Rewritten when the list, a model's settings, a download or the models folder changes; then `GET /models?reload=1` makes the router pick it up (the router unloads a running model whose preset changed). Changing "Models in memory" restarts the router.
- No `--models-dir`: only the listed models are served.
- **Checked live on 2026-11-18** against the owner's llama-server build 12359 with the presets above (Sweep 1.5B and Mellum 4B, `--models-max 1`):
  - each model instance starts with the preset's `--ctx-size` and `--parallel` (and `[*]`'s flags); with `c` pinned, `--fit` does not change the context. `/props?model=sweep-next-edit-1.5b` then reports `total_slots` 2 and `n_ctx` 8192 per slot;
  - section names are the model ids: names with `.` and `-` work, and matching is case-sensitive (`Mellum-4b-base` is "not found");
  - `/infill` routes by the body's `model` and loads an unloaded model automatically (about 5 s for the first request on Sweep 1.5B, including the load); `id_slot` works per instance;
  - a request for the other model unloads the first (about 5 s);
  - `GET /props` without `model` answers the router itself (`"role": "router"`, `model_path` `none`, `n_ctx` 0): that is how the backend and adoption recognise a router;
  - `GET /props?model=<name>&autoload=false` for an unloaded model answers 400 "model is not loaded";
  - after editing a section, `GET /models?reload=1` unloads that model and its next load uses the new values.
- Requires router mode: `llama-server --help` must list `--models-preset` (checked once per path and version). Otherwise the page and the Set Up flow say "this llama-server is too old for the local model helper; update llama.cpp" with the install hint.
- Load and unload buttons call `POST /models/load` and `POST /models/unload` with `{ "model": <name> }`; the page reads states from `GET /models` (`status.value`). Requests load models automatically (router default), so Load is only a warm-up.
- **Several windows** (builder's call, settled in the design): any window may rewrite `presets.ini` and call `?reload=1` after a change it made (the settings are shared, so the file is the same from any window). A change of "Models in memory" restarts the router from the window that made it: it stops the recorded process (as Stop Local Models does) and starts its own, becoming the owner.
- **Warm-up**: when the router starts and when **Use for…** changes a model, the extension sends `POST /models/load` for the selected models (up to "Models in memory"), so the first completion does not pay the load time. A request that still hits a load can miss the backend's deadline; that shows as a normal timeout and the next request succeeds.
- Lifecycle as Phase 4, with one server instead of one per backend: it starts when the `local` backend is selected for completions or Next Edit (at activation or on a settings change) and when the page's Start is pressed; it stops on Stop, on Stop Local Models, or when `local` is deselected (only the window that started it stops it, when that window closes). The cross-window adopt / watch / take-over rules of `serverPool.ts` stay, with one record (`local`) instead of one per recipe; adopting checks `/health` and that `GET /models` lists the expected model names. The port is kept in global state (a free port is chosen the first time, as today).
- The router's output is the server log: kept in memory (the last 200 lines for the page) and written to the output channel at debug, as today.

### Backend

- One backend entry `local`: kind `llamacpp`, `baseUrl` `http://127.0.0.1:<port>`, `use` from the selected models, `model` = the completions model name, `nextEditModel` = the Next Edit model name. Written to user settings (machine scope) like the Backends page does; never shown with a key.
- **Use for…** sets `model` and/or `nextEditModel` on `local` and selects `local` for that use (completions and/or Next Edit backend settings), starting the router if needed.
- The llama.cpp backend already sends `model` in `/infill`, `/completion` and chat bodies. In router mode `GET /props` needs `?model=<name>`: the backend sends `?model=<name>&autoload=false` whenever it has a model name (a plain server ignores both), and keeps its slot count (`total_slots`, used for `id_slot`) per model name. A 400 (model not loaded) leaves the count unknown, so no `id_slot` is sent and it is read again on a later request, as after a failure today.
- **Migration** (on activation, once): old helper entries `local-<recipe>` (llama-server) are removed, their records cleared and their processes stopped (by recorded pid, as Stop Local Models does); if one was selected for a use, `local` is created with that recipe's model and selected instead. When the completions and Next Edit selections were two different `local-*` recipes, `local` gets both (and the swap warning shows). The files are already in the models folder at the same paths; a row counts a file as downloaded when its size matches (the sha256 was checked when it was downloaded). Entries ending in `-lmstudio` are left as they are: they are ordinary LM Studio backends and keep working while LM Studio runs. One log line names what moved.

### Model list

- Settings (machine scope, read from `globalValue` only, added to the manifest test's machine-scoped list):
  - `aiAutocomplete.local.models`: the user's additions and changes, an array of `{ name, repo?, revision?, file?, bytes?, sha256?, uses?, contextTokens?, extraArgs?, hidden? }`. An entry whose `name` matches a built-in recipe's model name changes that recipe (only `uses`, `contextTokens`, `extraArgs`, `hidden`); other entries are added models and need `repo`, `revision`, `file`, `bytes`, `sha256`.
  - `aiAutocomplete.local.modelsDir`: empty means `<globalStorage>/models` (today's place).
  - `aiAutocomplete.local.modelsInMemory`: integer ≥ 1, default 1.
  - `aiAutocomplete.local.llamaServerPath` stays; `aiAutocomplete.local.lmsPath` is removed.
- Built-in recipes stay as data in `recipes.ts` (pinned revision, size, sha256).
- **Add model**: `GET https://huggingface.co/api/models/<repo>` gives the current commit (`sha`), `GET https://huggingface.co/api/models/<repo>/tree/<sha>` lists the files with `size` and `lfs.oid` (the sha256). The added model is pinned to that commit and checksum. The tree is read with `?recursive=true`, following the `Link` header's next page; files in subfolders are fine (they download to the same relative path). A file without `lfs.oid` cannot be added, and split files (`-00001-of-0000N.gguf`) and `mmproj*` files are listed but disabled ("multi-file models are not supported"). The model name defaults to the file name without `.gguf`, lowercased, with characters outside `[a-z0-9._-]` turned into `-`; names must be unique, and a name containing `v2` gets a note that it selects the Sweep v2 layout.
- **Check for update** (a button on each added model's row; built-in models are updated with extension releases): reads the repo's current commit; when it differs from the pinned one, reads the same file path at that commit. The row then shows "up to date", "update available (<size>, <date of the commit>)" with an **Update** button, or "this file is no longer in the repo" (the pinned file keeps working). **Update** downloads the new file next to the old one (`.part`), checks it against the new sha256, then replaces the old file and writes the new commit, size and sha256 to the model's entry; a failed or cancelled update leaves the old file and entry as they were. If the model is loaded, the presets reload makes the router load the new file on the next request. Checks run only when the button is pressed (no background requests to Hugging Face).
- **Default sampling** per model is stored in `aiAutocomplete.modelOverrides` under the key `^<escaped name>$` (`sampling` for completions; Next Edit uses the same override's sampling, as it does today). The page shows the values from that exact key only, and writing an empty form removes the key. When another `modelOverrides` key also matches the name, the form notes "other overrides also match this model" (builder's call).
- **Extra arguments**: a single line split like a shell command line without expansion (quotes group words); each `--flag value` / `--flag` becomes a preset key. Refused (the form names the flag): `host`, `port`, `m`/`model`, `alias`/`a`, `c`/`ctx-size`, `np`/`parallel`, `api-key`, `api-key-file`, `hf-*`, `models-*`, `webui`/`no-webui`, `ssl-*`, `path`, `mmproj*`. The context field owns `-c`; slots are derived from the uses.
- The memory hint stays (file > 40% of RAM: "may not fit"); with "Models in memory" above 1, the page adds the sizes of the largest models that could be loaded together and warns when they pass 75% of RAM.

### Downloads and the token

- Files go to `<models folder>/<repo>/<file>` as today, with resume, the sha256 check and https-only redirects. Several downloads may run; each row shows its own progress and Cancel.
- **Changing the models folder** asks whether to move the existing model files (same volume: rename; else copy, verify size, delete). Without the move, the old files stay and the rows show "not downloaded".
- **Hugging Face token**: stored in SecretStorage under its own key, never in settings, never sent to the page (the page gets only "set" or "not set"), never logged. It is sent as `Authorization: Bearer` only on requests whose host is `huggingface.co` (the API calls and the first download request); redirects to any other host (Hugging Face's CDN) are followed without it. A 401 or 403 from Hugging Face shows "this model needs a Hugging Face token, or access to the repo" with a link to the repo page.

### Page and commands

- `src/ui/localModelsPanel.ts` hosts the page; `src/webview/localModels/` holds `main.ts` (DOM), pure `render.ts` and `style.css`, bundled by esbuild like the Backends page. Pure state and form logic lives in `src/local/` (no `vscode` import) and is unit-tested. Server-supplied text (model ids, log lines, error bodies) is HTML-escaped; errors shown on the page are fixed text plus escaped details.
- The page updates live: server state and model states are polled from `GET /models` every 2 s while the page is visible and the server runs; download progress is pushed.
- **Set Up Local Model...** (command, status bar menu, Backends page, walkthrough) opens this page. The first time, when no model is downloaded, the page highlights the default (Sweep 1.5B) with one button: download, start, use for both, then run the Backends page's Test for `local` and show its result.
- **Stop Local Models** stops the router (this window's process, or the recorded pid when another window runs it) and clears the record so no window restarts it until a selection change or Start. **Remove Downloaded Models...** stays as a command (a pick of files) besides the page's per-row Remove file.
- The swap warning: when the `local` backend's completions model and Next Edit model differ and "Models in memory" is 1, the Server section shows "Completions and Next Edit use different models; with 1 model in memory the server swaps between them (seconds each). Use one model for both, or set Models in memory to 2."

## Testing

- Unit: presets.ini rendering (sections, slots, context, escaping of values), extra-argument parsing and refusals, model-list merging (built-ins, changes, hidden, added), Hugging Face API parsing (commit, files, sha256, missing `lfs.oid`), name derivation, the token header only on `huggingface.co`, `/props?model=` and per-model slot counts, the migration plan from `local-*` entries, page state and render.
- The webview's DOM code is covered by opening the page in the integration test; its logic is in the pure, unit-tested `render.ts` and state modules (as the Backends page).
- Integration: a fake router (Node script set through `local.llamaServerPath`) answering `--help` with `--models-preset`, `/health`, `/models`, `/models/load`, `/models/unload`, `/infill` and `/props?model=`; the page opens, a test model downloads from the mock server, Start runs the fake router with the expected arguments and presets file, Use for completions selects `local`, and a completion arrives through it.
- Manual (ROADMAP): real llama-server: Sweep 1.5B for both; then Qwen2.5-Coder 3B for completions with Sweep for Next Edit at Models in memory 1 (warning shown, swaps visible in the log) and 2 (no swaps); an added model from a gated repo with and without a token; moving the models folder; two windows sharing the router.

## Left to the builder

- Page layout and wording beyond the sections above (the Backends page's look is the reference).
- How the log is shown on the page (collapsed by default is fine) and its line limit within the 200 kept.
- Poll interval details while the page is hidden (none needed).
- Whether "Use for…" is one button with a pick or separate buttons.
