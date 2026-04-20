import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

type RequiredSqliteColumns = {
  aggregateName: SQLiteColumn;
  aggregateId: SQLiteColumn;
  version: SQLiteColumn;
  type: SQLiteColumn;
  payload: SQLiteColumn;
  metadata: SQLiteColumn;
  timestamp: SQLiteColumn;
};

/**
 * Compile-time constraint on the `eventTable` passed to the sqlite adapter
 * constructor. See `PgEventTableContract` for the overall rationale.
 */
export type SqliteEventTableContract<Dialect extends 'sqlite' = 'sqlite'> =
  SQLiteTable & RequiredSqliteColumns & { readonly __dialect?: Dialect };

type RequiredSqliteOutboxColumns = {
  id: SQLiteColumn;
  aggregateName: SQLiteColumn;
  aggregateId: SQLiteColumn;
  version: SQLiteColumn;
  createdAt: SQLiteColumn;
  claimToken: SQLiteColumn;
  claimedAt: SQLiteColumn;
  processedAt: SQLiteColumn;
  attempts: SQLiteColumn;
  lastError: SQLiteColumn;
  lastAttemptAt: SQLiteColumn;
  deadAt: SQLiteColumn;
};

export type SqliteOutboxTableContract<Dialect extends 'sqlite' = 'sqlite'> =
  SQLiteTable & RequiredSqliteOutboxColumns & { readonly __dialect?: Dialect };
