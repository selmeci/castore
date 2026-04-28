import { expectTypeOf } from 'vitest';

import type { EventStorageAdapter } from '@castore/core';

import type { OutboxColumnTable } from '../common/outbox/selectColumns';
import type { BoundClaim, OutboxDialect } from '../relay';
import type {
  OutboxConformanceSetup,
  OutboxConformanceSetupResult,
} from './outboxConformance';
import { makeOutboxConformanceSuite } from './outboxConformance';

// The factory's generic parameters must accept any EventStorageAdapter — the
// outbox-capability invariant is enforced at runtime by `createOutboxRelay`
// (isOutboxEnabledAdapter), not at the factory's type boundary, because the
// dialect adapters expose the capability symbols as structurally optional.
type Adapter = EventStorageAdapter;

interface FakeTable {
  id: 'id-col';
  aggregateName: 'agg-name-col';
  aggregateId: 'agg-id-col';
  version: 'version-col';
  createdAt: 'created-col';
  claimToken: 'claim-token-col';
  claimedAt: 'claimed-at-col';
  processedAt: 'processed-at-col';
  attempts: 'attempts-col';
  lastError: 'last-error-col';
  lastAttemptAt: 'last-attempt-col';
  deadAt: 'dead-at-col';
}

// FakeTable satisfies the OutboxColumnTable contract.
expectTypeOf<FakeTable>().toExtend<OutboxColumnTable>();

// The factory is callable with an EventStorageAdapter + OutboxColumnTable.
expectTypeOf(makeOutboxConformanceSuite<Adapter, FakeTable>).toBeFunction();

// The setup result exposes every field scenarios require.
type Setup = OutboxConformanceSetupResult<Adapter, FakeTable>;
expectTypeOf<Setup['adapter']>().toEqualTypeOf<Adapter>();
expectTypeOf<Setup['claim']>().toEqualTypeOf<BoundClaim>();
expectTypeOf<Setup['reset']>().toEqualTypeOf<() => Promise<void>>();
expectTypeOf<Setup['backdateClaimedAt']>().toEqualTypeOf<
  (rowId: string, msAgo: number) => Promise<void>
>();
expectTypeOf<Setup['uniqueConstraintExists']>().toEqualTypeOf<
  () => Promise<boolean>
>();

// The factory config is parametric over OutboxDialect — pg/mysql/sqlite.
type Config = OutboxConformanceSetup<Adapter, FakeTable>;
expectTypeOf<Config['dialectName']>().toEqualTypeOf<OutboxDialect>();

// Negative: a table object missing one of the outbox columns must NOT
// satisfy the OutboxColumnTable constraint that the factory requires.
interface BadTable {
  id: 'id-col';
  // Missing aggregateName, aggregateId, version, etc. — incomplete contract.
}
// @ts-expect-error incomplete table type is not assignable to OutboxColumnTable
type _NegativeTable = OutboxConformanceSetupResult<Adapter, BadTable>;
