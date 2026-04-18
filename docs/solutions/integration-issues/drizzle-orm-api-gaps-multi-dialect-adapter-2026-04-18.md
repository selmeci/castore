---
title: "Drizzle ORM 0.45 dialect quirks — MySQL RETURNING, better-sqlite3 sync transactions, per-driver error wrapping"
date: 2026-04-18
category: integration-issues
module: event-storage-adapter-drizzle
problem_type: integration_issue
component: database
symptoms:
  - "MySqlInsertBuilder has no `.returning()` method — copying the pg pattern fails to type-check and there is no single uniform insert API across dialects"
  - "better-sqlite3's `db.transaction(async callback)` throws `TypeError: Transaction function cannot return a promise` at runtime"
  - "Unique-constraint violations surface as four distinct error shapes across drivers, and checks for a uniform `.code` on the root error silently miss all of them"
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components:
  - tooling
tags:
  - drizzle-orm
  - mysql
  - sqlite
  - better-sqlite3
  - libsql
  - transactions
  - error-handling
  - returning
---

# Drizzle ORM 0.45 dialect quirks — MySQL RETURNING, better-sqlite3 sync transactions, per-driver error wrapping

## Problem

Building a multi-dialect Drizzle adapter against PostgreSQL, MySQL, and SQLite surfaces three non-obvious dialect hazards that Drizzle's docs do not call out. None fail at install or package-build time; all three surface only when the adapter runs against real database engines, and two produce silent misclassification rather than loud errors.

## Symptoms

- `await tx.insert(eventTable).values(...).returning({...})` — valid TypeScript on pg, type error on mysql (method does not exist).
- `await db.transaction(async tx => { ... })` — works on pg, mysql, and libsql; throws `TypeError: Transaction function cannot return a promise` on better-sqlite3.
- A uniform `if (err.code === '23505')` check catches pg duplicate-key errors but misses mysql (error is wrapped, code is on `.cause`), better-sqlite3 (uses `SQLITE_CONSTRAINT_UNIQUE` not `23505`), and libsql (root code is the parent `SQLITE_CONSTRAINT`, specific code is on `.cause`).

## What Didn't Work

- **Assuming `RETURNING` is universal** — the plan originally specified MySQL 8.0.21+ because "RETURNING is available in recent MySQL". It isn't. MySQL has never shipped `INSERT ... RETURNING`; that is a MariaDB extension. Verified by reading `node_modules/.pnpm/drizzle-orm@0.45.2_*/drizzle-orm/mysql-core/query-builders/insert.d.cts`: the MySQL insert builder exposes only `.onDuplicateKeyUpdate()` and `.$returningId()`. No `.returning()` method exists.
- **Reusing `db.transaction()` across SQLite drivers** — works on libsql, fails on better-sqlite3. The sync-only contract is intentional: better-sqlite3's `Database.prototype.transaction()` wraps the callback in a synchronous `BEGIN IMMEDIATE`/`COMMIT` pair and actively rejects promise-returning callbacks.
- **Trusting the top-level error object for a `.code`** — Drizzle 0.45 wraps `postgres-js` and `node-postgres` errors in `DrizzleQueryError`. The top-level `.code` is `undefined`; the SQLSTATE lives on `.cause`. mysql2 errors are wrapped the same way. Verified empirically by logging the full error chain from a unit-test probe before writing the detector.

## Solution

### 1. MySQL RETURNING — insert + same-transaction re-SELECT

MySQL lacks native `RETURNING`, so build the adapter around a two-statement pattern executed on the same transaction handle:

```typescript
// src/mysql/adapter.ts
await tx.insert(this.eventTable).values(values);
const rows = await tx
  .select(this.selectColumns())
  .from(this.eventTable)
  .where(
    and(
      eq(this.eventTable.aggregateName, options.eventStoreId),
      eq(this.eventTable.aggregateId, aggregateId),
      eq(this.eventTable.version, version),
    ),
  )
  .limit(1);
```

When `tx` is a real `db.transaction(async tx => ...)` handle, the re-SELECT is phantom-read-safe under MySQL's default REPEATABLE READ isolation. When `tx === this.db` (standalone `pushEvent`), the re-SELECT can race with concurrent writers under `force: true` — document the constraint or wrap the standalone call in a transaction as well.

### 2. better-sqlite3 transaction portability — raw `BEGIN`/`COMMIT`/`ROLLBACK`

Raw transaction statements work identically on both sqlite drivers. `db.run(sql\`BEGIN\`)` returns a non-thenable value on better-sqlite3 and a `Promise` on libsql; `await` is a no-op on the former and resolves the latter.

```typescript
// src/sqlite/adapter.ts — pushEventGroup
await this.db.run(sql`BEGIN`);
try {
  for (const groupedEvent of groupedEvents) {
    await groupedAdapter.pushEventInTx(this.db, event, options);
  }
  await this.db.run(sql`COMMIT`);
} catch (err) {
  try {
    await this.db.run(sql`ROLLBACK`);
  } catch (rollbackErr) {
    console.error(
      '[DrizzleSqliteEventStorageAdapter] ROLLBACK failed; connection state is undefined:',
      rollbackErr,
    );
  }
  throw err;
}
```

### 3. Cross-driver error classification — `walkErrorCauses` with a Set cycle guard

A single helper traverses the `.cause` / `.sourceError` / `.originalError` chain; dialect-specific predicates match the precise code.

```typescript
// src/common/walkErrorCauses.ts
export const walkErrorCauses = (
  err: unknown,
  predicate: (node: unknown) => boolean,
): boolean => {
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (predicate(current)) return true;
    current =
      (current as { cause?: unknown }).cause ??
      (current as { sourceError?: unknown }).sourceError ??
      (current as { originalError?: unknown }).originalError;
  }
  return false;
};

// pg
walkErrorCauses(err, node => (node as { code?: unknown }).code === '23505');
// mysql
walkErrorCauses(err, node => {
  const n = node as { code?: unknown; errno?: unknown };
  return n.code === 'ER_DUP_ENTRY' || n.errno === 1062;
});
// sqlite — MUST be the specific UNIQUE code, not the parent SQLITE_CONSTRAINT
walkErrorCauses(
  err,
  node => (node as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE',
);
```

## Why This Works

**MySQL re-SELECT** is atomic against concurrent writers because it runs on the same `tx` as the INSERT and MySQL's default REPEATABLE READ isolation snapshot is fixed for the duration of the transaction.

**Raw `BEGIN`/`COMMIT`/`ROLLBACK`** bypasses driver-specific transaction-callback semantics entirely. Both better-sqlite3 and libsql accept these statements verbatim. The `db.run(sql\`...\`)` return value is discarded; `await` handles the async case transparently.

**`walkErrorCauses`** handles every observed wrap shape:
| Driver | Root error | Duplicate key signal |
|---|---|---|
| postgres-js | `DrizzleQueryError` | `.code === '23505'` on `.cause` |
| node-postgres | `DrizzleQueryError` | `.code === '23505'` on `.cause` |
| mysql2 | `DrizzleQueryError` | `.errno === 1062` / `.code === 'ER_DUP_ENTRY'` on `.cause` |
| better-sqlite3 | `SqliteError` | `.code === 'SQLITE_CONSTRAINT_UNIQUE'` on root |
| libsql | `LibsqlError` | `.code === 'SQLITE_CONSTRAINT'` on root; `'SQLITE_CONSTRAINT_UNIQUE'` on `.cause` |

Matching only `SQLITE_CONSTRAINT_UNIQUE` (not the coarse parent `SQLITE_CONSTRAINT`) avoids misclassifying NOT NULL / CHECK / FK violations — which share the parent code on libsql — as `EventAlreadyExistsError`.

## Prevention

- **Before writing a Drizzle adapter, read the dialect-specific `*-core/query-builders/insert.d.cts`** to confirm which methods actually exist. Drizzle's public docs do not reliably call out API gaps between dialects. (Session history: this check was done proactively before writing the MySQL adapter, not after the first failure.)
- **Never assume `db.transaction(async cb)` works everywhere in SQLite.** better-sqlite3's sync-only contract is easy to miss because libsql (the usual dev-environment sqlite driver) handles async callbacks fine.
- **Observe the real error shape before writing the detector.** Log `err` including `.cause` / `.sourceError` / `.originalError` against each supported driver in an exploratory probe; write the predicate against observed fields, not assumed ones.
- **Match only the most specific error code.** Accepting parent codes (like libsql's `SQLITE_CONSTRAINT`) silently swallows unrelated constraint classes as version-conflict errors.

## Related Issues

- Plan: [specs/plans/2026-04-17-002-feat-event-storage-adapter-drizzle-plan.md](../../../specs/plans/2026-04-17-002-feat-event-storage-adapter-drizzle-plan.md) — the MySQL RETURNING assumption is documented as a plan correction in Unit 5 and the review fixes commit.
- Requirements: [specs/requirements/2026-04-17-event-storage-adapter-drizzle-requirements.md](../../../specs/requirements/2026-04-17-event-storage-adapter-drizzle-requirements.md)
- PR #4: https://github.com/selmeci/castore/pull/4
- Canonical code:
  - [`packages/event-storage-adapter-drizzle/src/common/walkErrorCauses.ts`](../../../packages/event-storage-adapter-drizzle/src/common/walkErrorCauses.ts)
  - [`packages/event-storage-adapter-drizzle/src/mysql/adapter.ts`](../../../packages/event-storage-adapter-drizzle/src/mysql/adapter.ts)
  - [`packages/event-storage-adapter-drizzle/src/sqlite/adapter.ts`](../../../packages/event-storage-adapter-drizzle/src/sqlite/adapter.ts)
