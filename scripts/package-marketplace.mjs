// Packages the Marketplace flavour: package.json without enabledApiProposals, the bundle built with the flavour flag.
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { marketplaceManifest } from './marketplaceManifest.mjs';

const original = readFileSync('package.json', 'utf8');
const pkg = JSON.parse(original);
let code;
try {
  writeFileSync('package.json', JSON.stringify(marketplaceManifest(pkg), null, 2) + '\n');
  const r = spawnSync('npx', ['--no-install', 'vsce', 'package', '--no-dependencies', '-o', `ai-autocomplete-${pkg.version}-marketplace.vsix`], {
    stdio: 'inherit',
    env: { ...process.env, AI_AUTOCOMPLETE_FLAVOR: 'marketplace' },
  });
  code = r.status ?? 1;
} finally {
  writeFileSync('package.json', original);
}
process.exit(code ?? 1);
