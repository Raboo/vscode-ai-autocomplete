import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

// The directory @vscode/test-electron uses by default, named here so the settings below land in it.
const userDataDir = join(dirname(fileURLToPath(import.meta.url)), '.vscode-test', 'user-data');

// Every run starts from these user settings; tests write their own settings and reset them in teardown.
// Built-in chat is off: VS Code 1.146 focuses the chat input at startup, and when the window has no OS focus
// (screen locked, another app in front) that editor never gets a blur event, so it keeps text focus and
// editor commands such as editor.action.inlineSuggest.trigger run on it instead of the test's editor.
mkdirSync(join(userDataDir, 'User'), { recursive: true });
writeFileSync(join(userDataDir, 'User', 'settings.json'), `${JSON.stringify({ 'chat.disableAIFeatures': true }, null, 2)}\n`);

const shared = { version: 'stable', mocha: { timeout: 20000 } };

// Two launches, run one after the other: `main` runs every test on Stable as users get it (no proposed API),
// `proposed` runs the Next Edit tests again with the inline-edit proposal enabled. Tests read their launch from the env.
export default defineConfig([
  {
    ...shared,
    label: 'main',
    files: 'out/test/integration/**/*.test.js',
    launchArgs: [`--user-data-dir=${userDataDir}`],
    env: { AI_AUTOCOMPLETE_TEST_LAUNCH: 'main' },
  },
  {
    ...shared,
    label: 'proposed',
    files: 'out/test/integration/nextEdit.test.js',
    launchArgs: [`--user-data-dir=${userDataDir}`, '--enable-proposed-api', 'raboo.ai-autocomplete'],
    env: { AI_AUTOCOMPLETE_TEST_LAUNCH: 'proposed' },
  },
]);
