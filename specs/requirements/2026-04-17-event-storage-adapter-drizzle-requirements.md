---
date: 2026-04-17
topic: event-storage-adapter-drizzle
---

# Drizzle-based Event Storage Adapter

## Problem Frame

Castore currently ships one SQL event-storage adapter: `@castore/event-storage-adapter-postgres`. It is tied to the `postgres` npm client and owns its own DDL via a `createEventTable` static, which locks consumers to PostgreSQL and to the adapter's connection/client choice.

Teams that already run on MySQL, SQLite/Turso/D1, or that use Drizzle ORM elsewhere in their stack cannot use Castore's SQL story without forking or writing a bespoke adapter. This is the main friction point when proposing Castore for a project that isn't already on Postgres.

The proposal is a new package, `@castore/event-storage-adapter-drizzle`, that accepts a pre-initialized Drizzle DB instance and implements `EventStorageAdapter` against a locked schema exported by the package, targeting all three Drizzle dialects (PostgreSQL, MySQL, SQLite). This unlocks a wider DB matrix in a single adapter while keeping the Castore side of the API small and type-safe.

The primary audience is TypeScript teams that already use Drizzle ORM in their stack. Teams on other ORMs (Prisma, TypeORM, raw query clients) are explicitly out of scope for this adapter — serving them would need a different package entirely (see Alternatives Considered).

## Requirements

**Package & public API**
- R1. Publish a new workspace package `@castore/event-storage-adapter-drizzle` under `packages/`, following the same build, test, ESLint, and ESM-first conventions as the other event-storage adapters.
- R2. Expose an adapter class (or per-dialect classes — see R6) that implements the full `EventStorageAdapter` interface from `@castore/core` (`getEvents`, `pushEvent`, `pushEventGroup`, `groupEvent`, `listAggregateIds`). The exact class/entrypoint split is resolved by the module-layout decision in R6 and the Outstanding Questions; it must not force a single class with runtime dialect dispatch that defeats R6's tree-shaking goal.
- R3. The adapter constructor accepts a pre-initialized Drizzle DB instance (per dialect) plus a Drizzle table that satisfies the package's event-column contract (see R8). The table may be the pre-built `eventTable` exported by the package, or a user-defined table that spreads `eventColumns` and adds its own columns. The caller owns connection lifecycle; the adapter does not open, close, or pool connections.
- R4. `@castore/core` is a `peerDependency`. `drizzle-orm` is a `peerDependency`. Underlying DB drivers (e.g. `pg`, `postgres`, `mysql2`, `better-sqlite3`, `@libsql/client`) are NOT declared by this package in any form — they are the caller's concern, already bound inside the Drizzle DB instance they pass in.

**Dialect coverage**
- R5. Ship first-class support for all three Drizzle dialects at v1: PostgreSQL, MySQL, and SQLite. "First-class" is firm — no dialect ships as "experimental" in v1. If a Drizzle feature needed by the adapter is missing on a given dialect (notably `RETURNING`, upsert semantics, or interactive transactions), the adapter implements a documented dialect-local fallback (e.g. re-select by unique key) that preserves the observable `EventStorageAdapter` contract.
- R6. Expose per-dialect sub-entrypoints so users only load the dialect they use (exact import shape is a planning detail; the observable requirement is that importing one dialect does not force-load Drizzle code for the others).
- R7. Behavior across dialects must be observably equivalent for the `EventStorageAdapter` contract: same returned shapes, same ordering guarantees for `getEvents` and `listAggregateIds`, same error on version conflicts. "Observably equivalent" is defined at the level of parsed JavaScript values returned by the adapter — byte-level equality of stored JSON is NOT guaranteed (MySQL's `JSON` type reorders keys, SQLite stores TEXT, Postgres JSONB drops whitespace). Callers must not rely on payload / metadata key order round-tripping.

**Schema ownership**
- R8. The package exports two artifacts per dialect:
  1. `eventColumns` — the Drizzle column-definition object for the event table (column names, types, constraints, and the unique-tuple constraint the adapter depends on).
  2. `eventTable` — a pre-built Drizzle table constructed from `eventColumns` with the default table name `event`.

  Users may pass `eventTable` to the adapter directly for the simple case, or they may spread `eventColumns` into their own `pgTable` / `mysqlTable` / `sqliteTable` (custom table name, plus any extra columns they need — tenant_id, correlation_id, audit columns, etc.) and pass that instead. Either way, users wire the resulting table into their Drizzle schema module and generate migrations with `drizzle-kit` from their own project.
- R9. The package owns the identity of the columns it reads and writes — their names, types, and the unique-tuple constraint — and exposes them via `eventColumns`. Users cannot rename these columns or change their types. Users MAY:
  - use a different table name (by spreading `eventColumns` into their own `pgTable('...', {...})`),
  - add additional columns alongside the adapter's columns (the adapter neither reads nor writes them),
  - add additional indexes on the table.

  User-added columns must be nullable or have DB-level defaults — the adapter's INSERT statements only set the columns it owns, and non-nullable user columns without defaults will cause insert failures. Document this constraint in the README.
- R10. Column set matches the existing postgres adapter semantics: aggregate name, aggregate id, version, event type, payload (JSON), metadata (JSON), timestamp, plus a unique constraint on (aggregate_name, aggregate_id, version). Dialect-appropriate types are used (JSONB on pg, JSON on mysql, TEXT-encoded JSON on sqlite with the column helper wrapping an explicit JSON transformer so that reads return parsed values). The concrete Drizzle definitions are a planning detail. Timestamp precision must be stable enough across dialects to support `listAggregateIds` pagination — the exact column type per dialect is deferred to planning (see Outstanding Questions).
- R11. On version conflict during `pushEvent` / `pushEventGroup`, the adapter throws a dedicated `EventAlreadyExistsError` (shape aligned with the existing `PostgresEventAlreadyExistsError`), regardless of dialect. Callers must not need to know which driver produced the conflict.
- R22. The adapter's queries are built from the table reference passed at construction time (not a hardcoded package-owned constant), so any table-name and extra-column variation the user applies is transparent to the query layer. The adapter references columns via `table.aggregateId`, `table.version`, etc., typed through the `eventColumns` contract.

**Transactions & grouped events**
- R12. `pushEventGroup` is atomic across all events in the group using Drizzle's transaction API. The adapter assumes the caller-supplied Drizzle DB supports interactive transactions — drivers without that support (Cloudflare D1, `drizzle-orm/neon-http`, PlanetScale serverless driver) are not supported in v1 (see R20).
- R13. A `pushEventGroup` call succeeds only when every grouped event is bound to an instance of this package's adapter (class-type identity check, matching the current postgres adapter's `instanceof` precedent). Mixed adapters (e.g. Drizzle + DynamoDB) yield a clear error. The adapter does NOT attempt to detect "same underlying Drizzle DB instance" at runtime — users who construct multiple adapters against different DBs and group events across them are responsible for not doing so.
- R19. Composing a Castore write from inside a caller-opened Drizzle transaction is not supported in v1. The adapter takes the DB handle given at construction time and uses it directly; it does not accept a per-call tx override. Document this as a known limitation.

**Supported drivers**
- R20. The README documents an explicit allow-list of Drizzle drivers the adapter is tested against and considers supported: `drizzle-orm/node-postgres`, `drizzle-orm/postgres-js`, `drizzle-orm/mysql2`, `drizzle-orm/better-sqlite3`, `drizzle-orm/libsql` (local file / embedded). Drivers outside this list (notably the non-transactional HTTP/serverless variants called out in R12) are "use at your own risk" — no runtime check, the adapter constructs successfully against any Drizzle DB, but atomicity and correctness guarantees are only claimed for the allow-listed drivers.

**Coexistence & migration**
- R14. `@castore/event-storage-adapter-postgres` continues to exist and is not modified as part of this work. No deprecation warnings, no code changes in v1.
- R15. v1 is greenfield-only for the Drizzle adapter. Users with an existing `event-storage-adapter-postgres` table keep that adapter; the Drizzle adapter's schema helper is not committed to be byte-compatible with `createEventTable` output, and no in-place migration or copy-migration tooling is provided. Document this explicitly in the README so users do not attempt to swap adapters against a populated table.
- R16. Docs site (`docs/docs/`) is updated to list the new package and point new users at it as the default SQL option on release; the existing postgres adapter page is kept but cross-linked to the Drizzle page.
- R21. `@castore/event-storage-adapter-postgres` deprecation trigger: starting with the first minor release after v1 (i.e. v1.1 of the Drizzle adapter), and conditional on at least one internal production deployment on the Drizzle adapter having landed, mark the postgres adapter as deprecated (README notice + console.warn on import). "Revisit later" is not an acceptable final state; this requirement converts it into a concrete trigger.

**Testing**
- R17. Unit/integration tests cover all three dialects: PostgreSQL and MySQL via `@testcontainers/*`, SQLite in-process (e.g. `better-sqlite3` or `@libsql/client` file/memory). The same behavior suite runs against each dialect so divergence is caught at CI time.
- R18. The test matrix covers at minimum: push + get round-trip, version-conflict error, `pushEventGroup` atomicity (rollback on mid-group failure), `listAggregateIds` pagination with `pageToken`, reverse-order queries, and a negative test per dialect confirming the documented fallback path (R5) when `RETURNING` / upsert is missing.

## Success Criteria

Measurable, not narrative:

- **Conformance**: a single shared behavior suite (in `lib-test-tools` or equivalent) runs byte-identically against pg / mysql / sqlite adapter instances in CI, and all assertions pass for all three dialects. If the suite diverges per dialect, R7 is violated and v1 is not shippable.
- **Greenfield-adopt test**: a demo or e2e fixture under `demo/` or `packages/.../__tests__/` exercises the full "install adapter + drizzle-orm + driver, run drizzle-kit on the exported schema, construct an `EventStore`, push and read events" flow for at least one dialect (ideally all three) with no Castore-domain-code changes compared to today's postgres-adapter-based demo.
- **Post-ship tracking** (documented here so it's not forgotten, not gated on v1): six months after release, review issue / PR volume for friction around the schema contract — specifically requests to rename adapter-owned columns or to change their types. If a material share of requests hit that specific boundary, reopen the "column rename / type override" question. Tenant_id / correlation_id / audit columns are already accommodated by R9 and are not falsification evidence.
- **Docs**: new-project documentation in `docs/docs/` points to the Drizzle adapter as the recommended SQL path at release.

## Scope Boundaries

- Renaming or retyping the adapter-owned columns is out. Users may add columns alongside (tenant_id, correlation_id, audit columns), use a custom table name, and add their own indexes — see R9. What they cannot do is change the names or types of the columns the adapter reads/writes.
- Extra user-defined columns that are non-nullable and have no DB-level default are out by construction (the adapter won't populate them on insert). Users are responsible for ensuring extras are nullable or have defaults.
- No in-place migration, no copy-migration tooling, no byte-compatible-DDL commitment between `event-storage-adapter-postgres` and the Drizzle adapter. v1 is greenfield-only.
- No rewrite of `event-storage-adapter-postgres` in this work. Deprecation is scheduled (R21), not executed now.
- Drivers without interactive transactions (Cloudflare D1, neon-http, PlanetScale serverless) are out of the supported-driver allow-list. The adapter does not guard against them at runtime but does not claim correctness with them either.
- Composing Castore writes inside a caller-opened Drizzle transaction is out (R19).
- No support for Drizzle dialects that don't exist in stable Drizzle at the time of v1.
- No bundled `drizzle-kit` config — users run their own migrations from their own project.
- No connection/pool management, retries, or observability wrappers inside the adapter.
- No changes to the `EventStorageAdapter` interface in `@castore/core`.

## Key Decisions

- **Column identity owned by the package, table composition open to the user.** The package exports `eventColumns` + a pre-built `eventTable`; users may spread the columns into their own table with a custom name and extra columns. Rationale: keeps adapter queries type-safe and the test matrix tractable (the adapter still only knows about its own columns), while unblocking the multi-tenant / correlation-id / audit-column cases that the adversarial review flagged as common enough to otherwise force forks. This is a deliberate revision of an earlier "fully locked" stance — the escape hatch costs near zero in API surface because Drizzle's object-spread-friendly schema makes it natural.
- **All three dialects at v1, first-class, no experimental tier.** If Drizzle's feature coverage on a dialect is thin (RETURNING, upsert, transactions), the adapter implements a documented fallback rather than downgrading the dialect's status. Rationale: a user-visible "experimental" label for mysql/sqlite would repeat the Postgres-only limitation under a new name and undermine the stated problem frame.
- **Coexist with the existing postgres adapter, Drizzle as preferred, with a concrete deprecation trigger (R21).** Rationale: existing users aren't disrupted at v1, but "revisit later" is converted into an explicit v1.1 trigger so the repo does not carry two SQL adapters forever.
- **Caller owns the Drizzle DB and connection lifecycle.** Rationale: the whole point is to plug into whichever Drizzle setup the user already has.
- **Per-dialect entrypoints rather than one giant class.** Rationale: avoid pulling pg/mysql/sqlite Drizzle code paths into bundles that only use one. Exact shape (sub-path exports vs. three exported classes) is for planning, constrained by the repo's ESLint "no internal `@castore/*/*` imports" rule.
- **`pushEventGroup` group check is class-type identity only, not DB-instance identity.** Rationale: matches the existing postgres adapter's `instanceof` precedent and avoids inventing a Drizzle-DB identity primitive; edge cases where a user wires two adapters against different DBs and groups across them are the user's to avoid.
- **Outer-transaction composition is not supported in v1.** Rationale: keeps the adapter API narrow and matches today's postgres adapter behavior. Reconsider if a concrete use case emerges.
- **Supported-driver allow-list is documentation, not runtime enforcement.** Rationale: runtime probing of a Drizzle DB is brittle across versions; a clear README list is a lighter, honest contract.
- **Greenfield-only migration story.** Rationale: committing to byte-compatibility with `createEventTable` would lock the new schema to legacy choices; shipping a copy-migration tool expands scope. Explicit greenfield scoping keeps v1 tight.

## Alternatives Considered

- **Kysely-based adapter.** Kysely is a lighter query-builder with the same three-dialect coverage and no schema-codegen coupling. Rejected: the explicit design point of this adapter is that the user wires a pre-initialized DB with a pre-declared schema into it, and Drizzle's schema-as-code primitive is what makes that ergonomic. Kysely would shift schema ownership back onto the user (R8 breaks) and lose the type-safe column access the adapter relies on.
- **BYO-client refactor of `event-storage-adapter-postgres`.** An alternative was to let the existing postgres adapter accept an injected client/query-runner, solving the "locked to the `postgres` npm client" half of the problem frame without a new package. Rejected as the sole change: it does not widen dialect coverage beyond Postgres, which is the primary stated goal. It remains plausible as an independent future improvement to the pg adapter but is not a substitute for this work.
- **Per-dialect separate adapters (`-mysql`, `-sqlite`, `-postgres-drizzle`).** Three sibling packages sharing a query-core. Rejected: triples the release / docs / issue surface without improving user ergonomics; one Drizzle package with per-dialect sub-entrypoints achieves the same tree-shaking benefit.

## Dependencies / Assumptions

- **Target audience is Drizzle users.** Teams on Prisma, TypeORM, raw mysql2, or Knex gain nothing from this adapter. The problem frame's "cannot use Castore's SQL story" is narrowed here to "cannot use it AND is on Drizzle or willing to adopt Drizzle". Sizing that overlap is a planning / go-to-market question, not a requirements concern.
- Drizzle ORM (`drizzle-orm`) is a stable, adequate abstraction over the three dialects for the query shapes the adapter needs: parameterized inserts with `ON CONFLICT` / `INSERT IGNORE` / upsert semantics, interactive transactions with rollback, JSON-typed columns, and cursor-style pagination. Where Drizzle support is weak on a dialect, the adapter implements a per-dialect fallback rather than downgrading the dialect (see R5).
- Users of the adapter are willing to run `drizzle-kit` in their own project to produce migrations. There is no intent to generate SQL scripts independently.
- The existing `EventStorageAdapter` contract does not assume any Postgres-specific behavior (e.g. `RETURNING *`). Planning must verify this against all three Drizzle dialects and commit to the fallback path where needed.
- Users of drivers outside the R20 allow-list understand that atomicity / correctness guarantees do not apply to them in v1.

## Outstanding Questions

### Resolve Before Planning
*(none — product shape is decided)*

### Deferred to Planning
- [Affects R6][Technical] Exact module layout for per-dialect entrypoints: sub-path exports (`@castore/event-storage-adapter-drizzle/pg`) vs. three named classes from the package root. Constrained by the repo's ESLint rule forbidding imports from `@castore/*/*` internal paths — any sub-path layout must be compatible with that rule for internal consumers (demos, tests).
- [Affects R1, R2, R5][Technical] The existing postgres adapter is ~566 lines with `/* eslint-disable complexity */`. The repo's ESLint config enforces `max-lines: 200` and `complexity: 8`. A three-dialect Drizzle adapter will not fit in one file; planning must commit upfront to a per-dialect file split (e.g. `src/pg/adapter.ts`, `src/mysql/adapter.ts`, `src/sqlite/adapter.ts`, plus shared helpers) rather than a disable-rule retrofit.
- [Affects R4, R17][Technical] `.npmrc` `only-built-dependencies[]` is fail-closed. Any test-time driver with a native build step (notably `better-sqlite3`) and `drizzle-kit` itself need to be audited and, if required, added to the allow-list with justification.
- [Affects R5, R10, R11, R12][Needs research] Confirm Drizzle's `RETURNING`, `INSERT ... ON CONFLICT` / upsert, and transaction support on MySQL (including older MySQL / MariaDB) and SQLite. For each gap, decide the dialect-local fallback (re-select by unique key, etc.) and document how the fallback preserves the EventAlreadyExistsError contract under concurrent writes.
- [Affects R10][Technical] Concrete per-dialect timestamp column type and precision that keeps `listAggregateIds` pagination stable: TIMESTAMPTZ(3) on pg, DATETIME(3) on mysql, TEXT ISO-8601 (or INTEGER ms) on sqlite. Pick one per dialect and lock the ordering semantics.
- [Affects R11][Technical] Exact error detection per dialect given that the adapter does not import driver packages: Postgres SQLSTATE 23505 vs. constraint name, MySQL errno 1062, SQLite `SQLITE_CONSTRAINT_UNIQUE`. Drizzle may or may not rewrap these into `DrizzleError`; planning must test each allow-listed driver and map to `EventAlreadyExistsError` without leaking driver types.
- [Affects R17][Technical] Test harness: reuse the existing `@testcontainers/postgresql` pattern and add `@testcontainers/mysql`, or collapse all three dialect suites into a single cross-dialect harness in `lib-test-tools`. The latter is cleaner but `lib-test-tools` today only contains mock helpers.
- [Affects R8][Technical] Whether the package should also export a tiny `drizzle-kit` config snippet in its README, or keep the docs provider-agnostic.

## Next Steps

-> `/ce:plan` for structured implementation planning.
