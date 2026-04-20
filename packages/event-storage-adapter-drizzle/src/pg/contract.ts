import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

type RequiredPgColumns = {
  aggregateName: PgColumn;
  aggregateId: PgColumn;
  version: PgColumn;
  type: PgColumn;
  payload: PgColumn;
  metadata: PgColumn;
  timestamp: PgColumn;
};

/**
 * Compile-time constraint on the `eventTable` passed to the pg adapter
 * constructor. Ensures the seven required columns are present with
 * dialect-appropriate Drizzle column types while still allowing the caller
 * to spread in extras (tenant_id, correlation_id, audit columns, etc.).
 *
 * The phantom `Dialect` parameter exists so the per-dialect contract names
 * (`PgEventTableContract`, `MysqlEventTableContract`, `SqliteEventTableContract`)
 * can all be re-exported from the package root without type-identity collision.
 */
export type PgEventTableContract<Dialect extends 'pg' = 'pg'> = PgTable &
  RequiredPgColumns & { readonly __dialect?: Dialect };

type RequiredPgOutboxColumns = {
  id: PgColumn;
  aggregateName: PgColumn;
  aggregateId: PgColumn;
  version: PgColumn;
  createdAt: PgColumn;
  claimToken: PgColumn;
  claimedAt: PgColumn;
  processedAt: PgColumn;
  attempts: PgColumn;
  lastError: PgColumn;
  lastAttemptAt: PgColumn;
  deadAt: PgColumn;
};

/**
 * Compile-time constraint on the `outboxTable` passed to the pg adapter
 * constructor. Same rationale as `PgEventTableContract`; users may spread
 * `outboxColumns` into a custom-named table with extra columns.
 */
export type PgOutboxTableContract<Dialect extends 'pg' = 'pg'> = PgTable &
  RequiredPgOutboxColumns & { readonly __dialect?: Dialect };
