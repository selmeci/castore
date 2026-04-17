# Requirements: Migration from Yarn 4 workspaces to pnpm workspaces

**Date:** 2026-04-17 (v2 revision after document review)
**Scope:** Standard (tooling-level refactor across the entire monorepo)
**Approach:** Split into two PRs (dep hygiene -> package manager swap)

## Problem & Motivation

The repo currently runs on Yarn 4.10.2 with `nodeLinker: node-modules`. We want to migrate to pnpm workspaces for three reasons, in this order of importance:

1. **Disk / speed** - pnpm's content-addressable store and symlinks save space and reduce cold install time in CI.
2. **Strict dependency graph** - pnpm's default linker prevents phantom dependencies. Although `eslint.config.js` already enforces `import/no-extraneous-dependencies` for `src/**`, dev tooling (Babel plugins, ESLint configs, `scripts/*`, `commonConfiguration/*`, `docs/`) is currently handled via hoisting. Migration and `strict-peer-dependencies` will expose this.
3. **Standardization** - alignment with other projects in the org and easier onboarding for internal developers.

**The load-bearing driver is (2).** (1) is a benefit, but not enough by itself to justify the change. (3) is an organizational multiplier: simpler internal onboarding and less package-manager-specific cognitive overhead.

### Why not a lighter alternative (depcheck/knip + ESLint extension)

We considered extending `import/no-extraneous-dependencies` to root-level tooling (Babel configs, scripts) + running `depcheck` in CI instead of a full package manager swap. **Rejected** because:

- The ESLint plugin only tracks `import`/`require` statically; Babel plugins and runtime configs often use dynamic `require()` that ESLint cannot see.
- `depcheck` has a known false-positive and false-negative rate; it needs per-package whitelists, which creates hidden carrying cost.
- Driver (3) - standardization - cannot be achieved by tooling linting at all.
- The pnpm linker additionally enforces correctness at the `.pnpm/` level, making it resilient even against future careless imports.

## Goals

Each goal includes a failure mode - what it means to "pass in the letter but fail in the spirit":

- **`pnpm install` without `shamefully-hoist=true` and without warnings.**
  *Failure mode:* achieved via a long `public-hoist-pattern[]` list that effectively reintroduces hoisting. Mitigation: `public-hoist-pattern[]` must stay empty except for one justified entry (if any); every additional entry requires PR-level discussion.
- **All Nx targets (`package`, `test`, `test-type`, `test-unit`, `test-linter`, `test-circular`, `test-stylelint`, `watch`) work via `pnpm nx ...` with identical semantics.**
  *Failure mode:* targets are green, but symlinked `node_modules` changes resolution order (for example `resolve.sync` searching sibling packages). Mitigation: see exit criteria - full Nx matrix must pass under pnpm before PR 2 is merged.
- **Published tarballs are functionally equivalent.**
  *Failure mode:* `dist/*` files are identical, but `dependencies`/`peerDependencies` ranges in tarball `package.json` change (pnpm rewrites `workspace:*` differently than Yarn 4 - Yarn often to `^x.y.z`, pnpm to exact pin). Mitigation: see exit criteria - diff `npm pack` output at the `package.json` range level, not only file listings.
- **CI (`.github/workflows/test-pr.yml`, `deploy-docs.yml`, `release-to-npm.yml`) migrates to pnpm with baseline-parity cold-install times.**
  *Failure mode:* CI is green but wall-time is significantly worse due to incorrect cache strategy. Mitigation: see exit criteria - baseline measurement before/after.
- **Husky hook + commitlint + `syncpack format` in `postinstall` remain functional.**
  *Failure mode:* pnpm 10 skips dependency postinstall scripts (without `onlyBuiltDependencies` allow-list) and root-package postinstall silently does not run due to similar gating. Mitigation: see PR 2 implementation unit 1 - explicit `onlyBuiltDependencies[]=husky` + verification of root-package script execution.

## Non-goals

- No version bumps except: (a) what pnpm strict mode forces, and (b) `syncpack fix-mismatches` alignment (patch/minor unification). No major bumps.
- No public API changes in packages (`packages/*/src/index.ts`).
- No build pipeline changes (`commonConfiguration/babel.config.js`, tsc + tsc-alias).
- No Nx configuration changes (`nx.json`) and no cache semantics changes.
- No migration to pnpm-native features (catalogs, `pnpm-workspace.yaml` filters beyond Yarn workspaces equivalence). Review decision: catalogs are explicitly rejected in this PR pair; syncpack is sufficient.

**Previously a non-goal, now in scope** (after document review): `preinstall: npx only-allow pnpm` guard - we are adding it. Reason: external contributors with in-progress branches can run `yarn install` even after PR 2 merges and silently regenerate `yarn.lock`. The guard is cheap (one line) and closes that contributor path.

## Users / Affected audiences

- **Internal maintainers** (5 people) - daily workflow changes (`yarn X` -> `pnpm X`).
- **External contributors** (public OSS repo `castore-dev/castore`):
  - `README.md`, `CONTRIBUTING.md` updated with pnpm-first install flow.
  - Before PR 2 merge: GitHub Issue announcement + 7-day warning window.
  - Before PR 2 merge: audit all open PRs; maintainers actively help contributors rebase (offering `git rebase` commits directly in their PRs where it makes sense).
  - `preinstall: only-allow pnpm` guard prevents silent `yarn.lock` regeneration on fork branches.
- **Downstream consumers of `@castore/*` packages** - expected zero impact. **Condition:** PR 2 exit criteria verify that `dependencies`/`peerDependencies` ranges in published tarballs do not change; if they do, this is a breaking change and must be handled in a separate block (see Risks).

## Decision: PR 1 - Dep hygiene pass (preliminary cleanup)

**Goal:** All `package.json` changes that would otherwise be mixed into the tooling swap PR. Still on Yarn 4, changes verifiable by existing CI.

**Scope:**

1. **Audit missing deps via a pnpm side worktree.**
   - Create a side worktree with `.npmrc` containing `strict-peer-dependencies=true`, `auto-install-peers=false`.
   - Run `pnpm install` and collect `ERR_PNPM_UNDECLARED_DEPENDENCY` + `ERR_PNPM_PEER_DEP_ISSUES`.
   - Run the **full Nx target matrix** (`test-type`, `test-unit`, `test-linter`, `test-circular`, `test-stylelint`, `package`) in the side worktree - install-time diagnostics do not catch runtime phantom deps.

2. **Fix `package.json` in each package** (`packages/*`, `demo/*`, `docs/`):
   - Add explicit `devDependencies` for everything the audit reveals.
   - Correct placement: runtime -> `dependencies`, tooling -> `devDependencies`, adapter core link -> `peerDependencies` + `devDependencies`.
   - Align versions via `syncpack list-mismatches` + `syncpack fix-mismatches` (patch/minor alignment only).

3. **Audit postinstall scripts for `onlyBuiltDependencies`.**
   - Enumerate all direct and transitive dependencies that have `postinstall`/`install` lifecycle hooks (for example `husky`, `esbuild` if transitive, node-gyp adapters).
   - Produce a list -> use it in PR 2 when creating `.npmrc`.

4. **Verify publish mechanism.**
   - Determine how `release-to-npm.yml` publishes today: direct `npm publish packages/*/dist` or workspace-aware `yarn npm publish`. The answer determines whether `workspace:*` rewrite in PR 2 is required and whether publish changes anything else.
   - Capture the result as a comment in PR 1 description (input to PR 2).

5. **Verify `syncpack` behavior with `workspace:*`.**
   - `syncpack@13` parser should support both `workspace:*` and `workspace:` - confirm experimentally (side worktree, test that `syncpack format` does not rewrite them incorrectly).

**PR 1 exit criteria:**

- `yarn install --immutable` still passes on main.
- All `nx run-many --target=test-*` targets are green on main.
- In side worktree (with strict pnpm `.npmrc`): `pnpm install` passes cleanly (zero `ERR_PNPM_UNDECLARED_DEPENDENCY`, zero `ERR_PNPM_PEER_DEP_ISSUES`).
- In side worktree: full `pnpm nx run-many --target=test-type,test-unit,test-linter,test-circular,test-stylelint,package --all` is green. This is the only way to verify that phantom deps are not hidden by Yarn hoisting.
- PR 1 description includes: list of postinstall-requiring packages (-> PR 2 `onlyBuiltDependencies`), publish mechanism type (-> PR 2 workspace protocol verification), syncpack verdict for `workspace:*`.

## Decision: PR 2 - Package manager swap

**Goal:** Clean swap of the tooling layer. PR 2 **requires** PR 1 as a prior merge - the sequential dependency is explicit, not hidden.

**Scope (mechanical):**

1. **Root configuration:**
   - `package.json`:
     - Remove `workspaces` field (pnpm reads from `pnpm-workspace.yaml`).
     - `packageManager` -> `pnpm@10.<minor>.<patch>+sha256.<hash>` (exact version + Corepack SHA-256 for tamper-evident pin). Generate exact value with `corepack use pnpm@10.<minor>.<patch>`.
     - Keep `engines.node: ^22.19.0`.
     - **Add `scripts.preinstall`:** `"preinstall": "only-allow pnpm"` (not `npx only-allow` - use pinned `only-allow@<version>` in root `devDependencies` so each install does not fetch from registry and to reduce supply-chain exposure).
   - New `pnpm-workspace.yaml` with patterns `packages/*`, `demo/*`, `docs`.
   - New `.npmrc` with:
     - `strict-peer-dependencies=true` - **gating in PR 2**, not follow-up. (Updated from review: previous proposal to defer this setting was incorrect - this flag is load-bearing for driver (2).)
     - `auto-install-peers=false`
     - `resolution-mode=highest`
     - `onlyBuiltDependencies[]=husky` + any additional packages identified in PR 1 (step 3).
     - **Without** `shamefully-hoist`.
     - **Without** default `public-hoist-pattern[]`. Add only if a concrete blocking case appears in CI, and document each entry with reason.

2. **Workspace protocol rewrite:**
   - `"@castore/*": "workspace:"` (Yarn 4 bare) -> `"@castore/*": "workspace:*"` across all `packages/*`, `demo/*` **and `docs/package.json`** (contains the same Yarn 4 bare syntax).
   - `peerDependencies` `"@castore/core": "*"` - keep as `*`, do not rewrite to `workspace:*`. Reason: published peer range should remain readable and compatible with any consumer setup. **Note:** under `strict-peer-dependencies=true` + `auto-install-peers=false`, semver drift in peer vs sibling `@castore/*` packages is not caught locally (peer `*` is a trivial match). Accepted tradeoff - downstream consumer install catches peer mismatches, not our CI.

3. **Delete Yarn artifacts:**
   - `yarn.lock`, `.yarn/` (including `.yarn/releases/yarn-4.10.2.cjs`), `.yarnrc.yml`.
   - Remove yarn-specific blocks from `.gitignore` (`.pnp.*`, `.yarn/*`, and related patterns).

4. **Generate `pnpm-lock.yaml`** (committed).

5. **Root scripts in `package.json`:**
   - `yarn depcruise` -> `pnpm exec depcruise`. (Per-package `test-circular` script in step 6 keeps direct `depcruise` call - `pnpm exec` at root level is for workspace-root binary resolution; per-package invocation already runs in `node_modules/.bin` scope.)
   - `ts-node scripts/setPackagesVersions` -> unchanged.
   - `check-audit`/`resolve-audit`: `npm-audit-resolver@3.0.0-RC` **has no `--pnpm` flag** (supports only yarn/npm). Decision: remove both scripts and `npm-audit-resolver` from root devDependencies; replace with `pnpm audit --prod` as an optional dev command (not CI automation). Ignore-list for specific advisories can be done via `.pnpmfile.cjs` or `pnpm overrides` if needed.
   - `postinstall`: `"husky install && syncpack format"` -> `"husky && syncpack format"` (Husky v9 uses bare `husky`, not `husky install`; this is also a pre-existing issue independent of pnpm).

6. **Per-package scripts (across `packages/*` and `demo/*`):**

   **Each** `package.json` has internal chains that use `yarn`:
   - `"package": "rm -rf dist && yarn package-cjs && yarn package-esm && yarn package-types"` - replace `yarn` with `pnpm` (or `pnpm run`).
   - `"package-cjs": "NODE_ENV=cjs yarn transpile ..."` - replace `yarn transpile` with `pnpm run transpile` or direct `babel ...` (consider removing mid-chain `yarn` indirection; usually a Yarn script-runner artifact).
   - `"test": "yarn test-type && yarn test-unit && yarn test-circular && yarn test-linter"` - replace `yarn` with `pnpm`.
   - `"test-circular": "yarn depcruise ..."`, `"test-linter": "yarn eslint ."`, `"test-unit": "yarn vitest ..."`, `"test-type": "tsc ..."` - replace `yarn <bin>` with direct binary call (`depcruise`, `eslint`, `vitest`), which pnpm resolves through `node_modules/.bin` the same way as Yarn.
   - `"watch": "rm -rf dist && concurrently 'yarn:package-* --watch'"` - `yarn:` prefix is Yarn-specific; `concurrently` supports generic `npm:` prefix that works with any package manager. Replace with `concurrently 'npm:package-* --watch'`.
   - `"lint-fix": "yarn eslint --fix"` -> `pnpm exec eslint --fix` or direct `eslint --fix`.

   **Scripted bulk rewrite** (for example `jq` + `find` one-liner) is recommended for this step to keep PR deterministic.

7. **CI changes** (`.github/`):
   - `.github/actions/install-node-modules/action.yml` - full rewrite:
     - Upgrade `actions/setup-node@v3` -> `@v4`, `actions/cache@v3` -> `@v4` (explicit bump, not only install step).
     - Add `pnpm/action-setup@<pinned-commit-sha>` (pin to SHA, not floating `@v4`).
     - `actions/setup-node@v4` with `cache: 'pnpm'` and `node-version: 22`.
     - **Remove** explicit `**/node_modules` cache step - with pnpm, caching nested `node_modules` is incorrect (dangling symlinks to global store). pnpm store is cached by `setup-node cache:'pnpm'`.
     - **Remove** conditional install skip (`if cache-hit != true`) - tied to removed cache step; pnpm `--frozen-lockfile` is fast with warm store.
     - Install step: `pnpm install --frozen-lockfile`.
   - `.github/actions/package/action.yml`: `yarn package` -> `pnpm package`.
   - `.github/actions/lint-and-tests/action.yml`: all literal `yarn` calls (`yarn test-linter`, `yarn test-stylelint`, `yarn test-unit`, `yarn test-type`, `yarn test-circular`) -> `pnpm <target>`.
   - `.github/actions/get-affected-packages-paths/get-affected-paths.sh`: `yarn nx` -> `pnpm exec nx`.
   - `.github/workflows/deploy-docs.yml`: `yarn nx run docs:build` -> `pnpm nx run docs:build`.
   - `.github/workflows/release-to-npm.yml`:
     - `yarn set-packages-versions` -> `pnpm set-packages-versions`.
     - Pin `JS-DevTools/npm-publish@v2` to a commit SHA (not floating tag).
     - Audit `NPM_TOKEN` scope before merge: confirm `automation`/`publish` scope limited to `@castore/*` (not legacy `read-write` token). Rotate token in the same PR if older than 6 months.
   - Pin all custom actions in all workflows to commit SHA (follow-up to migration, but practical to do in the same PR while files are being edited).

8. **Documentation:**
   - `README.md` and `CONTRIBUTING.md` - replace `yarn <x>` commands, add link to pnpm install guide.
   - Root `CLAUDE.md` - update *Common commands* and build pipeline section.
   - `docs/docs/1-installation.md` - verify and update if needed.
   - `packages/*/README.md` - **decision:** keep existing `yarn add @castore/...` instructions unchanged because they document downstream consumer install (users can choose any package manager). Alternative: add `pnpm add` and `npm install` variants. Decision: add `pnpm add` + `npm install` variants next to existing `yarn add`; do not remove yarn (we do not choose package manager for downstream users).

**PR 2 exit criteria:**

- Fresh clone + `pnpm install` passes cleanly on a fresh store.
- `pnpm test` (Nx run-many) is green, including `test-stylelint`.
- CI job `test-pr` is green.
- **Lockfile integrity check:** CI job (or documented manual step) runs `pnpm install --frozen-lockfile=false` in an empty container with an empty pnpm store, diffs resulting `pnpm-lock.yaml` against committed version, and fails on differences.
- **Publish parity check:**
  - For each `packages/*`: `pnpm pack --dry-run` (or equivalent) and diff `package.json` in output against latest published npm version.
  - No changes in `dependencies`/`peerDependencies` ranges beyond workspace rewrite.
  - Tarball file list is identical (`npm pack --dry-run` file list diff).
- **Runtime publish smoke test (Babel plugin validation):**
  - Build `@castore/core` tarball via `pnpm package` + `npm pack`.
  - Install in a throwaway pnpm project and run minimal `import` + `require()` test on public exports (`EventStore`, `EventType`, `Command`).
  - Verifies that `addImportExtension` plugin in `commonConfiguration/babel.config.js` produces runtime-resolvable output under pnpm symlinked layout - not only file-listing parity.
- **Canary publish rehearsal:**
  - Before tag release: publish scratch version (for example `0.0.0-pnpm-canary.1`) with `--tag=canary` dist-tag from PR 2 branch, to validate full `release-to-npm.yml` flow including `NPM_TOKEN`, provenance (if enabled), and tag-specific matrix behavior. Local `pnpm publish --dry-run` is **not sufficient**.
- Local `pnpm deploy-docs` (Docusaurus build) passes without regression.
- Baseline cold-install time is recorded on CI before migration (`test-pr` job, without cache); after migration, prove no degradation (target: <= baseline + 10%).

## Successful state (after both PRs)

- Developers run `pnpm install`, `pnpm test`, `pnpm package`, `pnpm nx affected --target=test` - all work.
- CI `test-pr` and canary publish are green. Tag release is validated on next real release.
- No `shamefully-hoist`, empty (or minimal) `public-hoist-pattern`, `strict-peer-dependencies=true` active on main.
- No dual-lockfile period - PR 1 + PR 2 merged within 7 days.
- Every `packages/*/package.json` fully declares runtime and dev deps (validated by strict pnpm + full Nx matrix under pnpm before PR 2 merge).
- External contributors can still `yarn add @castore/...` from npm (downstream install flow unaffected); internal contributors must use pnpm.

## Risks and mitigations

| Risk | Probability | Mitigation |
|---|---|---|
| `release-to-npm.yml` fails on first real tag release after PR 2 merge | Medium | Canary publish rehearsal (`0.0.0-pnpm-canary.1` with canary dist-tag) as part of PR 2 exit criteria - real run with `NPM_TOKEN` and provenance. |
| Babel plugin `addImportExtension` produces output that breaks pnpm symlinked layout at runtime resolution | Low-medium | Runtime publish smoke test (see PR 2 exit criteria) - install tarball in scratch pnpm project and actually `require()`/`import`. File-listing diff alone is not enough. |
| Phantom dependency survives PR 1 and breaks `pnpm nx test-*` after PR 2 merge | Low | PR 1 exit criteria require **full Nx matrix under pnpm** - install-time diagnostics would miss this. |
| Nx cache invalidation across package manager change | Low | Nx cache key does not include lockfile by default; run `nx reset` once in CI after merge if needed. |
| `docs/` workspace (Docusaurus) has different assumptions | Medium | `deploy-docs.yml` tested in PR 2 branch push before merge; Docusaurus is package-manager-agnostic. |
| External contributors with in-progress PRs/forks - merge conflicts beyond `yarn.lock` | Medium | Before PR 2 merge: GitHub Issue with 7-day warning + audit of open PRs, maintainers actively help with rebases. Conflicts include `.yarnrc.yml`, `.yarn/releases/`, all `package.json` files changed in PR 1 and PR 2 - not only `yarn.lock`. |
| Fork contributor runs `yarn install` after PR 2 merge and regenerates `yarn.lock` | Low | `preinstall: "npx only-allow pnpm"` guard fails fast with clear error message. |
| `syncpack@13` rewrites `workspace:*` incorrectly during `postinstall format` | Low | Verified in PR 1 step 5 - if risky, replace `postinstall` `syncpack format` with `syncpack list-mismatches` (non-mutating) or disable until follow-up. |
| Published `package.json` ranges change (pnpm `workspace:*` rewrite to exact pin vs Yarn `^x.y.z`) - silent semver regression for downstream | Medium-low | Publish parity check (see PR 2 exit criteria) - diff tarball `package.json` before/after. If ranges change, block PR 2 and either rewrite `workspace:*` to explicit ranges before publish, or accept in release notes. |
| pnpm 10.x minor upgrade during rollout window changes `.npmrc` defaults | Low | `packageManager` pin is exact (`pnpm@10.x.y+sha256.<hash>`); pinned in PR 2, no floating range. |
| Nx 21 does not detect pnpm packageManager correctly (cache metadata) | Low | Run `nx reset` once after PR 2 merge; add to release notes if needed for all contributors. |

## Open questions (for planning phase)

- ~~Should we set `dedupe-peer-dependents=true` in `.npmrc`?~~ **Resolved:** pnpm 10 default is `true`, no explicit setting needed.
- ~~Should we use `pnpm catalog`?~~ **Resolved (non-goal):** syncpack is sufficient; catalogs add carrying cost without clear benefit.
- ~~Does Nx need explicit `packageManager` change in `nx.json`?~~ **Resolved:** Nx 21 auto-detects; if needed after merge, run `nx reset` as follow-up.
- ~~Should `.github/workflows/sync-readme-sponsors.yml` / `draft-or-update-next-release.yml` be changed?~~ **Resolved:** no yarn invocation, no changes.
- ~~Should `strict-peer-dependencies=true` be gating in PR 2 or deferred?~~ **Resolved:** gating. Deferred version would negate primary driver (2).
- What is the exact publish command in `release-to-npm.yml` today? **Answered by PR 1** (step 4); input to PR 2 step 2.
- Which pnpm 10.x version should we pin (minor.patch)? **Open** - latest stable at PR 2 writing time; document SHA-256 in `packageManager` field.

## Follow-ups (outside scope of this migration)

- Pin `JamesIves/github-sponsors-readme-action@v1.5.0` and review PAT scopes in `sync-readme-sponsors.yml` (not directly related to package manager swap, but a sensible security upgrade during CI touch window).
- Consider npm OIDC "Trusted Publishing" as replacement for long-lived `NPM_TOKEN` - separate security initiative, not in this migration.

## Handoff

Ready for `/compound-engineering:ce-plan` using this document as input. The plan should produce two independently mergeable tech specs:

- **PR 1 tech spec** - audit procedure, side worktree setup script, diagnostic output format, per-package `package.json` change plan, publish mechanism investigation.
- **PR 2 tech spec** - mechanical swap checklist, bulk rewrite scripts (per-package scripts, CI action files), canary publish rehearsal procedure, exit-criteria verification scripts (lockfile integrity, publish parity diff, runtime smoke test).
