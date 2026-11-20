# Publishing

Where AI Autocomplete is published and how a release gets there.

## Open VSX

Releases are published to [Open VSX](https://open-vsx.org/extension/raboo/ai-autocomplete) automatically. Open VSX serves VSCodium, Cursor, Windsurf and other VS Code builds.

### One-time setup (the owner)

1. Create an Eclipse account and log in at open-vsx.org with it.
2. Sign the Open VSX publisher agreement (the site asks for it from your profile).
3. Create an access token at <https://open-vsx.org/user-settings/tokens>.
4. Store it as the repository secret `OPEN_VSX_TOKEN` (Settings, Secrets and variables, Actions). Renew it when it expires or is revoked.
5. Verify the namespace: open an issue at <https://github.com/EclipseFdn/open-vsx.org/issues> to claim `raboo`. Until it is claimed, the extension page shows the namespace as unverified. Publishing works meanwhile.

The release job creates the `raboo` namespace if it is missing.

### How a release reaches Open VSX

1. release-please merges its release PR, which tags the release.
2. The `vsix` job in `.github/workflows/release-please.yml` checks out the tag, runs lint, typecheck, build and tests, builds `ai-autocomplete-X.Y.Z.vsix` and uploads it to the GitHub release.
3. The same job publishes that `.vsix` to Open VSX with `npx ovsx publish`. The token reaches `ovsx` only through the `OVSX_PAT` environment variable. If the `OPEN_VSX_TOKEN` secret is empty, the step prints a notice and skips Open VSX.

### Republish a tag

Actions, then release-please, then Run workflow, and enter the tag (for example `v1.4.0`). The workflow rebuilds that tag, uploads the `.vsix` to its GitHub release (replacing the file there) and publishes it to Open VSX. The release-please job does not run on a manual start.

Open VSX refuses a version it already has, so a tag that is already published cannot be published again; the step then fails with that message. To fix a bad release, release a new version.

## VS Code Marketplace

Blocked. The extension declares the proposed API `inlineCompletionsAdditions` (for native Next Edit inline edits), and the Marketplace and `vsce` refuse extensions that declare proposed APIs; the only exceptions are Microsoft's own extensions. The path is finalization of that API (see [microsoft/vscode#205594](https://github.com/microsoft/vscode/issues/205594)).

Planned as a separate roadmap step (5b in `ROADMAP.md`): a Marketplace build without the proposal, where Next Edit always uses decorations. Open VSX and GitHub releases keep the full build.

Until then, stock VS Code users install the `.vsix` from the GitHub release.
