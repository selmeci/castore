import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { ExtraConfigColumn, IndexBuilder } from 'drizzle-orm/pg-core';
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
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

/**
 * Drizzle column definitions for the outbox table (pg dialect).
 *
 * Pointer-shaped (no payload column): the relay reads the source event row at
 * publish time via the adapter's symbol-keyed single-row lookup. See origin
 * R9 for the full column-by-column rationale.
 *
 * All mutation timestamps are DB-authoritative — set via `NOW()` in the
 * adapter's write SQL rather than from worker wall-clock. `created_at` has a
 * `defaultNow()` so plain Drizzle inserts automatically pick up server time.
 *
 * `last_error` is capped at 2048 chars by scrubber-side truncation (see
 * `common/outbox/scrubber.ts`); no DB-level CHECK constraint to keep the
 * ergonomics consistent across the three dialects.
 */
export const outboxColumns = {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  aggregateName: text('aggregate_name').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  version: integer('version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 })
    .notNull()
    .defaultNow(),
  claimToken: text('claim_token'),
  claimedAt: timestamp('claimed_at', { withTimezone: true, precision: 3 }),
  processedAt: timestamp('processed_at', { withTimezone: true, precision: 3 }),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  lastAttemptAt: timestamp('last_attempt_at', {
    withTimezone: true,
    precision: 3,
  }),
  deadAt: timestamp('dead_at', { withTimezone: true, precision: 3 }),
};

/**
 * Third-arg constraints for the outbox table. The unique index on
 * `(aggregate_name, aggregate_id, version)` is load-bearing for both the
 * write-side idempotency (same pair can't be inserted twice) and the
 * claim-eligibility FIFO-exclusion query.
 */
export const outboxTableConstraints = <
  TTable extends {
    aggregateName: PgIndexable;
    aggregateId: PgIndexable;
    version: PgIndexable;
  },
>(
  table: TTable,
): [IndexBuilder] => [
  uniqueIndex('outbox_aggregate_version_uq').on(
    table.aggregateName,
    table.aggregateId,
    table.version,
  ),
];

/**
 * Prebuilt outbox table for users who do not need any extra columns.
 * Default table name is `castore_outbox`.
 */
export const outboxTable = pgTable(
  'castore_outbox',
  outboxColumns,
  outboxTableConstraints,
);
