import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { vi } from 'vitest';

import {
  ConnectedEventStore,
  EventStore,
  EventType,
  NotificationMessageBus,
  OUTBOX_ENABLED_SYMBOL,
  OUTBOX_GET_EVENT_SYMBOL,
  StateCarryingMessageBus,
} from '@castore/core';
import type { EventDetail, OutboxCapability } from '@castore/core';

import type { OutboxRow, RelayRegistryEntry } from '../common/outbox/types';
import { outboxTable } from '../sqlite/schema';
import { publish } from './publish';

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

// Minimal event store for registry fixtures.
const counterEventType = new EventType({
  type: 'COUNTER_INCREMENTED',
});

interface CounterAggregate {
  aggregateId: string;
  version: number;
  count: number;
}

const counterEventStore = new EventStore({
  eventStoreId: 'counters',
  eventTypes: [counterEventType],
  reducer: (agg: CounterAggregate, event: EventDetail): CounterAggregate => ({
    aggregateId: event.aggregateId,
    version: event.version,
    count: agg.count + 1,
  }),
});

const makeNotificationBus = () =>
  new NotificationMessageBus({
    messageBusId: 'bus',
    sourceEventStores: [counterEventStore],
  });

const makeStateCarryingBus = () =>
  new StateCarryingMessageBus({
    messageBusId: 'bus',
    sourceEventStores: [counterEventStore],
  });

const makeRow = (overrides: Partial<OutboxRow> = {}): OutboxRow => ({
  id: randomUUID(),
  aggregate_name: 'counters',
  aggregate_id: 'counter-1',
  version: 1,
  created_at: new Date().toISOString(),
  claim_token: 'worker-token',
  claimed_at: new Date().toISOString(),
  processed_at: null,
  attempts: 0,
  last_error: null,
  last_attempt_at: null,
  dead_at: null,
  ...overrides,
});

const makeAdapter = (
  lookup: OutboxCapability[typeof OUTBOX_GET_EVENT_SYMBOL],
): OutboxCapability => ({
  [OUTBOX_ENABLED_SYMBOL]: true,
  [OUTBOX_GET_EVENT_SYMBOL]: lookup,
});

describe('publish', () => {
  let bs: Database.Database;
  let db: ReturnType<typeof drizzle>;

  const seedRow = async (row: OutboxRow): Promise<void> => {
    await db.insert(outboxTable).values({
      id: row.id,
      aggregateName: row.aggregate_name,
      aggregateId: row.aggregate_id,
      version: row.version,
      claimToken: row.claim_token,
      claimedAt: row.claimed_at,
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

  const ctx = () => ({
    dialect: 'sqlite' as const,
    db,
    outboxTable,
  });

  it('publishes a notification envelope and marks the row processed', async () => {
    const row = makeRow();
    await seedRow(row);

    const event: EventDetail = {
      aggregateId: row.aggregate_id,
      version: row.version,
      type: 'COUNTER_INCREMENTED',
      timestamp: '2026-04-20T00:00:00.000Z',
    };
    const adapter = makeAdapter(async () => event);

    const bus = makeNotificationBus();
    const publishMessage = vi.spyOn(bus, 'publishMessage').mockResolvedValue();

    const registryEntry: RelayRegistryEntry = {
      eventStoreId: 'counters',
      connectedEventStore: new ConnectedEventStore(counterEventStore, bus),
      channel: bus,
    };
    const registry = new Map([[registryEntry.eventStoreId, registryEntry]]);

    const result = await publish({
      row,
      registry,
      ctx: { ...ctx(), adapter },
      hooks: {},
    });

    expect(result).toBe('ok');
    expect(publishMessage).toHaveBeenCalledOnce();
    expect(publishMessage).toHaveBeenCalledWith({
      eventStoreId: 'counters',
      event,
    });

    const [persisted] = bs
      .prepare('SELECT processed_at FROM castore_outbox WHERE id = ?')
      .all(row.id) as { processed_at: string | null }[];
    expect(persisted?.processed_at).not.toBeNull();
  });

  it('builds a StateCarrying envelope with the reconstructed aggregate', async () => {
    const row = makeRow({ version: 2 });
    await seedRow(row);

    const event = {
      aggregateId: row.aggregate_id,
      version: 2,
      type: 'COUNTER_INCREMENTED' as const,
      timestamp: '2026-04-20T00:00:00.000Z',
    };
    const adapter = makeAdapter(async () => event);

    const bus = makeStateCarryingBus();
    const publishMessage = vi.spyOn(bus, 'publishMessage').mockResolvedValue();

    const ces = new ConnectedEventStore(counterEventStore, bus);
    const fakeAggregate: CounterAggregate = {
      aggregateId: row.aggregate_id,
      version: 2,
      count: 2,
    };
    vi.spyOn(ces, 'getAggregate').mockResolvedValue({
      aggregate: fakeAggregate,
      events: [event],
      lastEvent: event,
    });

    const registryEntry: RelayRegistryEntry = {
      eventStoreId: 'counters',
      connectedEventStore: ces,
      channel: bus,
    };

    const result = await publish({
      row,
      registry: new Map([[registryEntry.eventStoreId, registryEntry]]),
      ctx: { ...ctx(), adapter },
      hooks: {},
    });

    expect(result).toBe('ok');
    expect(publishMessage).toHaveBeenCalledWith({
      eventStoreId: 'counters',
      event,
      aggregate: fakeAggregate,
    });
  });

  it('transitions to dead when source event row is missing (nil-row)', async () => {
    const row = makeRow();
    await seedRow(row);

    const adapter = makeAdapter(async () => undefined);
    const bus = makeNotificationBus();
    const publishMessage = vi.spyOn(bus, 'publishMessage');

    const onDead = vi.fn();

    const result = await publish({
      row,
      registry: new Map([
        [
          'counters',
          {
            eventStoreId: 'counters',
            connectedEventStore: new ConnectedEventStore(
              counterEventStore,
              bus,
            ),
            channel: bus,
          },
        ],
      ]),
      ctx: { ...ctx(), adapter },
      hooks: { onDead },
    });

    expect(result).toBe('dead');
    expect(publishMessage).not.toHaveBeenCalled();
    expect(onDead).toHaveBeenCalledOnce();
    expect(onDead).toHaveBeenCalledWith({
      row,
      lastError: 'source event row missing',
    });

    const [persisted] = bs
      .prepare('SELECT dead_at, last_error FROM castore_outbox WHERE id = ?')
      .all(row.id) as { dead_at: string | null; last_error: string | null }[];
    expect(persisted?.dead_at).not.toBeNull();
    expect(persisted?.last_error).toBe('source event row missing');
  });

  it('transitions to dead when registry has no entry for the aggregate', async () => {
    const row = makeRow({ aggregate_name: 'unregistered-store' });
    await seedRow(row);

    const event: EventDetail = {
      aggregateId: row.aggregate_id,
      version: row.version,
      type: 'COUNTER_INCREMENTED',
      timestamp: '2026-04-20T00:00:00.000Z',
    };
    const adapter = makeAdapter(async () => event);

    const bus = makeNotificationBus();
    const publishMessage = vi.spyOn(bus, 'publishMessage');
    const onDead = vi.fn();

    const result = await publish({
      row,
      registry: new Map(), // empty registry
      ctx: { ...ctx(), adapter },
      hooks: { onDead },
    });

    expect(result).toBe('dead');
    expect(publishMessage).not.toHaveBeenCalled();
    expect(onDead).toHaveBeenCalledOnce();
    expect((onDead.mock.calls[0] as unknown[][])[0]).toMatchObject({
      lastError: expect.stringContaining('no channel registered') as string,
    });
  });

  it('fires the fenced-no-op path when claim_token rotated before mark-processed', async () => {
    const row = makeRow();
    await seedRow(row);

    // Simulate a concurrent worker rotating the row's claim_token after the
    // publish but before our fencedUpdate for processed_at.
    const event: EventDetail = {
      aggregateId: row.aggregate_id,
      version: row.version,
      type: 'COUNTER_INCREMENTED',
      timestamp: '2026-04-20T00:00:00.000Z',
    };
    const adapter = makeAdapter(async () => {
      await db
        .update(outboxTable)
        .set({ claimToken: 'hijacker-token' })
        .where(eq(outboxTable.id, row.id));

      return event;
    });

    const bus = makeNotificationBus();
    vi.spyOn(bus, 'publishMessage').mockResolvedValue();

    const result = await publish({
      row,
      registry: new Map([
        [
          'counters',
          {
            eventStoreId: 'counters',
            connectedEventStore: new ConnectedEventStore(
              counterEventStore,
              bus,
            ),
            channel: bus,
          },
        ],
      ]),
      ctx: { ...ctx(), adapter },
      hooks: {},
    });

    expect(result).toBe('fenced-no-op');

    const [persisted] = bs
      .prepare('SELECT processed_at FROM castore_outbox WHERE id = ?')
      .all(row.id) as { processed_at: string | null }[];
    expect(persisted?.processed_at).toBeNull();
  });

  it('swallows onDead hook exceptions', async () => {
    const row = makeRow();
    await seedRow(row);

    const adapter = makeAdapter(async () => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onDead = vi.fn().mockRejectedValue(new Error('hook boom'));

    const bus = makeNotificationBus();

    const result = await publish({
      row,
      registry: new Map([
        [
          'counters',
          {
            eventStoreId: 'counters',
            connectedEventStore: new ConnectedEventStore(
              counterEventStore,
              bus,
            ),
            channel: bus,
          },
        ],
      ]),
      ctx: { ...ctx(), adapter },
      hooks: { onDead },
    });

    expect(result).toBe('dead');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
