import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { vi } from 'vitest';

import {
  ConnectedEventStore,
  EventStore,
  EventType,
  NotificationMessageBus,
  OUTBOX_ENABLED_SYMBOL,
  OUTBOX_GET_EVENT_SYMBOL,
} from '@castore/core';
import type { EventDetail, OutboxCapability } from '@castore/core';

import type { RelayRegistryEntry } from '../common/outbox/types';
import { claimSqlite } from '../sqlite/outbox/claim';
import { outboxTable } from '../sqlite/schema';
import { runOnce, type RelayState } from './runOnce';

const createOutboxDDL = `
  CREATE TABLE castore_outbox (
    id              TEXT PRIMARY KEY,
    aggregate_name  TEXT NOT NULL,
    aggregate_id    TEXT NOT NULL,
    version         INTEGER NOT NULL,
    created_at      TEXT NOT NULL,
    claim_token     TEXT,
    claimed_at      TEXT,
    processed_at    TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    last_attempt_at TEXT,
    dead_at         TEXT,
    CONSTRAINT outbox_aggregate_version_uq UNIQUE (aggregate_name, aggregate_id, version)
  )
`;

const eventType = new EventType({ type: 'COUNTER_INCREMENTED' });
const eventStore = new EventStore({
  eventStoreId: 'counters',
  eventTypes: [eventType],
  reducer: (_agg, event: EventDetail) => ({
    aggregateId: event.aggregateId,
    version: event.version,
  }),
});

describe('runOnce', () => {
  let bs: Database.Database;
  let db: ReturnType<typeof drizzle>;

  const seedRow = async (
    aggregateId: string,
    version: number,
  ): Promise<string> => {
    const id = randomUUID();
    await db.insert(outboxTable).values({
      id,
      aggregateName: 'counters',
      aggregateId,
      version,
    });

    return id;
  };

  beforeEach(() => {
    bs = new Database(':memory:');
    bs.prepare(createOutboxDDL).run();
    db = drizzle(bs);
  });

  afterEach(() => {
    bs.close();
  });

  const makeState = (
    overrides: {
      lookup?: OutboxCapability[typeof OUTBOX_GET_EVENT_SYMBOL];
      publishFn?: () => Promise<void>;
      maxAttempts?: number;
    } = {},
  ): {
    state: RelayState;
    bus: NotificationMessageBus;
    publishSpy: ReturnType<typeof vi.fn>;
  } => {
    const bus = new NotificationMessageBus({
      messageBusId: 'bus',
      sourceEventStores: [eventStore],
    });
    const publishFn = overrides.publishFn ?? (async () => undefined);
    const publishSpy = vi
      .spyOn(bus, 'publishMessage')
      .mockImplementation(publishFn as () => Promise<void>);

    const entry: RelayRegistryEntry = {
      eventStoreId: 'counters',
      connectedEventStore: new ConnectedEventStore(eventStore, bus),
      channel: bus,
    };
    const registry = new Map([['counters', entry]]);

    const lookup: OutboxCapability[typeof OUTBOX_GET_EVENT_SYMBOL] =
      overrides.lookup ??
      (async (_name, id, version) => ({
        aggregateId: id,
        version,
        type: 'COUNTER_INCREMENTED',
        timestamp: '2026-04-20T00:00:00.000Z',
      }));

    const adapter: OutboxCapability = {
      [OUTBOX_ENABLED_SYMBOL]: true,
      [OUTBOX_GET_EVENT_SYMBOL]: lookup,
    };

    const state: RelayState = {
      ctx: { dialect: 'sqlite', db, outboxTable, adapter },
      registry,
      hooks: {},
      options: {
        baseMs: 100,
        ceilingMs: 10_000,
        maxAttempts: overrides.maxAttempts ?? 3,
        claimTimeoutMs: 60_000,
        pollingMs: 250,
        batchSize: 10,
        publishTimeoutMs: 30_000,
      },
      claim: args =>
        claimSqlite({
          db,
          outboxTable,
          ...args,
        }),
      stopping: false,
    };

    return { state, bus, publishSpy: publishSpy as never };
  };

  it('returns 0-result when registry is empty', async () => {
    const { state } = makeState();
    const emptyState: RelayState = { ...state, registry: new Map() };
    const result = await runOnce(emptyState);
    expect(result.claimed).toBe(0);
    expect(result.processed).toBe(0);
  });

  it('claims, publishes, and marks rows processed for a happy-path batch', async () => {
    await seedRow('a', 1);
    await seedRow('b', 1);
    await seedRow('c', 1);

    const { state, publishSpy } = makeState();

    const result = await runOnce(state);
    expect(result.claimed).toBe(3);
    expect(result.processed).toBe(3);
    expect(publishSpy).toHaveBeenCalledTimes(3);

    const processedCount = (
      bs
        .prepare(
          'SELECT COUNT(*) AS c FROM castore_outbox WHERE processed_at IS NOT NULL',
        )
        .get() as { c: number }
    ).c;
    expect(processedCount).toBe(3);
  });

  it('resolves 0-claim case cleanly', async () => {
    const { state } = makeState();
    const result = await runOnce(state);
    expect(result.claimed).toBe(0);
  });

  it('routes publish failures through retry → attempts++ and release claim', async () => {
    await seedRow('a', 1);

    const { state, publishSpy } = makeState({
      publishFn: async () => {
        throw new Error('bus down');
      },
    });

    const result = await runOnce(state);
    expect(result.claimed).toBe(1);
    expect(result.failed).toBe(1);
    expect(publishSpy).toHaveBeenCalledOnce();

    const persisted = bs
      .prepare('SELECT attempts, claim_token, dead_at FROM castore_outbox')
      .get() as {
      attempts: number;
      claim_token: string | null;
      dead_at: string | null;
    };
    expect(persisted.attempts).toBe(1);
    expect(persisted.claim_token).toBeNull();
    expect(persisted.dead_at).toBeNull();
  });

  it('marks dead when repeated failures reach maxAttempts', async () => {
    await seedRow('a', 1);

    const { state } = makeState({
      publishFn: async () => {
        throw new Error('terminal');
      },
      maxAttempts: 2,
    });

    await runOnce(state); // attempts: 0 → 1
    await runOnce(state); // attempts: 1 → 2 (== maxAttempts) → dead

    const persisted = bs
      .prepare('SELECT attempts, dead_at FROM castore_outbox')
      .get() as { attempts: number; dead_at: string | null };
    expect(persisted.attempts).toBe(2);
    expect(persisted.dead_at).not.toBeNull();
  });

  it('accumulates mixed outcomes across the batch — continues after per-row failures', async () => {
    await seedRow('a', 1);
    await seedRow('b', 1);
    await seedRow('c', 1);

    // Middle row throws; first and third succeed. The loop must not
    // abort — it must keep processing and end with processed=2, failed=1.
    let calls = 0;
    const { state, publishSpy } = makeState({
      publishFn: async () => {
        calls += 1;
        if (calls === 2) {
          throw new Error('bus blip on row 2');
        }
      },
    });

    const result = await runOnce(state);
    expect(result.claimed).toBe(3);
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(1);
    expect(publishSpy).toHaveBeenCalledTimes(3);

    const processedCount = (
      bs
        .prepare(
          'SELECT COUNT(*) AS c FROM castore_outbox WHERE processed_at IS NOT NULL',
        )
        .get() as { c: number }
    ).c;
    expect(processedCount).toBe(2);

    // Failed row had attempts incremented and claim released for retry.
    const failedCount = (
      bs
        .prepare(
          `SELECT COUNT(*) AS c FROM castore_outbox
           WHERE processed_at IS NULL AND attempts > 0 AND claim_token IS NULL`,
        )
        .get() as { c: number }
    ).c;
    expect(failedCount).toBe(1);
  });

  it('honours state.stopping mid-batch — remaining rows stay claimed', async () => {
    await seedRow('a', 1);
    await seedRow('b', 1);

    const { state } = makeState({
      publishFn: async () => {
        state.stopping = true;
      },
    });

    const result = await runOnce(state);
    // Only the first row was published (the second was short-circuited by
    // the stopping flag). The other stays with claim_token set but
    // processed_at null — a fresh relay will TTL-reclaim and publish it.
    expect(result.claimed).toBe(2);
    expect(result.processed).toBe(1);

    const unprocessed = bs
      .prepare(
        'SELECT COUNT(*) AS c FROM castore_outbox WHERE processed_at IS NULL',
      )
      .get() as { c: number };
    expect(unprocessed.c).toBe(1);
  });
});
