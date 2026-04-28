/**
 * Runtime recipe: outbox relay in a cron-triggered Lambda (or any short-lived
 * worker that wakes up, drains the outbox, and exits).
 *
 * Plot:
 *   1. Set up an in-memory SQLite database, event table, and outbox table.
 *   2. Construct a `DrizzleSqliteEventStorageAdapter` with the outbox option
 *      enabled — this is the ONLY change needed on the write side.
 *   3. Wire a `ConnectedEventStore` + `NotificationMessageBus` (in-memory for
 *      the test; real Lambdas use EventBridge/SQS adapters).
 *   4. Push N events through the store. Because outbox is enabled, events are
 *      committed to both the event table and the outbox table atomically, but
 *      they are NOT published to the bus yet.
 *   5. Construct an outbox relay, call `runOnce()`, and assert all N events
 *      arrive on the bus.
 *
 * In production you would replace the in-memory bus with your real message-bus
 * adapter (e.g. `@castore/message-bus-adapter-event-bridge`) and the SQLite
 * DB with your persistent PostgreSQL / MySQL connection.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import {
  ConnectedEventStore,
  EventStore,
  EventType,
  NotificationMessageBus,
} from '@castore/core';

import {
  assertOutboxEnabled,
  claimSqlite,
  createOutboxRelay,
} from '../src/relay';
import {
  DrizzleSqliteEventStorageAdapter,
  eventTable,
  outboxTable,
} from '../src/sqlite';

describe('outbox-lambda recipe: cron Lambda that drains outbox with runOnce()', () => {
  // In-memory DB for the test. In production this is your persistent pg/mysql.
  const bsDb = new Database(':memory:');
  const db = drizzle(bsDb);

  // Raw DDL — in production, drizzle-kit owns these migrations.
  bsDb
    .prepare(
      `
    CREATE TABLE event (
      aggregate_name  TEXT NOT NULL,
      aggregate_id    TEXT NOT NULL,
      version         INTEGER NOT NULL,
      type            TEXT NOT NULL,
      payload         TEXT,
      metadata        TEXT,
      timestamp       TEXT NOT NULL,
      CONSTRAINT event_aggregate_version_uq UNIQUE (aggregate_name, aggregate_id, version)
    )
  `,
    )
    .run();
  bsDb
    .prepare(
      `
    CREATE TABLE castore_outbox (
      id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      aggregate_name  TEXT NOT NULL,
      aggregate_id    TEXT NOT NULL,
      version         INTEGER NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      claim_token     TEXT,
      claimed_at      TEXT,
      processed_at    TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      last_attempt_at TEXT,
      dead_at         TEXT,
      CONSTRAINT outbox_aggregate_version_uq UNIQUE (aggregate_name, aggregate_id, version)
    )
  `,
    )
    .run();

  const counterEventType = new EventType<'COUNTER_INCREMENTED', { at: number }>(
    { type: 'COUNTER_INCREMENTED' },
  );

  interface CounterAggregate {
    aggregateId: string;
    version: number;
    count: number;
  }

  const counterEventStore = new EventStore({
    eventStoreId: 'COUNTERS',
    eventTypes: [counterEventType],
    reducer: (agg: CounterAggregate | undefined, event): CounterAggregate => ({
      aggregateId: event.aggregateId,
      version: event.version,
      count: (agg?.count ?? 0) + 1,
    }),
  });

  const bus = new NotificationMessageBus({
    messageBusId: 'COUNTERS-bus',
    sourceEventStores: [counterEventStore],
  });

  // Write-side adapter with outbox enabled.
  const adapter = new DrizzleSqliteEventStorageAdapter({
    db,
    eventTable,
    outbox: outboxTable,
  });

  // Bootstrap safety check — fails fast in production if the adapter was
  // constructed without the outbox option (see README for mode semantics).
  assertOutboxEnabled(adapter, { mode: 'throw' });

  counterEventStore.eventStorageAdapter = adapter;
  const connectedEventStore = new ConnectedEventStore(counterEventStore, bus);

  // Relay registry — maps eventStoreId to the store + channel pair.
  const relay = createOutboxRelay({
    dialect: 'sqlite',
    adapter,
    db,
    outboxTable,
    claim: args => claimSqlite({ db, outboxTable, ...args }),
    registry: [
      {
        eventStoreId: 'COUNTERS',
        connectedEventStore,
        channel: bus,
      },
    ],
    hooks: {
      // In production, wire this to PagerDuty / Datadog / CloudWatch.
      onDead: ({ row, lastError }) => {
        console.warn(`[outbox] Row ${row.id} is dead:`, lastError);
      },
      onFail: ({ row, error, attempts, nextBackoffMs }) => {
        console.warn(
          `[outbox] Publish failed for row ${row.id} (attempt ${attempts}, next retry in ${nextBackoffMs}ms):`,
          error instanceof Error ? error.message : String(error),
        );
      },
    },
  });

  const receivedMessages: unknown[] = [];
  const originalPublishMessage = bus.publishMessage.bind(bus);

  beforeEach(() => {
    receivedMessages.length = 0;
    bsDb.prepare(`DELETE FROM event`).run();
    bsDb.prepare(`DELETE FROM castore_outbox`).run();
  });

  afterEach(() => {
    // Restore the original publishMessage so test isolation is clean.
    bus.publishMessage = originalPublishMessage;
  });

  afterAll(() => {
    bsDb.close();
  });

  it('pushes events atomically, then runOnce drains them to the bus', async () => {
    // Intercept publishMessage so we can observe what the relay publishes.
    bus.publishMessage = async message => {
      receivedMessages.push(message);
    };

    // Push 5 events. Because outbox is enabled, these land in the event
    // table AND the outbox table, but the bus subscriber receives nothing
    // yet — publish is deferred to the relay.
    for (let v = 1; v <= 5; v++) {
      await connectedEventStore.pushEvent({
        aggregateId: 'counter-1',
        version: v,
        type: 'COUNTER_INCREMENTED',
        payload: { at: v },
      });
    }
    expect(receivedMessages).toHaveLength(0);

    // The Lambda handler body: drain the outbox in a loop.
    // One runOnce() per iteration because per-aggregate FIFO means each batch
    // can claim only the earliest unprocessed version.
    let totalClaimed = 0;
    let totalProcessed = 0;

    let result = await relay.runOnce();
    while (result.claimed > 0) {
      totalClaimed += result.claimed;
      totalProcessed += result.processed;
      result = await relay.runOnce();
    }
    expect(totalClaimed).toBe(5);
    expect(totalProcessed).toBe(5);

    // All 5 events were published in FIFO order.
    expect(receivedMessages).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(receivedMessages[i]).toMatchObject({
        eventStoreId: 'COUNTERS',
        event: {
          aggregateId: 'counter-1',
          version: i + 1,
          type: 'COUNTER_INCREMENTED',
          payload: { at: i + 1 },
        },
      });
    }
  });

  it('runOnce resolves cleanly when the outbox is empty', async () => {
    const result = await relay.runOnce();
    expect(result.claimed).toBe(0);
    expect(result.processed).toBe(0);
  });
});
