import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { vi } from 'vitest';

import {
  ConnectedEventStore,
  EventStore,
  EventType,
  NotificationMessageBus,
  type EventDetail,
  type EventStorageAdapter,
} from '@castore/core';

import { dialectNow } from '../common/outbox/fencedUpdate';
import {
  selectOutboxColumns,
  type OutboxColumnTable,
} from '../common/outbox/selectColumns';
import type {
  OutboxRow,
  RelayChannel,
  RelayRegistryEntry,
} from '../common/outbox/types';
import {
  createOutboxRelay,
  DuplicateEventStoreIdError,
  InvalidPublishTimeoutError,
  RegistryEntryMismatchError,
} from '../relay';
import type { BoundClaim, OutboxDialect } from '../relay';

/**
 * Shape returned by the per-dialect `setup()` callback. The per-dialect test
 * file owns the DB / testcontainer / schema lifecycle and builds the adapter,
 * outbox table handle, registry pieces, bound claim closure, reset fn, and
 * dialect-specific SQL helpers. The factory is dialect-agnostic.
 */
export interface OutboxConformanceSetupResult<
  A extends EventStorageAdapter,
  T extends OutboxColumnTable,
> {
  /** Outbox-enabled adapter built against the shared DB + outbox table. */
  adapter: A;
  /** Drizzle db handle (pg/mysql/sqlite). Opaque to the factory; used for raw SQL. */
  db: any;
  /** Dialect outbox table contract (Drizzle schema object). */
  outboxTable: T;
  /** ConnectedEventStore whose adapter === `adapter`; drives the registry. */
  connectedEventStore: ConnectedEventStore;
  /** Notification or StateCarrying bus; the relay publishes through it. */
  channel: RelayChannel;
  /** Pre-bound claim closure — dialect-specific (claimPg/Mysql/Sqlite) with db + outboxTable already captured. */
  claim: BoundClaim;
  /** Drop-and-recreate event + outbox tables between scenarios. */
  reset: () => Promise<void>;
  /** Backdate claimed_at by `msAgo` using dialect-authoritative time. Required for TTL recovery scenarios. */
  backdateClaimedAt: (rowId: string, msAgo: number) => Promise<void>;
  /** Dialect-specific introspection of the `outbox_aggregate_version_uq` unique constraint. */
  uniqueConstraintExists: () => Promise<boolean>;
}

export interface OutboxConformanceSetup<
  A extends EventStorageAdapter,
  T extends OutboxColumnTable,
> {
  dialectName: OutboxDialect;
  adapterClass: abstract new (...args: any[]) => A;
  setup: () => Promise<OutboxConformanceSetupResult<A, T>>;
  teardown: () => Promise<void>;
}

// Shared fixtures — every dialect runs the same event store + channel shape so
// scenarios only need to vary behavior, not plumbing.

const counterEventType = new EventType({ type: 'COUNTER_INCREMENTED' });

interface CounterAggregate {
  aggregateId: string;
  version: number;
  count: number;
}

export const makeCounterEventStore = (eventStoreId: string): EventStore =>
  new EventStore({
    eventStoreId,
    eventTypes: [counterEventType],
    reducer: (
      agg: CounterAggregate | undefined,
      event: EventDetail,
    ): CounterAggregate => ({
      aggregateId: event.aggregateId,
      version: event.version,
      count: (agg?.count ?? 0) + 1,
    }),
  });

export const makeCounterBus = (eventStoreId: string): NotificationMessageBus =>
  new NotificationMessageBus({
    messageBusId: `${eventStoreId}-bus`,
    sourceEventStores: [makeCounterEventStore(eventStoreId)],
  });

const pushCounterEvent = async (
  ces: ConnectedEventStore,
  aggregateId: string,
  version: number,
  timestamp?: string,
): Promise<void> => {
  await ces.pushEvent(
    {
      aggregateId,
      version,
      type: 'COUNTER_INCREMENTED',
      timestamp: timestamp ?? new Date().toISOString(),
      payload: { at: version },
    },
    { force: false },
  );
};

const selectRowByKey = async <T extends OutboxColumnTable>(
  db: any,
  outboxTable: T,
  aggregateId: string,
  version: number,
): Promise<OutboxRow | undefined> => {
  const rows = (await db
    .select(selectOutboxColumns(outboxTable))
    .from(outboxTable)
    .where(eq(outboxTable.aggregateId as never, aggregateId))) as OutboxRow[];

  return rows.find(r => r.version === version);
};

const markRowProcessed = async <T extends OutboxColumnTable>(
  db: any,
  outboxTable: T,
  rowId: string,
  dialect: OutboxDialect,
): Promise<void> => {
  await db
    .update(outboxTable)
    .set({
      processedAt: dialectNow(dialect),
      claimToken: null,
      claimedAt: null,
    })
    .where(eq(outboxTable.id as never, rowId));
};

/**
 * Dialect-agnostic conformance suite for the transactional outbox relay.
 * Every scenario here runs byte-identically against pg, mysql, and sqlite —
 * that is the guarantee R24 / R28 demand. The scenarios pin mechanism-level
 * invariants (fencing row count, error classes, hook invocation counts)
 * rather than just end-state shapes.
 *
 * Call at the top level of a per-dialect `*.unit.test.ts` file after the
 * existing `makeAdapterConformanceSuite` invocation.
 *
 * The per-dialect file owns the testcontainer / in-process DB / DDL lifecycle
 * via the setup/teardown callbacks; the factory only wires beforeAll /
 * beforeEach / afterAll and the assertions.
 */
export const makeOutboxConformanceSuite = <
  A extends EventStorageAdapter,
  T extends OutboxColumnTable,
>(
  config: OutboxConformanceSetup<A, T>,
): void => {
  const { dialectName, setup, teardown } = config;

  describe(`drizzle ${dialectName} outbox relay — conformance`, () => {
    let ctx: OutboxConformanceSetupResult<A, T>;

    const buildRegistry = () => {
      const publishSpy = vi
        .spyOn(ctx.channel, 'publishMessage')
        .mockResolvedValue(undefined as never);

      const registry: RelayRegistryEntry[] = [
        {
          eventStoreId: ctx.connectedEventStore.eventStoreId,
          connectedEventStore: ctx.connectedEventStore,
          channel: ctx.channel,
        },
      ];

      return { registry, publishSpy };
    };

    const makeRelay = (
      registry: RelayRegistryEntry[],
      extra?: Partial<Parameters<typeof createOutboxRelay>[0]>,
    ): ReturnType<typeof createOutboxRelay> =>
      createOutboxRelay({
        dialect: dialectName,
        adapter: ctx.adapter,
        db: ctx.db,
        outboxTable: ctx.outboxTable,
        claim: ctx.claim,
        registry,
        ...extra,
      });

    beforeAll(async () => {
      ctx = await setup();
    }, 120_000);

    beforeEach(async () => {
      await ctx.reset();
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      await teardown();
    });

    describe('atomic write path (R7, R9)', () => {
      it('pushEvent inserts event + outbox rows atomically with NEW state', async () => {
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);

        const row = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        expect(row).toBeDefined();
        expect(row?.claim_token).toBeNull();
        expect(row?.claimed_at).toBeNull();
        expect(row?.processed_at).toBeNull();
        expect(row?.dead_at).toBeNull();
        expect(row?.attempts).toBe(0);

        const { events } = await ctx.adapter.getEvents(aggregateId, {
          eventStoreId: ctx.connectedEventStore.eventStoreId,
        });
        expect(events).toHaveLength(1);
      });

      it('outbox_aggregate_version_uq unique constraint exists after reset', async () => {
        // R9 — outbox schema shape (DDL introspection at the real DB).
        const exists = await ctx.uniqueConstraintExists();
        expect(exists).toBe(true);
      });
    });

    describe('claim + FIFO (R12)', () => {
      it('per-aggregate FIFO: claims the earliest-version row first', async () => {
        const aggregateId = randomUUID();
        const now = Date.now();
        for (let v = 1; v <= 3; v += 1) {
          await pushCounterEvent(
            ctx.connectedEventStore,
            aggregateId,
            v,
            new Date(now + v).toISOString(),
          );
        }

        const versions: number[] = [];
        for (let i = 0; i < 3; i += 1) {
          const claimed = await ctx.claim({
            workerClaimToken: `w-${i}`,
            aggregateNames: [ctx.connectedEventStore.eventStoreId],
            batchSize: 1,
            claimTimeoutMs: 60_000,
          });
          expect(claimed).toHaveLength(1);
          versions.push(claimed[0]!.version);
          await markRowProcessed(
            ctx.db,
            ctx.outboxTable,
            claimed[0]!.id,
            dialectName,
          );
        }
        expect(versions).toStrictEqual([1, 2, 3]);
      });

      it('TTL recovery (R13): stale claim is reclaimable by a different worker', async () => {
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);

        const claimedA = await ctx.claim({
          workerClaimToken: 'worker-A',
          aggregateNames: [ctx.connectedEventStore.eventStoreId],
          batchSize: 10,
          claimTimeoutMs: 60_000,
        });
        expect(claimedA).toHaveLength(1);
        const rowId = claimedA[0]!.id;

        // A second claim with the same TTL must NOT pick this row back up —
        // TTL hasn't expired yet.
        const immediateRe = await ctx.claim({
          workerClaimToken: 'worker-B',
          aggregateNames: [ctx.connectedEventStore.eventStoreId],
          batchSize: 10,
          claimTimeoutMs: 60_000,
        });
        expect(immediateRe).toHaveLength(0);

        // Backdate past TTL; now worker B can reclaim.
        await ctx.backdateClaimedAt(rowId, 10 * 60_000);

        const claimedB = await ctx.claim({
          workerClaimToken: 'worker-B',
          aggregateNames: [ctx.connectedEventStore.eventStoreId],
          batchSize: 10,
          claimTimeoutMs: 60_000,
        });
        expect(claimedB).toHaveLength(1);
        expect(claimedB[0]!.id).toBe(rowId);
        expect(claimedB[0]!.claim_token).toBe('worker-B');
      });

      it('claim() ignores rows whose aggregate_name is not in the registry', async () => {
        // R11 — registry validation at claim time. Push rows for a different
        // event store id; they must NOT be picked up when aggregateNames
        // excludes that id.
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);

        const claimed = await ctx.claim({
          workerClaimToken: 'w',
          aggregateNames: ['some-other-store-not-in-registry'],
          batchSize: 10,
          claimTimeoutMs: 60_000,
        });
        expect(claimed).toHaveLength(0);
      });
    });

    describe('registry validation (R11)', () => {
      it('rejects duplicate eventStoreId at construction', () => {
        const entry: RelayRegistryEntry = {
          eventStoreId: ctx.connectedEventStore.eventStoreId,
          connectedEventStore: ctx.connectedEventStore,
          channel: ctx.channel,
        };
        expect(() => makeRelay([entry, { ...entry }])).toThrow(
          DuplicateEventStoreIdError,
        );
      });

      it('rejects mismatched eventStoreId at construction', () => {
        const entry: RelayRegistryEntry = {
          eventStoreId: 'declared-different',
          connectedEventStore: ctx.connectedEventStore,
          channel: ctx.channel,
        };
        expect(() => makeRelay([entry])).toThrow(RegistryEntryMismatchError);
      });

      it('rejects publishTimeoutMs >= claimTimeoutMs at construction', () => {
        expect(() =>
          makeRelay(
            [
              {
                eventStoreId: ctx.connectedEventStore.eventStoreId,
                connectedEventStore: ctx.connectedEventStore,
                channel: ctx.channel,
              },
            ],
            { options: { claimTimeoutMs: 1000, publishTimeoutMs: 2000 } },
          ),
        ).toThrow(InvalidPublishTimeoutError);
      });
    });

    describe('runOnce happy path (R18)', () => {
      it('claims, publishes, marks processed, and releases claim token', async () => {
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);

        const { registry, publishSpy } = buildRegistry();
        const relay = makeRelay(registry);

        const result = await relay.runOnce();
        expect(result.claimed).toBe(1);
        expect(result.processed).toBe(1);
        expect(result.dead).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.fencedNoOps).toBe(0);
        expect(publishSpy).toHaveBeenCalledOnce();

        const row = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        expect(row?.processed_at).not.toBeNull();
        expect(row?.claim_token).toBeNull();
        expect(row?.claimed_at).toBeNull();
        expect(row?.dead_at).toBeNull();
      });
    });
  });
};
