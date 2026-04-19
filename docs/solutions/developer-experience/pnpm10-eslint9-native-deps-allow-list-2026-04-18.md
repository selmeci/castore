---
title: "pnpm 10 fail-closed native builds + ESLint 9 flat-config no-restricted-imports sub-path carve-outs"
date: 2026-04-18
category: developer-experience
module: event-storage-adapter-drizzle
problem_type: developer_experience
component: tooling
severity: medium
applies_when:
  - "Adding a workspace package that depends on a native (postinstall/node-gyp) npm package under pnpm 10"
  - "Adding an ESLint v9 flat-config rule that must allow-list specific sub-paths of a broadly-restricted import pattern"
tags:
  - pnpm
  - pnpm-10
  - eslint
  - eslint-v9
  - flat-config
  - native-deps
  - better-sqlite3
  - no-restricted-imports
---

# pnpm 10 fail-closed native builds + ESLint 9 flat-config no-restricted-imports sub-path carve-outs

## Context

Two orthogonal tooling gotchas hit the same workstream when the Drizzle event-storage adapter was added: one silently skipped a native postinstall, the other silently dropped an ESLint allow-list. Both surface as "the install/lint passed, but the code doesn't work" — the failure mode costs hours to isolate without prior knowledge of the toolchain's behavior change.

This note documents both together because they are the kinds of pitfalls any new package hitting this repo's toolchain will trip on.

## Guidance

### pnpm 10 `only-built-dependencies[]` is fail-closed

The project's root `.npmrc` opts into pnpm 10's strict supply-chain posture: packages with `install` / `postinstall` lifecycle scripts do **not** run those scripts unless explicitly allow-listed in `only-built-dependencies[]`. pnpm does not warn when a postinstall is skipped — `pnpm install` exits `0` whether or not the native build ran.

When `better-sqlite3` (which ships native `node-gyp`-compiled bindings) is added as a dev dependency without an allow-list entry, `pnpm install` appears clean but `import Database from 'better-sqlite3'` throws at runtime:

```text
Error: Could not locate the bindings file.
  Tried:
    .../better-sqlite3/build/Release/better_sqlite3.node
    ...
```

Fix — add to the root `.npmrc` with an inline justification matching the existing entries' style:

```ini
# better-sqlite3: native postinstall builds the SQLite binary. Required by
# the sqlite drizzle adapter's unit tests (drizzle-orm/better-sqlite3 driver).
only-built-dependencies[]=better-sqlite3
```

The justification comment is load-bearing — the project's CLAUDE.md explicitly requires it for every `only-built-dependencies[]` entry so future audit passes don't silently remove entries they can't justify.

### ESLint v9 flat-config `no-restricted-imports` drops the `allow` key

In classic ESLint config (`.eslintrc.json` + `eslint-plugin-import`), `no-restricted-imports` group patterns accepted an `allow` array for per-path exceptions. In **flat-config** (ESLint v9+), the built-in `no-restricted-imports` rule's `patterns[]` accepts only `regex`, `group`, `message`, `importNames`. The `allow` key is not a valid property — ESLint 9.39 reports `Unexpected property "allow"`.

The repo's root ESLint config bans all `@castore/*/*` imports to enforce public-API discipline (consumers must import from package roots). The new Drizzle adapter intentionally exposes three sub-path exports (`/pg`, `/mysql`, `/sqlite`) in its `exports` map; those sub-paths need to be allow-listed without weakening the general ban.

Fix — use `regex` with a negative lookahead that excludes the three declared sub-paths:

```js
// eslint.config.js — both the JS-scope and TS-scope blocks
'no-restricted-imports': [
  'error',
  {
    patterns: [
      {
        // Match `@castore/<pkg>/<anything>` but NOT the three declared
        // per-dialect sub-path exports of event-storage-adapter-drizzle.
        regex:
          '^@castore/(?!event-storage-adapter-drizzle/(?:pg|mysql|sqlite)$)[^/]+/.+',
        message:
          'import of internal modules must be done at the root level.',
      },
    ],
    paths: [
      /* existing lodash / aws-sdk / '.' restrictions unchanged */
    ],
  },
],
```

The `$` anchor after `(?:pg|mysql|sqlite)` preserves the ban on any deeper path under those sub-entrypoints (`@castore/event-storage-adapter-drizzle/pg/internal` is still forbidden).

Verify the fix with a cross-package probe — intra-package relative imports don't trigger `no-restricted-imports`, so only a cross-package test confirms the regex actually allows the three paths. After verifying, delete the probe file.

## Why This Matters

Both silent failures produce runtime or review-time surprises far from the config change that caused them. The pnpm native-build skip surfaces as a cryptic "Could not locate the bindings file" with zero mention of pnpm; every new collaborator who clones the repo and runs `pnpm install` without the allow-list entry will hit it. The ESLint `allow`-is-silent failure is worse — if the developer copies a classic-config rule into flat-config and doesn't test against a cross-package import, they'll see lint errors on legitimate sub-path imports and suspect the package's `exports` map rather than the ESLint rule.

Both behaviors are deliberate on the toolchain's part (fail-closed supply chain; strict rule surface) but neither is obvious from their docs. Capturing them here means the second Drizzle-like package with native deps or sub-path exports lands in minutes, not hours.

## When to Apply

- Any workspace package added to this repo that ships native code (`better-sqlite3`, `argon2`, `bcrypt`, `canvas`, `sharp`, etc.).
- Any ESLint config change migrating from classic to flat config, or adding a new sub-path carve-out to the existing `@castore/*/*` rule.
- When a `pnpm install` exits `0` but a runtime import immediately fails with "bindings not found" or similar native-load errors.
- When `eslint.config.js` type-checking or ESLint itself flags `Unexpected property "allow"`.

## Examples

From [`.npmrc`](../../../.npmrc):

```ini
only-built-dependencies[]=esbuild
only-built-dependencies[]=@parcel/watcher
only-built-dependencies[]=core-js
only-built-dependencies[]=core-js-pure
only-built-dependencies[]=tree-sitter
only-built-dependencies[]=tree-sitter-json
only-built-dependencies[]=@tree-sitter-grammars/tree-sitter-yaml
only-built-dependencies[]=nx

# better-sqlite3: native postinstall builds the SQLite binary. Required by
# the sqlite drizzle adapter's unit tests (drizzle-orm/better-sqlite3 driver).
only-built-dependencies[]=better-sqlite3
```

From [`eslint.config.js`](../../../eslint.config.js) lines 82-112 (both JS-scope and TS-scope blocks use the same pattern):

```js
{
  regex:
    '^@castore/(?!event-storage-adapter-drizzle/(?:pg|mysql|sqlite)$)[^/]+/.+',
  message: 'import of internal modules must be done at the root level.',
},
```

## Related

- Plan: [specs/plans/2026-04-17-002-feat-event-storage-adapter-drizzle-plan.md](../../../specs/plans/2026-04-17-002-feat-event-storage-adapter-drizzle-plan.md) — Unit 1 covers the ESLint carve-out upfront; the `.npmrc` entry landed in Unit 6 when better-sqlite3 was first exercised by tests.
- Predecessor plan: [specs/plans/2026-04-17-001-refactor-yarn-to-pnpm-migration-plan.md](../../../specs/plans/2026-04-17-001-refactor-yarn-to-pnpm-migration-plan.md) — the pnpm 10 migration that established the `only-built-dependencies[]` policy.
- PR #4: https://github.com/selmeci/castore/pull/4
