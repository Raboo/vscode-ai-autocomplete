/** Other extensions that offer inline suggestions and may compete with ours. Pure: no `vscode` import. */

export interface Conflict {
  /** Lowercase extension id. */
  id: string;
  name: string;
  /** The extension's own inline-suggestion setting, when it has one. */
  setting?: { key: string; isOff(value: unknown): boolean };
}

const offWhenFalse = (v: unknown): boolean => v === false;
/** Language-keyed objects: `{ "*": false }` turns it off everywhere. */
const offWhenStarFalse = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && (v as Record<string, unknown>)['*'] === false;

/**
 * Ids and setting keys were read from each extension's published manifest (read only), 2026-11-20:
 * https://github.gallery.vsassets.io/_apis/public/gallery/publisher/github/extension/copilot/latest/assetbyname/Microsoft.VisualStudio.Code.Manifest
 * (same URL shape for continue/continue, kilocode/kilo-code, Codeium/codeium, supermaven/supermaven, TabNine/tabnine-vscode).
 * Tabnine has no setting that turns inline suggestions off, so it counts as active when installed.
 */
export const CONFLICTS: readonly Conflict[] = [
  { id: 'github.copilot', name: 'GitHub Copilot', setting: { key: 'github.copilot.enable', isOff: offWhenStarFalse } },
  { id: 'continue.continue', name: 'Continue', setting: { key: 'continue.enableTabAutocomplete', isOff: offWhenFalse } },
  { id: 'kilocode.kilo-code', name: 'Kilo Code', setting: { key: 'kilo-code.new.autocomplete.enableAutoTrigger', isOff: offWhenFalse } },
  { id: 'codeium.codeium', name: 'Codeium (Windsurf)', setting: { key: 'codeium.enableConfig', isOff: offWhenStarFalse } },
  { id: 'supermaven.supermaven', name: 'Supermaven', setting: { key: 'supermaven.enable', isOff: offWhenStarFalse } },
  { id: 'tabnine.tabnine-vscode', name: 'Tabnine' },
];

/**
 * The known extensions that are installed (and enabled: the caller passes only those), have inline
 * suggestions on and are not dismissed. `isActive` is ignored: extensions activate lazily.
 */
export function activeConflicts(
  installed: { id: string; isActive?: boolean }[],
  getSetting: (key: string) => unknown,
  dismissed: Set<string>,
): { id: string; name: string }[] {
  const ids = new Set(installed.map((e) => e.id.toLowerCase()));
  const out: { id: string; name: string }[] = [];
  for (const c of CONFLICTS) {
    if (!ids.has(c.id) || dismissed.has(c.id)) continue;
    if (c.setting?.isOff(getSetting(c.setting.key))) continue;
    out.push({ id: c.id, name: c.name });
  }
  return out;
}
