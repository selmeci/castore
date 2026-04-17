# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language

All documents, comments, commit messages, PR descriptions, plans, and written communication in this repository must be in **English**. This applies regardless of the language the user communicates in.

## Specification documents

Requirements, brainstorms, and implementation plans live under `specs/` — always, not `brainstorms/` or `docs/plans/` (these older locations are deprecated). Use this layout:

- `specs/requirements/<YYYY-MM-DD>-<slug>-requirements.md` — brainstorms, problem framings, requirements.
- `specs/plans/<YYYY-MM-DD>-<NNN>-<slug>-plan.md` — implementation plans derived from a requirements doc.

Plans reference their originating requirements doc via an `origin:` frontmatter field and a Sources & References link. When creating or moving either kind, keep both references in sync.

## Git remote policy (internal fork)

This checkout is an internal fork takeover. `origin` points to `selmeci/castore` (the fork we own); `upstream` points to `castore-dev/castore` (the original, do NOT target it). All work stays within the fork:

- Push branches to `origin` only.
- Open PRs against `selmeci/castore`, not `castore-dev/castore`. `gh pr create` defaults to the upstream parent when `origin` is a fork — always pass `--repo selmeci/castore` explicitly.
- Never push to `upstream`, never open issues/PRs against it, never run `gh` commands that target it without explicit instruction.

## Repository layout

Castore is a pnpm + Nx monorepo of TypeScript packages for event sourcing. Workspaces live in `packages/*`, `demo/*`, and `docs` (declared in `pnpm-workspace.yaml`). Node `^22.19.0` and pnpm `10.33.0` are required — enforced at install time via `packageManager` + the `preinstall: only-allow pnpm` guard. The repo is ESM-first (`"type": "module"` at the root).

- `packages/core` — the event-sourcing primitives (`EventStore`, `EventType`, `Command`, `ConnectedEventStore`, messaging channels/bus/queue). Everything else is an adapter or extension.
- `packages/event-storage-adapter-*` — persistence backends for an `EventStorageAdapter` (DynamoDB, Postgres, HTTP, in-memory, Redux).
- `packages/message-bus-adapter-*`, `packages/message-queue-adapter-*` — transport adapters for the messaging side (EventBridge, SQS, in-memory, and their `-s3` large-payload variants).
- `packages/event-type-*`, `packages/command-*` — validation integrations (Zod, JSON Schema).
- `packages/lib-*` — side libraries (`lib-dam` data-access/migration utils, `lib-react-visualizer` UI, `lib-test-tools`).
- `demo/{blueprint,implementation,visualization}` — runnable demos that exercise the packages end-to-end.
- `docs` — Docusaurus site under `docs/docs/` (installation, event sourcing concepts, reacting-to-events, migration guides).
- `commonConfiguration/{babel.config.js,vite.config.js}` — shared build/test configs consumed by every package.
- `scripts/setPackagesVersions.ts` — release helper invoked via `pnpm set-packages-versions`.

## Common commands

Root-level (run from repo root; Nx caches and fans out across workspaces):

- `pnpm package` — build every package (rm -rf dist, then CJS + ESM + types). Run before any script that depends on another package's `dist/`.
- `pnpm test` — runs each package's `test` target (which chains type + unit + circular + linter).
- `pnpm test-unit` / `pnpm test-type` / `pnpm test-linter` — run just that dimension across all packages.
- `pnpm test-affected` — Nx affected graph against `main` (the default base, see `nx.json`).
- `pnpm test-circular` — repo-wide dependency-cruiser check using `.dependency-cruiser.js`.
- `pnpm watch` — parallel watch mode across all packages (rebuilds CJS/ESM/types on change).
- `pnpm graph` — open the Nx dep graph.

Per-package (run from inside `packages/<name>` with `pnpm`, or target via Nx, e.g. `pnpm nx run core:test-unit`):

- `pnpm package` — build just that package. Sub-targets: `package-cjs`, `package-esm`, `package-types`.
- `pnpm test-unit` — `vitest run --passWithNoTests`. Run a single file with `pnpm vitest run path/to/file.unit.test.ts`, a single test with `-t "name"`, and watch with `pnpm vitest` (no `run`).
- `pnpm test-type` — `tsc --noEmit` using the package's `tsconfig.json`.
- `pnpm test-linter` — `eslint .`. Use `pnpm lint-fix <path>` or `pnpm lint-fix-all` to autofix.
- `pnpm test-circular` — dependency-cruiser for just this package.

Commits are linted by commitlint (conventional commits) via a Husky hook installed by `postinstall`. Don't pass `--no-verify`. PR titles are validated by the same conventional-commits rules in CI (`amannn/action-semantic-pull-request`). Both commit messages and PR titles must use the same format:

```
type(scope): lowercase description
```

Allowed types: `feat`, `fix`, `build`, `chore`, `ci`, `docs`, `style`, `refactor`, `perf`, `test`, `revert`. The subject must start lowercase. Scope is optional but encouraged (typically a package name like `core`, `pnpm`, `docs`). Do **not** use types from other presets (e.g. `feature`, `update`, `new` from the beemo preset) — they will pass locally but fail CI, or vice-versa.

`.npmrc` at the root sets `strict-peer-dependencies=true`, `auto-install-peers=false`, and a fail-closed `only-built-dependencies[]` allow-list. Any new package with an install/postinstall script must be added explicitly to that list (with justification) or it will be blocked.

## Build pipeline (important when touching configs)

Each package emits three artifacts under `dist/` consumed via conditional `exports` in `package.json`:

1. `dist/cjs/*.cjs` — Babel with `NODE_ENV=cjs` → `@babel/preset-env` `modules: 'cjs'`.
2. `dist/esm/*.mjs` — Babel with `NODE_ENV=esm` → `@babel/preset-env` `modules: false`.
3. `dist/types/*.d.ts` — `tsc -p tsconfig.build.json` then `tsc-alias` to rewrite `~/*` path aliases.

The shared `commonConfiguration/babel.config.js` uses a custom `addImportExtension` plugin that rewrites extensionless relative imports to end in `.cjs` or `.mjs` depending on the build env. Keep source imports extensionless in `.ts` files — the plugin adds the correct extension per build. Directory imports must resolve to an `index.{ts,tsx,js}`; otherwise the plugin falls back to appending an extension.

Tests run through Vitest using `commonConfiguration/vite.config.js`'s `testConfig`, which only picks up `*.unit.test.{ts,tsx,...}`. Type-only tests use the `*.type.test.ts` suffix and are checked by `tsc` in `test-type`, not executed — they rely on `expectTypeOf` / conditional types. Do not rename these patterns without updating both configs.

## Package conventions

- Public surface is re-exported from each package's `src/index.ts`. The root ESLint config forbids importing from internal module paths (`@castore/*/*`) — consumers must import from the package root, and you must re-export anything you want to expose.
- Relative imports from `'.'` are also banned — always use an explicit file path (e.g. `from './eventStore'`).
- `lodash` and `aws-sdk` must be imported from subpaths (`lodash/get`, `aws-sdk/clients/...`) for tree-shaking.
- Source files (not tests) may only depend on `dependencies` and `peerDependencies`; test files may also use `devDependencies`. Moving a dep in `package.json` changes which files can import it.
- ESLint enforces `max-lines: 200`, `complexity: 8`, `max-depth: 3`, `max-params: 4`, `prefer-arrow`, exhaustiveness checks, and `strict-boolean-expressions`. When a file grows past these, split it rather than disabling the rule.
- TypeScript config is strict with `noUncheckedIndexedAccess` and `noImplicitReturns`. The path alias `~/*` maps to the package `src/` via Babel + `tsc-alias` — prefer `~/foo` only where the shared config already uses it.

## Core architecture (packages/core)

The `EventStore` class (`src/eventStore/eventStore.ts`) is the central abstraction. It combines:

- `eventStoreId` + `eventTypes` (array of `EventType` instances defining the shape of each event).
- A `reduce` function producing an `Aggregate` from events (pure, no I/O).
- An optional `EventStorageAdapter` (from an `event-storage-adapter-*` package) — all persistence is delegated to the adapter; `EventStore` never touches a DB directly.
- An optional `onEventPushed` hook and `requestContext` (used by `ConnectedEventStore`).

`ConnectedEventStore` (`src/connectedEventStore/`) wraps an `EventStore` and bridges it to the messaging layer: after a successful `pushEvent`, it publishes to the configured `MessageChannel` implementations (`bus`, `queue`, `channel` under `src/messaging/`). Three message shapes are supported — `NotificationMessage`, `StateCarryingMessage`, `AggregateExistsMessage` — each with matching bus/queue/channel variants.

`Command` (`src/command/command.ts`) models a use case: it declares the event stores it reads from, an input/output schema, and a `handler` that emits events via `pushEvent` / `groupEvent`. `GroupedEvent` (`src/event/groupedEvent.ts`) lets a command atomically push events across multiple stores when the storage adapter supports it.

When adding a new adapter package, implement the relevant interface from core (`EventStorageAdapter` from `src/eventStorageAdapter.ts`, or `MessageChannelAdapter` from `src/messaging/`) and re-export a constructor from `src/index.ts`. Adapter packages should declare `@castore/core` as a `peerDependency`, not a `dependency`.
