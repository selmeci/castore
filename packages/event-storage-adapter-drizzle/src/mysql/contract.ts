import type { MySqlColumn, MySqlTable } from 'drizzle-orm/mysql-core';

type RequiredMysqlColumns = {
  aggregateName: MySqlColumn;
  aggregateId: MySqlColumn;
  version: MySqlColumn;
  type: MySqlColumn;
  payload: MySqlColumn;
  metadata: MySqlColumn;
  timestamp: MySqlColumn;
};

/**
 * Compile-time constraint on the `eventTable` passed to the mysql adapter
 * constructor. See `PgEventTableContract` for the overall rationale.
 */
export type MysqlEventTableContract<Dialect extends 'mysql' = 'mysql'> =
  MySqlTable & RequiredMysqlColumns & { readonly __dialect?: Dialect };

type RequiredMysqlOutboxColumns = {
  id: MySqlColumn;
  aggregateName: MySqlColumn;
  aggregateId: MySqlColumn;
  version: MySqlColumn;
  createdAt: MySqlColumn;
  claimToken: MySqlColumn;
  claimedAt: MySqlColumn;
  processedAt: MySqlColumn;
  attempts: MySqlColumn;
  lastError: MySqlColumn;
  lastAttemptAt: MySqlColumn;
  deadAt: MySqlColumn;
};

export type MysqlOutboxTableContract<Dialect extends 'mysql' = 'mysql'> =
  MySqlTable & RequiredMysqlOutboxColumns & { readonly __dialect?: Dialect };
