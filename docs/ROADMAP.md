# Roadmap

Phase status for AI Autocomplete. The spec is `superpowers/specs/2026-11-13-ai-autocomplete-design.md`.

| Phase | Scope | Plan | Status |
| --- | --- | --- | --- |
| 0. Scaffold | Project skeleton, license files, CI, GitHub automation, AI-session handoff | [Phase 0–1 plan](superpowers/plans/2026-11-13-ai-autocomplete-phase0-1.md) | released in [v0.1.0](https://github.com/Raboo/vscode-ai-autocomplete/releases/tag/v0.1.0) |
| 1. FIM core (v0.1) | llama.cpp `/infill`, openaiCompat, Mistral/Codestral; coder-family presets; full FIM pipeline; status bar; SecretStorage keys; `localOnly`; backends page ([design](superpowers/specs/2026-11-14-backend-manager-design.md)) | [Phase 0–1 plan](superpowers/plans/2026-11-13-ai-autocomplete-phase0-1.md) | released in [v0.1.0](https://github.com/Raboo/vscode-ai-autocomplete/releases/tag/v0.1.0) |
| 2. Chat path and thinking control (v0.2) | Hole-filler, `thinking.ts` and capability learning, OpenRouter backend, model-family presets, Strata host flavor | [Phase 2 plan](superpowers/plans/2026-11-15-phase2-chat-thinking.md) | implemented; v0.2.0 ships after Publish |
| 3. Next Edit (v0.3) | Edit history, region, trigger; chatXtab, sweep and zeta21 formats; native renderer with decoration fallback | not written yet | not started |
| 4. Local model helper (v0.4) | Curated recipes, llama-server/lms manager, download progress, automatic backend registration | not written yet | not started |
| 5. Publishing and Copilot (later) | Marketplace and Open VSX release jobs, `docs/PUBLISHING.md`, Copilot sidecar spike | not written yet | not started |

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
