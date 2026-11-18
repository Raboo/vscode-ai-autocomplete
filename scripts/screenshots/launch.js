// Launches the test VS Code for the screenshot scenes; run from the repo root (see README.md here).
const { runTests } = require(require.resolve('@vscode/test-electron', { paths: [process.cwd()] }));
const D = process.env.DEMO_DIR;
runTests({
  version: '1.146.0',
  extensionDevelopmentPath: process.cwd(),
  extensionTestsPath: `${D}/run.js`,
  launchArgs: [`${D}/ws`, `--user-data-dir=${D}/user`, `--extensions-dir=${D}/ext`, '--skip-welcome', '--skip-release-notes'],
  extensionTestsEnv: { DEMO_SIG: `${D}/sig` },
}).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
