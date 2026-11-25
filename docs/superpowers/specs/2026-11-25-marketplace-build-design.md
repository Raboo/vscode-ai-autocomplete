# Marketplace build without the proposed API — design

Roadmap step 5b. The owner asked for it on 2026-11-25 after the short sketch (manifest variant, build flag, packaging test, publish job that skips without a token).

## Intent

Stock VS Code users find extensions in the Marketplace, which refuses any extension that declares a proposed API. A second package of the same extension, without `enabledApiProposals`, can be listed there. Next Edit then always uses decorations (and ghost text for insertions at the cursor). GitHub releases and Open VSX keep the full build.

## Goals, non-goals, anti-goals

- Goals: every release also builds `ai-autocomplete-X.Y.Z-marketplace.vsix` and publishes it to the Marketplace through Trusted Publishing (GitHub OIDC, no stored token) once the owner turns it on; the Marketplace build never points users at an opt-in it cannot use.
- Non-goals: a different extension id or display name; feature differences beyond the native inline-edit view; publishing the Marketplace `.vsix` on the GitHub release (one download there avoids picking the wrong file).
- Anti-goals: a broken or proposal-declaring package reaching the Marketplace; `package.json` in the working tree left modified after packaging; the full build changing behaviour.

## Approaches

1. **Same id, flavour chosen at build time** (chosen): one `package.json`; a packaging script writes a variant manifest without `enabledApiProposals` and builds with an esbuild `define` flag. Users keep their settings and reviews whichever store they install from.
2. A separate id (`raboo.ai-autocomplete-lite`): no update crossover, but two listings, settings under the same `aiAutocomplete.*` keys fighting when both are installed, split reviews. Rejected.
3. Wait for `inlineCompletionsAdditions` to be finalized (microsoft/vscode#205594): no date. Rejected.

## The design

- **Build flag**: `esbuild.mjs` defines `__MARKETPLACE__` as `true` when the environment variable `AI_AUTOCOMPLETE_FLAVOR=marketplace` is set, `false` otherwise. A pure module `src/flavor.ts` exports `MARKETPLACE: boolean` (false when the constant is undefined, as in vitest). The env variable also reaches vsce's `vscode:prepublish` build.
- **Manifest variant**: a pure function `marketplaceManifest(pkg)` returns a copy without `enabledApiProposals`, with the `nextEdit.display` `native` description saying it needs the GitHub or Open VSX build. Nothing else differs (same name, publisher, version, commands).
- **Packaging**: `npm run package:marketplace` runs `scripts/package-marketplace.mjs`: it writes the variant `package.json`, runs `vsce package --no-dependencies -o ai-autocomplete-<version>-marketplace.vsix` with the env variable set, and restores the original `package.json` in a `finally`, even on failure.
- **Runtime, Marketplace build only**:
  - the status bar menu never shows "Enable native Next Edit UI...";
  - `display: native` behaves as `auto` (decorations), so the "needs VS Code's inline-edit view" notice never fires;
  - **Enable Native Next Edit UI** does not touch argv.json; it says the native view needs the GitHub or Open VSX build (the Marketplace forbids the API it uses) and offers "Open releases" (the GitHub releases page);
  - on activation, if argv.json already opts this extension in (the user had the full build and VS Code updated it from the Marketplace), one notice per VS Code session says so and offers "Open releases". VS Code updates a `.vsix` install from the Marketplace when auto-update is on and the installed version equals the Marketplace's latest; the README says to turn off auto-update for the extension when keeping the full build.
  - the activation log line names the flavour.
- **CI**: the `check` job also runs `npm run package:marketplace` and fails if the packaged `extension/package.json` declares `enabledApiProposals` or the bundle lacks the flag; both `.vsix` files go into its artifact.
- **Release**: the `vsix` job also builds the Marketplace package and uploads it as a separate artifact `vsix-marketplace` (not to the GitHub release; the Open VSX job's glob stays on the full build). A new job `marketplace` (needs `vsix`, permissions `contents: read` and `id-token: write`, `timeout-minutes`, SHA-pinned actions, no GitHub environment) runs `npx --no-install vsce publish --oidc --packagePath <file>` (vsce 4.1.1 in the lockfile; `--oidc` needs 4.1.0 or later), and skips with a notice unless the repository variable `MARKETPLACE_PUBLISH` is `true`. The `workflow_dispatch` path publishes it too; the Marketplace refuses a version it has, like Open VSX.
- **Approval**: the owner creates the Trusted Publishing policy on the publisher (owner `Raboo`, repository `vscode-ai-autocomplete`, workflow `release-please.yml`, environment empty) and sets the repository variable `MARKETPLACE_PUBLISH=true`; that is the consent to automatic Marketplace publishing, as the token was for Open VSX. AGENTS.md says so; agents never create or change the policy or the variable. If the Marketplace refuses the first OIDC publish of a new extension, the owner uploads that release's Marketplace `.vsix` by hand once (the workflow run's `vsix-marketplace` artifact).
- **Docs**: `docs/PUBLISHING.md` Marketplace section (publisher `raboo` at marketplace.visualstudio.com/manage, the Trusted Publishing policy values, the `MARKETPLACE_PUBLISH` variable, the two builds and what differs); README install section and native-view paragraph; AGENTS.md workflow and approval lines; ROADMAP row 5b.

## Facts checked (2026-11-25)

- The Marketplace has no extension `raboo.ai-autocomplete`, and no extension shows the exact display name "AI Autocomplete" (similar names exist: "Predicte AI Autocomplete", "Splashy AI Autocomplete"). Whether the publisher `raboo` is free is checked by the owner when creating it.
- Trusted Publishing: the VS Code publishing guide (vscode-docs `publishing-extension.md`) documents the policy fields and `vsce publish --oidc` with `id-token: write`; local vsce 4.1.1 has `--oidc`.
- VS Code 1.146 `installFromVSIX`: a `.vsix` of the version the Marketplace lists as latest is pinned only when auto-update is off for it; another version is installed as given.

## Left to the builder

The exact notice wording; how the script finds vsce (`npx --no-install vsce`); the CI check's shell.

## Amendment 2026-11-25: separate name

The first Marketplace publish (v1.6.0) was refused: "The extension 'ai-autocomplete' already exists in the Marketplace" (the name is held, though not publicly listed). The owner chose the name `ai-autocomplete-prediction`, so the Marketplace build is the extension `raboo.ai-autocomplete-prediction` (approach 2 above, which the refusal forced; its objection, settings fighting when both are installed, is met by the guard below). Consequences:

- `marketplaceManifest` also sets `name`; display name, publisher, version, commands and settings stay the same.
- The running build's id (`SELF_ID` in `src/flavor.ts`) drives the settings filter and the walkthrough id.
- Both builds cannot run together (same commands): the Marketplace build stays off, with a warning offering to uninstall it, when `raboo.ai-autocomplete` is installed.
- API keys (SecretStorage), global state and the default models folder are per id, so they do not carry over between builds; the README says so.
- VS Code no longer updates a GitHub install from the Marketplace, so the argv.json notice and `hasProposedApiOptIn` are removed, and the README no longer asks to turn off auto-update.
