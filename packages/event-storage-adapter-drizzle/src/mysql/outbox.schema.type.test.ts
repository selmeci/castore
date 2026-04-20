import { mysqlTable, varchar } from 'drizzle-orm/mysql-core';

import type { MysqlOutboxTableContract } from './contract';
import { outboxColumns, outboxTable, outboxTableConstraints } from './schema';

/** Happy path: the prebuilt `outboxTable` satisfies the contract. */
const _contractOk: MysqlOutboxTableContract = outboxTable;
_contractOk;

/** Extension path: spreading `outboxColumns` + user extras still conforms. */
const myOutbox = mysqlTable(
  'my_outbox',
  {
    ...outboxColumns,
    tenantId: varchar('tenant_id', { length: 64 }),
  },
  outboxTableConstraints,
);
const _extensionOk: MysqlOutboxTableContract = myOutbox;
_extensionOk;

/** Error path: missing `claim_token` column MUST NOT satisfy the contract. */
// @ts-expect-error — claim_token is absent
const _missingClaimToken: MysqlOutboxTableContract = mysqlTable(
  'bad_missing_claim_token',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    aggregateName: varchar('aggregate_name', { length: 255 }).notNull(),
    aggregateId: varchar('aggregate_id', { length: 64 }).notNull(),
    version: varchar('version', { length: 16 }).notNull(),
    createdAt: varchar('created_at', { length: 32 }).notNull(),
    claimedAt: varchar('claimed_at', { length: 32 }),
    processedAt: varchar('processed_at', { length: 32 }),
    attempts: varchar('attempts', { length: 16 }).notNull(),
    lastError: varchar('last_error', { length: 2048 }),
    lastAttemptAt: varchar('last_attempt_at', { length: 32 }),
    deadAt: varchar('dead_at', { length: 32 }),
  },
);
