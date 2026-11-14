import { expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { FIM_LIMITS } from '../../src/config/settings';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
test('identity', () => {
  expect(pkg.publisher).toBe('raboo'); expect(pkg.name).toBe('ai-autocomplete');
  expect(pkg.license).toBe('Apache-2.0'); expect(pkg.author.name).toBe('Elias Abacioglu');
  expect(pkg.enabledApiProposals).toBeUndefined();
  expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
});
test('NOTICE credits the original author', () => {
  expect(readFileSync('NOTICE', 'utf8')).toContain('Originally created by Elias Abacioglu');
});
test('bundle exists after build', () => { expect(readFileSync('dist/extension.js', 'utf8')).toContain('activate'); });
test('webview bundle is built and packaged', () => {
  expect(existsSync('dist/webview/backends.js')).toBe(true);
  expect(existsSync('dist/webview/backends.css')).toBe(true);
  expect(readFileSync('.vscodeignore', 'utf8').split(/\r?\n/).map((l) => l.trim())).toContain('!dist/webview/**');
});
test('commands are categorised and accepted is hidden from the palette', () => {
  const cmds = pkg.contributes.commands as { command: string; category: string }[];
  expect(cmds.map((c) => c.command).sort()).toEqual(['about', 'accepted', 'manageBackends', 'menu', 'retry', 'selectBackend', 'setApiKey', 'showLog', 'snooze', 'toggle'].map((c) => `aiAutocomplete.${c}`).sort());
  expect(cmds.every((c) => c.category === 'AI Autocomplete')).toBe(true);
  expect(pkg.contributes.menus.commandPalette).toContainEqual({ command: 'aiAutocomplete.accepted', when: 'false' });
});
test('the backends setting links to the Backends page', () => {
  const backends = pkg.contributes.configuration.properties['aiAutocomplete.backends'];
  expect(backends.markdownDescription.startsWith('[Manage backends](command:aiAutocomplete.manageBackends)')).toBe(true);
  const manage = (pkg.contributes.commands as { command: string; title: string }[]).find((c) => c.command === 'aiAutocomplete.manageBackends');
  expect(manage?.title).toBe('Manage Backends');
});
test('backends schema fim limits match FIM_LIMITS', () => {
  const props = pkg.contributes.configuration.properties['aiAutocomplete.backends'].items.properties.fim.properties;
  for (const [key, lim] of Object.entries(FIM_LIMITS)) {
    const p = props[key];
    expect(p, key).toBeDefined();
    if (lim.exclusiveMin) { expect(p.exclusiveMinimum, key).toBe(lim.min); expect(p.minimum, key).toBeUndefined(); } else expect(p.minimum, key).toBe(lim.min);
    expect(p.maximum, key).toBe(lim.max);
    expect(p.type === 'integer', key).toBe(lim.integer);
  }
});
