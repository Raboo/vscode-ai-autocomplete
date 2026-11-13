# AGENTS.md

Rules every AI agent follows in this repo. `CLAUDE.md` only imports this file.

## What this is

- An autocomplete-only VS Code extension: no chat, no agents, no telemetry.
- Fast FIM (fill-in-the-middle) ghost-text completion now, Next Edit later; self-hosted backends first.
- Design spec: `docs/superpowers/specs/2026-11-13-ai-autocomplete-design.md`. Phase status: `docs/ROADMAP.md`.

## Hard rules

- No telemetry, ever. Nothing leaves the machine except requests to the user-configured backend.
- Machine-scoped settings (`aiAutocomplete.backends`, `aiAutocomplete.modelOverrides`, `aiAutocomplete.debug.logPrompts`) are read from `globalValue` only; workspace values are ignored.
- Only these files may `import 'vscode'`: `src/extension.ts`, `src/log.ts`, `src/config/vscodeSettings.ts`, `src/config/secrets.ts`, `src/completion/provider.ts`, `src/completion/contextTracker.ts`, `src/ui/*`. Everything else is pure and unit-testable.
- Prompt and completion text are logged only when `aiAutocomplete.debug.logPrompts` is true; timings, status codes and sizes may always be logged at debug level.
- A file that copies or closely adapts upstream code starts with `// Portions adapted from <project> <path> @ <commit> (<license>). Copyright <holder>.`, and `THIRD_PARTY_NOTICES.md` gets an entry for that project (full MIT text for MIT projects).
- Never touch the GitHub repo `Raboo/ai-autocomplete`.
- Interactive sessions ask the user before creating repos, pushing, changing repo settings or releasing, and wait for a yes.
- Commit subjects follow Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`, `build:`); nobody edits `CHANGELOG.md` or the `version` field by hand.
- AI-authored commits end with a Co-Authored-By trailer naming the model.
- Never run upstream code; read it only (for example with `gh api repos/<o>/<r>/contents/<path>?ref=<sha>`).
- Two versions are pinned on purpose: `typescript ~6.0.x` (typescript-eslint supports TypeScript below 6.1 only) and `@types/vscode ~1.100.0` (tracks `engines.vscode`).
- Zero runtime dependencies in Phase 0-1 (the spec allows `diff` and `jsonc-parser` later).
- GitHub Actions are pinned by full commit SHA with a `# vX.Y.Z` comment, and every workflow declares top-level least-privilege `permissions:`.

## Commands

Node version comes from `.nvmrc` (22); code must also work on newer Node.

- `npm run build`: bundle `src/extension.ts` into `dist/extension.js` with esbuild.
- `npm run watch`: rebuild on change.
- `npm run typecheck`: `tsc --noEmit`.
- `npm run lint`: ESLint over the repo.
- `npm test`: unit tests with vitest.
- `npm run package`: build a `.vsix` with `vsce package --no-dependencies`.
- `npm run vscode:prepublish`: production (minified) build, run by vsce.

## Layout

- Pure modules (config parsing, backends, models, most of `completion/`) never import `vscode` and are unit-tested in `test/unit/`.
- `vscode`-facing modules are limited to the allowlist above: extension entry, logging, settings and secrets access, the inline completion provider, context tracking and `src/ui/*`.
- See the spec's architecture tree for the full folder-by-folder breakdown.

## How work is done here

1. The spec (`docs/superpowers/specs/`) is the authority.
2. Each phase gets a plan (`docs/superpowers/plans/`).
3. Tasks run test-first, one commit per task, using the plan's commit message.
4. The task's checkboxes are ticked in the plan in a `docs(plan): mark Task N complete` commit.

## How to continue the work

- Read `docs/ROADMAP.md` and open the current phase's plan.
- Done tasks have ticked boxes and matching commit subjects in `git log`.
- If the next phase has no plan yet, write one from the spec before writing code (with the Superpowers `writing-plans` skill when available).
- Check the spec's "To verify during implementation" list for open questions.

## GitHub automation

See Task 14 of the Phase 0–1 plan; this section is completed there.
