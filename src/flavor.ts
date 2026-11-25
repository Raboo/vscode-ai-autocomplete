export const RELEASES_URL = 'https://github.com/Raboo/vscode-ai-autocomplete/releases';

/** True in the build for the VS Code Marketplace, which cannot use the proposed API (esbuild defines `__MARKETPLACE__`). */
export const MARKETPLACE: boolean = typeof __MARKETPLACE__ !== 'undefined' && __MARKETPLACE__ === true;
