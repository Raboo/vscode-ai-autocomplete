import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { MARKETPLACE, RELEASES_URL } from '../../src/flavor';
import { marketplaceManifest } from '../../scripts/marketplaceManifest.mjs';

type Manifest = { enabledApiProposals?: unknown; contributes: { commands: unknown; configuration: { properties: Record<string, { enum: string[]; markdownEnumDescriptions: string[] }> }[] } } & Record<string, unknown>;
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Manifest;

test('the releases link', () => {
  expect(RELEASES_URL).toBe('https://github.com/Raboo/vscode-ai-autocomplete/releases/latest');
});

test('MARKETPLACE is false outside the Marketplace build', () => {
  expect(MARKETPLACE).toBe(false);
});

test('marketplaceManifest drops the proposed API and keeps the rest', () => {
  const before = JSON.stringify(pkg);
  const out = marketplaceManifest(pkg) as Manifest;
  expect(JSON.stringify(pkg)).toBe(before);
  expect(pkg.enabledApiProposals).toBeDefined();
  expect('enabledApiProposals' in out).toBe(false);
  for (const k of ['name', 'publisher', 'version']) expect(out[k]).toEqual(pkg[k]);
  expect(out.contributes.commands).toEqual(pkg.contributes.commands);
});

test('marketplaceManifest explains the native display value', () => {
  const out = marketplaceManifest(pkg) as Manifest;
  const prop = out.contributes.configuration.map((c) => c.properties['aiAutocomplete.nextEdit.display']).find(Boolean)!;
  const i = prop.enum.indexOf('native');
  expect(prop.markdownEnumDescriptions[i]).toMatch(/GitHub|Open VSX/);
});
