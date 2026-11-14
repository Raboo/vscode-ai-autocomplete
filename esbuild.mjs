import { context, build } from 'esbuild';
import process from 'node:process';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extension = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/**
 * The Backends page: dist/webview/backends.js and backends.css.
 * Source maps are inline: .vscodeignore packages all of dist/webview, so a stale .map file there would ship.
 * @type {import('esbuild').BuildOptions}
 */
const webview = {
  entryPoints: ['src/webview/backends/main.ts', 'src/webview/backends/style.css'],
  outdir: 'dist/webview',
  entryNames: 'backends',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
};

if (watch) {
  const contexts = await Promise.all([context(extension), context(webview)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all([build(extension), build(webview)]);
}
