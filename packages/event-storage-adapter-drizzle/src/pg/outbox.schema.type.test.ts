import { pgTable, text } from 'drizzle-orm/pg-core';

import type { PgOutboxTableContract } from './contract';
import { outboxColumns, outboxTable, outboxTableConstraints } from './schema';

/** Happy path: the prebuilt `outboxTable` satisfies the contract. */
const _contractOk: PgOutboxTableContract = outboxTable;
_contractOk;

/** Extension path: spreading `outboxColumns` + user extras still conforms. */
const myOutbox = pgTable(
  'my_outbox',
  {
    ...outboxColumns,
    tenantId: text('tenant_id'),
  },
  outboxTableConstraints,
);
const _extensionOk: PgOutboxTableContract = myOutbox;
_extensionOk;

/** Error path: missing `claim_token` column MUST NOT satisfy the contract. */
// @ts-expect-error — claim_token is absent
const _missingClaimToken: PgOutboxTableContract = pgTable(
  'bad_missing_claim_token',
  {
    id: text('id').primaryKey(),
    aggregateName: text('aggregate_name').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    version: text('version').notNull(),
    createdAt: text('created_at').notNull(),
    claimedAt: text('claimed_at'),
    processedAt: text('processed_at'),
    attempts: text('attempts').notNull(),
    lastError: text('last_error'),
    lastAttemptAt: text('last_attempt_at'),
    deadAt: text('dead_at'),
  },
);
