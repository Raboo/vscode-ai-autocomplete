# Other extensions that offer inline suggestions

When two extensions offer inline suggestions at once, they compete for the same ghost text. AI Autocomplete warns once per extension and session. Turn the other one's inline suggestions off in one of these ways, then reload the window if it still shows.

Settings keys below come from each extension's published manifest. Use **Preferences: Open User Settings (JSON)**.

## GitHub Copilot

Run **GitHub Copilot: Toggle Completions** (or the Copilot status bar menu, then "Disable Completions"), or set:

```json
"github.copilot.enable": { "*": false }
```

## Continue

```json
"continue.enableTabAutocomplete": false
```

## Kilo Code

```json
"kilo-code.new.autocomplete.enableAutoTrigger": false
```

## Codeium / Windsurf Plugin

```json
"codeium.enableConfig": { "*": false }
```

Or run **Codeium: Disable** from the command palette.

## Supermaven

Run **Supermaven: Toggle**, or set `"supermaven.enable": { "*": false }`.

## Tabnine

Tabnine has no setting for inline suggestions. Disable the extension (Extensions view, gear icon, **Disable**) for this workspace or everywhere.

## Any of them

Disabling the extension itself (Extensions view, **Disable (Workspace)**) always works.

The warning's **Don't show again** button hides it for that extension for good.
