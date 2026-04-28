# Drizzle Event Storage Adapter

DRY Castore [`EventStorageAdapter`](https://castore-dev.github.io/castore/docs/event-sourcing/fetching-events/) implementations for PostgreSQL, MySQL, and SQLite, backed by any caller-supplied [Drizzle ORM](https://orm.drizzle.team) DB instance.

One package, three dialects, one shared conformance suite. Per-dialect sub-entrypoints (`/pg`, `/mysql`, `/sqlite`) keep each bundle tree-shakeable — importing from `/pg` does not pull MySQL or SQLite code into your module graph.

## 📥 Installation

```bash
# npm
npm install @castore/event-storage-adapter-drizzle

# pnpm
pnpm add @castore/event-storage-adapter-drizzle

# yarn
yarn add @castore/event-storage-adapter-drizzle
```

This package has `@castore/core` and `drizzle-orm` as peer dependencies, so you will have to install them as well:

```bash
# npm
npm install @castore/core drizzle-orm

# pnpm
pnpm add @castore/core drizzle-orm

# yarn
yarn add @castore/core drizzle-orm
```

Driver packages are **not** declared as dependencies — install the one(s) you actually use:

```bash
# PostgreSQL (pick one)
pnpm add postgres       # drizzle-orm/postgres-js
pnpm add pg             # drizzle-orm/node-postgres

# MySQL — requires MySQL 8.0.21+ (see per-dialect notes)
pnpm add mysql2

# SQLite — requires SQLite 3.35+ (shipped with current better-sqlite3 / @libsql/client)
pnpm add better-sqlite3 # drizzle-orm/better-sqlite3
pnpm add @libsql/client # drizzle-orm/libsql (local file or in-process only)
```

> **pnpm 10 build-gate note.** `better-sqlite3` ships a native addon and needs an entry in the root `.npmrc`'s `only-built-dependencies[]` allow-list for its postinstall step to run. If you hit a silent install where `better-sqlite3` is present but fails to load at runtime, add `better-sqlite3` to that list.

## 👩‍💻 Usage — simple case (prebuilt `eventTable`)

Every dialect ships a prebuilt `eventTable` with a default name of `event`. Import it, pass it to the adapter, and you are done — no other configuration needed.

### PostgreSQL

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { EventStore } from '@castore/core';
import {
  DrizzlePgEventStorageAdapter,
  eventTable,
} from '@castore/event-storage-adapter-drizzle/pg';

const db = drizzle(postgres(process.env.DATABASE_URL!));

const pokemonsEventStorageAdapter = new DrizzlePgEventStorageAdapter({
  db,
  eventTable,
});

const pokemonsEventStore = new EventStore({
  ...
  eventStorageAdapter: pokemonsEventStorageAdapter,
});
```

The `drizzle-orm/node-postgres` driver works identically — swap `postgres-js` + `postgres` for `node-postgres` + `pg`:

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const db = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }));
```

### MySQL

```ts
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';

import { EventStore } from '@castore/core';
import {
  DrizzleMysqlEventStorageAdapter,
  eventTable,
} from '@castore/event-storage-adapter-drizzle/mysql';

const connection = await mysql.createPool(process.env.DATABASE_URL!);
const db = drizzle(connection);

const pokemonsEventStorageAdapter = new DrizzleMysqlEventStorageAdapter({
  db,
  eventTable,
});
```

### SQLite (`better-sqlite3`)

```ts
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';

import { EventStore } from '@castore/core';
import {
  DrizzleSqliteEventStorageAdapter,
  eventTable,
} from '@castore/event-storage-adapter-drizzle/sqlite';

const db = drizzle(new Database('events.sqlite'));

const pokemonsEventStorageAdapter = new DrizzleSqliteEventStorageAdapter({
  db,
  eventTable,
});
```

### SQLite (`libsql` local)

```ts
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';

const db = drizzle(createClient({ url: 'file:events.sqlite' }));

const pokemonsEventStorageAdapter = new DrizzleSqliteEventStorageAdapter({
  db,
  eventTable,
});
```

## 👩‍💻 Usage — extended table (`eventColumns` + `eventTableConstraints`)

If you want to add your own columns (tenant IDs, correlation IDs, audit columns, etc.), spread `eventColumns` into your own Drizzle table and pass `eventTableConstraints` as the third argument. The adapter reads and writes only its own columns; your extras are left to DB-side defaults or application-side writes.

Extras must be **nullable or defaulted** — the adapter never sets them when inserting an event.

### PostgreSQL

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import postgres from 'postgres';

import {
  DrizzlePgEventStorageAdapter,
  eventColumns,
  eventTableConstraints,
} from '@castore/event-storage-adapter-drizzle/pg';

export const pokemonEvents = pgTable(
  'pokemon_events',
  {
    ...eventColumns,
    // 👇 Nullable extra — fine, adapter leaves it as NULL
    tenantId: text('tenant_id'),
    // 👇 Defaulted extra — DB supplies the value
    correlationId: uuid('correlation_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
  },
  eventTableConstraints,
);

const db = drizzle(postgres(process.env.DATABASE_URL!));

const pokemonsEventStorageAdapter = new DrizzlePgEventStorageAdapter({
  db,
  eventTable: pokemonEvents,
});
```

### MySQL

```ts
import { drizzle } from 'drizzle-orm/mysql2';
import { sql } from 'drizzle-orm';
import { mysqlTable, varchar, char } from 'drizzle-orm/mysql-core';
import mysql from 'mysql2/promise';

import {
  DrizzleMysqlEventStorageAdapter,
  eventColumns,
  eventTableConstraints,
} from '@castore/event-storage-adapter-drizzle/mysql';

export const pokemonEvents = mysqlTable(
  'pokemon_events',
  {
    ...eventColumns,
    // 👇 Nullable extra
    tenantId: varchar('tenant_id', { length: 64 }),
    // 👇 Defaulted extra — DB supplies the value
    correlationId: char('correlation_id', { length: 36 })
      .notNull()
      .default(sql`(UUID())`),
  },
  eventTableConstraints,
);

const db = drizzle(await mysql.createPool(process.env.DATABASE_URL!));

const pokemonsEventStorageAdapter = new DrizzleMysqlEventStorageAdapter({
  db,
  eventTable: pokemonEvents,
});
```

### SQLite

```ts
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import Database from 'better-sqlite3';

import {
  DrizzleSqliteEventStorageAdapter,
  eventColumns,
  eventTableConstraints,
} from '@castore/event-storage-adapter-drizzle/sqlite';

export const pokemonEvents = sqliteTable(
  'pokemon_events',
  {
    ...eventColumns,
    // 👇 Nullable extra
    tenantId: text('tenant_id'),
    // 👇 Defaulted extra — client-side default is fine on SQLite
    correlationId: text('correlation_id').$defaultFn(() => crypto.randomUUID()),
  },
  eventTableConstraints,
);

const db = drizzle(new Database('events.sqlite'));

const pokemonsEventStorageAdapter = new DrizzleSqliteEventStorageAdapter({
  db,
  eventTable: pokemonEvents,
});
```

You are in charge of migrations — generate and apply them with `drizzle-kit` as you would for any other Drizzle table. The adapter only issues queries; it never runs DDL.

## 🧭 Supported Drivers

| Drizzle driver                  | Version floor     | Transaction support | Status        |
| ------------------------------- | ----------------- | ------------------- | ------------- |
| `drizzle-orm/node-postgres`     | PostgreSQL 12+    | ✅ Interactive       | ✅ Supported   |
| `drizzle-orm/postgres-js`       | PostgreSQL 12+    | ✅ Interactive       | ✅ Supported   |
| `drizzle-orm/mysql2`            | MySQL **8.0.21+** | ✅ Interactive       | ✅ Supported   |
| `drizzle-orm/better-sqlite3`    | SQLite 3.35+      | ✅ Sync-wrapped      | ✅ Supported   |
| `drizzle-orm/libsql` (local)    | SQLite 3.35+      | ✅ Interactive       | ✅ Supported   |
| `drizzle-orm/d1` (Cloudflare)   | —                 | ❌ None              | ❌ Unsupported |
| `drizzle-orm/neon-http`         | —                 | ❌ HTTP-only         | ❌ Unsupported |
| `drizzle-orm/planetscale-serverless` | —            | ❌ HTTP-only         | ❌ Unsupported |

### ❌ Unsupported drivers

Cloudflare D1, `drizzle-orm/neon-http`, and the PlanetScale serverless driver **cannot be used safely** with this adapter. They lack interactive transaction support, which means `pushEventGroup` will silently partial-commit on a mid-group failure, violating Castore's atomicity contract.

There is **no runtime rejection** — construction will succeed. The adapter surfaces whatever error the driver throws when it cannot start a transaction (or commits partially, if the driver silently ignores the transaction call). If you need Castore on one of those environments today, stay on [`@castore/event-storage-adapter-postgres`](https://www.npmjs.com/package/@castore/event-storage-adapter-postgres) with a managed PostgreSQL instance, or use the in-memory adapter during development.

For libSQL / Turso **remote** (HTTP) deployments, use the `libsql` driver in local/embedded-replica mode only. Pure HTTP mode shares the same non-transactional constraint as `neon-http`.

## 📝 Per-dialect notes

### PostgreSQL

- `payload` and `metadata` columns use `jsonb`. Read values are parsed JS values; byte layout is not preserved, but key order round-trips within one write/read cycle.
- `timestamp` is `timestamptz(3)` with a server-side `defaultNow()` and is returned as an ISO-8601 string by the adapter.
- No version or driver gotchas. Both `postgres-js` and `node-postgres` are tested against the same conformance suite.

### MySQL

- **Minimum version: MySQL 8.0.21.** The adapter uses native `RETURNING`-equivalents and CTEs in `listAggregateIds`; older MySQL / MariaDB versions are not supported in v1. Aurora Serverless v1 and RDS MySQL 5.7 users should stay on the existing Postgres adapter or a self-managed alternative.
- MySQL does not support `INSERT ... RETURNING *` syntactically. The adapter re-selects the inserted row after `INSERT` to assemble the `EventDetail`. This round-trip is invisible to callers.
- `payload` and `metadata` use the `json` type. MySQL parses and re-serializes JSON server-side, so **JSON key order is not preserved** — compare parsed values, not byte layout.
- `timestamp` is `datetime(3)` with a server-side `CURRENT_TIMESTAMP(3)` default, returned as an ISO-8601 string via Drizzle's `{ mode: 'string' }` column option.

### SQLite

- **Minimum version: SQLite 3.35** (shipped with current `better-sqlite3` and `@libsql/client`). Earlier versions lack the native `RETURNING` clause the adapter relies on.
- `payload` and `metadata` are stored as `TEXT` with Drizzle's `{ mode: 'json' }` transformer — parse/stringify happens transparently.
- `timestamp` is stored as `TEXT` with a client-side `$defaultFn(() => new Date().toISOString())`. Fixed-width ISO-8601 strings sort chronologically under lexicographic order, so `listAggregateIds` pagination works identically to PostgreSQL/MySQL.
- **better-sqlite3 is synchronous.** Its `db.transaction(...)` helper rejects async callbacks with a runtime error. To keep the adapter API uniform, `pushEventGroup` on the SQLite adapter issues raw `BEGIN` / `COMMIT` / `ROLLBACK` statements internally rather than calling Drizzle's transaction wrapper. You should not notice this from outside — `pushEventGroup` is atomic exactly as it is on PostgreSQL / MySQL.
- **Do not wrap multiple adapter calls in `db.transaction(async ...)` on better-sqlite3.** Because better-sqlite3's transaction helper is sync, passing an async callback will throw at call time. This is a driver limitation, not an adapter choice. If you need multi-call atomicity, use `pushEventGroup` (which handles the transaction internally) or switch to the `libsql` driver, which accepts async transaction callbacks.

## ❗ Error handling

All dialects throw a single `DrizzleEventAlreadyExistsError` on a version conflict (duplicate `(aggregate_name, aggregate_id, version)`), regardless of which driver detected it:

```ts
import { eventAlreadyExistsErrorCode } from '@castore/core';
import { DrizzleEventAlreadyExistsError } from '@castore/event-storage-adapter-drizzle';

try {
  await eventStore.pushEvent(event);
} catch (error) {
  // 👇 Dialect-agnostic check — works for pg, mysql, and sqlite adapters
  if (
    error instanceof DrizzleEventAlreadyExistsError ||
    (error as { code?: string }).code === eventAlreadyExistsErrorCode
  ) {
    // handle concurrent-write case
  }
}
```

The error's `code` field matches Castore core's `eventAlreadyExistsErrorCode` constant, so existing consumers that branch on `error.code` keep working without changes.

The shared error class is also available from the per-dialect sub-entrypoints (`/pg`, `/mysql`, `/sqlite`) if you prefer to colocate the import with the adapter.

## 🔁 Transaction composition

**v1 does not support outer-transaction composition.** The adapter takes a Drizzle DB handle at construction time and uses that handle directly for all writes. There is no per-call `tx` override, and calling adapter methods from inside a caller-opened `db.transaction(async (tx) => ...)` block is **not** supported — the adapter's writes will run on the outer `db`, not your `tx`, and nesting behavior is driver-dependent.

Atomic multi-event writes are supported via `pushEventGroup`, which manages its own transaction internally. That is the intended escape hatch for "write N events, all-or-nothing".

If you need cross-store transactional composition with caller-owned transactions, stay on the existing [`@castore/event-storage-adapter-postgres`](https://www.npmjs.com/package/@castore/event-storage-adapter-postgres) adapter for now; a per-call `tx` parameter is a candidate for a future minor release.

## 📦 Migration from `@castore/event-storage-adapter-postgres`

**This adapter is greenfield-only in v1.** It is **not** byte-compatible with the existing [`@castore/event-storage-adapter-postgres`](https://www.npmjs.com/package/@castore/event-storage-adapter-postgres) event table — column types, nullability, and defaults differ.

If you already run `@castore/event-storage-adapter-postgres` in production, **stay on that adapter**. A migration tool is explicitly deferred to a future v2 of this package and is not part of the existing Postgres adapter's deprecation timeline. No migration tooling ships in v1.

If you are starting a new project and want SQL persistence, this adapter is the recommended choice — it gives you MySQL / SQLite / Turso support out of the box and hooks cleanly into your own `drizzle-kit` migration workflow.

## 🤔 How it works

The adapter persists events in a single table with columns:

| Column         | pg type            | mysql type             | sqlite type                 | Description                                          |
| -------------- | ------------------ | ---------------------- | --------------------------- | ---------------------------------------------------- |
| aggregate_name | `text`             | `varchar(255)`         | `text`                      | Event store id (identifies the aggregate's store)    |
| aggregate_id   | `text`             | `varchar(64)`          | `text`                      | Aggregate id                                         |
| version        | `integer`          | `int`                  | `integer`                   | Event version within the aggregate                   |
| type           | `text`             | `varchar(255)`         | `text`                      | Event type name                                      |
| payload        | `jsonb` (nullable) | `json` (nullable)      | `text mode:'json'` nullable | Event payload; parsed JS value on read               |
| metadata       | `jsonb` (nullable) | `json` (nullable)      | `text mode:'json'` nullable | Event metadata; parsed JS value on read              |
| timestamp      | `timestamptz(3)`   | `datetime(3)` (string) | `text` (ISO-8601)           | Event timestamp; server-default where supported      |

The table also carries a `UNIQUE (aggregate_name, aggregate_id, version)` constraint named `event_aggregate_version_uq`, which enforces optimistic concurrency and is what surfaces as `DrizzleEventAlreadyExistsError` on duplicate pushes.

These column shapes are part of the adapter contract and are **not** configurable in v1. You can add extra columns by composing with `eventColumns` + `eventTableConstraints`, but you cannot rename or re-type existing columns.

`pushEvent` issues a single `INSERT ... RETURNING *` (or `INSERT ... ON CONFLICT DO UPDATE ... RETURNING *` for `force: true`). On MySQL, `RETURNING *` is simulated with a follow-up `SELECT` since MySQL 8 does not support the syntax on `INSERT`. Duplicate-key errors are caught per-dialect and re-thrown as `DrizzleEventAlreadyExistsError`.

`pushEventGroup` wraps all inserts in a single Drizzle transaction (or raw `BEGIN/COMMIT/ROLLBACK` on better-sqlite3). If any insert throws, the transaction rolls back and no partial writes are committed. All events in the group must belong to adapters of the same dialect as the first event.

`listAggregateIds` uses a CTE (or equivalent) to return aggregates ordered by `initialEventTimestamp`, with cursor-based pagination via `pageToken`. The page-token encoding is consistent across dialects.

## 📤 Transactional Outbox

The Drizzle adapter ships a built-in [transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) that closes the N4 zero-event-loss gap for SQL-backed event stores. When outbox mode is enabled, `pushEvent` and `pushEventGroup` atomically commit both the event row and an outbox row in a single database transaction. A separate relay process drains the outbox table and publishes messages to your bus at-least-once, with per-aggregate FIFO ordering and automatic retry.

> **v1 closes the write-side half of N4.** Consumer-side deduplication (G-03) is a mandatory follow-up before any production traffic with N4 intent. See [Known limits](#known-limits) below.

### Quick start

Enable outbox by passing an `outbox` table to the adapter constructor. The table shape is identical to the event table pattern — you can use the prebuilt `outboxTable` or spread `outboxColumns` + `outboxTableConstraints` into your own table to add extras.

```ts
import { DrizzlePgEventStorageAdapter, eventTable, outboxTable } from '@castore/event-storage-adapter-drizzle/pg';
import { createOutboxRelay, claimPg } from '@castore/event-storage-adapter-drizzle/relay';

const adapter = new DrizzlePgEventStorageAdapter({
  db,
  eventTable,
  outbox: outboxTable, // <-- enables outbox mode
});
```

When `outbox` is present, the adapter sets two capability symbols on its instance. Core's `publishPushedEvent` detects them and short-circuits the fire-and-forget publish path — the relay becomes the sole publisher.

### Schema

The outbox table has 12 columns. Mutation timestamps are DB-authoritative for PostgreSQL and MySQL (server-side `NOW()`); for SQLite `created_at` is client-generated ISO-8601 text (the schema uses `.$defaultFn(() => new Date().toISOString())`).

| Column         | pg type            | mysql type             | sqlite type                 | Description                                          |
| -------------- | ------------------ | ---------------------- | --------------------------- | ---------------------------------------------------- |
| id             | `uuid` PK          | `varchar(36)` PK       | `text` PK                   | Random UUID; generated by DB default                 |
| aggregate_name | `text`             | `varchar(255)`         | `text`                      | Logical eventStoreId (matches event table)            |
| aggregate_id   | `text`             | `varchar(64)`          | `text`                      | Aggregate id                                          |
| version        | `integer`          | `int`                  | `integer`                   | Event version within the aggregate                   |
| created_at     | `timestamptz(3)`   | `datetime(3)`          | `text` (ISO-8601)           | Row creation time; server default (SQLite: client-generated) |
| claim_token    | `text` (nullable)  | `varchar(36)` nullable | `text` nullable             | Cryptographic token set at claim time; fencing key   |
| claimed_at    | `timestamptz(3)`   | `datetime(3)` nullable | `text` nullable             | Last claim time; TTL threshold for re-claim          |
| processed_at  | `timestamptz(3)`   | `datetime(3)` nullable | `text` nullable             | Set when publish succeeds                             |
| attempts       | `integer`          | `int`                  | `integer`                   | Failed publish attempts; dead transition at max      |
| last_error     | `text` (nullable)  | `varchar(2048)` nullable | `text` nullable           | Scrubbed error message; capped at 2048 chars         |
| last_attempt_at | `timestamptz(3)` | `datetime(3)` nullable | `text` nullable             | Timestamp of last failed attempt                     |
| dead_at        | `timestamptz(3)`  | `datetime(3)` nullable | `text` nullable             | Set when max attempts reached; blocks FIFO           |

A unique constraint `outbox_aggregate_version_uq` on `(aggregate_name, aggregate_id, version)` prevents duplicate outbox rows and is load-bearing for the FIFO-exclusion query.

### `pushEvent` semantic change

Without outbox, `ConnectedEventStore.pushEvent` resolves when the event is committed **and** the message has been published to the bus. With outbox, it resolves when the event **and** outbox row are committed. Publish happens later, asynchronously, via the relay.

This shift affects five caller patterns:

1. **Integration tests** that assert bus-side effects immediately after `pushEvent` must now flush the relay via `await relay.runOnce()` before asserting.
2. **In-process CQRS** handlers that rely on synchronous publish visibility must wait for the relay.
3. **Operator runbooks** that monitor `onEventPushed` hooks should be aware the hook fires on relay publish, not on commit.
4. **`onEventPushed` hook users** doing real work should validate their assumptions — the hook now runs in the relay context, not the writer context.
5. **Multi-`ConnectedEventStore` wrappers** (two channels around one base store) are unsupported in v1. The relay registry maps one eventStoreId to one channel.

### Relay setup

Import the relay factory and the dialect-specific claim primitive from the `./relay` sub-entrypoint:

```ts
import {
  createOutboxRelay,
  claimPg,       // or claimMysql / claimSqlite
  assertOutboxEnabled,
} from '@castore/event-storage-adapter-drizzle/relay';

assertOutboxEnabled(adapter, { mode: 'throw' });

const relay = createOutboxRelay({
  dialect: 'pg',
  adapter,
  db,
  outboxTable,
  claim: claimPg,
  registry: [
    {
      eventStoreId: 'USERS',
      connectedEventStore: usersConnectedEventStore,
      channel: usersBus,
    },
  ],
  hooks: {
    onDead: (row, err) => {
      // Wire to PagerDuty / Datadog / CloudWatch
      console.error(`[outbox] dead row ${row.id}:`, err);
    },
    onFail: (row, err, attempts, nextBackoffMs) => {
      console.warn(`[outbox] retry ${attempts} for ${row.id}, next in ${nextBackoffMs}ms`);
    },
  },
  options: {
    baseMs: 100,
    ceilingMs: 30_000,
    maxAttempts: 5,
    claimTimeoutMs: 60_000,
    publishTimeoutMs: 30_000,
    pollingMs: 5_000,
    batchSize: 100,
  },
});
```

**Options explained:**

| Option            | Default               | Description                                           |
| ----------------- | --------------------- | ----------------------------------------------------- |
| `baseMs`          | `250`                 | First backoff; doubles each attempt (`base * 2^(n-1)`) |
| `ceilingMs`       | `60_000`              | Hard backoff cap                                      |
| `maxAttempts`     | `10`                  | Dead transition threshold                             |
| `claimTimeoutMs`  | `300_000`             | TTL: stale claim re-eligible after this many ms       |
| `publishTimeoutMs`| `150_000`             | Hard wall-clock cap on a single publish; MUST be `< claimTimeoutMs` |
| `pollingMs`       | `250`                 | Sleep between empty `runOnce` iterations              |
| `batchSize`       | `50`                  | Max rows claimed per `runOnce` pass                   |

**Run modes:**

- **`await relay.runOnce()`** — claim, publish, and mark one batch, then return. Ideal for cron-triggered Lambdas or any short-lived worker.
- **`await relay.runContinuously()`** — supervised loop that polls until `relay.stop()` is called. Ideal for long-running containers. Call `stop()` in your SIGTERM handler for graceful shutdown.

### Liveness queries

The relay exposes three SQL query templates you can wire into your monitoring stack. All use DB-authoritative time.

**Age (oldest unprocessed row):**

```sql
-- PostgreSQL
SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) * 1000 AS age_ms
FROM castore_outbox
WHERE processed_at IS NULL AND dead_at IS NULL;

-- MySQL
SELECT TIMESTAMPDIFF(MICROSECOND, MIN(created_at), NOW(3)) / 1000 AS age_ms
FROM castore_outbox
WHERE processed_at IS NULL AND dead_at IS NULL;

-- SQLite
SELECT CAST((julianday('now') - julianday(MIN(created_at))) * 86400000 AS INTEGER) AS age_ms
FROM castore_outbox
WHERE processed_at IS NULL AND dead_at IS NULL;
```

**Depth (unprocessed row count):**

```sql
SELECT COUNT(*) AS depth
FROM castore_outbox
WHERE processed_at IS NULL AND dead_at IS NULL;
```

**Dead-count:**

```sql
SELECT COUNT(*) AS dead_count
FROM castore_outbox
WHERE dead_at IS NOT NULL;
```

### Admin API

The relay exposes two admin helpers for operator intervention.

**`retryRow(rowId, options?)`** — clears `dead_at`, `attempts`, `last_error`, and `claim_token` so the row is re-eligible for claim.

```ts
// Safe default: rejects if the row is currently claimed
await relay.retryRow('row-uuid');
// => { warning: 'at-most-once-not-guaranteed', rowId: 'row-uuid', forced: false }

// Force-clear even if a worker owns the row (accepts double-publish hazard)
await relay.retryRow('row-uuid', { force: true });
// => { warning: 'at-most-once-not-guaranteed', rowId: 'row-uuid', forced: true }
```

The returned `warning` is an explicit signal that retrying a row may produce duplicate deliveries. Your runbook should require operator acknowledgment before calling `retryRow` on a live row.

**`deleteRow(rowId)`** — removes the outbox row. The event table is untouched. Use for GDPR erasure or to unblock an aggregate that has a dead row you no longer care about.

```ts
await relay.deleteRow('row-uuid');
// => { rowId: 'row-uuid' }
```

### Security & deployment

- **Dedicated DB credentials for the relay.** The relay needs `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on the outbox table plus `SELECT` on the event table. It does NOT need `INSERT` / `UPDATE` / `DELETE` on the event table. Segregate roles:

```sql
-- Writer role (app processes that push events)
GRANT INSERT, UPDATE, SELECT ON castore_outbox TO writer_role;
GRANT INSERT, UPDATE, SELECT ON event TO writer_role;

-- Relay role (outbox relay workers only)
GRANT SELECT, UPDATE, DELETE ON castore_outbox TO relay_role;
GRANT SELECT ON event TO relay_role;
```

- **Network restriction.** The relay should connect to your database over a private network (VPC peering, private link, or socket) — not over the public internet.
- **`last_error` scrubber.** Error messages persisted to the `last_error` column are automatically scrubbed: JSON-like fragments are parsed to depth 3 and all leaf values replaced with `'<redacted>'`. This prevents accidental PII leakage from bus-level errors into the outbox table. The scrubber operates on the error string only — it never sees event payloads directly.
- **Encryption-at-rest.** The outbox table stores pointer-shaped rows (no payload column). Payload data lives only in the event table, which inherits your existing encryption-at-rest policy. The `last_error` column may contain scrubbed string fragments — classify it at the same tier as application logs.

### Known limits

- **Unbounded backlog.** There is no framework-level guard that prevents `pushEvent` when the outbox depth exceeds a threshold. Use the liveness queries above and wire your own alerting / circuit breaker.
- **G-03 consumer dedup is mandatory for production N4.** The relay delivers at-least-once. Without consumer-side deduplication, duplicate messages will reach downstream handlers after crashes, TTL reclaims, or `retryRow` calls.
- **Multi-wrapper unsupported.** One relay registry entry per eventStoreId. If you need multiple channels for the same store, that is a v1.1 candidate.
- **StateCarrying on hot aggregates without G-02.** Reconstructing aggregate state for every publish on a busy aggregate is expensive. If you use `StateCarryingMessageChannel` and the aggregate has many events, consider the snapshot helper (G-02) or switch to `NotificationMessageChannel`.
- **No built-in DLQ table.** Dead rows stay in the outbox table. Use `retryRow` or `deleteRow` to manage them.
- **No multi-channel fan-out.** One channel per eventStoreId in the registry.

### Operator runbook

**Dead-row resolution:**

1. Query `dead_count` liveness query. If > 0, inspect `last_error`:
   ```sql
   SELECT id, aggregate_name, aggregate_id, version, last_error, attempts, dead_at
   FROM castore_outbox
   WHERE dead_at IS NOT NULL;
   ```
2. If the error is transient (network blip, downstream service unavailable), call `retryRow(id)`.
3. If the error is permanent (schema mismatch, missing registry entry, deleted aggregate), call `deleteRow(id)` to unblock newer versions of the same aggregate.

**GDPR erasure playbook:**

1. Do NOT delete the event row unless your legal team requires it — the event table is the source of truth.
2. Call `deleteRow(id)` on the outbox row only. This removes the pointer without touching the event.
3. If you must also erase the event, delete from the event table first, then `deleteRow` the outbox row. The relay's nil-row dead path will catch any race where the outbox row is claimed between the two deletes.

**`retryRow` on a claimed row hazard:**

If `retryRow` is called on a row with a non-null `claim_token`, the default-safe behavior rejects with `RetryRowClaimedError`. If you pass `{ force: true }`, the worker's in-flight publish may double-send. Always prefer waiting for TTL reclaim (`claimTimeoutMs`) over forcing a retry.

