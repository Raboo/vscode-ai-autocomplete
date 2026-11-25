/** The package.json of the Marketplace build: no proposed API, and the settings text says what that costs. */
export function marketplaceManifest(pkg) {
  const out = JSON.parse(JSON.stringify(pkg));
  delete out.enabledApiProposals;
  const sections = [out.contributes?.configuration ?? []].flat();
  const prop = sections.map((s) => s.properties?.['aiAutocomplete.nextEdit.display']).find(Boolean);
  const i = prop?.enum?.indexOf('native') ?? -1;
  if (i >= 0 && Array.isArray(prop.markdownEnumDescriptions)) {
    prop.markdownEnumDescriptions[i] =
      "VS Code's own inline-edit view. Not available in the Marketplace build; it needs the GitHub or Open VSX build. Treated as auto here.";
  }
  return out;
}
