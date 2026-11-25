# Marketplace Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second package, `ai-autocomplete-X.Y.Z-marketplace.vsix`, without the proposed API, built in CI and published to the VS Code Marketplace on release through Trusted Publishing once the repository variable `MARKETPLACE_PUBLISH` is `true`.

**Architecture:** An esbuild `define` (`__MARKETPLACE__`) read through `src/flavor.ts` switches three runtime spots (menu entry, `display: native`, the opt-in command) plus one activation notice; a pure `marketplaceManifest()` and a packaging script produce the variant `.vsix`; CI packages it and the release workflow publishes it.

**Tech Stack:** TypeScript, esbuild, vsce, vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-25-marketplace-build-design.md`

## Global Constraints

- Same id `raboo.ai-autocomplete`, name, publisher, version and commands in both builds; the variant manifest differs only by dropping `enabledApiProposals` and the `nextEdit.display` `native` description.
- Env variable `AI_AUTOCOMPLETE_FLAVOR=marketplace` → `__MARKETPLACE__` `true`; anything else → `false`. `src/flavor.ts` never imports `vscode` and gives `false` when the constant is undefined (vitest).
- Package file name: `ai-autocomplete-<version>-marketplace.vsix`. The working-tree `package.json` is byte-identical after `npm run package:marketplace`, also when vsce fails.
- The full build's behaviour is unchanged.
- Releases page link: `https://github.com/Raboo/vscode-ai-autocomplete/releases/latest`.
- Workflows: actions pinned by full SHA with `# vX.Y.Z`, least-privilege `permissions:`, `timeout-minutes` on every job; job ids `check` and `integration` unchanged; the `marketplace` job publishes with `vsce publish --oidc` and has `id-token: write`; no job stores or reads a Marketplace token.
- Commits: Conventional Commits, no trailers, stage by explicit path.

## Review Focus

- vsce fails mid-packaging (bad manifest, disk full): `package.json` is restored and the script exits non-zero.
- `npm run package` after `npm run package:marketplace` in the same tree: the full `.vsix` has the full bundle (vsce's prepublish rebuilds without the env variable) and declares the proposal.
- argv.json missing, malformed, or not listing this id: no activation notice and no error in the Marketplace build.
- The release `vsix` job uploads only the full `.vsix` to the GitHub release, and the Open VSX job still finds exactly one file.
- `workflow_dispatch` with an old tag that has no `package:marketplace` script: the Marketplace build step skips with a notice instead of failing the job.

---

### Task 1: Marketplace flavour in code and packaging

**Files:**
- Create: `src/flavor.ts`, `src/types/flavor.d.ts` (declares `__MARKETPLACE__: boolean | undefined` as a global const), `scripts/package-marketplace.mjs`, `scripts/marketplaceManifest.mjs` (the pure transform, shared by the script and the test)
- Modify: `esbuild.mjs`, `package.json` (script `package:marketplace`), `src/nextEdit/optIn.ts`, `src/ui/statusModel.ts`, `src/ui/commands.ts`, `src/nextEdit/vscode/controller.ts`, `src/extension.ts`
- Test: `test/unit/flavor.test.ts`, `test/unit/statusModel.test.ts`, `test/unit/nextEdit/optIn.test.ts` (or wherever `withProposedApiOptIn` is tested)

**Interfaces:**
- Produces: `export const MARKETPLACE: boolean` (`src/flavor.ts`); `export function hasProposedApiOptIn(text: string, id: string): boolean` (`optIn.ts`, false for empty, malformed or non-object text); `export function marketplaceManifest(pkg: object): object` (`scripts/marketplaceManifest.mjs`); `menuEntries`/`menuGroups` take the flavour through `MenuInputs.marketplace?: true`.

- [ ] **Step 1: Write the failing tests**
  - `marketplaceManifest(pkg)` on the real `package.json`: no `enabledApiProposals` key; `name`, `publisher`, `version`, `contributes.commands` deep-equal the original; the `native` entry of `aiAutocomplete.nextEdit.display`'s `markdownEnumDescriptions` mentions the GitHub or Open VSX build; the input object is not mutated.
  - `MARKETPLACE` is `false` under vitest.
  - `hasProposedApiOptIn`: `'{"enable-proposed-api":["raboo.ai-autocomplete"]}'` → true; with comments and trailing comma → true; other ids only → false; `''`, `'{'`, `'[]'` → false.
  - Status menu: with `marketplace: true` and `nativeNextEdit: false`, no `enableNativeNextEdit` entry; without `marketplace`, unchanged.
- [ ] **Step 2: Run to verify failure** — `npx vitest run test/unit/flavor.test.ts test/unit/statusModel.test.ts` FAIL.
- [ ] **Step 3: Implement**
  - `esbuild.mjs`: `define: { __MARKETPLACE__: JSON.stringify(process.env.AI_AUTOCOMPLETE_FLAVOR === 'marketplace') }` on the extension build only.
  - `src/flavor.ts`: `typeof __MARKETPLACE__ !== 'undefined' && __MARKETPLACE__ === true`.
  - Controller: in the Marketplace build a `native` display setting is treated as `auto` before `displayFor`.
  - `enableNativeNextEdit` in the Marketplace build: information message that the native view needs the GitHub or Open VSX build because the Marketplace forbids its API, button "Open releases" → `vscode.env.openExternal` of the releases link; argv.json untouched.
  - `extension.ts`: log the flavour in the existing native-probe log line; in the Marketplace build, read argv.json (same path logic as the command, skipped on the remote side) and if `hasProposedApiOptIn` is true show one notice that this is the Marketplace build, which cannot show the native view, with "Open releases"; read errors are logged at debug and ignored.
  - `scripts/package-marketplace.mjs`: read `package.json` text, write `JSON.stringify(marketplaceManifest(pkg), null, 2) + '\n'`, run `npx --no-install vsce package --no-dependencies -o ai-autocomplete-<version>-marketplace.vsix` with `AI_AUTOCOMPLETE_FLAVOR=marketplace` (inherit stdio), restore the original text in `finally`, exit with vsce's code.
  - `package.json`: `"package:marketplace": "node scripts/package-marketplace.mjs"`.
- [ ] **Step 4: Verify** — `npm run build && npm run typecheck && npm run lint && npm test` pass; then `npm run package:marketplace`, `git diff --exit-code package.json`, and `unzip -p ai-autocomplete-*-marketplace.vsix extension/package.json | grep -c enabledApiProposals` prints `0`; `npm run package` afterwards gives a `.vsix` whose `extension/package.json` still lists `inlineCompletionsAdditions`. Delete both `.vsix` files.
- [ ] **Step 5: Commit**
```bash
git add src/flavor.ts src/types/flavor.d.ts scripts/package-marketplace.mjs scripts/marketplaceManifest.mjs esbuild.mjs package.json src/nextEdit/optIn.ts src/ui/statusModel.ts src/ui/commands.ts src/nextEdit/vscode/controller.ts src/extension.ts test/unit/flavor.test.ts test/unit/statusModel.test.ts <optIn test file>
git commit -m "feat: Marketplace build without the proposed API"
```

### Task 2: CI, release job and docs

**Files:**
- Modify: `.github/workflows/ci.yml`, `.github/workflows/release-please.yml`, `docs/PUBLISHING.md`, `README.md`, `AGENTS.md`, `docs/ROADMAP.md`
- Test: `test/unit/repoAutomation.test.ts`

- [ ] **Step 1: Write the failing tests** in `repoAutomation.test.ts`: `ci.yml`'s `check` job runs `npm run package:marketplace` after `npm run package` and checks the packaged manifest has no `enabledApiProposals`; `release-please.yml` has a job `marketplace` with `needs: vsix`, permissions `contents: read` and `id-token: write`, a `timeout-minutes`, `vsce publish --oidc`, and a skip notice unless `vars.MARKETPLACE_PUBLISH == 'true'`; no `VSCE_PAT` anywhere; the `vsix` job uploads the artifact `vsix-marketplace` and its `gh release upload` names only the full package (not a glob that matches `-marketplace`).
- [ ] **Step 2: Run to verify failure** — `npx vitest run test/unit/repoAutomation.test.ts` FAIL.
- [ ] **Step 3: Implement**
  - `ci.yml` `check`: after `npm run package`, `npm run package:marketplace` and `unzip -p ai-autocomplete-*-marketplace.vsix extension/package.json | grep -q enabledApiProposals && exit 1 || true` (or equivalent); the existing artifact keeps `*.vsix`.
  - `release-please.yml` `vsix`: upload `ai-autocomplete-<version>.vsix` by its exact name (version from the tag); then, only if `package.json` has a `package:marketplace` script (old tags skip with a notice), `npm run package:marketplace` and upload artifact `vsix-marketplace`.
  - New job `marketplace` mirroring `open-vsx`: checkout `github.sha`, `npm ci --ignore-scripts`, download `vsix-marketplace` (skip with a notice when it is missing), skip with a notice unless `MARKETPLACE_PUBLISH` is `true` (passed in through `env` from `vars`), require exactly one file, `npx --no-install vsce publish --oidc --packagePath "$file"`.
  - `docs/PUBLISHING.md`: replace "Blocked" with the two builds, the one-time setup (publisher `raboo`; Trusted Publishing policy: owner `Raboo`, repository `vscode-ai-autocomplete`, workflow `release-please.yml`, environment empty; repository variable `MARKETPLACE_PUBLISH=true`), that the variable turns on automatic publishing, and the manual first upload if the Marketplace refuses an OIDC publish of a new extension.
  - `README.md`: install from the Marketplace; the Marketplace build shows Next Edit with decorations; for the native view install the GitHub `.vsix` and turn off auto-update for the extension.
  - `AGENTS.md`: the workflow list names the `marketplace` job; the approval line says releases publish to the Marketplace automatically once the owner has created the Trusted Publishing policy and set `MARKETPLACE_PUBLISH`; agents never create or change either; "Needs a human" names the policy and the variable instead of a Marketplace token.
  - `docs/ROADMAP.md`: row 5b design and plan links, status "in progress".
- [ ] **Step 4: Verify** — `npm run build && npm run typecheck && npm run lint && npm test` pass; actionlint passes in CI.
- [ ] **Step 5: Commit**
```bash
git add .github/workflows/ci.yml .github/workflows/release-please.yml docs/PUBLISHING.md README.md AGENTS.md docs/ROADMAP.md test/unit/repoAutomation.test.ts
git commit -m "ci: build and publish the Marketplace package"
```
