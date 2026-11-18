import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // The pinned VS Code proposal is Microsoft's file, kept verbatim: its disable comments name VS Code's own lint rules.
  // scripts/screenshots holds plain CommonJS helpers run by Node and a test VS Code, outside the extension.
  { ignores: ['dist', 'out', 'node_modules', '.vscode-test', 'src/types/vscode.proposed.*.d.ts', 'scripts/screenshots'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
