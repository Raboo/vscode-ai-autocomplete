import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { expect, test } from 'vitest';

// Reads the build output: run `npm run build` first, as for the manifest test.
test('the bundle requires only vscode and Node built-ins at run time', () => {
  // The .vsix ships no node_modules, and a relative path cannot resolve from dist/: jsonc-parser's UMD build left
  // require("./impl/format") in the bundle, and the extension failed to activate.
  const bundle = readFileSync('dist/extension.js', 'utf8');
  const required = [...bundle.matchAll(/\brequire\d*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  expect(required).toContain('vscode');
  expect(required.filter((id) => id !== 'vscode' && !isBuiltin(id))).toEqual([]);
});
