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

import type { OutboxRow, RelayRegistryEntry } from '../common/outbox/types';
import { claimSqlite } from '../sqlite/outbox/claim';
import { outboxTable } from '../sqlite/schema';
import { makeStop, runContinuously } from './runContinuously';
import type { RelayState } from './runOnce';

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

describe('runContinuously + makeStop', () => {
  let bs: Database.Database;
  let db: ReturnType<typeof drizzle>;

  const seedRow = async (
    aggregateId: string,
    version: number,
  ): Promise<void> => {
    await db.insert(outboxTable).values({
      id: randomUUID(),
      aggregateName: 'counters',
      aggregateId,
      version,
    });
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
      claim?: RelayState['claim'];
      publishFn?: () => Promise<void>;
      pollingMs?: number;
    } = {},
  ): RelayState => {
    const bus = new NotificationMessageBus({
      messageBusId: 'bus',
      sourceEventStores: [eventStore],
    });
    vi.spyOn(bus, 'publishMessage').mockImplementation(
      overrides.publishFn ?? (async () => undefined),
    );

    const entry: RelayRegistryEntry = {
      eventStoreId: 'counters',
      connectedEventStore: new ConnectedEventStore(eventStore, bus),
      channel: bus,
    };

    const lookup: OutboxCapability[typeof OUTBOX_GET_EVENT_SYMBOL] = async (
      _name,
      id,
      version,
    ) => ({
      aggregateId: id,
      version,
      type: 'COUNTER_INCREMENTED',
      timestamp: '2026-04-20T00:00:00.000Z',
    });

    const adapter: OutboxCapability = {
      [OUTBOX_ENABLED_SYMBOL]: true,
      [OUTBOX_GET_EVENT_SYMBOL]: lookup,
    };

    return {
      ctx: { dialect: 'sqlite', db, outboxTable, adapter },
      registry: new Map([['counters', entry]]),
      hooks: {},
      options: {
        baseMs: 10,
        ceilingMs: 500,
        maxAttempts: 3,
        claimTimeoutMs: 60_000,
        pollingMs: overrides.pollingMs ?? 40,
        batchSize: 10,
        publishTimeoutMs: 30_000,
      },
      claim:
        overrides.claim ?? (args => claimSqlite({ db, outboxTable, ...args })),
      stopping: false,
    };
  };

  it('drains seeded rows and exits cleanly after stop()', async () => {
    await seedRow('a', 1);
    await seedRow('b', 1);

    const state = makeState();
    const loop = runContinuously(state);
    const { stop } = makeStop(state, loop);

    // Give the loop two poll cycles, then shut down.
    await new Promise(resolve => setTimeout(resolve, 100));
    await stop();

    const processed = (
      bs
        .prepare(
          'SELECT COUNT(*) AS c FROM castore_outbox WHERE processed_at IS NOT NULL',
        )
        .get() as { c: number }
    ).c;
    expect(processed).toBe(2);
  });

  it('supervisor survives a claim-phase exception', async () => {
    await seedRow('a', 1);

    let calls = 0;
    const baseClaim = (
      args: Parameters<RelayState['claim']>[0],
    ): Promise<OutboxRow[]> => claimSqlite({ db, outboxTable, ...args });
    const flakyClaim: RelayState['claim'] = args => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error('connection dropped'));
      }

      return baseClaim(args);
    };

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = makeState({ claim: flakyClaim });
    const loop = runContinuously(state);
    const { stop } = makeStop(state, loop);

    // First iteration throws; the supervisor logs + backs off + continues
    // and eventually drains the row.
    await new Promise(resolve => setTimeout(resolve, 200));
    await stop();

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();

    const processed = (
      bs
        .prepare(
          'SELECT COUNT(*) AS c FROM castore_outbox WHERE processed_at IS NOT NULL',
        )
        .get() as { c: number }
    ).c;
    expect(processed).toBe(1);
  });

  it('supervisor re-throws programming errors (TypeError) instead of looping forever', async () => {
    const boomClaim: RelayState['claim'] = () => {
      throw new TypeError('relay bug: undefined.foo');
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = makeState({ claim: boomClaim });

    // The loop rejects with the TypeError rather than silently looping.
    await expect(runContinuously(state)).rejects.toBeInstanceOf(TypeError);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('stop() resolves even when the inflight iteration rejects at shutdown', async () => {
    // Seed nothing — the loop spends its time in pollingMs sleeps. If
    // `stop()` were gated on a promise that rejected, it would reject too.
    const rejectingClaim: RelayState['claim'] = () =>
      Promise.reject(new Error('db gone during shutdown'));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = makeState({ claim: rejectingClaim, pollingMs: 20 });
    const loop = runContinuously(state);
    const { stop } = makeStop(state, loop);

    await new Promise(resolve => setTimeout(resolve, 50));
    await expect(stop()).resolves.toBeUndefined();

    errSpy.mockRestore();
  });
});
