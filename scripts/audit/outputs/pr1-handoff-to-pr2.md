# PR 1 → PR 2 Handoff

This PR (PR 1: dep hygiene pass) leaves the repo on Yarn 4.10.2 but
declares every dep that the source/dist/tests import. PR 2 (package-manager
swap) can now swap to pnpm without tripping over phantom deps.

Full audit evidence is committed under `scripts/audit/outputs/` — review those
files before merging PR 2 since the decisions there (allow-list membership,
peer-dep resolution strategy) are scoped to PR 2 Units 6–11.

## Verification performed in PR 1

Side-worktree at `../castore-pnpm-audit`, pnpm 10.33.0, Node 22.19.0:

| Check | Result | Notes |
|---|---|---|
| `pnpm install` (strict-peer-deps=true, no shamefully-hoist) | ✅ 0 `ERR_PNPM_UNDECLARED_DEPENDENCY` | After Unit 3 additions (19 packages, 22 new dep entries). |
| `pnpm -r package` (build all workspaces) | ⚠️ 18/20 green | Remaining 2 are **NOT phantom deps** — see "Known residuals" below. |
| `pnpm -r test-unit` (tests across workspaces) | ⚠️ 20/21 green | Only failure: `docs` (docusaurus build; webpack peer-version issue). |
| `pnpm install` peer-dep surface | ⚠️ 3 unmet peer ranges | All pre-existing version conflicts surfaced by strict mode; PR 2 addresses. |
| `syncpack format` on `workspace:*` | ✅ no rewrite | Keeps PR 2 Unit 10's postinstall chain intact. |
| `yarn install --immutable` + full Nx matrix | ✅ green (one pre-existing flake) | Main-branch compatibility preserved; `docs:test-type` flakes when `test-unit` runs concurrently in the same Nx batch (docusaurus regenerates hashed `docs/build/*.js` mid-compile; `docs/tsconfig.json#include` is `"."`). Nx itself detects this as flaky. Fix (out of scope for PR 1): add `"./build"` to `docs/tsconfig.json#exclude`. |

Raw logs: `/tmp/pnpm-install-final.log`, `/tmp/pnpm-package-v3.log`,
`/tmp/pnpm-test-unit-v3.log`, `/tmp/yarn-nx-verify.log`.

## Inputs PR 2 consumes from this PR

### 1. `only-built-dependencies[]` allow-list for PR 2 `.npmrc`

Starting set (from `postinstall-packages.txt`, verdict ALLOW):

```ini
only-built-dependencies[]=esbuild
only-built-dependencies[]=@parcel/watcher
only-built-dependencies[]=core-js
only-built-dependencies[]=core-js-pure
only-built-dependencies[]=tree-sitter
only-built-dependencies[]=tree-sitter-json
only-built-dependencies[]=@tree-sitter-grammars/tree-sitter-yaml
only-built-dependencies[]=nx
```

`husky` does not need an entry — it is a root workspace devDep invoked by
the root `postinstall` script, which always runs regardless of pnpm's
fail-closed gate. Packages with TBD verdict (`protobufjs`, `es5-ext`,
`ssh2`, `cpu-features`, `serverless`) should start blocked; add entries
one-at-a-time only if PR 2 CI reveals a concrete blocker, each with a
CODEOWNERS-reviewed justification line in `.npmrc`.

### 2. Publish mechanism (PR 2 Unit 12 parity test)

`release-to-npm.yml` uses `JS-DevTools/npm-publish@v2` with
`package: ./packages/X/package.json` (source-dir pack, not `dist/`).
`npm pack` rewrites `workspace:*` → exact version in the shipped
`package.json#dependencies`. `@castore/core: "*"` in adapter
`peerDependencies` survives pack unchanged.

`publish-parity.sh` (PR 2 Unit 12) should diff normalized
`npm pack --dry-run --json` output between Yarn-built tarball (main) and
pnpm-built tarball (PR 2 branch), stripping `version`, `packageManager`,
`gitHead`. Zero-diff is the pass criterion; any `dependencies` range
change is a hard fail.

Full analysis: `publish-mechanism-notes.md`.

### 3. Syncpack verdict

`syncpack format` leaves `workspace:*` untouched. **No change to PR 2
Unit 10's postinstall chain** — keep `"postinstall": "husky && syncpack format"`.
Full test: `syncpack-workspace-protocol-check.md`.

## Known residuals — deferred to PR 2

These are **not phantom deps**. PR 1 deliberately ships them unfixed so PR 2
can handle each in its natural unit.

### Residual A — `packages/lib-dam` TS2742 "non-portable" inference

`src/fixtures.test.ts` imports types via `@castore/demo-blueprint` that
transitively name `@castore/event-type-json-schema` and `json-schema-to-ts`.
Under pnpm's nested symlink layout, tsc's emitted `.d.ts` wants a portable
path — it finds two, and flags both as non-portable. Yarn's hoisting hid
this by placing all types at a single root-level path.

**PR 2 fix path (Unit 12 tsconfig tweak or Unit 7 source annotation):**
- Either add explicit type annotations to `fixtures.test.ts` exports
  (TypeScript-recommended fix), OR
- Set `compilerOptions.preserveSymlinks: false` in `packages/lib-dam/tsconfig.json`
  to let tsc resolve symlinks before naming, OR
- Add `public-hoist-pattern[]=@castore/event-type-json-schema` to `.npmrc`
  (the plan's Open Question flagged this as needing per-entry justification).

### Residual B — `packages/lib-react-visualizer` multi-issue

1. **TS2688 `vitest/globals` type resolution.** Root `tsconfig.json` has
   `types: ["node", "vitest/globals"]`; vitest IS declared as devDep here.
   Under pnpm + this package's `preserveSymlinks: true`, tsc can't reach
   `vitest/globals`. PR 2 fix: drop `preserveSymlinks: true` from this
   package's `tsconfig.json` (it was likely added to address a yarn-era
   symlink quirk that pnpm resolves differently).

2. **Peer-range conflicts with React 19.**
   - `react-json-view@1.21.3` supports only React 15–17.
   - `@reduxjs/toolkit@1.9.7` (in the redux adapter) supports only React 16–18
     and `react-redux 7–8` (current is 9).
   PR 2 options: (a) upgrade to React 18 (repo currently has `react@^19.1.1`
   in devDeps); (b) replace `react-json-view` with a React 19–compatible
   alternative (e.g., `@textea/json-viewer`); (c) add `.npmrc`
   `peer-dependency-rules.allowedVersions` overrides for these two.

### Residual C — `docs` unmet peer + docusaurus webpack error

1. `search-insights` peer dep missing (transitive via
   `@docusaurus/theme-search-algolia → @docsearch/react`). PR 2 fix: add
   `search-insights: ">=1.0.0 <3.0.0-0"` to `docs/package.json` devDeps.
2. `docusaurus build` fails with `ProgressPlugin` ValidationError — webpack
   peer-version mismatch under pnpm's strict graph. Diagnostics pending; may
   resolve automatically once `search-insights` is pinned and pnpm re-resolves.

### Residual D — `packages/event-storage-adapter-redux` peer conflict

`@reduxjs/toolkit@1.9.7` requires `react@"^16||^17||^18"` + `react-redux@"^7||^8"`.
The repo has React 19 / react-redux 9. Same handling as Residual B (upgrade
toolkit, downgrade react, or use `peer-dependency-rules.allowedVersions`).

## Notable phantom deps found (applied in Unit 3)

- `@babel/runtime` → 18 packages (all adapters + libs + commands; `core` and
  `demo/blueprint` already had it). Added to `dependencies`. This is the
  highest-consequence fix — every published tarball was shipping helpers
  imports that would resolve only by consumer-side hoisting.
- `@castore/event-type-json-schema`, `json-schema-to-ts` → `lib-dam` devDeps
  (type-leakage through demo-blueprint re-exports).
- `ts-toolbelt` → `lib-test-tools`, `message-bus-adapter-in-memory` devDeps.
- `@types/react`, `@types/react-dom` → `lib-react-visualizer` devDeps.
- `vitest` → `demo/blueprint` devDeps (root tsconfig types inheritance).

Full list with evidence: `phantom-deps.txt`.
