import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import type { PgEventTableContract } from './contract';
import { eventColumns, eventTable, eventTableConstraints } from './schema';

/**
 * Happy path: the prebuilt `eventTable` satisfies the contract.
 */
const _contractOk: PgEventTableContract = eventTable;
_contractOk;

/**
 * Extension path: spreading `eventColumns` into a user-defined table with an
 * extra nullable column still produces a contract-satisfying table.
 */
const myEvents = pgTable(
  'my_events',
  {
    ...eventColumns,
    tenantId: text('tenant_id'),
  },
  eventTableConstraints,
);
const _extensionOk: PgEventTableContract = myEvents;
_extensionOk;

/**
 * Error path — missing required column (`version`) MUST NOT satisfy the
 * contract. `@ts-expect-error` inverts the assertion: tsc fails the build if
 * the next statement does NOT error.
 */
// @ts-expect-error — the `version` column is absent, so this table must not be assignable to the contract
const _missingVersion: PgEventTableContract = pgTable('bad_missing_version', {
  aggregateName: text('aggregate_name').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  type: text('type').notNull(),
  payload: text('payload'),
  metadata: text('metadata'),
  timestamp: timestamp('timestamp', {
    withTimezone: true,
    precision: 3,
  }).notNull(),
});

/**
 * Error path — renaming a required column (`aggregateId` → `id`) MUST NOT
 * satisfy the contract.
 */
// @ts-expect-error — `aggregateId` has been renamed to `id`, so this table must not be assignable to the contract
const _renamedColumn: PgEventTableContract = pgTable('bad_renamed_column', {
  aggregateName: text('aggregate_name').notNull(),
  id: text('id').notNull(),
  version: integer('version').notNull(),
  type: text('type').notNull(),
  payload: text('payload'),
  metadata: text('metadata'),
  timestamp: timestamp('timestamp', {
    withTimezone: true,
    precision: 3,
  }).notNull(),
});
