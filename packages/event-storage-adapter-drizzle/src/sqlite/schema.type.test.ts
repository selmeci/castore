import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import type { SqliteEventTableContract } from './contract';
import { eventColumns, eventTable, eventTableConstraints } from './schema';

/**
 * Happy path: the prebuilt `eventTable` satisfies the contract.
 */
const _contractOk: SqliteEventTableContract = eventTable;
_contractOk;

/**
 * Extension path: spreading `eventColumns` into a user-defined table with an
 * extra nullable column still produces a contract-satisfying table.
 */
const myEvents = sqliteTable(
  'my_events',
  {
    ...eventColumns,
    tenantId: text('tenant_id'),
  },
  eventTableConstraints,
);
const _extensionOk: SqliteEventTableContract = myEvents;
_extensionOk;

/**
 * Error path — missing required column (`version`) MUST NOT satisfy the
 * contract. `@ts-expect-error` inverts the assertion: tsc fails the build if
 * the next statement does NOT error.
 */
// @ts-expect-error — the `version` column is absent, so this table must not be assignable to the contract
const _missingVersion: SqliteEventTableContract = sqliteTable(
  'bad_missing_version',
  {
    aggregateName: text('aggregate_name').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    type: text('type').notNull(),
    payload: text('payload'),
    metadata: text('metadata'),
    timestamp: text('timestamp').notNull(),
  },
);

/**
 * Error path — renaming a required column (`aggregateId` → `id`) MUST NOT
 * satisfy the contract.
 */
// @ts-expect-error — `aggregateId` has been renamed to `id`, so this table must not be assignable to the contract
const _renamedColumn: SqliteEventTableContract = sqliteTable(
  'bad_renamed_column',
  {
    aggregateName: text('aggregate_name').notNull(),
    id: text('id').notNull(),
    version: integer('version').notNull(),
    type: text('type').notNull(),
    payload: text('payload'),
    metadata: text('metadata'),
    timestamp: text('timestamp').notNull(),
  },
);
