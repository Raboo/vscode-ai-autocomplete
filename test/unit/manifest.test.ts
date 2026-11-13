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
