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
| **UNIQUE**     | `(aggregate_name, aggregate_id, version)` — constraint name `event_aggregate_version_uq`                                                                                            |

These column shapes are part of the adapter contract and are **not** configurable in v1. You can add extra columns by composing with `eventColumns` + `eventTableConstraints`, but you cannot rename or re-type existing columns.

`pushEvent` issues a single `INSERT ... RETURNING *` (or `INSERT ... ON CONFLICT DO UPDATE ... RETURNING *` for `force: true`). On MySQL, `RETURNING *` is simulated with a follow-up `SELECT` since MySQL 8 does not support the syntax on `INSERT`. Duplicate-key errors are caught per-dialect and re-thrown as `DrizzleEventAlreadyExistsError`.

`pushEventGroup` wraps all inserts in a single Drizzle transaction (or raw `BEGIN/COMMIT/ROLLBACK` on better-sqlite3). If any insert throws, the transaction rolls back and no partial writes are committed. All events in the group must belong to adapters of the same dialect as the first event.

`listAggregateIds` uses a CTE (or equivalent) to return aggregates ordered by `initialEventTimestamp`, with cursor-based pagination via `pageToken`. The page-token encoding is consistent across dialects.
