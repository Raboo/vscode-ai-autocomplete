# Hardening before publishing — design

Date: 2026-11-20. From the triage of `docs/superpowers/followups/2026-11-13-phase0-1-review-followups.md`; the owner went through each item and approved writing this up ("yes").

## Why

Before Phase 5 puts the extension in front of strangers, fix what they would hit: a damaged `argv.json`, two auth headers, log spam while a server is down, lost chat text, a rejected Next Edit coming back, a competing autocomplete extension with no hint, out-of-range numbers, and the test and CI rough edges that make releases less reliable.

## Non-goals

- Guarding against raw-format answers that delete lines (dropped by the owner: a deletion is always shown before Tab, and undo restores it).
- The other follow-up entries (test gaps, tidying); stale ones are removed from the file.

## Approaches

One plan with one task per item (chosen): the items are independent and small, each gets its own test and review. The alternative, folding them into Phase 5, would mix release plumbing with behaviour changes.

## Decisions

1. **Atomic `argv.json` write** (Enable Native Next Edit UI): resolve symlinks (`realpath`), write a temporary file in the target's folder with the original file's permissions, then rename it over the target. A failed write leaves the original untouched and removes the temporary file.
2. **Authorization header:** when a backend's `headers` contain `authorization` in any case, the stored API key is not added (the user's header wins). The Backends page shows "API key not sent: an Authorization header is set" for such a backend that also has a stored key.
3. **Model detection while a server is down:** a failed `GET /models` (or `/props`) detection waits out the backend's existing backoff before trying again, like completion requests; the status bar's "cannot reach backend; retrying in N s" stays the user-facing signal. No new UI.
4. **`</think>` on the chat route:** a bare closing reasoning tag (no opener seen) ends hidden reasoning only when the model may be thinking: its thinking strategy is `cannotDisable`, or the session learned it "thinks anyway". Otherwise a bare closer is answer text. A closer after an opener works as today.
5. **Rejected Next Edit memory:** after Esc (or any rejection), the rejected edit (document, range, new text) is remembered; the identical edit is not shown again until the document text in or around that range changes. A different edit can show. A cursor move alone does not bring it back. The 5 s cooldown stays.
6. **Competing inline-suggestion extensions:** on startup and when extensions change, check for installed and enabled GitHub Copilot, Continue, Kilo Code, Codeium/Windsurf, Supermaven and Tabnine, using the extension's own inline-suggestion setting where one is known (read from their published manifests, read only) to skip ones that have it turned off. If one is active: one notification, "<Name> also offers inline suggestions, so they may compete with AI Autocomplete." with **How to fix** (opens `docs/conflicts.md` on GitHub) and **Don't show again** (per extension, remembered in global state). New `docs/conflicts.md`: how to turn off each one's inline suggestions; linked from the README troubleshooting part.
7. **Numeric settings:** `completions.maxTokens` integer 1–1024; `completions.prefixLines` integer ≥ 0; `completions.suffixLines` integer ≥ 0; `completions.debounceMs` integer 0–2000 or null. The reader clamps out-of-range values and rounds fractions, with one log line per setting and value (`completions.prefixLines -50 is out of range, using 0`). The deprecated `fim.*` twins get the same schema limits. A manifest test checks that every numeric setting's `package.json` default equals the reader's default and has bounds.
8. **Integration tests isolated from the user's `~/.vscode/argv.json`:** the test VS Code runs with `VSCODE_PORTABLE` pointing at a folder under `.vscode-test/`, so it reads its own `argv.json`. Verified on the owner's Mac: the three main-launch proposed-API tests pass locally.
9. **Flaky history test:** the diff time limit can be passed in (default 50 ms); the "merged diff is too large" test sets it so the result does not depend on machine speed.
10. **actionlint in CI:** a step in the `check` job runs actionlint (pinned by version and checksum, or a SHA-pinned action) over `.github/workflows/`; findings from the first run are fixed.

## Left to the builder

- Exact extension ids and setting keys for item 6 (verify from each extension's published `package.json`).
- How item 4 learns "thinks anyway" (the capability store already records it).
- The wording of `docs/conflicts.md`.
