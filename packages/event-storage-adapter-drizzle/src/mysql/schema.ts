import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { IndexBuilder, MySqlColumn } from 'drizzle-orm/mysql-core';
import {
  datetime,
  int,
  json,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

/**
 * Drizzle column definitions for the Castore event table (mysql dialect).
 *
 * Users may pass this package's prebuilt `eventTable` directly, or spread
 * these columns into their own `mysqlTable(...)` call to add extras.
 * Extras must be nullable or have a DB-side default.
 *
 * Column types are fixed by the adapter contract and MUST NOT be overridden:
 * - aggregate_name / type → `varchar(255)` (generous default; won't truncate
 *   EventStore IDs or event types)
 * - aggregate_id         → `varchar(64)` (fits UUID / ULID / custom IDs)
 * - version              → `int` (INT32; EventDetail.version is `number`)
 * - payload / metadata   → `json` (nullable; parsed JS value on read, but
 *   MySQL re-serializes — no byte-order guarantees)
 * - timestamp            → `datetime(3)` with server-side `CURRENT_TIMESTAMP(3)`
 *   default, returned as ISO-8601 string via `mode: 'string'`.
 */
export const eventColumns = {
  aggregateName: varchar('aggregate_name', { length: 255 }).notNull(),
  aggregateId: varchar('aggregate_id', { length: 64 }).notNull(),
  version: int('version').notNull(),
  type: varchar('type', { length: 255 }).notNull(),
  payload: json('payload'),
  metadata: json('metadata'),
  timestamp: datetime('timestamp', { mode: 'string', fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`),
};

/**
 * Third-argument callback for `mysqlTable(...)` — declares the unique index
 * `UNIQUE (aggregate_name, aggregate_id, version)` the adapter relies on for
 * version-conflict detection.
 *
 * The constraint name `event_aggregate_version_uq` is stable across dialects
 * so adapter code can reason about duplicate-key errors by name if needed.
 *
 * In Drizzle 0.45.x the third-arg callback returns an array; the object-form
 * is deprecated.
 */
type MysqlIndexable = MySqlColumn | SQL;

export const eventTableConstraints = <
  TTable extends {
    aggregateName: MysqlIndexable;
    aggregateId: MysqlIndexable;
    version: MysqlIndexable;
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

/**
 * Prebuilt event table for users who do not need any extra columns.
 * Default table name is `event`.
 */
export const eventTable = mysqlTable(
  'event',
  eventColumns,
  eventTableConstraints,
);
