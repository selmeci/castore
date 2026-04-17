# Examples

Runnable demos of `@castore/event-storage-adapter-drizzle` in realistic
adoption shapes. These files live inside the package so they run as part of
the package's CI test suite — you can trust they stay green against the
current adapter code.

## `drizzle-integration.unit.test.ts`

**Scenario: a team with an existing Drizzle schema adopts Castore.**

Demonstrates the recommended adopt path:

1. The team already has a Drizzle schema (here: a `users` table) managed by
   their own `drizzle-kit` setup.
2. They add a new schema file for events that SPREADS `eventColumns` from
   `@castore/event-storage-adapter-drizzle/pg` into a custom-named table
   (`app_events`), tacking on a user-owned extra column (`tenant_id`).
3. They run `drizzle-kit` to generate + apply the migration alongside their
   existing tables. (This demo hand-writes the DDL to keep the example
   self-contained; in production, your drizzle-kit workflow handles it.)
4. They construct `DrizzlePgEventStorageAdapter({ db, eventTable: appEvents })`
   against the extended table.
5. They wire a Castore `EventStore` + `Command` on top of the adapter and
   push events — with zero changes to the pre-existing `users` table or any
   other part of the codebase.

The test asserts that events round-trip correctly through the adapter AND
that the pre-existing `users` table stays untouched. Copy the file
structure as a starting point for your own adoption.

## Running

The examples run automatically as part of the package's `test-unit` target:

```bash
pnpm nx run event-storage-adapter-drizzle:test-unit
```

They spin up a Postgres testcontainer alongside the other integration
tests. No extra configuration needed.
