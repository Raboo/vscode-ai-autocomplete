# Roadmap

Phase status for AI Autocomplete. The spec is `superpowers/specs/2026-11-13-ai-autocomplete-design.md`.

| Phase | Scope | Plan | Status |
| --- | --- | --- | --- |
| 0. Scaffold | Project skeleton, license files, CI, GitHub automation, AI-session handoff | [Phase 0–1 plan](superpowers/plans/2026-11-13-ai-autocomplete-phase0-1.md) | released in [v0.1.0](https://github.com/Raboo/vscode-ai-autocomplete/releases/tag/v0.1.0) |
| 1. FIM core (v0.1) | llama.cpp `/infill`, openaiCompat, Mistral/Codestral; coder-family presets; full FIM pipeline; status bar; SecretStorage keys; `localOnly`; backends page ([design](superpowers/specs/2026-11-14-backend-manager-design.md)) | [Phase 0–1 plan](superpowers/plans/2026-11-13-ai-autocomplete-phase0-1.md) | released in [v0.1.0](https://github.com/Raboo/vscode-ai-autocomplete/releases/tag/v0.1.0) |
| 2. Chat path and thinking control (v0.2) | Hole-filler, `thinking.ts` and capability learning, OpenRouter backend, model-family presets, Strata host flavor | [Phase 2 plan](superpowers/plans/2026-11-15-phase2-chat-thinking.md), [revisions](superpowers/plans/2026-11-15-phase2-revisions.md) | released in [v0.2.0](https://github.com/Raboo/vscode-ai-autocomplete/releases/tag/v0.2.0) |
| 3a. Next Edit core, chatXtab, native display (v0.3) | Edit history, region, trigger; chatXtab format; ghost text for insertions; native inline edits with the argv.json opt-in | [Phase 3a plan](superpowers/plans/2026-11-15-phase3a-next-edit.md) | released in [v0.3.0](https://github.com/Raboo/vscode-ai-autocomplete/releases/tag/v0.3.0) |
| 3b. Sweep and Zeta formats, decoration fallback | `sweep` and `zeta21` formats, decoration fallback, the deferred `nextEdit.*` settings | [Phase 3b plan](superpowers/plans/2026-11-16-phase3b-formats-decorations.md) | released in [v0.4.0](https://github.com/Raboo/vscode-ai-autocomplete/releases/tag/v0.4.0) |
| 3c. Backend roles | Use for checkboxes per backend (Completions / Next Edit), per-use model fields and pickers, a Next Edit check in Test, Next Edit-only models kept out of ghost text | [Phase 3c plan](superpowers/plans/2026-11-16-backend-roles.md), [design](superpowers/specs/2026-11-16-backend-roles-design.md) | released in [v0.5.0](https://github.com/Raboo/vscode-ai-autocomplete/releases/tag/v0.5.0) |
| 3d. LM Studio MLX fixes | The leading space MLX drops from completions, the StopIteration error at the token limit | [plan](superpowers/plans/2026-11-16-lmstudio-mlx-fixes.md), [design](superpowers/specs/2026-11-16-lmstudio-mlx-fixes-design.md) | released in [v0.5.1](https://github.com/Raboo/vscode-ai-autocomplete/releases/tag/v0.5.1) |
| 4. Local model helper | Curated recipes, llama-server/lms manager, download progress, automatic backend registration | [plan](superpowers/plans/2026-11-16-local-model-helper.md), [design](superpowers/specs/2026-11-16-local-model-helper-design.md) | released in [v0.6.0](https://github.com/Raboo/vscode-ai-autocomplete/releases/tag/v0.6.0) |
| 4b. Polish before publish | Settings renamed to `completions.*`, status tooltip stats and Why No Suggestion?, Next Edit kept while typing, Get Started walkthrough, local llama.cpp warm-up | [plan](superpowers/plans/2026-11-18-polish-before-publish.md) | released in [v0.6.0](https://github.com/Raboo/vscode-ai-autocomplete/releases/tag/v0.6.0) |
| 4c. Local Models page | One llama-server router with Models in memory, the Manage Local Models page, Add model from Hugging Face, per-model settings, models folder, token, update checks | [plan](superpowers/plans/2026-11-18-local-models-page.md), [design](superpowers/specs/2026-11-18-local-models-page-design.md) | released in [v1.0.0](https://github.com/Raboo/vscode-ai-autocomplete/releases/tag/v1.0.0) |
| 4d. Next Edit without completions | Shorter Next Edit pause and llama.cpp warm-up with completions off, Next Edit in Why No Suggestion and the stats, Zeta 2.1 recipe, latency benchmark | [plan](superpowers/plans/2026-11-19-next-edit-only.md), [design](superpowers/specs/2026-11-19-next-edit-only-design.md) | released in [v1.1.0](https://github.com/Raboo/vscode-ai-autocomplete/releases/tag/v1.1.0) |
| 4e. Full Zeta 2.1 coverage | Zeta region by length (1225 chars, up to 40 lines), 16-line marker blocks, Zeta budgets, three-line history context, definitions of nearby symbols as Next Edit context (`nextEdit.definitions`), cursor moves where Zeta predicted after Tab | [design](superpowers/specs/2026-11-19-zeta-full-design.md) | released in [v1.2.0](https://github.com/Raboo/vscode-ai-autocomplete/releases/tag/v1.2.0) |
| 4f. Speculative decoding for local models | n-gram speculative decoding (`--spec-type ngram-cache,ngram-simple`) in the router presets when llama-server supports it; `--spec-type none` in a model's extra arguments turns it off | [design](superpowers/specs/2026-11-20-speculative-decoding-design.md) | released in [v1.3.0](https://github.com/Raboo/vscode-ai-autocomplete/releases/tag/v1.3.0) |
| 4g. Hardening before publishing | Limits on numeric settings, one Authorization header, detection backoff, rejected Next Edit memory, a notice for competing inline-suggestion extensions, atomic argv.json writes, isolated integration runs, actionlint in CI | [plan](superpowers/plans/2026-11-20-hardening.md), [design](superpowers/specs/2026-11-20-hardening-design.md) | released in [v1.4.0](https://github.com/Raboo/vscode-ai-autocomplete/releases/tag/v1.4.0) |
| 4h. Instinct next edit | `instinct` Next Edit format (Continue's Instinct on chat completions), preset row, Instinct 7B recipe that serves completions and Next Edit | [plan](superpowers/plans/2026-11-22-instinct.md), [design](superpowers/specs/2026-11-22-instinct-design.md) | released in [v1.5.0](https://github.com/Raboo/vscode-ai-autocomplete/releases/tag/v1.5.0) |
| 5a. Open VSX publishing | The release job publishes the `.vsix` to Open VSX with `OPEN_VSX_TOKEN`; manual republish of a tag; `docs/PUBLISHING.md` | [plan](superpowers/plans/2026-11-20-open-vsx.md), [design](superpowers/specs/2026-11-20-open-vsx-design.md) | released: v1.4.0 published by hand, v1.5.0 by the release job |
| 5b. VS Code Marketplace build without the proposed API (Option A) | A second package variant without `enabledApiProposals` and with the native-UI opt-in command hidden, so Next Edit always uses decorations there; Open VSX and GitHub keep the full build | not written yet | not started |
| 5c. Copilot sidecar spike (later) | Spike of running next to Copilot | not written yet | not started |

## Known follow-ups

Open review findings for Phase 0–1 are listed in [superpowers/followups/2026-11-13-phase0-1-review-followups.md](superpowers/followups/2026-11-13-phase0-1-review-followups.md). Check it before starting the next phase.

## Deferred manual checks

- Install the released `.vsix` with `code --install-extension ai-autocomplete-0.1.0.vsix` and check completions work.
- Start llama-server after VS Code (status shows "cannot reach backend; retrying in N s"), then check **AI Autocomplete: Retry Now** brings completions back at once.
- With a Mistral backend and a wrong API key (status `HTTP 401`), check that **AI Autocomplete: Set API Key** with the right key brings completions back without touching the settings.
- Backends page: add an LM Studio backend from **AI Autocomplete: Manage Backends** and reload its model list.
- Backends page: Test with Zeta shows a warning, then passes after choosing seed-coder.
- Backends page: change a temperature and see "changed · reset".
- The link at the top of the `aiAutocomplete.backends` setting on the Settings page opens the Backends page.

Phase 2 (Publish step 4 of the [Phase 2 plan](superpowers/plans/2026-11-15-phase2-chat-thinking.md), run on the PR's CI `.vsix`):

- Strata, added from the Backends page as type Strata: Test shows `Model qwen3.8-flash-next-iq3_s (chat prompt)`, a completion and `Thinking is off`. On a large file the first suggestion may miss the 5 s deadline; raising the backend's Timeout fixes that. In a TypeScript file ghost text appears with no reasoning in it. With `debug.logPrompts` on, the log shows the chat request and the completion time, and the request carries `presence_penalty` 0. Press Enter inside a function body and accept a multi-line chat suggestion: its first line is not indented twice, and the later lines line up.
- OpenRouter with your key:
  - a model that can turn thinking off (for example `z-ai/glm-5`) gives ghost text with no `<think>` leak and sane latency;
  - in the model list a mandatory-reasoning model (for example `minimax/minimax-m2.5`) is tagged `chat prompt, cannot turn thinking off`; Test fails with `cannot turn thinking off`, and using it shows `cannot turn thinking off` in the status bar;
  - a model the list tags the same way that falls to the generic preset (for example a `google/gemini-*` or `openai/o*` id): after the first request the log says the model must reason, and the status bar shows `cannot turn thinking off`;
  - a model that keeps thinking although thinking is off: Test fails with `keeps thinking` and suggests a Thinking switch that works, if one does;
  - `privacy.localOnly` blocks OpenRouter.
- LM Studio with a Qwen3.x model in `auto` mode: the chat route is used. Record whether thinking goes off per request in the main spec's "To verify" list.
- llama.cpp, no regression: a coder model (`--fim-qwen-1.5b-default`) still completes through `/infill`.

Results on 2026-11-15:

- Strata: passed, after two fixes found in the test (a fenced chat answer indented twice; at the end of a line the model left out the line break).
- OpenRouter: passed.
- LM Studio 0.4.28 with an MLX Qwen3.5-4B from Hugging Face: thinking cannot be turned off per request, and the extension fails it clearly; turning it off in the model's prompt template works (README, spec "To verify"). With Predicte also installed, `Tab` indented instead of accepting; disabling Predicte fixed it.
- llama.cpp: not run yet; still deferred.

Phase 3a (Publish step 4 of the [Phase 3a plan](superpowers/plans/2026-11-15-phase3a-next-edit.md), run on the PR's CI `.vsix` against Strata; select it with **Select Next Edit Backend**). Run it on default editor settings (`editor.quickSuggestions` as shipped; the integration tests turn it off):

- Without the opt-in:
  - rename a parameter in one function, then move the cursor down: nothing shows except, once, the notice offering the native UI;
  - press Enter at the end of a line inside a function whose next line is obvious: an insertion shows as ghost text and Tab accepts it;
  - FIM still works as before.
- With the opt-in (run **Enable Native Next Edit UI**, quit and reopen VS Code):
  - the rename shows as an inline edit on the next function; Tab jumps, Tab accepts;
  - Esc dismisses it, and nothing re-shows for 5 s;
  - accepting chains the next suggestion;
  - with an inline edit showing, type a character on another line, then press Tab: the edit is either gone or still correct, never applied to shifted text.
- With `debug.logPrompts` on, the log shows the chatXtab prompt with `<|edit_diff_history|>` and the request time. Note the latency on a large file.
- A `.env` file gets no Next Edit request.
- After a Next Edit timeout, FIM pauses too (shared backoff).
- Alt+\ then waiting: no Next Edit at that spot (known gap).
- A Markdown file with a fenced code block: editing next to the block offers no deletion (no Next Edit request near a ```` ``` ```` line).
- A multi-root workspace with the same relative path in two folders (for example `src/index.ts` in both): edits in one never show up as the other's diff, and the prompt names the folder.
- With Next Edit off, format a large file (thousands of lines, all re-indented): no stall; with Next Edit on, the same change records no history entry and nothing stalls.

Phase 3b (Publish step 4 of the [Phase 3b plan](superpowers/plans/2026-11-16-phase3b-formats-decorations.md), run on the PR's CI `.vsix`):

- LM Studio with `randmaru/zeta-2.1-mlx` as the Next Edit model (`nextEditModel`): a rename propagates, and an unrelated edit offers nothing.
- Sweep 1.5B (GGUF in LM Studio or llama.cpp): a rename propagates. Note whether the v1 or the v2 layout answers better (force v2 with a model name containing `v2`; the spec's "To verify" has the open question).
- Decorations without the opt-in: Tab jumps to the edit and then applies it, Esc dismisses it, and Tab still indents, accepts ghost text and moves through snippet placeholders.
- `nextEdit.display: decorations` with the opt-in active shows decorations, not the native view.
- A file in this repo that contains `<|file_sep|>` gets no Next Edit request with a Sweep model (the Debug log says why).
- The status-bar menu shows **Enable native Next Edit UI...** until the opt-in is active, and **Settings...** opens the Settings page filtered to this extension.
- A Zeta and a Sweep edit near the end of a file that ends with a newline keeps the final newline.
- Next Edit still fires with FIM on against the same llama.cpp/LM Studio server.

Phase 3c (check before merging the Phase 3c PR, on its CI `.vsix`; [plan](superpowers/plans/2026-11-16-backend-roles.md)):

- A Zeta-only LM Studio backend (Use for: Next Edit only): Test shows the Next Edit step and no completion step.
- The menu's **Completions** picker (**Select Completion Backend**) does not list that backend.
- A both-uses Strata backend selected with **Select Next Edit Backend**: Test shows both the completion steps and the Next Edit step; unselected and without a Next Edit model, only the completion steps.
- An existing backend without `use` looks and works as before (both boxes ticked).
- Unticking Completions on the selected completion backend turns completions off, with a problem in the log.
- The status bar menu reads **Turn off AI Autocomplete**, **Snooze...**, **Completions: <backend>**, **Next Edit: <backend>**; no **Toggle completions on/off**.
- **Completions → Off** stops ghost text and the entry reads **Completions: off**; with Next Edit on, the status bar stays normal and its tooltip says "Completions: off". Picking the backend again brings ghost text back.
- **Turn off AI Autocomplete** stops ghost text and Next Edit and shows the off icon; **Turn on AI Autocomplete** brings both back with the same backends.
- A Sweep v2 backend on LM Studio with both uses ticked: no warning, Test passes the completion steps and the Next Edit step, and ghost text appears (expect the MLX leading-space loss after a word).

Phase 4 (released in v0.6.0; the server parts are replaced by 4c; [plan](superpowers/plans/2026-11-16-local-model-helper.md)):

- Setup with llama-server: Sweep 1.5B, ghost text and Next Edit work.
- Stop Local Models (with two windows open: both lose the server, and neither starts it again).
- Remove Downloaded Models.
- A cancelled download resumes.

0.6.0 polish (check on the released `.vsix`):

- Settings moved from `fim.*` to `completions.*` in user settings; the old keys are gone and completions behave the same.
- The status bar tooltip shows the stats, and **Why No Suggestion?** explains an empty result.
- Next Edit kept while typing: an edit that is still valid stays shown while you type matching text.
- The Get Started walkthrough opens and its steps complete.
- Warm-up on local llama.cpp: switching files and accepting a suggestion makes the next one fast.

Phase 4c (released in v1.0.0; check on the release `.vsix`; [plan](superpowers/plans/2026-11-18-local-models-page.md)):

- Real llama-server, Sweep 1.5B for both completions and Next Edit.
- Qwen2.5-Coder 3B for completions with Sweep for Next Edit at Models in memory 1 (the swap warning shows, swaps are visible in the log) and 2 (no swaps).
- An added model from a gated repo, with and without a token.
- Moving the models folder (files move, the router keeps working).
- Two windows sharing the router.
- Update of an added model: Check for update, then Update; the old file keeps working until the new one is checked.
- Remove from list and Hide of a model `local` uses: the selection is cleared and the page says so.
- Restart from the page brings the router back with the same models.
- Remove Downloaded Models offers leftover files the model list no longer names.

Phase 4d (check on the release `.vsix`; [plan](superpowers/plans/2026-11-19-next-edit-only.md)):

- Completions → Off, Next Edit on `local` with Sweep 1.5B: typing pauses show ghost text after about 150 ms plus the answer time; Tab accepts; typing the start of a suggestion keeps it.
- With the Debug log on, opening a file sends one Next Edit warm-up (`n_predict` 0) to llama-server, and none again for 30 s.
- **Why No Suggestion?** lists Next Edit entries ("Next Edit: shown", "no change", skipped reasons); the tooltip shows a Next Edit line.
- The Local Models page lists Zeta 2.1 (community quant), already downloaded if the file is in the models folder; **Use for Next Edit** works; with Models in memory 1 and Sweep for completions, the swap warning shows.
- Completions on again: Next Edit behaves as before (400 ms pause, no Next Edit warm-up).

Phase 4e (check on the release `.vsix`; [design](superpowers/specs/2026-11-19-zeta-full-design.md)):

- Zeta 2.1 suggests an edit about 20 lines below the cursor.
- With `debug.logPrompts` on, the definitions of an imported function the edited code uses appear in the Next Edit prompt log.
- After Tab, the cursor lands where Zeta predicted.
- Turning `aiAutocomplete.nextEdit.definitions` off removes the definitions from the prompt.

Phase 4f (check on the release `.vsix`; [design](superpowers/specs/2026-11-20-speculative-decoding-design.md)):

- With a llama-server that lists `--spec-type`, the Local Models server log shows `draft acceptance` lines after a Next Edit or completion request.
- Adding `--spec-type none` to a model's extra arguments removes them after the model reloads.

Phase 4g (check on the release `.vsix`; [design](superpowers/specs/2026-11-20-hardening-design.md)):

- Enable Native Next Edit UI on a symlinked `argv.json` keeps the symlink.
- With GitHub Copilot installed, the competing-extension notice shows once; How to fix opens `docs/conflicts.md`; Don't show again silences it.
- A Next Edit dismissed with Esc does not come back unchanged after a cursor move.
- `completions.prefixLines: -50` logs one line and completions still work.
- A backend with an `Authorization` header and a stored key shows the "API key not sent" note.

Phase 4h (check on the release `.vsix`; [design](superpowers/specs/2026-11-22-instinct-design.md)):

- Local Models page: Instinct 7B shows as already downloaded (same file as before) and Use starts it; the backend gets Completions and Next Edit.
- Backends page Test on the Instinct backend: the Next Edit step says "Instinct format" and suggests an edit or no change, never a cut-off warning on the sample.
- Rename a parameter, move to the next use: Instinct offers the rename (note the time in the log; expect about Zeta's speed).
- With `debug.logPrompts` on, the prompt has `### Context:`, `### User Edits:` (newest first) and `### User Excerpt:` with the region tags around 1 line above and 5 below the cursor.
- Completions with Instinct work but are slower than Qwen2.5-Coder 3B; ghost text never runs past the closing bracket.

Phase 5a (check after the next release; [design](superpowers/specs/2026-11-20-open-vsx-design.md)):

- open-vsx.org/extension/raboo/ai-autocomplete shows the released version.
- Installing it in VSCodium works and completions appear.
- Actions, release-please, Run workflow with tag `v1.4.0` publishes 1.4.0 to Open VSX (only with the owner's yes).
