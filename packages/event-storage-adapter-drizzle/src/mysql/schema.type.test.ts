import { datetime, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

import type { MysqlEventTableContract } from './contract';
import { eventColumns, eventTable, eventTableConstraints } from './schema';

/**
 * Happy path: the prebuilt `eventTable` satisfies the contract.
 */
const _contractOk: MysqlEventTableContract = eventTable;
_contractOk;

/**
 * Extension path: spreading `eventColumns` into a user-defined table with an
 * extra nullable column still produces a contract-satisfying table.
 */
const myEvents = mysqlTable(
  'my_events',
  {
    ...eventColumns,
    tenantId: varchar('tenant_id', { length: 64 }),
  },
  eventTableConstraints,
);
const _extensionOk: MysqlEventTableContract = myEvents;
_extensionOk;

/**
 * Error path — missing required column (`version`) MUST NOT satisfy the
 * contract. `@ts-expect-error` inverts the assertion: tsc fails the build if
 * the next statement does NOT error.
 */
// @ts-expect-error — the `version` column is absent, so this table must not be assignable to the contract
const _missingVersion: MysqlEventTableContract = mysqlTable(
  'bad_missing_version',
  {
    aggregateName: varchar('aggregate_name', { length: 255 }).notNull(),
    aggregateId: varchar('aggregate_id', { length: 64 }).notNull(),
    type: varchar('type', { length: 255 }).notNull(),
    payload: varchar('payload', { length: 255 }),
    metadata: varchar('metadata', { length: 255 }),
    timestamp: datetime('timestamp', { mode: 'string', fsp: 3 }).notNull(),
  },
);

/**
 * Error path — renaming a required column (`aggregateId` → `id`) MUST NOT
 * satisfy the contract.
 */
// @ts-expect-error — `aggregateId` has been renamed to `id`, so this table must not be assignable to the contract
const _renamedColumn: MysqlEventTableContract = mysqlTable(
  'bad_renamed_column',
  {
    aggregateName: varchar('aggregate_name', { length: 255 }).notNull(),
    id: varchar('id', { length: 64 }).notNull(),
    version: int('version').notNull(),
    type: varchar('type', { length: 255 }).notNull(),
    payload: varchar('payload', { length: 255 }),
    metadata: varchar('metadata', { length: 255 }),
    timestamp: datetime('timestamp', { mode: 'string', fsp: 3 }).notNull(),
  },
);
