// Packages the Marketplace flavour: package.json without enabledApiProposals, the bundle built with the flavour flag.
// package.json and dist/ are restored when the child ends, also after Ctrl-C or SIGTERM (the child gets the signal too).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { marketplaceManifest } from './marketplaceManifest.mjs';

const original = readFileSync('package.json', 'utf8');
const pkg = JSON.parse(original);
const shell = process.platform === 'win32';
let signalled = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (signalled = true));

writeFileSync('package.json', JSON.stringify(marketplaceManifest(pkg), null, 2) + '\n');
const child = spawn('npx', ['--no-install', 'vsce', 'package', '--no-dependencies', '-o', `ai-autocomplete-${pkg.version}-marketplace.vsix`], {
  stdio: 'inherit',
  shell,
  env: { ...process.env, AI_AUTOCOMPLETE_FLAVOR: 'marketplace' },
});
child.on('close', (status) => {
  writeFileSync('package.json', original);
  // vsce's prepublish left the minified Marketplace bundle in dist/: put the normal development bundle back.
  const env = { ...process.env };
  delete env.AI_AUTOCOMPLETE_FLAVOR;
  const rebuilt = spawnSync(process.execPath, ['esbuild.mjs'], { stdio: 'inherit', env });
  process.exit(signalled || rebuilt.status !== 0 ? 1 : (status ?? 1));
});
child.on('error', (err) => {
  process.stderr.write(`${err.message}\n`);
  writeFileSync('package.json', original);
  process.exit(1);
});
