import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
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
  config: OutboxConformanceSetup<A, T>,
): void => {
  const { dialectName, setup, teardown } = config;

  describe(`drizzle ${dialectName} outbox relay — fault injection`, () => {
    let ctx: OutboxConformanceSetupResult<A, T>;

    // Mirrors the conformance suite's loud-cleanup primitives so a slow
    // publishMessage mock can register its setTimeout for guaranteed
    // teardown; afterEach asserts no leaked timers / unhandled rejections.
    const pendingMockTimers = new Set<ReturnType<typeof setTimeout>>();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    let mockAbortController: AbortController;

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
      // vi.getTimerCount() cannot be asserted here — vitest 3 throws when
      // fake timers aren't active, and the suite uses real timers. The
      // explicit pendingMockTimers cleanup above is the load-bearing guard.
      expect(unhandledRejections).toStrictEqual([]);
    });

    afterAll(async () => {
      process.off('unhandledRejection', onUnhandledRejection);
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

      it('crash mid-handleFailure: TTL-reclaim recovers; total publishes ≤ maxAttempts+1', async () => {
        // Reproduces the post-crash DB state where handleFailure started but
        // crashed before its attempts++ fencedUpdate landed: the row keeps
        // its original claim_token and its prior attempts value. Pins the
        // recovery half of the try/catch at relay/runOnce.ts:119-140 — the
        // test scenario the unit-level retry tests can not exercise because
        // that try/catch only fires when the DB throws between publish-fail
        // and attempts++.
        //
        // Setup: simulate "the dying relay had already failed publish #1
        // (handleFailure ran and incremented attempts to 1), then claimed
        // again for attempt #2, publish #2 failed, handleFailure started but
        // crashed mid-fencedUpdate." Post-crash row state: claim_token
        // populated, attempts = 1 (NOT 2 — the second handleFailure didn't
        // commit). Recovery: TTL reclaim picks it up, fresh publish lands.
        const aggregateId = randomUUID();
        await pushEvent(ctx.connectedEventStore, aggregateId, 1);

        // Snapshot state of the row, then construct the post-crash state
        // directly: claim it (puts claim_token + claimed_at) and bump
        // attempts via a plain UPDATE (mirrors what handleFailure would have
        // done on attempt #1's success).
        const claimed = await ctx.claim({
          workerClaimToken: 'crashed-worker',
          aggregateNames: [ctx.connectedEventStore.eventStoreId],
          batchSize: 10,
          claimTimeoutMs: 60_000,
        });
        expect(claimed).toHaveLength(1);
        const rowId = claimed[0]!.id;
        await ctx.db
          .update(ctx.outboxTable)
          .set({ attempts: 1 })
          .where(eq(ctx.outboxTable.id as never, rowId));

        // Drop the "dying relay" — there is no relay reference to drop here
        // because we constructed the state directly; the test's contract is
        // "DB rows survive a process kill, fresh relay observes the post-
        // crash state". Backdate so TTL reclaim is eligible.
        await ctx.backdateClaimedAt(rowId, 10 * 60_000);

        const publishSpy = vi
          .spyOn(ctx.channel, 'publishMessage')
          .mockResolvedValue(undefined as never);
        const maxAttempts = 3;
        const freshRelay = makeRelay(buildRegistry(), {
          options: { maxAttempts, baseMs: 1, ceilingMs: 10 },
        });

        const result = await freshRelay.runOnce();
        expect(result.processed).toBe(1);

        // The fresh relay published exactly once. Per parent §2's at-least-
        // once guarantee, the bound on total publishes for this event from
        // the crash to recovery is maxAttempts + 1: the dying relay could
        // have called publishMessage up to `maxAttempts` times (each
        // handleFailure crash leaves the row claimable), and the fresh
        // relay adds exactly one more. The dying relay's mock count is 0
        // here because we constructed the state directly without invoking
        // its publishMessage spy; the assertion still holds end-to-end.
        expect(publishSpy.mock.calls.length).toBeLessThanOrEqual(
          maxAttempts + 1,
        );

        const rows = await selectAllRows(ctx.db, ctx.outboxTable);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.processed_at).not.toBeNull();
        expect(rows[0]!.claim_token).toBeNull();
        expect(rows[0]!.dead_at).toBeNull();
      });

      it('crash post-publishTimeoutMs pre-retry: original claim_token stays; TTL reclaim picks up', async () => {
        // Models the timing window where withTimeout has already rejected
        // the publish but handleFailure has not run yet (relay killed
        // between the two). Post-crash row state: claim_token is the
        // original token, attempts = 0, claimed_at is the original time.
        // Distinguishes from the previous scenario by attempts = 0 — proves
        // the recovery is not gated on a non-zero attempts counter.
        const aggregateId = randomUUID();
        await pushEvent(ctx.connectedEventStore, aggregateId, 1);

        const claimed = await ctx.claim({
          workerClaimToken: 'dying-worker',
          aggregateNames: [ctx.connectedEventStore.eventStoreId],
          batchSize: 10,
          claimTimeoutMs: 60_000,
        });
        expect(claimed).toHaveLength(1);
        const rowId = claimed[0]!.id;

        // No attempts++ — the post-timeout fencedUpdate never ran. Backdate
        // so TTL reclaim is eligible.
        await ctx.backdateClaimedAt(rowId, 10 * 60_000);

        const publishSpy = vi
          .spyOn(ctx.channel, 'publishMessage')
          .mockResolvedValue(undefined as never);
        const freshRelay = makeRelay(buildRegistry());

        const result = await freshRelay.runOnce();
        expect(result.processed).toBe(1);
        expect(publishSpy).toHaveBeenCalledOnce();

        const rows = await selectAllRows(ctx.db, ctx.outboxTable);
        expect(rows).toHaveLength(1);
        const recovered = rows[0]!;
        expect(recovered.processed_at).not.toBeNull();
        expect(recovered.claim_token).toBeNull();
        expect(recovered.dead_at).toBeNull();
        // attempts stayed at 0 from the dying relay AND the fresh publish
        // succeeded in one shot — no spurious increment from the recovery
        // path. This pins the "post-timeout fencedUpdate never ran" detail.
        expect(recovered.attempts).toBe(0);
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

    describe('no stuck rows under mixed workload (100 events × 10 aggregates)', () => {
      // Extracted helpers — each one's intent stays small enough to satisfy
      // the complexity ceiling and keeps the it() body readable.
      const drainWithBackdate = async (
        relay: ReturnType<typeof createOutboxRelay>,
        guardCap: number,
      ): Promise<number> => {
        let guard = 0;
        while (guard < guardCap) {
          const result = await relay.runOnce();
          if (result.claimed === 0) {
            const orphanedIds = await selectOrphanedIds();
            if (orphanedIds.length === 0) {
              return guard;
            }
            for (const id of orphanedIds) {
              await ctx.backdateClaimedAt(id, 10 * 60_000);
            }
          }
          guard += 1;
        }

        return guard;
      };

      const selectOrphanedIds = async (): Promise<string[]> => {
        const rows = await selectAllRows(ctx.db, ctx.outboxTable);

        return rows
          .filter(
            r =>
              r.processed_at === null &&
              r.dead_at === null &&
              r.claim_token !== null,
          )
          .map(r => r.id);
      };

      const groupVersionsByAggregate = (
        deliveries: Array<{ aggregateId: string; version: number }>,
      ): Map<string, number[]> => {
        const out = new Map<string, number[]>();
        for (const { aggregateId, version } of deliveries) {
          const list = out.get(aggregateId) ?? [];
          list.push(version);
          out.set(aggregateId, list);
        }

        return out;
      };

      const assertFifoVersions = (
        versionsByAggregate: Map<string, number[]>,
        finalVersion: number,
      ): void => {
        for (const versions of versionsByAggregate.values()) {
          for (let i = 1; i < versions.length; i += 1) {
            expect(versions[i]).toBeGreaterThanOrEqual(versions[i - 1]!);
          }
          // Sanity: the last recorded version per aggregate must be the
          // final committed version. Otherwise the aggregate didn't drain.
          expect(versions[versions.length - 1]).toBe(finalVersion);
        }
      };

      it('every committed event settles + per-aggregate bus-delivery FIFO preserved', async () => {
        // Plan §Verification lines 280-322 at full scale: 100 events × 10
        // aggregates with mixed kill modes, then assert (a) no stuck rows
        // and (b) per-aggregate FIFO bus-delivery order. Two kill modes
        // exercised here:
        //   - post-claim-pre-publish (publishMessage rejects before the
        //     bus receives anything): row stays in the retry path until
        //     it succeeds or hits maxAttempts.
        //   - post-publish-pre-mark (publishMessage records on the bus mock
        //     before the slow body exceeds publishTimeoutMs): the relay
        //     treats it as a publish failure, retries, and the bus
        //     receives a duplicate next pass — at-least-once delivery.
        // Together with the 40% normal cohort this is a faithful runtime
        // version of the parent-spec scenario; the smaller 5×4 sibling we
        // replaced was insufficient for the FIFO assertion.
        const aggregates = Array.from({ length: 10 }, () => randomUUID());
        const eventsPerAggregate = 10;
        for (const aggId of aggregates) {
          for (let v = 1; v <= eventsPerAggregate; v += 1) {
            await pushEvent(ctx.connectedEventStore, aggId, v);
          }
        }

        let callIdx = 0;
        // Successful bus deliveries (the bus actually saw the envelope) —
        // ordered by call sequence. Used for the per-aggregate FIFO
        // assertion. Pre-publish rejects are NOT recorded here because
        // the bus never received them.
        const busDeliveries: Array<{ aggregateId: string; version: number }> =
          [];
        const publishImpl = async (msg: unknown): Promise<void> => {
          const idx = callIdx;
          callIdx += 1;
          const event = (
            msg as { event: { aggregateId: string; version: number } }
          ).event;
          const bucket = idx % 10;
          if (bucket < 2) {
            // 20% post-claim-pre-publish kill
            throw new Error(`pre-publish kill #${idx}`);
          }
          // For both the slow-publish and normal cohorts the bus has
          // received the envelope; record before the slow wait so the
          // ordering reflects what the bus actually saw.
          busDeliveries.push({
            aggregateId: event.aggregateId,
            version: event.version,
          });
          if (bucket < 4) {
            // 20% post-publish-pre-mark kill: bus received, but the
            // body sleeps past publishTimeoutMs so withTimeout fires
            // and the relay routes through retry — bus will receive
            // a duplicate on the next claim.
            await slowPublishHonoringAbort(60, mockAbortController.signal)();
          }
          // 60% normal: nothing else to do.
        };
        vi.spyOn(ctx.channel, 'publishMessage').mockImplementation(
          publishImpl as never,
        );

        // maxAttempts = 15 keeps the no-death guarantee comfortable even
        // under the 40% combined kill rate: probability of a row dying is
        // 0.4^15 ≈ 1e-6, so ~1e-4 expected deaths over 100 rows. Without
        // this margin a stray death triggers the dead-blocks-newer FIFO
        // semantic on its aggregate and the no-stuck-rows assertion fails
        // for the still-eligible later versions.
        const relay = makeRelay(buildRegistry(), {
          options: {
            maxAttempts: 15,
            baseMs: 1,
            ceilingMs: 5,
            publishTimeoutMs: 30,
            claimTimeoutMs: 200,
          },
        });

        // Drain — iteration cap covers post-publish-pre-mark kills which
        // leave claim_token populated and require TTL reclaim; the helper
        // backdates them between iterations instead of waiting on the
        // wall clock.
        const guardCap = 200;
        const usedIterations = await drainWithBackdate(relay, guardCap);
        expect(usedIterations).toBeLessThan(guardCap);

        const rows = await selectAllRows(ctx.db, ctx.outboxTable);
        expect(rows).toHaveLength(aggregates.length * eventsPerAggregate);
        for (const row of rows) {
          const settled = row.processed_at !== null || row.dead_at !== null;
          expect(settled).toBe(true);
        }

        // Per-aggregate FIFO: monotonically non-decreasing versions
        // (duplicates from at-least-once retries OK; reordering NOT OK).
        assertFifoVersions(
          groupVersionsByAggregate(busDeliveries),
          eventsPerAggregate,
        );
      }, 30_000);
    });
  });
};
