import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { FULL_ID, MARKETPLACE, MARKETPLACE_ID, RELEASES_URL, SELF_ID } from '../../src/flavor';
import { marketplaceManifest } from '../../scripts/marketplaceManifest.mjs';

type Manifest = { enabledApiProposals?: unknown; contributes: { commands: unknown; configuration: { properties: Record<string, { enum: string[]; markdownEnumDescriptions: string[] }> }[] } } & Record<string, unknown>;
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Manifest;

test('the releases link', () => {
  expect(RELEASES_URL).toBe('https://github.com/Raboo/vscode-ai-autocomplete/releases/latest');
});

test('MARKETPLACE is false outside the Marketplace build', () => {
  expect(MARKETPLACE).toBe(false);
  expect(SELF_ID).toBe(FULL_ID);
  expect(FULL_ID).toBe(`${pkg.publisher as string}.${pkg.name as string}`);
  expect(MARKETPLACE_ID).toBe(`${pkg.publisher as string}.${(marketplaceManifest(pkg) as Manifest).name as string}`);
});

test('marketplaceManifest drops the proposed API and keeps the rest', () => {
  const before = JSON.stringify(pkg);
  const out = marketplaceManifest(pkg) as Manifest;
  expect(JSON.stringify(pkg)).toBe(before);
  expect(pkg.enabledApiProposals).toBeDefined();
  expect('enabledApiProposals' in out).toBe(false);
  for (const k of ['publisher', 'version', 'displayName']) expect(out[k]).toEqual(pkg[k]);
  expect(out.name).toBe('ai-autocomplete-prediction');
  expect(out.contributes.commands).toEqual(pkg.contributes.commands);
});

test('marketplaceManifest explains the native display value', () => {
  const out = marketplaceManifest(pkg) as Manifest;
  const prop = out.contributes.configuration.map((c) => c.properties['aiAutocomplete.nextEdit.display']).find(Boolean)!;
  const i = prop.enum.indexOf('native');
  expect(prop.markdownEnumDescriptions[i]).toMatch(/GitHub|Open VSX/);
});
