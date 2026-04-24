import { randomUUID } from 'crypto';
import { vi } from 'vitest';

import { ConnectedEventStore, type EventStorageAdapter } from '@castore/core';

import {
  selectOutboxColumns,
  type OutboxColumnTable,
} from '../common/outbox/selectColumns';
import type { OutboxRow, RelayRegistryEntry } from '../common/outbox/types';
import { createOutboxRelay } from '../relay';
import type {
  OutboxConformanceSetup,
  OutboxConformanceSetupResult,
} from './outboxConformance';

/**
 * The fault-injection suite uses the same setup contract as the conformance
 * suite — the per-dialect test file passes the same object shape to both
 * factories, with its shared `reset()` wiping both event and outbox tables
 * between scenarios so each scenario starts from a clean slate.
 */
export type OutboxFaultInjectionSetup<
  A extends EventStorageAdapter,
  T extends OutboxColumnTable,
> = OutboxConformanceSetup<A, T>;

const pushEvent = async (
  ces: ConnectedEventStore,
  aggregateId: string,
  version: number,
): Promise<void> => {
  await ces.pushEvent(
    {
      aggregateId,
      version,
      type: 'COUNTER_INCREMENTED',
      timestamp: new Date(Date.now() + version).toISOString(),
      payload: { at: version },
    },
    { force: false },
  );
};

const selectAllRows = async <T extends OutboxColumnTable>(
  db: any,
  outboxTable: T,
): Promise<OutboxRow[]> =>
  (await db
    .select(selectOutboxColumns(outboxTable))
    .from(outboxTable)) as OutboxRow[];

/**
 * Fault-injection suite for the transactional outbox relay. Proves zero-loss
 * under induced failure — the parent §2 success criterion that the relay-core
 * unit tests could not close alone.
 *
 * Crash-simulation shape per parent plan: drop references to the "dying"
 * relay (let GC claim it) while leaving outbox DB rows in place; construct
 * a fresh `createOutboxRelay({...})` that observes the post-crash state.
 * `state.stopping` is NOT used — the goal is abrupt termination, not
 * graceful shutdown.
 *
 * sqlite carve-out: sqlite's single-writer model means two-concurrent-relay
 * and cross-aggregate-parallelism scenarios don't apply. sqlite only runs
 * single-relay scenarios here, matching parent §2.
 */
export const makeOutboxFaultInjectionSuite = <
  A extends EventStorageAdapter,
  T extends OutboxColumnTable,
>(
  config: OutboxFaultInjectionSetup<A, T>,
): void => {
  const { dialectName, setup, teardown } = config;

  describe(`drizzle ${dialectName} outbox relay — fault injection`, () => {
    let ctx: OutboxConformanceSetupResult<A, T>;

    const buildRegistry = (): RelayRegistryEntry[] => [
      {
        eventStoreId: ctx.connectedEventStore.eventStoreId,
        connectedEventStore: ctx.connectedEventStore,
        channel: ctx.channel,
      },
    ];

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

    describe('crash post-claim-pre-publish', () => {
      it('TTL-reclaim on a fresh relay publishes the claim-orphaned row', async () => {
        // Simulate the "kill between claim and publish" crash by calling
        // ctx.claim() directly to put the row in claimed state without any
        // publish, then dropping every reference to the "dying" relay.
        const aggregateId = randomUUID();
        await pushEvent(ctx.connectedEventStore, aggregateId, 1);

        const claimed = await ctx.claim({
          workerClaimToken: 'crashed-worker',
          aggregateNames: [ctx.connectedEventStore.eventStoreId],
          batchSize: 10,
          claimTimeoutMs: 60_000,
        });
        expect(claimed).toHaveLength(1);
        const claimedRow = claimed[0]!;

        // Backdate claimed_at so TTL reclaim is eligible.
        await ctx.backdateClaimedAt(claimedRow.id, 10 * 60_000);

        // Fresh relay; spy records bus delivery. The parent §2 success
        // criterion: every committed event eventually reaches the bus
        // at-least-once. Here it must be exactly once from this relay's
        // perspective since the "dying" relay never called publish.
        const publishSpy = vi
          .spyOn(ctx.channel, 'publishMessage')
          .mockResolvedValue(undefined as never);
        const relay = makeRelay(buildRegistry());

        const result = await relay.runOnce();
        expect(result.claimed).toBe(1);
        expect(result.processed).toBe(1);
        expect(publishSpy).toHaveBeenCalledOnce();

        const rows = await selectAllRows(ctx.db, ctx.outboxTable);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.processed_at).not.toBeNull();
        expect(rows[0]!.claim_token).toBeNull();
        expect(rows[0]!.dead_at).toBeNull();
      });
    });

    describe('maxAttempts exhaustion (100% failure)', () => {
      it('every row transitions to dead_at; onDead + onFail cadence matches maxAttempts', async () => {
        const aggregateA = randomUUID();
        const aggregateB = randomUUID();
        const aggregateC = randomUUID();
        await pushEvent(ctx.connectedEventStore, aggregateA, 1);
        await pushEvent(ctx.connectedEventStore, aggregateB, 1);
        await pushEvent(ctx.connectedEventStore, aggregateC, 1);

        vi.spyOn(ctx.channel, 'publishMessage').mockRejectedValue(
          new Error('bus down permanently'),
        );
        const onDead = vi.fn();
        const onFail = vi.fn();
        const maxAttempts = 3;

        const relay = makeRelay(buildRegistry(), {
          hooks: { onDead, onFail },
          options: { maxAttempts, baseMs: 1, ceilingMs: 10 },
        });

        // maxAttempts iterations to exhaust every row.
        for (let i = 0; i < maxAttempts; i += 1) {
          await relay.runOnce();
        }

        const rows = await selectAllRows(ctx.db, ctx.outboxTable);
        expect(rows).toHaveLength(3);
        for (const row of rows) {
          expect(row.dead_at).not.toBeNull();
          expect(row.attempts).toBe(maxAttempts);
          expect(row.last_error).toContain('bus down');
        }

        // Per-row cadence: onDead fires once per row; onFail fires
        // (maxAttempts - 1) times per row (the last failure transitions
        // to dead and fires onDead instead).
        expect(onDead).toHaveBeenCalledTimes(3);
        expect(onFail).toHaveBeenCalledTimes(3 * (maxAttempts - 1));
      });
    });

    describe('FIFO preserved under crash+recover (per-aggregate v1..v3)', () => {
      it('bus receives v1, v2, v3 in order after mid-aggregate crash', async () => {
        const aggregateId = randomUUID();
        await pushEvent(ctx.connectedEventStore, aggregateId, 1);
        await pushEvent(ctx.connectedEventStore, aggregateId, 2);
        await pushEvent(ctx.connectedEventStore, aggregateId, 3);

        // Simulate crash of worker-A after claiming v1 (no publish).
        const claimed = await ctx.claim({
          workerClaimToken: 'crashed-worker-A',
          aggregateNames: [ctx.connectedEventStore.eventStoreId],
          batchSize: 1,
          claimTimeoutMs: 60_000,
        });
        expect(claimed).toHaveLength(1);
        expect(claimed[0]!.version).toBe(1);

        // Backdate so TTL reclaim picks it up.
        await ctx.backdateClaimedAt(claimed[0]!.id, 10 * 60_000);

        // Record publish order via the spy's call history.
        const publishSpy = vi
          .spyOn(ctx.channel, 'publishMessage')
          .mockResolvedValue(undefined as never);
        const relay = makeRelay(buildRegistry());

        // runOnce enough times to drain all three rows.
        for (let i = 0; i < 3; i += 1) {
          await relay.runOnce();
        }

        const versions = publishSpy.mock.calls.map(
          call => (call[0] as { event: { version: number } }).event.version,
        );
        expect(versions).toStrictEqual([1, 2, 3]);

        const finalRows = await selectAllRows(ctx.db, ctx.outboxTable);
        for (const row of finalRows) {
          expect(row.processed_at).not.toBeNull();
          expect(row.dead_at).toBeNull();
          expect(row.claim_token).toBeNull();
        }
      });
    });

    describe('no stuck rows under mixed workload', () => {
      it('every committed event ends up either processed_at or dead_at', async () => {
        // Smaller-scale version of the parent-spec "100 events × 10
        // aggregates with 30% kill rates" — the critical invariant is
        // "no stuck rows in the final state", which this asserts over a
        // modest batch that runs deterministically in CI.
        const aggregates = Array.from({ length: 5 }, () => randomUUID());
        const eventsPerAggregate = 4;
        for (const aggId of aggregates) {
          for (let v = 1; v <= eventsPerAggregate; v += 1) {
            await pushEvent(ctx.connectedEventStore, aggId, v);
          }
        }

        let call = 0;
        vi.spyOn(ctx.channel, 'publishMessage').mockImplementation(async () => {
          const current = call;
          call += 1;
          // Reject every third call deterministically — simulates
          // transient bus failures mixed with successes.
          if (current % 3 === 2) {
            throw new Error(`transient bus failure #${current}`);
          }
        });

        const relay = makeRelay(buildRegistry(), {
          options: { maxAttempts: 5, baseMs: 1, ceilingMs: 5 },
        });

        // Drain: keep running until the runOnce claims 0 rows.
        let guard = 0;
        let lastClaimed = 1;
        while (lastClaimed > 0 && guard < 30) {
          const result = await relay.runOnce();
          lastClaimed = result.claimed;
          guard += 1;
        }
        expect(guard).toBeLessThan(30);

        const rows = await selectAllRows(ctx.db, ctx.outboxTable);
        expect(rows).toHaveLength(aggregates.length * eventsPerAggregate);
        for (const row of rows) {
          const settled = row.processed_at !== null || row.dead_at !== null;
          expect(settled).toBe(true);
        }
      });
    });
  });
};
