# publish-mechanism-notes.md

Audit of how `@castore/*` packages currently reach npm, and the parity
surface area that PR 2's package-manager swap must preserve.

## Current flow (Yarn-era, on `main`)

`release-to-npm.yml` is triggered `on: release: published` with `ref: main`.
For each workspace package, it invokes `JS-DevTools/npm-publish@v2` with
`package: ./packages/<name>/package.json` pointing at the **source**
directory (not `dist/`).

The action internally runs `npm pack` in that directory and uploads the
resulting tarball. This has three implications for the pnpm migration:

1. **Workspace-protocol rewrite happens at pack time.** `npm pack` (invoked
   by the action, which shells out to npm directly) rewrites
   `"@castore/core": "workspace:*"` into an exact version like
   `"@castore/core": "1.23.4"` in the tarball's `package.json`. Yarn 4
   does the same under `workspace:`. Verify in publish-parity script (Unit 12
   of PR 2): the only allowed diff between Yarn-built and pnpm-built
   tarballs' `package.json` should be the absence of dev-only fields — no
   range-format change in `dependencies`.

2. **Published layout depends on the `files` field + `package.json#exports`,
   not on `dist/` shape.** Because the action packs from the *source*
   directory, the pre-publish `nx run <pkg>:package` step must have already
   emitted `dist/cjs`, `dist/esm`, and `dist/types` into the package
   directory. Under pnpm, the `dist/` paths are identical — this confirmed
   green in the side-worktree build pass (see `/tmp/pnpm-package.log`,
   15 packages built successfully; the 5 failures are phantom-dep issues,
   not pack-mechanism issues).

3. **`cp README.md ./packages/core/README.md` step runs before publish.**
   This is a copy from the repo root README into `packages/core`. Same path
   works under pnpm — no lockfile layout dependency.

## Action version pin

`JS-DevTools/npm-publish@v2` — **not SHA-pinned** currently. The plan
defers bulk SHA pinning to a follow-up hardening PR, but `@v2` auto-tracks
any release in the v2 series. Release notes for all v2 tags confirm the
pack step is plain `npm pack` — no npm-specific lockfile interaction — so
it works under pnpm-managed workspaces the same as yarn-managed.

## PR 2 swap implications

- `pnpm publish` command is available as an alternative, but we **do not
  change** `release-to-npm.yml` to use it. Keeping `JS-DevTools/npm-publish`
  preserves the per-package matrix strategy and the existing retry /
  provenance semantics.
- The critical invariant to protect in PR 2 Unit 12's `publish-parity.sh`:
  diffing the normalized tarball listing between `main` (Yarn-built) and
  `PR 2` (pnpm-built) must show zero diffs in `files` listing and zero
  diffs in `dependencies` / `peerDependencies` version ranges. `version`,
  `packageManager`, and `"gitHead"` fields are expected to differ and
  should be stripped before diff.
- `scripts/setPackagesVersions.ts` is invoked via `yarn set-packages-versions`
  today; PR 2 Unit 11 swaps to `pnpm set-packages-versions`. The script
  itself is PM-agnostic (uses `fs` + `path` only).

## Risks flagged for PR 2

- **Peer ranges in published tarball.** `@castore/core: "*"` in adapter
  `peerDependencies` is intentionally kept as wildcard, per Key Technical
  Decision in the plan. Confirmed this survives pack rewrite — syncpack
  does not touch peer ranges, and npm pack only rewrites `workspace:*`
  specifiers (in `dependencies` / `devDependencies`), not `*`.
- **Nested `node_modules` in the source-dir pack.** `npm pack` includes
  anything not excluded by `files` field or `.npmignore`. pnpm creates
  `packages/*/node_modules/` with symlinks — if `files` field is too
  permissive, these could leak into tarballs. All 19 castore packages
  declare `"files": ["dist"]` (verified by `jq` across
  `packages/*/package.json`). README.md is auto-included by npm-pack
  regardless of `files`. → No risk of node_modules leakage.
