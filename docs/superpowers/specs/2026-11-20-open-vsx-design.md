# Publishing to Open VSX — design

Date: 2026-11-20. Phase 5, first part. The owner chose to start with Open VSX ("Lets start with publishing on Open VSX, I added a secret, OPEN_VSX_TOKEN") after learning the VS Code Marketplace refuses extensions that declare proposed APIs.

## Why

Open VSX is the extension store of VSCodium, Cursor, Windsurf, Gitpod, Theia and other VS Code builds. It accepts our full build, including the `inlineCompletionsAdditions` proposal behind the native Next Edit view. Today the extension ships only as a `.vsix` on GitHub releases.

## Goals

- Every release that release-please creates is also published to Open VSX as `raboo.ai-autocomplete`, from the same `.vsix` the GitHub release gets.
- The current release (1.4.0) can be published once by hand from the workflow, without a new release.
- The `raboo` namespace is created by the workflow if it does not exist.
- `docs/PUBLISHING.md` explains the setup, the token's renewal and the namespace verification.

## Non-goals

- The VS Code Marketplace (blocked by the proposed API; see "Proposed API" below).
- Changing what the extension does.

## Approaches

- **A. Publish from the existing `vsix` job in `release-please.yml` (chosen).** The file is built and tested there already; one more step publishes it. A `workflow_dispatch` entry point with a tag input covers republishing an existing release.
- B. A separate workflow triggered by `release: published`. Releases created with `RELEASE_PLEASE_TOKEN` do trigger it, but it rebuilds or downloads the asset again: two places that build the file.

## Decisions

- `ovsx` (Eclipse, EPL-2.0) becomes a pinned devDependency, so Dependabot keeps it current; the runtime dependency list does not change.
- The `vsix` job, after uploading the asset to the GitHub release: `npx ovsx create-namespace raboo` (an "already exists" answer is fine; any other error fails the job) then `npx ovsx publish ai-autocomplete-X.Y.Z.vsix`, with the token from the `OPEN_VSX_TOKEN` secret in the `OVSX_PAT` environment variable (never on the command line, never printed). A missing secret skips the Open VSX steps with a notice, like the release-please token.
- `workflow_dispatch` with input `tag` (for example `v1.4.0`): checks out that tag, builds, tests, packages, uploads to its GitHub release (`--clobber`) and publishes to Open VSX. Publishing a version that Open VSX already has fails clearly, which is the wanted behaviour.
- Permissions stay least-privilege (`contents: write` for the release upload only); actions stay SHA-pinned.
- Project rule change (AGENTS.md): releases publish to Open VSX automatically as part of the release (the owner's choice, 2026-11-20). Agents still ask before running the manual publish, before Marketplace publishing, and before changing the token.
- README: an "Install" section with the Open VSX link next to the GitHub `.vsix` instructions, and an Open VSX version badge.
- `docs/PUBLISHING.md`: the Eclipse account and publisher agreement, the token (scope, renewal, secret name), namespace verification (claim `raboo` through an issue at `EclipseFdn/open-vsx.org` so the page does not show "unverified"; an owner step), how a release reaches Open VSX, how to republish a tag, and the Marketplace status.

## Proposed API (research for the owner)

- The Marketplace (and `vsce publish`) refuse extensions with `enabledApiProposals`.
- The exception list is `extensionEnabledApiProposals` in VS Code's built `product.json`. In VS Code 1.147 it has 65 entries, all Microsoft or Microsoft-partner extensions; `inlineCompletionsAdditions` is allowed for GitHub Copilot/Copilot Chat, IntelliCode and C# Dev Kit only. There is no public application process.
- The realistic path is finalization: the proposal's parts (`isInlineEdit`, `showRange`, `handleDidShowCompletionItem`, …) become stable API. Issue microsoft/vscode#205594 asks for that and is open.

## Left to the builder

- Whether the dispatch path shares steps with the release path through a reusable job or a condition.
