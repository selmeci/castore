import type { SQL } from 'drizzle-orm';
import type { IndexBuilder, SQLiteColumn } from 'drizzle-orm/sqlite-core';
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Drizzle column definitions for the Castore event table (sqlite dialect).
 *
 * Users may pass this package's prebuilt `eventTable` directly, or spread
 * these columns into their own `sqliteTable(...)` call to add extras.
 * Extras must be nullable or have a DB-side default.
 *
 * Column types are fixed by the adapter contract and MUST NOT be overridden:
 * - aggregate_name / aggregate_id / type → `text` (unlimited)
 * - version                              → `integer` (INT32; EventDetail.version is `number`)
 * - payload / metadata                   → `text` with `mode: 'json'`, typed
 *   `unknown` so downstream adapter code treats the column as opaque JSON.
 *   Drizzle parses / stringifies automatically.
 * - timestamp                            → `text` with a client-side default
 *   (`new Date().toISOString()`); fixed-width ISO-8601 strings sort
 *   chronologically under lexicographic order.
 */
export const eventColumns = {
  aggregateName: text('aggregate_name').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  version: integer('version').notNull(),
  type: text('type').notNull(),
  payload: text('payload', { mode: 'json' }).$type<unknown>(),
  metadata: text('metadata', { mode: 'json' }).$type<unknown>(),
  timestamp: text('timestamp')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
};

/**
 * Third-argument callback for `sqliteTable(...)` — declares the unique index
 * `UNIQUE (aggregate_name, aggregate_id, version)` the adapter relies on for
 * version-conflict detection.
 *
 * The constraint name `event_aggregate_version_uq` is stable across dialects
 * so adapter code can reason about duplicate-key errors by name if needed.
 *
 * In Drizzle 0.45.x the third-arg callback returns an array; the object-form
 * is deprecated.
 */
type SqliteIndexable = SQLiteColumn | SQL;

export const eventTableConstraints = <
  TTable extends {
    aggregateName: SqliteIndexable;
    aggregateId: SqliteIndexable;
    version: SqliteIndexable;
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
export const eventTable = sqliteTable(
  'event',
  eventColumns,
  eventTableConstraints,
);
