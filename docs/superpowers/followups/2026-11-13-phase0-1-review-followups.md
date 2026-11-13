# Phase 0–1 review follow-ups

Known issues found by the per-task reviews and the final whole-branch review of the Phase 0–1 plan, and left open on purpose. None blocks v0.1.0. Pick them up when you next touch the area, or fold them into a later phase's plan. Remove an entry when it is fixed.

## Recommended next (small, behaviour-visible)

- **Requests waiting in the debouncer during a settings change use the old settings.** A request not yet in `InFlight` still goes out up to ~600 ms after the change, with the old backend and the old `localOnly` value. Fix: in `FimProvider.provide()`, return `[]` when `this.d.getSettings()` is no longer the object read at the start, checked after the awaits and before `inflight.add`. (`src/completion/provider.ts`)
- **A settings change leaves a stale error on the status bar**, with a "retrying in N s" that matches no backoff. Fix: call `provider.clearError()` in the settings rebuild. (`src/extension.ts`)
- **A string `"true"` for `privacy.localOnly` fails open**, because the check is `=== true`. Fix: type-check boolean settings in `parseSettings` (report a problem; treat `"true"` as true for restrict-only keys).

## Settings

- `fim.disableInLanguages` and `fim.extraContext` keep normal resource precedence. A workspace can therefore widen what the extra-context ring captures, or turn extra context back on. The data still goes only to the user's own backend.
- Numeric settings accept 0, negatives and fractions. Add `integer` and `minimum` to the schema and clamp them in `num()`.
- Problems are reported inconsistently for dropped values (bad `hostFlavor`, non-string headers, non-object `modelOverrides`).
- Defaults live in both `package.json` and the `settings.ts` fallbacks, and no test checks they agree.
- `toggle` writes Global, so a workspace `fim.enabled` value silently overrides it.

## Backends and transport

- The 5 s timeout covers the whole stream, so output from a slow stream is thrown away. The spec's "show what we have at X ms" time cap is not implemented (Phase 2).
- An abort with a custom reason is classified as a network failure. Callers must use a plain `abort()`.
- Late in-flight failures count as consecutive. After the circuit expires, a single failure re-opens it.
- Failed model detection (`GET /models`) is not backed off. It probes again on every debounced keystroke while the server is down.
- `0.0.0.0` and `::` count as not local. This fails safe.
- `stop: []` is always sent by the OpenAI-compatible backend.
- A `/props` response that is not ok is not cancelled. A missing `res.body` silently ends as an empty completion.
- A user `Authorization` header in a different case is sent alongside the stored key.
- `Content-Type` can be duplicated the same way.
- `extraBody` can override `stream`, `model` and `prompt`. This is a user opt-in.

## Context, filters, provider

- Ring chunk text has no cap. A chunk from a minified file never fits the budget, but it still takes one of the 16 slots until it is evicted.
- `ContextTracker` splits the whole document on every capture.
- In multi-root workspaces, relative paths can collide in the ring.
- One debounce timer is shared across editors.
- The trailing ``` fence is stripped even when there is no leading fence.
- `#` inline comments are not detected.
- `levenshteinRatio` has no length short-circuit, and the whole accumulation is re-split on every push.
- Exceptions in our own code inside `run()` are counted as backend failures.
- A missing API key makes the status flicker.
- `provider.ts` has some 160–190-character lines.
- The "retrying in N s" countdown only refreshes on a keystroke.
- Retry and key changes also clear unrelated errors until the next keystroke.
- Adding or removing a workspace folder triggers a full rebuild.

## Tests

- Integration test 1 waits a fixed 300 ms before committing; poll instead.
- Integration test 2's `requests.length === 0` is trivially true.
- The cache "newest wins" test does not tell the two orders apart.
- `Debouncer` boundary cases are untested: `elapsed == delay`, and the call time recorded after an abort.
- SSE tests miss three cases: a `\r`|`\n` split across chunks, a UTF-8 character split across chunks, and cancellation on `[DONE]`.
- The action-pin test accepts a pin without the `# vX.Y.Z` comment.

## CI and automation (check at the first push)

- actionlint has never been run, because the Docker daemon was down: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest`.
- The `integration` job has never run on GitHub. If it fails on Ubuntu 24.04 with sandbox errors, see AGENTS.md section 7.
- CodeQL **default setup** must stay off. While it is on, uploads from the advanced `codeql.yml` workflow are rejected.
- Watch whether Dependabot auto-merges, which use `GITHUB_TOKEN`, trigger the `push` workflows on `main`.
- `setup-github-repo.sh` treats an unknown `-*` argument as the repo. The first `gh` call fails before any write, but the script should reject the argument up front.
- The ruleset lookup can return more than one id. Use `first(...)` and `includes_parents=false`.
- The Dependabot `actions` group has no `update-types: [minor, patch]`, so one major bump holds back the whole group.
- The dry-run output escapes the commas in the topic list (cosmetic).
- There is no `.vscode-test` cache, and the integration tests run against an unpinned `stable` VS Code.
