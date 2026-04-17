import type { SQL } from 'drizzle-orm';
import type { ExtraConfigColumn, IndexBuilder } from 'drizzle-orm/pg-core';
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle column definitions for the Castore event table (pg dialect).
 *
 * Users may pass this package's prebuilt `eventTable` directly, or spread
 * these columns into their own `pgTable(...)` call to add extras
 * (tenant_id, correlation_id, audit columns, etc.). Extras must be
 * nullable or have a DB-side default.
 *
 * Column types are fixed by the adapter contract and MUST NOT be overridden:
 * - aggregate_name / aggregate_id / type → `text` (unlimited)
 * - version                              → `integer` (INT32; EventDetail.version is `number`)
 * - payload / metadata                   → `jsonb` (nullable; parsed JS value on read)
 * - timestamp                            → `timestamptz(3)` with `defaultNow()`
 */
export const eventColumns = {
  aggregateName: text('aggregate_name').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  version: integer('version').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload'),
  metadata: jsonb('metadata'),
  timestamp: timestamp('timestamp', { withTimezone: true, precision: 3 })
    .notNull()
    .defaultNow(),
};

/**
 * Third-argument callback for `pgTable(...)` — declares the unique index
 * `UNIQUE (aggregate_name, aggregate_id, version)` the adapter relies on for
 * version-conflict detection.
 *
 * The constraint name `event_aggregate_version_uq` is stable across dialects
 * so adapter code can reason about duplicate-key errors by name if needed.
 *
 * In Drizzle 0.45.x the third-arg callback returns an array; the object-form
 * (`(t) => ({ idx: uniqueIndex(...) })`) is deprecated.
 */
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

/**
 * Prebuilt event table for users who do not need any extra columns.
 * Default table name is `event`.
 */
export const eventTable = pgTable('event', eventColumns, eventTableConstraints);
