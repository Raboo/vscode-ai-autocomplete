# Roadmap

Phase status for AI Autocomplete. The spec is `superpowers/specs/2026-11-13-ai-autocomplete-design.md`.

| Phase | Scope | Plan | Status |
| --- | --- | --- | --- |
| 0. Scaffold | Project skeleton, license files, CI, GitHub automation, AI-session handoff | [Phase 0–1 plan](superpowers/plans/2026-11-13-ai-autocomplete-phase0-1.md) | implemented; v0.1.0 ships after Publish |
| 1. FIM core (v0.1) | llama.cpp `/infill`, openaiCompat, Mistral/Codestral; coder-family presets; full FIM pipeline; status bar; SecretStorage keys; `localOnly` | [Phase 0–1 plan](superpowers/plans/2026-11-13-ai-autocomplete-phase0-1.md) | implemented; v0.1.0 ships after Publish |
| 2. Chat path and thinking control (v0.2) | Hole-filler, `thinking.ts` and capability learning, OpenRouter backend, model-family presets, Strata host flavor | not written yet | not started |
| 3. Next Edit (v0.3) | Edit history, region, trigger; chatXtab, sweep and zeta21 formats; native renderer with decoration fallback | not written yet | not started |
| 4. Local model helper (v0.4) | Curated recipes, llama-server/lms manager, download progress, automatic backend registration | not written yet | not started |
| 5. Publishing and Copilot (later) | Marketplace and Open VSX release jobs, `docs/PUBLISHING.md`, Copilot sidecar spike | not written yet | not started |

## Known follow-ups

Open review findings for Phase 0–1 are listed in [superpowers/followups/2026-11-13-phase0-1-review-followups.md](superpowers/followups/2026-11-13-phase0-1-review-followups.md). Check it before starting the next phase.

## Deferred manual checks

- Task 12 Step 4 smoke test (real editor, real backend).
- Install the released `.vsix` with `code --install-extension ai-autocomplete-0.1.0.vsix` and check completions work.
- Start llama-server after VS Code (status shows "cannot reach backend; retrying in N s"), then check **AI Autocomplete: Retry Now** brings completions back at once.
- With a Mistral backend and a wrong API key (status `HTTP 401`), check that **AI Autocomplete: Set API Key** with the right key brings completions back without touching the settings.
