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
