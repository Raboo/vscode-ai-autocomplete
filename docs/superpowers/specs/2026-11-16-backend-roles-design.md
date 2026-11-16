# Backend roles ("Use for") — design

Date: 2026-11-16. Phase 3c of AI Autocomplete. Short design; the main spec (`2026-11-13-ai-autocomplete-design.md`) and the backend manager design (`2026-11-14-backend-manager-design.md`) still apply.

## Why

During the Phase 3b smoke test the user loaded Zeta 2.1 in LM Studio and pressed Test on the backend. The test asked Zeta for a fill-in-the-middle completion and showed `"<|marker_1|><|marker_1|>"`: Zeta's "no edit" answer to a prompt it was never trained on. Two gaps:

- A backend has one **Model** field for completions and a **Next Edit model** field that falls back to it, so a backend set up only for Zeta or Sweep silently becomes a completion backend too, and ghost text shows marker tokens.
- **Test** only tests completions; nothing checks that a Next Edit model answers in its format.

## Goals

- Each backend says what it is used for: **Completions**, **Next Edit**, or both.
- The Backends page shows a model field per ticked use; the backend pickers list only backends with that use.
- **Test** runs a completion test and a Next Edit test, one per ticked use, the Next Edit test through the same format and request code the editor uses.
- A Next Edit-only model (Zeta, Sweep) chosen for completions gets a warning, and ghost text never shows their special tokens.

## Non-goals

- Hiding the per-backend completion settings (template, sampling, context) when Completions is unticked: some of them (timeout, thinking, extra context, extra body) also apply to Next Edit.
- Per-use API keys, URLs or headers: one backend is still one server.
- Changing the names in settings keys (`fim.*` stays).

## Approaches

- **A. "Use for" checkboxes on each backend (chosen by the user).** Two checkboxes, Completions and Next Edit. Each ticked use shows its model field; pickers filter by use; Test runs one test per use. A server that hosts a coder model and Zeta stays one backend with both ticked.
- B. A backend type dropdown (Completions / Next Edit / Both): the same result as A with a clumsier control.
- C. No roles, only warnings for Next Edit-only models in the completion role: least work, but the form still invites the mistake.

## Decisions

- **Setting:** `aiAutocomplete.backends[].use`, an array of `"completions"` and `"nextEdit"`. Missing means both, so existing settings behave exactly as today and nobody has to migrate. An empty array or unknown values are a problem (the usual `aiAutocomplete.backends[i] ("id"): …` text) and count as both.
- **Selection:** `fim.backend` unset falls back to the first backend **with the Completions use** (today: the first backend). A selected backend without the use gives that feature no backend, with a problem entry; there is no fallback to another backend. `nextEdit.backend` keeps its "no fallback" rule and also needs the Next Edit use.
- **Models:** with both uses, an empty Next Edit model still means "same as the completion model" (a chat model such as Qwen3.8 on Strata does both). On a Next Edit-only backend the completion model never feeds Next Edit: the Next Edit model, else the detected one. Saving the form removes the model of an unticked use.
- **Page:**
  - The **Use for** checkboxes sit in the Connection section; at least one must be ticked (a form error otherwise).
  - **Model** shows only with Completions, **Next Edit model** only with Next Edit. With Next Edit alone, its placeholder is "auto-detect" instead of "same as the completion model".
  - The Next Edit model field's hint names the format it will use, from `nextEdit.format` and the model id: "Zeta 2.1 format", "Sweep v1 format", "Sweep v2 format" or "chat prompt (chatXtab)".
  - Cards list their uses, and show "Use for completions" / "Use for Next Edit" buttons and "in use" badges per use.
- **Pickers:** **Select backend** lists Completions backends; **Select Next Edit Backend** lists Next Edit backends (plus Off). **Set API key** still lists all.
- **Test:**
  - The Completions steps run as today when Completions is ticked.
  - With Next Edit ticked, a Next Edit step follows. It uses a built-in sample (a rename with a second use of the old name, no format special strings), `pickFormat`, the same route check as the editor, and `runNextEdit`.
  - Results: an edit is ok; "answered, no edit suggested" is a warning; an unreadable answer is a failure naming the parse reason; an answer cut at max tokens is a warning; a thinking model fails as on the completion path.
  - The answer text is logged only with `debug.logPrompts`.
- **Next Edit-only models:** a model id matching `/zeta/i` or `/sweep/i` (the same rules `pickFormat` uses) chosen for Completions gives a form warning and a card warning. Ghost text cuts an answer at the first Next Edit special token (`<|marker_N|>`, `<|user_cursor|>`, `<|file_sep|>`, `<|endoftext|>`, `<|cursor|>`), whatever the model, so an answer that starts with one shows nothing.
- **Names:** the page says "Completions" and "Next Edit" (not FIM, NES or NEP).

## Left to the builder

- Exact wording of hints and warnings, within the rules above.
- Where the Next Edit sample fixture lives, as long as it is our own text.

## Addendum: status bar menu (2026-11-16, asked by the user after the build)

The user asked for the completion entry to match "Next Edit: <backend>", for completions to be turned off from it, and for one switch that stops both.

- **Completions: <backend>** replaces "Select backend..." and "Toggle completions on/off" in the menu. It lists the Completions backends plus **Off**, the current one marked. Off sets `fim.enabled` false and keeps `fim.backend`; picking a backend sets it and turns completions back on. The command keeps its id (`aiAutocomplete.selectBackend`, now titled "Select Completion Backend"); "Toggle Completions" stays in the Command Palette for existing key bindings.
- **Next Edit: <backend>** shows off when `nextEdit.enabled` is false, and picking a backend turns `nextEdit.enabled` back on (the same rule as completions, also for the page's "Use for" buttons).
- **Turn off / Turn on AI Autocomplete** (first entry; command `aiAutocomplete.toggleEnabled`, "Turn On/Off") flips a new setting, `aiAutocomplete.enabled` (default true, resource scope). Off stops completions and Next Edit and keeps both backend choices. Snooze stays for a timed pause.
- While the switch is off, the Completions and Next Edit entries still name their backends: what **Turn on** brings back. With completions on but no backend serving them, the entry reads **Completions: none**. The palette's "Snooze Completions" is now "Snooze", since it pauses both.
- A switch is written where its value comes from: the workspace when it sets one, otherwise user settings.
- **Status bar:** off only when nothing runs (the switch off, or completions off and no Next Edit). Completions off with Next Edit on stays normal, with "Completions off" in the tooltip. The Backends page's header says completions are off when either switch is off.
