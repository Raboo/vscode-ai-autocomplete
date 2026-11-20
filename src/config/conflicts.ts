/** Other extensions that offer inline suggestions and may compete with ours. Pure: no `vscode` import. */

export interface Conflict {
  /** Lowercase extension id. */
  id: string;
  name: string;
  /** The extension's own inline-suggestion setting, when it has one. */
  setting?: { key: string; isOff(value: unknown): boolean };
  /** A Copilot entry: `chat.disableAIFeatures` true turns it off. */
  copilot?: true;
}

const offWhenFalse = (v: unknown): boolean => v === false;
/** Language-keyed objects: `{ "*": false }` turns it off everywhere. */
const offWhenStarFalse = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && (v as Record<string, unknown>)['*'] === false;

/**
 * Ids and setting keys were read from each extension's published manifest (read only), 2026-11-20:
 * https://github.gallery.vsassets.io/_apis/public/gallery/publisher/github/extension/copilot/latest/assetbyname/Microsoft.VisualStudio.Code.Manifest
 * (same URL shape for continue/continue, kilocode/kilo-code, Codeium/codeium, supermaven/supermaven, TabNine/tabnine-vscode).
 * Tabnine has no setting that turns inline suggestions off, and `supermaven.enable` has no documented schema, so those two count as active when installed.
 */
export const CONFLICTS: readonly Conflict[] = [
  { id: 'github.copilot', name: 'GitHub Copilot', setting: { key: 'github.copilot.enable', isOff: offWhenStarFalse }, copilot: true },
  // Copilot Chat ships the completions too and contributes the same setting: one notice, shown as "GitHub Copilot".
  // Current VS Code ships Copilot Chat built in, with the setting on by default; it suggests nothing until the user signs in.
  { id: 'github.copilot-chat', name: 'GitHub Copilot', setting: { key: 'github.copilot.enable', isOff: offWhenStarFalse }, copilot: true },
  { id: 'continue.continue', name: 'Continue', setting: { key: 'continue.enableTabAutocomplete', isOff: offWhenFalse } },
  { id: 'kilocode.kilo-code', name: 'Kilo Code', setting: { key: 'kilo-code.new.autocomplete.enableAutoTrigger', isOff: offWhenFalse } },
  { id: 'codeium.codeium', name: 'Codeium (Windsurf)', setting: { key: 'codeium.enableConfig', isOff: offWhenStarFalse } },
  { id: 'supermaven.supermaven', name: 'Supermaven' },
  { id: 'tabnine.tabnine-vscode', name: 'Tabnine' },
];

/**
 * The known extensions that are installed (and enabled: the caller passes only those), have inline
 * suggestions on and are not dismissed. `isActive` is ignored: extensions activate lazily.
 * A built-in extension (shipped with VS Code) counts only when the user set its setting to a value that is not off
 * (`getUserSetting`: the value set in user, workspace or folder settings, not the default). With
 * `chat.disableAIFeatures` true, Copilot entries never count.
 */
export function activeConflicts(
  installed: { id: string; isActive?: boolean; builtIn?: boolean }[],
  getSetting: (key: string) => unknown,
  dismissed: Set<string>,
  getUserSetting: (key: string) => unknown = () => undefined,
): { id: string; name: string }[] {
  const byId = new Map(installed.map((e) => [e.id.toLowerCase(), e]));
  const out: { id: string; name: string }[] = [];
  // Entries with one name (Copilot and Copilot Chat) are one notice and one dismissal.
  const dismissedNames = new Set(CONFLICTS.filter((c) => dismissed.has(c.id)).map((c) => c.name));
  const aiOff = getSetting('chat.disableAIFeatures') === true;
  for (const c of CONFLICTS) {
    const ext = byId.get(c.id);
    if (!ext || dismissedNames.has(c.name) || out.some((o) => o.name === c.name)) continue;
    if (c.copilot && aiOff) continue;
    if (ext.builtIn) {
      const user = c.setting ? getUserSetting(c.setting.key) : undefined;
      if (user === undefined || c.setting?.isOff(user)) continue;
    } else if (c.setting?.isOff(getSetting(c.setting.key))) continue;
    out.push({ id: c.id, name: c.name });
  }
  return out;
}
