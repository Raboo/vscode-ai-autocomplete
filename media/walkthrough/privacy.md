# Keep code private

- **No telemetry.** Nothing leaves your machine except requests to the backends you configure.
- **Local only.** Turn on `aiAutocomplete.privacy.localOnly` and requests go only to servers on this machine or your own network.
- **Excluded files.** `aiAutocomplete.completions.disableInFiles` lists glob patterns (such as `**/.env`) whose files are never sent anywhere.
- **Why No Suggestion?** When nothing shows up, run **AI Autocomplete: Why No Suggestion?** to see the reason.
