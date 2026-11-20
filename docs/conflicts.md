# Other extensions that offer inline suggestions

When two extensions offer inline suggestions at once, they compete for the same ghost text. AI Autocomplete warns once per extension and session when another one is installed and its inline suggestions are on. Copilot Chat, which current VS Code ships built in, counts only once you have set `github.copilot.enable` yourself to a value that is not off (its default does not count, since it suggests nothing until you sign in), and no Copilot entry counts while `chat.disableAIFeatures` is `true`. Turn the other one's inline suggestions off in one of these ways, then reload the window if it still shows.

Settings keys below come from each extension's published manifest. Use **Preferences: Open User Settings (JSON)**.

## GitHub Copilot

Current VS Code ships GitHub Copilot Chat built in, and it holds the completions too; the older GitHub Copilot extension uses the same setting.

Run **GitHub Copilot: Toggle (Enable/Disable) Inline Suggestions** (`github.copilot.chat.completions.toggle`, built-in Copilot Chat) or, with the older extension, **GitHub Copilot: Toggle (Enable/Disable) Completions**, or set:

```json
"github.copilot.enable": { "*": false }
```

Copilot's next edit suggestions compete with AI Autocomplete's Next Edit too. Turn them off with:

```json
"github.copilot.nextEditSuggestions.enabled": false
```

Setting `"chat.disableAIFeatures": true` turns off all of Copilot's built-in AI features, these included.

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

Or run **Windsurf: Toggle Autocomplete Globally** from the command palette.

## Supermaven

Run **Supermaven: Toggle** from the command palette.

## Tabnine

Tabnine has no setting for inline suggestions. Disable the extension (Extensions view, gear icon, **Disable**) for this workspace or everywhere.

## Any of them

Disabling the extension itself (Extensions view, **Disable (Workspace)**) always works.

The warning's **Don't show again** button hides it for that extension for good.
