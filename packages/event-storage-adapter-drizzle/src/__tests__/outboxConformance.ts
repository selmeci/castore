import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { vi } from 'vitest';

import {
  ConnectedEventStore,
  EventStore,
  EventType,
  GroupedEvent,
  NotificationMessageBus,
  type EventDetail,
  type EventStorageAdapter,
} from '@castore/core';

import { dialectNow, fencedUpdate } from '../common/outbox/fencedUpdate';
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
  OutboxPublishTimeoutError,
  OutboxRowNotFoundError,
  RegistryEntryMismatchError,
  RetryRowClaimedError,
  UnsupportedChannelTypeError,
} from '../relay';
import type { BoundClaim, OutboxDialect } from '../relay';

/**
 * Minimal Drizzle database surface used by the conformance helpers.
 * Every per-dialect setup returns an actual Drizzle database class (PgDatabase,
 * MySqlDatabase, etc.); this interface is only used for internal structural
 * typing inside the test suite so the exported types stay free of `any`.
 *
 * Drizzle's `select(...).from(...)` is a thenable that resolves to rows AND
 * has a `.where(...)` that itself resolves to rows. Modelled here as the
 * intersection of `Promise<unknown[]>` and `{ where }` so both `await
 * db.select().from(table)` and `await db.select().from(table).where(cond)`
 * type-check.
 */
type DrizzleSelectChain = Promise<unknown[]> & {
  where: (condition: unknown) => Promise<unknown[]>;
};

export interface DrizzleDatabaseLike {
  select: {
    (): { from: (source: unknown) => DrizzleSelectChain };
    (fields: unknown): { from: (source: unknown) => DrizzleSelectChain };
  };
  update: (table: unknown) => {
    set: (values: unknown) => {
      where: (condition: unknown) => Promise<unknown>;
    };
  };
}

/**
 * Shape returned by the per-dialect `setup()` callback. The per-dialect test
 * file owns the DB / testcontainer / schema lifecycle and builds the adapter,
 * outbox table handle, registry pieces, bound claim closure, reset fn, and
 * dialect-specific SQL helpers. The factory is dialect-agnostic.
 */
export interface OutboxConformanceSetupResult<
  A extends EventStorageAdapter,
  T extends OutboxColumnTable,
  D = unknown,
> {
  /** Outbox-enabled adapter built against the shared DB + outbox table. */
  adapter: A;
  /** Drizzle db handle (pg/mysql/sqlite). Opaque to the factory; used for raw SQL. */
  db: D;
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
  /** Delete the event row for an aggregateId via dialect-appropriate raw SQL. Used by nil-row dead path scenarios that simulate out-of-band event deletion. */
  deleteEventRow: (aggregateId: string) => Promise<void>;
}

export interface OutboxConformanceSetup<
  A extends EventStorageAdapter,
  T extends OutboxColumnTable,
  D = unknown,
> {
  dialectName: OutboxDialect;
  setup: () => Promise<OutboxConformanceSetupResult<A, T, D>>;
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

const selectRowByKey = async <T extends OutboxColumnTable, D = unknown>(
  db: D,
  outboxTable: T,
  aggregateId: string,
  version: number,
): Promise<OutboxRow | undefined> => {
  const rows = (await (db as unknown as DrizzleDatabaseLike)
    .select(selectOutboxColumns(outboxTable))
    .from(outboxTable)
    .where(eq(outboxTable.aggregateId as never, aggregateId))) as OutboxRow[];

  return rows.find(r => r.version === version);
};

const markRowProcessed = async <T extends OutboxColumnTable, D = unknown>(
  db: D,
  outboxTable: T,
  rowId: string,
  dialect: OutboxDialect,
): Promise<void> => {
  await (db as unknown as DrizzleDatabaseLike)
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
    let ctx: OutboxConformanceSetupResult<A, T, DrizzleDatabaseLike>;
    // Per-test mock-timer registry. Slow publishMessage mocks register their
    // setTimeout handles here so afterEach can guarantee no leaked timers
    // outlive the test. Without this, a test that fires withTimeout (which
    // wins the Promise.race at publishTimeoutMs) leaves the mock's
    // setTimeout(resolve, 600) running long after the test completes —
    // a real-timer leak that vitest's `vi.getTimerCount()` does not track
    // because it is real, not faked.
    const pendingMockTimers = new Set<ReturnType<typeof setTimeout>>();
    // Per-test unhandledRejection collector. The publishTimeoutMs scenarios
    // race a Promise.race timeout against a slow publish mock; if the mock's
    // promise rejects later (e.g. an AbortSignal-aware mock that rejects on
    // abort) we want the rejection to be observed, not silently swallowed
    // by Node's unhandledRejection handler. A loud failure here surfaces
    // "the test design left a promise dangling" instead of letting a real
    // bug masquerade as a clean run.
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };

    /**
     * AbortSignal-honoring slow-publish mock implementation. The mock
     * resolves after `ms` OR rejects when the test scope's abort fires —
     * whichever comes first. Returns a function suitable for
     * `vi.spyOn(...).mockImplementation(...)`.
     *
     * The relay's `withTimeout` does not currently thread its AbortSignal
     * into `channel.publishMessage`, so the mock cannot observe the relay-
     * side abort. Instead, the test scope provides its own controller
     * (aborted in afterEach) so the mock's pending promise unwinds at
     * test boundary instead of leaking until `ms` elapses.
     */
    const slowPublishHonoringAbort =
      (ms: number, abortSignal: AbortSignal): (() => Promise<void>) =>
      () =>
        new Promise<void>((resolve, reject) => {
          const handle = setTimeout(() => {
            pendingMockTimers.delete(handle);
            resolve();
          }, ms);
          pendingMockTimers.add(handle);
          const onAbort = (): void => {
            clearTimeout(handle);
            pendingMockTimers.delete(handle);
            reject(new Error('mock cancelled at test cleanup'));
          };
          if (abortSignal.aborted) {
            onAbort();

            return;
          }
          abortSignal.addEventListener('abort', onAbort, { once: true });
        });

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

    // Each test gets a fresh AbortController; tests that need an
    // abort-aware slow-publish mock pass `mockAbortController.signal`
    // into `slowPublishHonoringAbort`. afterEach aborts it to cancel
    // any still-pending mock promises.
    let mockAbortController: AbortController;

    beforeAll(async () => {
      ctx = (await setup()) as unknown as OutboxConformanceSetupResult<
        A,
        T,
        DrizzleDatabaseLike
      >;
      process.on('unhandledRejection', onUnhandledRejection);
    }, 120_000);

    beforeEach(async () => {
      await ctx.reset();
      vi.restoreAllMocks();
      mockAbortController = new AbortController();
      unhandledRejections.length = 0;
    });

    afterEach(() => {
      mockAbortController.abort();
      for (const handle of pendingMockTimers) {
        clearTimeout(handle);
      }
      pendingMockTimers.clear();
      // unhandledRejections from the current test must not bleed into
      // the next one. Loud failure: a leaked rejection is a contract
      // violation in the test design. (vi.getTimerCount() can not be
      // asserted here — vitest 3 throws when fake timers aren't active,
      // and the suite uses real timers throughout. The explicit
      // pendingMockTimers cleanup above is the load-bearing guard.)
      expect(unhandledRejections).toStrictEqual([]);
    });

    afterAll(async () => {
      process.off('unhandledRejection', onUnhandledRejection);
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

      // Pins the parent Key Decision: timestamps come from the dialect's
      // server-time function (`NOW()` / `NOW(3)` / `strftime`), not from
      // worker wall-clock. sqlite's `strftime` form is already exercised in
      // unit-layer tests; pg + mysql need to be checked end-to-end against
      // a real driver because their server clock and the worker process
      // clock can drift independently. Asserting the per-row created_at is
      // within seconds of `dialectNow(...)` evaluated by the same DB proves
      // that no JS-side timestamp slipped into the INSERT path.
      it.skipIf(dialectName === 'sqlite')(
        'dialectNow runtime: created_at stamped from server time, within 2s of NOW()',
        async () => {
          const aggregateId = randomUUID();
          await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);

          const rows = (await ctx.db
            .select({
              createdAt: ctx.outboxTable.createdAt,
              now: dialectNow(dialectName),
            })
            .from(ctx.outboxTable)
            .where(
              eq(ctx.outboxTable.aggregateId as never, aggregateId),
            )) as Array<{ createdAt: unknown; now: unknown }>;
          expect(rows).toHaveLength(1);

          const createdAtMs = new Date(rows[0]!.createdAt as string).getTime();
          const nowMs = new Date(rows[0]!.now as string).getTime();
          expect(Number.isFinite(createdAtMs)).toBe(true);
          expect(Number.isFinite(nowMs)).toBe(true);
          // `nowMs` is evaluated AFTER the insert, so the delta is
          // non-negative under normal conditions; a 2s window absorbs
          // testcontainer + driver latency without admitting a clock-source
          // regression.
          expect(nowMs - createdAtMs).toBeGreaterThanOrEqual(0);
          expect(nowMs - createdAtMs).toBeLessThan(2_000);
        },
      );
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

    describe('pushEventGroup atomicity (R7)', () => {
      it('commits event + outbox rows for every grouped event atomically', async () => {
        const aggregateA = randomUUID();
        const aggregateB = randomUUID();
        const ts = '2021-01-01T00:00:00.000Z';
        const groupA = new GroupedEvent({
          event: {
            aggregateId: aggregateA,
            version: 1,
            type: 'COUNTER_INCREMENTED',
            timestamp: ts,
          },
          eventStorageAdapter: ctx.adapter,
          context: { eventStoreId: ctx.connectedEventStore.eventStoreId },
        });
        const groupB = new GroupedEvent({
          event: {
            aggregateId: aggregateB,
            version: 1,
            type: 'COUNTER_INCREMENTED',
            timestamp: ts,
          },
          eventStorageAdapter: ctx.adapter,
          context: { eventStoreId: ctx.connectedEventStore.eventStoreId },
        });

        await ctx.adapter.pushEventGroup({}, groupA, groupB);

        const rowA = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateA,
          1,
        );
        const rowB = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateB,
          1,
        );
        expect(rowA).toBeDefined();
        expect(rowB).toBeDefined();
      });

      it('rolls back event + outbox rows when a mid-group push fails', async () => {
        const aggregateA = randomUUID();
        const aggregateB = randomUUID();
        const ts = '2021-01-01T00:00:00.000Z';

        // Pre-seed a duplicate for aggregateB v1 so the second pushEventInTx
        // fires a unique-constraint violation and the whole transaction
        // rolls back. The first event+outbox rows for aggregateA must NOT
        // survive.
        await pushCounterEvent(ctx.connectedEventStore, aggregateB, 1, ts);

        const groupA = new GroupedEvent({
          event: {
            aggregateId: aggregateA,
            version: 1,
            type: 'COUNTER_INCREMENTED',
            timestamp: ts,
          },
          eventStorageAdapter: ctx.adapter,
          context: { eventStoreId: ctx.connectedEventStore.eventStoreId },
        });
        const groupB = new GroupedEvent({
          event: {
            aggregateId: aggregateB,
            version: 1,
            type: 'COUNTER_INCREMENTED',
            timestamp: ts,
          },
          eventStorageAdapter: ctx.adapter,
          context: { eventStoreId: ctx.connectedEventStore.eventStoreId },
        });

        await expect(
          ctx.adapter.pushEventGroup({}, groupA, groupB),
        ).rejects.toThrow();

        const rowA = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateA,
          1,
        );
        expect(rowA).toBeUndefined();

        // R7 atomicity at both sides of the transaction: not just the outbox
        // pointer but the underlying event row must also be absent for
        // aggregateA. A surviving event row would be a partially-committed
        // group — the bug pushEventGroup is supposed to make impossible.
        const { events: eventsA } = await ctx.adapter.getEvents(aggregateA, {
          eventStoreId: ctx.connectedEventStore.eventStoreId,
        });
        expect(eventsA).toHaveLength(0);
      });
    });

    describe('fencing-token correctness (R14)', () => {
      it('slow worker A is fenced out after worker B TTL-reclaims', async () => {
        // Load-bearing invariant: worker A claims row and begins publish;
        // worker B reclaims after TTL; worker A's subsequent mark-processed
        // MUST no-op (fencedUpdate returns 0) rather than double-stamp the
        // row. Without the fencing predicate this would silently double-
        // publish.
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);

        const claimedA = await ctx.claim({
          workerClaimToken: 'worker-A',
          aggregateNames: [ctx.connectedEventStore.eventStoreId],
          batchSize: 1,
          claimTimeoutMs: 60_000,
        });
        expect(claimedA).toHaveLength(1);
        const rowId = claimedA[0]!.id;

        // Simulate worker A's publish being slow enough that worker B's TTL
        // reclaim fires first.
        await ctx.backdateClaimedAt(rowId, 10 * 60_000);
        const claimedB = await ctx.claim({
          workerClaimToken: 'worker-B',
          aggregateNames: [ctx.connectedEventStore.eventStoreId],
          batchSize: 1,
          claimTimeoutMs: 60_000,
        });
        expect(claimedB).toHaveLength(1);
        expect(claimedB[0]!.id).toBe(rowId);

        // Worker A's stale fencedUpdate returns 0 affected rows — NOT 1.
        const affectedA = await fencedUpdate({
          dialect: dialectName,
          db: ctx.db,
          outboxTable: ctx.outboxTable,
          rowId,
          currentClaimToken: 'worker-A',
          set: { processedAt: dialectNow(dialectName) },
        });
        expect(affectedA).toBe(0);

        // Worker B's fencedUpdate still succeeds.
        const affectedB = await fencedUpdate({
          dialect: dialectName,
          db: ctx.db,
          outboxTable: ctx.outboxTable,
          rowId,
          currentClaimToken: 'worker-B',
          set: { processedAt: dialectNow(dialectName) },
        });
        expect(affectedB).toBe(1);

        // Final state: processed_at stamped exactly once (by B).
        const row = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        expect(row?.processed_at).not.toBeNull();
      });
    });

    describe('dead state + retry (R16, R17, R19)', () => {
      it('transitions to dead_at after maxAttempts failures; onDead fires once; onFail fires maxAttempts-1 times', async () => {
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);

        const { registry } = buildRegistry();
        const publishSpy = vi
          .spyOn(ctx.channel, 'publishMessage')
          .mockRejectedValue(new Error('bus unavailable: ignite the retry'));
        const onDead = vi.fn();
        const onFail = vi.fn();
        const maxAttempts = 3;

        const relay = makeRelay(registry, {
          hooks: { onDead, onFail },
          options: { maxAttempts, baseMs: 1, ceilingMs: 10 },
        });

        // Each runOnce increments attempts and reclaims on next call (the
        // failed row releases claim_token via the retry path). After
        // maxAttempts runs the row transitions to dead_at.
        for (let i = 0; i < maxAttempts; i += 1) {
          await relay.runOnce();
        }

        const row = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        expect(row?.dead_at).not.toBeNull();
        expect(row?.attempts).toBe(maxAttempts);
        expect(row?.last_error).toContain('bus unavailable');
        expect(onDead).toHaveBeenCalledTimes(1);
        expect(onFail).toHaveBeenCalledTimes(maxAttempts - 1);
        expect(publishSpy).toHaveBeenCalledTimes(maxAttempts);
      });

      it('nil-row dead path: missing event row → immediate dead_at on claim', async () => {
        // R10 — the relay looks up the source event via
        // `adapter[OUTBOX_GET_EVENT_SYMBOL]`; if the event row was deleted
        // out-of-band between commit and claim, the publish path must
        // dead-transition the outbox row rather than retry forever.
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);

        // Delete the event row directly; the outbox pointer is left behind.
        // Per-dialect setup owns the raw SQL.
        await ctx.deleteEventRow(aggregateId);

        const { registry } = buildRegistry();
        const onDead = vi.fn();
        const relay = makeRelay(registry, { hooks: { onDead } });

        const result = await relay.runOnce();
        expect(result.dead).toBe(1);
        expect(onDead).toHaveBeenCalledTimes(1);

        const row = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        expect(row?.dead_at).not.toBeNull();
        expect(row?.claim_token).toBeNull();
      });

      it('dead row blocks newer same-aggregate rows; retryRow unblocks without force', async () => {
        // R16 — FIFO block by design: v2 must not claim while v1 is dead.
        // After retryRow (default-safe — no force:true — because relay-core
        // fix d115927 releases claim_token on dead transition), the retried
        // row becomes eligible again and unblocks v2.
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 2);

        // Drive v1 to dead.
        const { registry } = buildRegistry();
        vi.spyOn(ctx.channel, 'publishMessage').mockRejectedValue(
          new Error('bus down'),
        );
        const relay = makeRelay(registry, {
          options: { maxAttempts: 1, baseMs: 1, ceilingMs: 10 },
        });
        await relay.runOnce();

        const v1Dead = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        expect(v1Dead?.dead_at).not.toBeNull();

        // v2 must NOT claim while v1 is dead (FIFO block).
        const blocked = await ctx.claim({
          workerClaimToken: 'blocked',
          aggregateNames: [ctx.connectedEventStore.eventStoreId],
          batchSize: 10,
          claimTimeoutMs: 60_000,
        });
        expect(blocked.find(r => r.version === 2)).toBeUndefined();

        // retryRow on the dead v1 succeeds without force:true.
        const retryResult = await relay.retryRow(v1Dead!.id);
        expect(retryResult.warning).toBe('at-most-once-not-guaranteed');
        expect(retryResult.rowId).toBe(v1Dead!.id);
        expect(retryResult.forced).toBe(false);

        const v1Retried = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        expect(v1Retried?.dead_at).toBeNull();

        // Now v1 AND v2 are eligible. Drain the relay until both are
        // processed. A single runOnce isn't sufficient evidence that v2
        // unblocked — FIFO claim could legitimately return only v1 first
        // and `result.processed > 0` would still be satisfied without v2
        // ever becoming claimable. Instead, drive the relay forward and
        // assert end-state: both v1 AND v2 carry processed_at via the
        // claim/publish path (not the markRowProcessed shortcut), and v2
        // was observably claimable post-retryRow.
        vi.restoreAllMocks();
        vi.spyOn(ctx.channel, 'publishMessage').mockResolvedValue(
          undefined as never,
        );

        // First runOnce processes v1 (FIFO head).
        const firstResult = await relay.runOnce();
        expect(firstResult.processed).toBeGreaterThan(0);
        const v1Processed = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        expect(v1Processed?.processed_at).not.toBeNull();
        expect(v1Processed?.dead_at).toBeNull();

        // With v1 cleared, v2 must now be claimable — the direct
        // observable that retryRow's unblock landed at the SQL predicate.
        const v2Claimable = await ctx.claim({
          workerClaimToken: 'unblocked',
          aggregateNames: [ctx.connectedEventStore.eventStoreId],
          batchSize: 10,
          claimTimeoutMs: 60_000,
        });
        const v2Row = v2Claimable.find(r => r.version === 2);
        expect(v2Row).toBeDefined();
      });

      it('R19 hook-swallow: throwing onDead and onFail do not fail runOnce or block dead transition', async () => {
        // Pins the try/catch contract at relay/hooks.ts:9-21,26-43: a hook
        // that throws never escapes — runOnce resolves cleanly, the row
        // still transitions to dead_at, and the result reports the dead
        // count. Without swallow semantics, an operator-supplied bug in
        // onDead would propagate up and abort the whole batch.
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);

        const { registry } = buildRegistry();
        vi.spyOn(ctx.channel, 'publishMessage').mockRejectedValue(
          new Error('bus down'),
        );
        const onDead = vi.fn(() => {
          throw new Error('onDead hook misbehaving');
        });
        const onFail = vi.fn(() => {
          throw new Error('onFail hook misbehaving');
        });
        const maxAttempts = 2;
        const relay = makeRelay(registry, {
          hooks: { onDead, onFail },
          options: { maxAttempts, baseMs: 1, ceilingMs: 10 },
        });

        // First failure fires onFail (which throws). Second failure
        // exhausts maxAttempts and fires onDead (which also throws).
        // Neither rejection escapes — both runOnce calls resolve. (Note:
        // result.dead counts only the publish-returned 'dead' outcome —
        // nil-row, missing-registry — NOT maxAttempts-exhaustion via
        // handleFailure. The DB state check below is the authoritative
        // dead-transition assertion for this scenario.)
        await expect(relay.runOnce()).resolves.toBeDefined();
        await expect(relay.runOnce()).resolves.toBeDefined();

        // The dead transition completed despite both hooks throwing.
        const row = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        expect(row?.dead_at).not.toBeNull();
        expect(onFail).toHaveBeenCalledTimes(maxAttempts - 1);
        expect(onDead).toHaveBeenCalledTimes(1);
      });
    });

    describe('admin API (R20)', () => {
      it('retryRow default-safe rejects live-claim rows; force:true bypasses', async () => {
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);

        const claimed = await ctx.claim({
          workerClaimToken: 'live',
          aggregateNames: [ctx.connectedEventStore.eventStoreId],
          batchSize: 10,
          claimTimeoutMs: 60_000,
        });
        expect(claimed).toHaveLength(1);
        const rowId = claimed[0]!.id;

        const { registry } = buildRegistry();
        const relay = makeRelay(registry);

        await expect(relay.retryRow(rowId)).rejects.toBeInstanceOf(
          RetryRowClaimedError,
        );

        const forced = await relay.retryRow(rowId, { force: true });
        expect(forced.forced).toBe(true);
        expect(forced.warning).toBe('at-most-once-not-guaranteed');
      });

      it('deleteRow removes outbox row leaving event row untouched', async () => {
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);
        const row = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );

        const { registry } = buildRegistry();
        const relay = makeRelay(registry);

        const result = await relay.deleteRow(row!.id);
        expect(result.rowId).toBe(row!.id);

        // Outbox row is gone.
        const after = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        expect(after).toBeUndefined();

        // Event row still present.
        const { events } = await ctx.adapter.getEvents(aggregateId, {
          eventStoreId: ctx.connectedEventStore.eventStoreId,
        });
        expect(events).toHaveLength(1);
      });

      it('deleteRow default-safe rejects live-claim; force:true bypasses', async () => {
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);

        const claimed = await ctx.claim({
          workerClaimToken: 'live',
          aggregateNames: [ctx.connectedEventStore.eventStoreId],
          batchSize: 10,
          claimTimeoutMs: 60_000,
        });
        const rowId = claimed[0]!.id;

        const { registry } = buildRegistry();
        const relay = makeRelay(registry);

        await expect(relay.deleteRow(rowId)).rejects.toBeInstanceOf(
          RetryRowClaimedError,
        );

        const forced = await relay.deleteRow(rowId, { force: true });
        expect(forced.rowId).toBe(rowId);
      });

      it('retryRow / deleteRow throw OutboxRowNotFoundError for unknown rowId', async () => {
        const { registry } = buildRegistry();
        const relay = makeRelay(registry);
        const ghostId = randomUUID();

        await expect(relay.retryRow(ghostId)).rejects.toBeInstanceOf(
          OutboxRowNotFoundError,
        );
        await expect(relay.deleteRow(ghostId)).rejects.toBeInstanceOf(
          OutboxRowNotFoundError,
        );
      });

      it('retryRow + concurrent claim: at most one wins; the other surfaces a typed error', async () => {
        // Pins the TOCTOU guarantee at relay/admin.ts:54-57 — the default-safe
        // path is a single conditional UPDATE that the DB serialises against
        // a concurrent claim. Either the claim lands first (retryRow's WHERE
        // claim_token IS NULL fails → typed error), or retryRow lands first
        // (claim returns the freshly-cleared row OR finds 0 eligible rows
        // because retryRow's resetSet didn't write a claim). What MUST NOT
        // happen: both succeed and the row ends in a half-applied state.
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);

        const seedRow = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        const rowId = seedRow!.id;

        const { registry } = buildRegistry();
        const relay = makeRelay(registry);

        const [claimResult, retryResult] = await Promise.allSettled([
          ctx.claim({
            workerClaimToken: 'concurrent-worker',
            aggregateNames: [ctx.connectedEventStore.eventStoreId],
            batchSize: 10,
            claimTimeoutMs: 60_000,
          }),
          relay.retryRow(rowId),
        ]);

        // One of three legal observable outcomes — never a half-applied
        // double-success on the same row:
        //   A. Claim wins: claim returns the row claimed; retryRow rejects
        //      with RetryRowClaimedError (or OutboxRowNotFoundError if the
        //      row got deleted concurrently — out of scope here).
        //   B. retryRow wins, claim then re-acquires the freshly-cleared
        //      row: both fulfilled, claim returns the row.
        //   C. retryRow wins, claim runs first but found 0 eligible rows
        //      (because at SELECT time the row was already in pristine state
        //      and the connection serialisation chose to schedule retryRow
        //      first): both fulfilled, claim returns [].
        const claimRows =
          claimResult.status === 'fulfilled' ? claimResult.value : null;
        const retrySettled = retryResult.status;

        if (retrySettled === 'rejected') {
          // Outcome A: claim raced ahead. Error must be one of the typed
          // surfaces, not a generic Error.
          const reason = (retryResult as PromiseRejectedResult).reason as
            | RetryRowClaimedError
            | OutboxRowNotFoundError
            | Error;
          const isTyped =
            reason instanceof RetryRowClaimedError ||
            reason instanceof OutboxRowNotFoundError;
          expect(isTyped).toBe(true);
          expect(claimResult.status).toBe('fulfilled');
          expect(claimRows).toHaveLength(1);
          expect(claimRows![0]!.id).toBe(rowId);
        } else {
          // Outcomes B / C: retryRow won; claim either picked the row up
          // afterward (length 1) or saw a clean row first (length 0).
          expect(claimResult.status).toBe('fulfilled');
          expect([0, 1]).toContain(claimRows!.length);
          if (claimRows!.length === 1) {
            expect(claimRows![0]!.id).toBe(rowId);
            expect(claimRows![0]!.claim_token).toBe('concurrent-worker');
          }
        }

        // Whichever path won, the row's final shape is consistent — never
        // a "claim_token populated AND attempts cleared by retryRow at the
        // same time" tear.
        const finalRow = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        expect(finalRow).toBeDefined();
        // attempts is 0 in every legal outcome (either retryRow reset it,
        // or the row was never failed and it's still 0 from insert).
        expect(finalRow!.attempts).toBe(0);
      });
    });

    describe('publishTimeoutMs (R14, R15)', () => {
      it('slow publishMessage rejects with OutboxPublishTimeoutError; row routes through retry', async () => {
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);

        const { registry } = buildRegistry();
        // Slow publish that does not race the relay-side AbortSignal (today's
        // publish.ts does not thread it into channel.publishMessage). The
        // mock's setTimeout is registered with the test scope's abort
        // controller so afterEach can guarantee no leaked timer outlives
        // the test — withTimeout's timer is the load-bearing primitive
        // proving a hung bus cannot pin a worker beyond publishTimeoutMs
        // regardless of whether the bus implementation honors abort.
        vi.spyOn(ctx.channel, 'publishMessage').mockImplementation(
          slowPublishHonoringAbort(600, mockAbortController.signal),
        );
        const onFail = vi.fn();

        const relay = makeRelay(registry, {
          hooks: { onFail },
          options: {
            claimTimeoutMs: 60_000,
            publishTimeoutMs: 50,
            maxAttempts: 5,
            baseMs: 1,
            ceilingMs: 10,
          },
        });

        const result = await relay.runOnce();
        expect(result.failed).toBe(1);
        expect(onFail).toHaveBeenCalledOnce();
        const failCall = onFail.mock.calls[0] as [
          { error: unknown; attempts: number },
        ];
        expect(failCall[0].error).toBeInstanceOf(OutboxPublishTimeoutError);
        expect(failCall[0].attempts).toBe(1);

        // Retry released the claim so the row is eligible again — no stuck
        // row. attempts incremented, claim_token cleared.
        const row = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        expect(row?.attempts).toBe(1);
        expect(row?.claim_token).toBeNull();
        expect(row?.processed_at).toBeNull();
        expect(row?.dead_at).toBeNull();
      });

      it('tight no-TTL-race: publishTimeoutMs ≈ claimTimeoutMs, second worker between timeout-fire and TTL never TTL-reclaims', async () => {
        // Plan §Risks row 5: prove the no-TTL-race guarantee at-runtime, not
        // just at factory-construction time. With publishTimeoutMs sitting
        // 10ms below claimTimeoutMs, the timeout MUST fire (and hence the
        // retry path MUST run) before the original claim_token would have
        // been TTL-eligible for reclaim by another worker. A regression that
        // bypassed the factory invariant (e.g. directly mutating
        // state.options.publishTimeoutMs) would fail here even though the
        // constructor guard still passed.
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);

        const claimTimeoutMs = 200;
        const publishTimeoutMs = 190; // claimTimeoutMs - 10

        // publish takes ~claimTimeoutMs - 5 (195ms). Comfortably past
        // publishTimeoutMs but short of claimTimeoutMs.
        const publishDelayMs = 195;

        // Order matters: buildRegistry() installs its own publishMessage spy
        // (mockResolvedValue), so the slow mock MUST be installed AFTER it
        // to take effect. Reversing the order silently turns this into a
        // happy-path test and the timeout assertion below would fail with
        // result.failed === 0.
        const { registry } = buildRegistry();
        vi.spyOn(ctx.channel, 'publishMessage').mockImplementation(
          slowPublishHonoringAbort(publishDelayMs, mockAbortController.signal),
        );

        const relay = makeRelay(registry, {
          options: {
            claimTimeoutMs,
            publishTimeoutMs,
            maxAttempts: 5,
            baseMs: 1,
            ceilingMs: 10,
          },
        });

        // Run the relay; the publish times out at ~190ms, retry runs.
        const result = await relay.runOnce();
        expect(result.failed).toBe(1);

        // After runOnce returns, claim_token has been cleared by the retry
        // path (well within claimTimeoutMs). A second worker that attempts
        // claim() now between timeout-fire and TTL must NOT see a stuck
        // row that it would have TTL-reclaimed; it sees a freshly-eligible
        // row (claim_token IS NULL) instead.
        const competing = await ctx.claim({
          workerClaimToken: 'competing-worker',
          aggregateNames: [ctx.connectedEventStore.eventStoreId],
          batchSize: 10,
          claimTimeoutMs,
        });
        expect(competing).toHaveLength(1);
        // The fresh claim wrote its own token — proves the row was claimed
        // via the eligibility-by-claim_token-IS-NULL path, NOT via TTL
        // reclaim of a still-populated original token.
        expect(competing[0]!.claim_token).toBe('competing-worker');

        // Crucially, the row carried attempts = 1 from the timeout's retry
        // path (NOT attempts = 0 + a still-original-token TTL reclaim).
        // This pins that handleFailure ran inside the publishTimeoutMs/
        // claimTimeoutMs window, not after.
        expect(competing[0]!.attempts).toBe(1);
      });
    });

    describe('unsupported channel (R11)', () => {
      it('rejects a channel that is neither Notification nor StateCarrying', () => {
        // A bare object is neither a NotificationMessageChannel nor a
        // StateCarryingMessageChannel instance; factory must fail fast
        // rather than dead-transitioning every row at publish time.
        const invalidChannel = {} as unknown as RelayChannel;
        expect(() =>
          makeRelay([
            {
              eventStoreId: ctx.connectedEventStore.eventStoreId,
              connectedEventStore: ctx.connectedEventStore,
              channel: invalidChannel,
            },
          ]),
        ).toThrow(UnsupportedChannelTypeError);
      });
    });

    describe('retried-then-re-dead (R16)', () => {
      it('onDead fires again when a retried dead row fails again', async () => {
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);

        const { registry } = buildRegistry();
        vi.spyOn(ctx.channel, 'publishMessage').mockRejectedValue(
          new Error('bus still down'),
        );
        const onDead = vi.fn();
        const relay = makeRelay(registry, {
          hooks: { onDead },
          options: { maxAttempts: 1, baseMs: 1, ceilingMs: 10 },
        });

        // First dead transition: maxAttempts=1 so one failure is enough.
        await relay.runOnce();
        const firstDead = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        expect(firstDead?.dead_at).not.toBeNull();
        expect(onDead).toHaveBeenCalledTimes(1);

        // Retry the dead row; relay claims it; fails again → re-dead.
        // The retried row starts with attempts = maxAttempts after the
        // first dead. The retry path resets attempts to 0, so the second
        // dead transition still takes maxAttempts failures (here: 1).
        await relay.retryRow(firstDead!.id);

        // Pin the resetSet contract from relay/admin.ts:83-90: retryRow
        // clears attempts, last_error, last_attempt_at, dead_at, and the
        // claim token. Without this assertion the "re-dead after maxAttempts
        // failures" claim above is trivially true regardless of whether
        // attempts was reset, and a regression that left attempts at the
        // pre-retry value would silently pass.
        const afterRetry = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        expect(afterRetry).toEqual(
          expect.objectContaining({
            attempts: 0,
            dead_at: null,
            last_error: null,
            last_attempt_at: null,
            claim_token: null,
            claimed_at: null,
          }),
        );

        await relay.runOnce();

        const secondDead = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        expect(secondDead?.dead_at).not.toBeNull();
        expect(onDead).toHaveBeenCalledTimes(2);
      });
    });

    describe('liveness queries (R22)', () => {
      it('depth / dead-count / age projections return expected shapes', async () => {
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 2);

        // Mark v1 dead out-of-band so dead-count > 0.
        const v1 = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        await ctx.db
          .update(ctx.outboxTable)
          .set({ deadAt: dialectNow(dialectName) })
          .where(eq(ctx.outboxTable.id as never, v1!.id));

        const depth = (await ctx.db
          .select({ n: sql<number>`COUNT(*)` })
          .from(ctx.outboxTable)) as Array<{ n: unknown }>;
        expect(Number(depth[0]!.n)).toBe(2);

        const deadCount = (await ctx.db
          .select({ n: sql<number>`COUNT(*)` })
          .from(ctx.outboxTable)
          .where(sql`dead_at IS NOT NULL`)) as Array<{ n: unknown }>;
        expect(Number(deadCount[0]!.n)).toBe(1);

        const ageRows = (await ctx.db
          .select({ minCreatedAt: sql<string>`MIN(created_at)` })
          .from(ctx.outboxTable)) as Array<{ minCreatedAt: unknown }>;
        expect(ageRows[0]!.minCreatedAt).not.toBeNull();
      });
    });

    describe('supervisor programming-error abort (R18)', () => {
      it('runContinuously rejects rather than loops when claim throws TypeError', async () => {
        const { registry } = buildRegistry();
        const brokenClaim: BoundClaim = () => {
          throw new TypeError('programming error in claim');
        };

        const relay = createOutboxRelay({
          dialect: dialectName,
          adapter: ctx.adapter,
          db: ctx.db,
          outboxTable: ctx.outboxTable,
          claim: brokenClaim,
          registry,
          options: { baseMs: 1, ceilingMs: 10, pollingMs: 1 },
        });

        await expect(relay.runContinuously()).rejects.toBeInstanceOf(TypeError);
      });

      it('graceful stop() is bounded by pollingMs + publishTimeoutMs (wakeController abort)', async () => {
        // Pins relay/runOnce.ts:42-51 + runContinuously.ts sleep/stop wiring:
        // calling stop() during an in-flight publish must unwind within
        // pollingMs + publishTimeoutMs (plus tolerance), NOT pollingMs +
        // however-long-the-bus-takes. Without the wakeController abort and
        // the withTimeout wrapper around publishMessage, a hung bus could
        // pin a worker for the full claimTimeoutMs (5min default).
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);

        // buildRegistry() installs its own happy-path publishMessage spy as
        // a side effect, so build the registry FIRST and install the slow
        // mock AFTER — otherwise mockResolvedValue(undefined) would clobber
        // slowPublishHonoringAbort and the test would pass on the happy
        // path instead of exercising publishTimeoutMs / wakeController.
        const { registry } = buildRegistry();

        // publishMessage hangs for 200ms — well past publishTimeoutMs (100).
        // The relay's withTimeout fires at ~100ms and rejects with
        // OutboxPublishTimeoutError; runContinuously then routes through
        // retry, sleeps pollingMs, and observes state.stopping = true on
        // the next iteration (or its sleep wakes early via wakeController).
        vi.spyOn(ctx.channel, 'publishMessage').mockImplementation(
          slowPublishHonoringAbort(200, mockAbortController.signal),
        );

        const relay = makeRelay(registry, {
          options: {
            pollingMs: 50,
            publishTimeoutMs: 100,
            claimTimeoutMs: 60_000,
            maxAttempts: 5,
            baseMs: 1,
            ceilingMs: 10,
          },
        });

        const startedAt = Date.now();
        const loop = relay.runContinuously();
        // Give the loop one tick to claim + start the slow publish.
        await new Promise(resolve => setTimeout(resolve, 25));

        await relay.stop();
        await loop;
        const elapsed = Date.now() - startedAt;

        // Hard upper bound: pollingMs (50) + publishTimeoutMs (100) +
        // generous tolerance for testcontainer latency on CI. A regression
        // that strips the wakeController abort or the withTimeout wrapper
        // would push this comfortably past 1s.
        expect(elapsed).toBeLessThan(1_000);
      });
    });

    describe('scrubber at DB boundary (R17)', () => {
      it('persists a scrubbed + truncated last_error that round-trips through the DB column', async () => {
        const aggregateId = randomUUID();
        await pushCounterEvent(ctx.connectedEventStore, aggregateId, 1);

        // Error message contains a payload-like JSON fragment so the
        // scrubber has something to redact; long enough to hit the 2048
        // cap when the raw message + redacted JSON exceeds it.
        const secretPayload = { ssn: '123-45-6789', card: '4111111111111111' };
        const repeatedTail = 'x'.repeat(3000);
        const err = new Error(
          `publish failed for payload=${JSON.stringify(secretPayload)} trailing=${repeatedTail}`,
        );

        const { registry } = buildRegistry();
        vi.spyOn(ctx.channel, 'publishMessage').mockRejectedValue(err);
        const relay = makeRelay(registry, {
          options: { maxAttempts: 1, baseMs: 1, ceilingMs: 10 },
        });
        await relay.runOnce();

        const row = await selectRowByKey(
          ctx.db,
          ctx.outboxTable,
          aggregateId,
          1,
        );
        expect(row?.last_error).toBeDefined();
        const lastError = row!.last_error!;
        // mysql varchar(2048) + other dialects cap at 2048.
        expect(lastError.length).toBeLessThanOrEqual(2048);
        // JSON-fragment leaves redacted — original PII NOT leaked.
        expect(lastError).not.toContain('123-45-6789');
        expect(lastError).not.toContain('4111111111111111');
      });
    });
  });
};
