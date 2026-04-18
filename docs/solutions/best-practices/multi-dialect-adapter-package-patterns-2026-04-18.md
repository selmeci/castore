---
title: "Patterns for multi-dialect Castore adapter packages (Drizzle per-dialect callbacks, phantom contracts, conformance factory, falsy-payload hazard)"
date: 2026-04-18
category: best-practices
module: event-storage-adapter-drizzle
problem_type: best_practice
component: database
severity: medium
applies_when:
  - "Building a new Castore EventStorageAdapter that targets multiple SQL dialects via Drizzle ORM"
  - "Structuring test suites for a package with per-dialect variants sharing one behavioral contract"
  - "Exporting per-dialect contract types from a single package root without cross-contaminating type graphs"
  - "Auditing event-storage adapters for nullable JSON payload handling"
tags:
  - drizzle-orm
  - castore-adapter
  - multi-dialect
  - test-factory
  - phantom-types
  - type-only-export
  - json-payload
  - event-sourcing
---

# Patterns for multi-dialect Castore adapter packages

## Context

Building `@castore/event-storage-adapter-drizzle` surfaced four reusable patterns that apply to any future Castore adapter (or similar library) that implements one interface across multiple database dialects. This note captures them together because the alternative — three separate half-page docs — would obscure the fact that they compose: each pattern assumes the others are already in place.

## Guidance

### 1. Generic index-callback factory for per-dialect Drizzle tables

Drizzle's table factories (`pgTable`, `mysqlTable`, `sqliteTable`) accept an optional third-argument callback that defines indexes and constraints. The callback's parameter type **differs per dialect** in Drizzle 0.45:

- `pgTable` passes `BuildExtraConfigColumns<TColumns>` — `Partial<ExtraConfigColumn>` entries.
- `mysqlTable` / `sqliteTable` pass `BuildColumns<...>` — concrete `MySqlColumn` / `SQLiteColumn` objects.

A `eventTableConstraints` helper that pins its parameter to any one dialect's concrete type fails on the other two. A helper that pins to the pre-factory builder type fails when Drizzle invokes it internally with built columns. The solution is a generic structural constraint that accepts any column-like shape:

```typescript
// src/pg/schema.ts
type PgIndexable = Partial<ExtraConfigColumn> | SQL;

export const eventTableConstraints = <
  TTable extends {
    aggregateName: PgIndexable;
    aggregateId: PgIndexable;
    version: PgIndexable;
  },
>(
  table: TTable,
): [IndexBuilder] => [
  uniqueIndex('event_aggregate_version_uq').on(
    table.aggregateName,
    table.aggregateId,
    table.version,
  ),
];
```

The `TTable extends { ... }` form satisfies both user-spread builder maps (pre-factory) and Drizzle's internal callback invocation (post-build). The pattern is the same per dialect — swap `PgIndexable` for `MySqlColumn | SQL` (mysql) or `SQLiteColumn | SQL` (sqlite).

### 2. Phantom type parameter on per-dialect contract types

Each dialect defines a contract type used to constrain the adapter constructor's `eventTable` argument. The structural shapes are nearly identical (dialect table + seven required columns); without disambiguation, TypeScript merges them and a MySQL table silently satisfies the pg contract.

Fix — attach a phantom `Dialect` parameter with a default that makes the types nominally distinct:

```typescript
// src/pg/contract.ts
export type PgEventTableContract<Dialect extends 'pg' = 'pg'> =
  PgTable & RequiredPgColumns & { readonly __dialect?: Dialect };

// src/mysql/contract.ts
export type MysqlEventTableContract<Dialect extends 'mysql' = 'mysql'> =
  MySqlTable & RequiredMysqlColumns & { readonly __dialect?: Dialect };

// src/index.ts — type-only re-export
export type { PgEventTableContract } from './pg/contract';
export type { MysqlEventTableContract } from './mysql/contract';
export type { SqliteEventTableContract } from './sqlite/contract';
```

`__dialect?: Dialect` is never set at runtime — its sole purpose is type identity. The `export type` keyword is critical: a value re-export would drag all three dialect type graphs into every consumer bundle, defeating the tree-shaking goal. Each sub-entrypoint (`/pg`, `/mysql`, `/sqlite`) imports only from its own `drizzle-orm/{pg,mysql,sqlite}-core`, so the root `.` bundle stays free of sibling-dialect types.

Caveat — the phantom property is optional (`__dialect?`), so a pg table can still be assigned to `MysqlEventTableContract` at the structural level (both accept `undefined`). If true cross-dialect rejection is required, brand with a non-optional `unique symbol`. For this adapter, the optional phantom is enough because the adapter constructor constrains the table against the dialect-specific contract — accidental cross-wiring fails at the call site.

### 3. Shared conformance test factory

When three adapter classes must satisfy one behavioral contract, a shared factory is dramatically cheaper than copy-paste. The Drizzle adapter pulled 14 dialect-agnostic scenarios into a single file; per-dialect test files now run ~200 lines each (vs. the 638-line pg-only postgres adapter test that preceded it).

The factory signature separates **container lifecycle** (per-file) from **per-test reset**:

```typescript
// src/__tests__/conformance.ts
export type ConformanceSetupResult<A extends EventStorageAdapter> = {
  adapterA: A;
  adapterB: A;
  reset: () => Promise<void>;
};

export const makeAdapterConformanceSuite = <A extends EventStorageAdapter>(
  config: {
    dialectName: string;
    adapterClass: abstract new (...args: any[]) => A;
    setup: () => Promise<ConformanceSetupResult<A>>;
    teardown: () => Promise<void>;
  },
): void => {
  describe(`drizzle ${config.dialectName} conformance`, () => {
    let ctx: ConformanceSetupResult<A>;
    beforeAll(async () => { ctx = await config.setup(); }, 100_000);
    beforeEach(async () => { await ctx.reset(); });
    afterAll(async () => { await config.teardown(); });
    // ... 14 shared scenarios
  });
};
```

Each per-dialect test file owns the testcontainer at **file scope** (not inside the factory's setup/teardown):

```typescript
// src/pg/adapter.unit.test.ts
let container: StartedPostgreSqlContainer;
let db: PgDatabase<...>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:15.3-alpine').start();
  db = drizzle(postgres(container.getConnectionUri()));
}, 120_000);

afterAll(async () => { await container.stop(); });

makeAdapterConformanceSuite({
  dialectName: 'pg',
  adapterClass: DrizzlePgEventStorageAdapter,
  setup: async () => ({
    adapterA: new DrizzlePgEventStorageAdapter({ db, eventTable }),
    adapterB: new DrizzlePgEventStorageAdapter({ db, eventTable }),
    reset: async () => { /* drop+recreate the event table */ },
  }),
  teardown: async () => {},
});

// Sibling describes can reuse the file-scope container.
describe('pg extended-table', () => { /* ... */ });
describe('pg node-postgres driver smoke', () => { /* ... */ });
```

This split is load-bearing: the factory's `afterAll` runs before the file's `afterAll`, so if the factory tore down the container, the sibling `describe` blocks (extended-table, driver smoke) would have nothing to connect to. Keep the container at file scope; keep the factory concerned only with adapter lifecycle and per-test reset.

### 4. Falsy JSON payload deletion hazard — inherited from the existing postgres adapter

When mapping a DB row to `EventDetail`, adapters typically drop the `payload` / `metadata` fields when the database stored SQL NULL — the Castore `EventDetail` type expects the field to be absent, not `null`. The existing `@castore/event-storage-adapter-postgres` uses this pattern:

```typescript
if (!eventDetail.payload) {
  delete eventDetail.payload;
}
```

`!` is the wrong check. It fires for `null` and `undefined` (correct) but also for `false`, `0`, and `''` (wrong — those are legal JSON payloads). An event written with `payload: false` reads back with `payload` absent. The database row is correct; the in-memory reconstitution is not. Every subsequent `getAggregate()` replay sees a different event shape than what was written — silent, permanent data corruption of aggregate state.

The correct pattern is explicit `null`/`undefined` equality:

```typescript
if (eventDetail.payload === null || eventDetail.payload === undefined) {
  delete eventDetail.payload;
}
if (eventDetail.metadata === null || eventDetail.metadata === undefined) {
  delete eventDetail.metadata;
}
```

The Drizzle adapter applies this fix across all three dialects (`src/pg/adapter.ts`, `src/mysql/adapter.ts`, `src/sqlite/adapter.ts`) and the shared conformance factory includes a round-trip test for `payload: false`, `payload: 0`, `payload: ''` to lock the fix in. **The original postgres adapter still carries the bug** — it was flagged as out of scope for the Drizzle PR but should be fixed in a follow-up.

## Why This Matters

Each pattern prevents a specific class of silent failure:

- **Generic callback factory** — without it, adding a new dialect (or a 4th/5th in the future) requires a bespoke `eventTableConstraints` per dialect, and the compile-time type is tighter than necessary on each.
- **Phantom type parameter** — without it, a pg-configured table can be passed to the mysql adapter constructor with no type error; the first query throws a cryptic dialect-mismatch error from the driver.
- **Conformance factory** — without it, scenario authorship for `N` dialects is `O(N)` and drift between per-dialect implementations is inevitable.
- **Falsy payload fix** — without it, any aggregate with a falsy-JSON event in its history reconstitutes to an incorrect state forever (event logs are immutable; the bug compounds).

## When to Apply

- Any new Castore `EventStorageAdapter` targeting multiple SQL dialects through a single package.
- Any Drizzle-based package that exposes a `*TableConstraints` helper for user-extended schemas.
- Any TypeScript package re-exporting structurally-similar types from different sub-modules at a shared root where nominal distinction matters.
- During code review or migration of any event-storage adapter that reads nullable JSON payloads — the `if (!payload)` pattern is the trigger to watch for.

## Examples

**Generic callback factory** — see [`src/pg/schema.ts`](../../../packages/event-storage-adapter-drizzle/src/pg/schema.ts), [`src/mysql/schema.ts`](../../../packages/event-storage-adapter-drizzle/src/mysql/schema.ts), [`src/sqlite/schema.ts`](../../../packages/event-storage-adapter-drizzle/src/sqlite/schema.ts).

**Phantom contracts** — see [`src/pg/contract.ts`](../../../packages/event-storage-adapter-drizzle/src/pg/contract.ts) and the type-only re-export in [`src/index.ts`](../../../packages/event-storage-adapter-drizzle/src/index.ts).

**Conformance factory** — see [`src/__tests__/conformance.ts`](../../../packages/event-storage-adapter-drizzle/src/__tests__/conformance.ts); per-dialect wiring in each adapter's `adapter.unit.test.ts`.

**Falsy-payload fix** — see `toEventDetail` in each of [`src/pg/adapter.ts`](../../../packages/event-storage-adapter-drizzle/src/pg/adapter.ts), [`src/mysql/adapter.ts`](../../../packages/event-storage-adapter-drizzle/src/mysql/adapter.ts), [`src/sqlite/adapter.ts`](../../../packages/event-storage-adapter-drizzle/src/sqlite/adapter.ts). The bug still lives in [`packages/event-storage-adapter-postgres/src/adapter.ts`](../../../packages/event-storage-adapter-postgres/src/adapter.ts) lines ~178-183 pending a follow-up.

## Related

- Integration hazards that prompted some of these patterns: [`docs/solutions/integration-issues/drizzle-orm-api-gaps-multi-dialect-adapter-2026-04-18.md`](../integration-issues/drizzle-orm-api-gaps-multi-dialect-adapter-2026-04-18.md)
- Toolchain constraints for this package: [`docs/solutions/developer-experience/pnpm10-eslint9-native-deps-allow-list-2026-04-18.md`](../developer-experience/pnpm10-eslint9-native-deps-allow-list-2026-04-18.md)
- Plan: [specs/plans/2026-04-17-002-feat-event-storage-adapter-drizzle-plan.md](../../../specs/plans/2026-04-17-002-feat-event-storage-adapter-drizzle-plan.md)
- PR #4: https://github.com/selmeci/castore/pull/4
