import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

// The test VS Code runs in portable mode (VSCODE_PORTABLE): it reads argv.json from the portable folder, not from the
// user's ~/.vscode, so a user's own "enable-proposed-api" entry cannot leak into the `main` launch. The folder holds no
// argv.json of its own. Portable mode also moves the user data to `<portable>/user-data`, so that is the folder named here
// (and the one test/integration/local.test.ts reads the extension's global storage from).
// The portable folder name is short on purpose: VS Code puts a Unix socket (`<user data>/1.14-main.sock`) in the user
// data folder, and Linux limits a socket path to 107 bytes; a longer path fails with `listen EINVAL` (CI: about 103).
const portableDir = join(dirname(fileURLToPath(import.meta.url)), '.vscode-test', 'p');
const userDataDir = join(portableDir, 'user-data');

// Every run starts from these user settings; tests write their own settings and reset them in teardown.
// Built-in chat is off: VS Code 1.146 focuses the chat input at startup, and when the window has no OS focus
// (screen locked, another app in front) that editor never gets a blur event, so it keeps text focus and
// editor commands such as editor.action.inlineSuggest.trigger run on it instead of the test's editor.
mkdirSync(join(userDataDir, 'User'), { recursive: true });
writeFileSync(join(userDataDir, 'User', 'settings.json'), `${JSON.stringify({ 'chat.disableAIFeatures': true }, null, 2)}\n`);

// An empty workspace folder: files a test writes into it count as project files (files outside it are never context).
const workspaceDir = join(dirname(fileURLToPath(import.meta.url)), '.vscode-test', 'workspace');
mkdirSync(workspaceDir, { recursive: true });

const shared = { version: 'stable', mocha: { timeout: 20000 }, workspaceFolder: workspaceDir };

// Two launches, run one after the other: `main` runs every test on Stable as users get it (no proposed API),
// `proposed` runs the Next Edit tests again with the inline-edit proposal enabled. Tests read their launch from the env.
export default defineConfig([
  {
    ...shared,
    label: 'main',
    files: 'out/test/integration/**/*.test.js',
    launchArgs: [`--user-data-dir=${userDataDir}`],
    env: { AI_AUTOCOMPLETE_TEST_LAUNCH: 'main', VSCODE_PORTABLE: portableDir },
  },
  {
    ...shared,
    label: 'proposed',
    files: 'out/test/integration/nextEdit.test.js',
    launchArgs: [`--user-data-dir=${userDataDir}`, '--enable-proposed-api', 'raboo.ai-autocomplete'],
    env: { AI_AUTOCOMPLETE_TEST_LAUNCH: 'proposed', VSCODE_PORTABLE: portableDir },
  },
]);
