export const RELEASES_URL = 'https://github.com/Raboo/vscode-ai-autocomplete/releases/latest';

/** True in the build for the VS Code Marketplace, which cannot use the proposed API (esbuild defines `__MARKETPLACE__`). */
export const MARKETPLACE: boolean = typeof __MARKETPLACE__ !== 'undefined' && __MARKETPLACE__ === true;

/** The full build's id (GitHub and Open VSX). The Marketplace refused its name, so the Marketplace build is a separate extension. */
export const FULL_ID = 'raboo.ai-autocomplete';
/** The Marketplace build's id: same publisher and settings, the name `ai-autocomplete-prediction`. */
export const MARKETPLACE_ID = 'raboo.ai-autocomplete-prediction';
/** The id of the running build (for the settings filter and the walkthrough). */
export const SELF_ID = MARKETPLACE ? MARKETPLACE_ID : FULL_ID;
