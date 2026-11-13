import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
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
test('commands are categorised and accepted is hidden from the palette', () => {
  const cmds = pkg.contributes.commands as { command: string; category: string }[];
  expect(cmds.map((c) => c.command).sort()).toEqual(['about', 'accepted', 'menu', 'retry', 'selectBackend', 'setApiKey', 'showLog', 'snooze', 'toggle'].map((c) => `aiAutocomplete.${c}`).sort());
  expect(cmds.every((c) => c.category === 'AI Autocomplete')).toBe(true);
  expect(pkg.contributes.menus.commandPalette).toContainEqual({ command: 'aiAutocomplete.accepted', when: 'false' });
});
