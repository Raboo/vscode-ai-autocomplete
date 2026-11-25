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
3. A separate `open-vsx` job (run from the workflow's own commit, so this repo's pinned `ovsx` is used) publishes that `.vsix` to Open VSX with `npx --no-install ovsx publish`. The token reaches `ovsx` only through the `OVSX_PAT` environment variable. If the `OPEN_VSX_TOKEN` secret is empty, the step prints a notice and skips Open VSX.

### Republish a tag

Actions, then release-please, then Run workflow, and enter the tag (for example `v1.4.0`). The workflow rebuilds that tag, uploads the `.vsix` to its GitHub release (replacing the file there) and publishes it to Open VSX. The release-please job does not run on a manual start.

Open VSX refuses a version it already has, so a tag that is already published cannot be published again; the step then fails with that message. To fix a bad release, release a new version.

## VS Code Marketplace

There are two builds, because the Marketplace and `vsce` refuse extensions that declare proposed APIs:

- The full build (GitHub release `.vsix` and Open VSX) declares `inlineCompletionsAdditions`, so Next Edit can use native inline edits after the opt-in.
- The Marketplace build (`ai-autocomplete-X.Y.Z-marketplace.vsix`, from `npm run package:marketplace`) has no `enabledApiProposals`, so Next Edit always uses decorations. It is never attached to the GitHub release; the `vsix` job keeps it only as the workflow artifact `vsix-marketplace`.

Design: `docs/superpowers/specs/2026-11-25-marketplace-build-design.md`.

### One-time setup (the owner)

1. Create the publisher `raboo` at <https://marketplace.visualstudio.com/manage>.
2. Create a Trusted Publishing policy for it (GitHub OIDC, no token): repository owner `Raboo`, repository `vscode-ai-autocomplete`, workflow `release-please.yml`, environment empty.
3. Set the repository variable `MARKETPLACE_PUBLISH` to `true` (Settings, Secrets and variables, Actions, Variables).

No Marketplace token or secret exists anywhere.

### How a release reaches the Marketplace

1. The `vsix` job also runs `npm run package:marketplace` and uploads the result as the artifact `vsix-marketplace` (tags from before this script skip it with a notice).
2. The `marketplace` job (run from the workflow's own commit, with `id-token: write`) downloads that artifact and runs `npx --no-install vsce publish --oidc --packagePath <file>`.
3. The variable `MARKETPLACE_PUBLISH` turns automatic publishing on. While it is not `true`, or when the artifact is missing, the job prints a notice and skips.

If the Marketplace refuses an OIDC publish for the first version of a new extension, download that run's `vsix-marketplace` artifact and upload it by hand once at <https://marketplace.visualstudio.com/manage>. Later versions publish through the workflow.

Republishing a tag (the manual workflow run) also runs the `marketplace` job; the Marketplace refuses a version it already has.
