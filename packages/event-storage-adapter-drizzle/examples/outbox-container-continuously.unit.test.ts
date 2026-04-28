/**
 * Runtime recipe: outbox relay in a long-running container (or any persistent
 * worker that stays up, polls the outbox, and drains rows as they arrive).
 *
 * Plot:
 *   1. Set up an in-memory SQLite database, event table, and outbox table.
 *   2. Construct a `DrizzleSqliteEventStorageAdapter` with the outbox option.
 *   3. Wire a `ConnectedEventStore` + `NotificationMessageBus`.
 *   4. Start `runContinuously()` in the background.
 *   5. Push events through the store while the relay is running.
 *   6. Assert the relay eventually publishes them without manual `runOnce()`.
 *   7. Call `stop()` and assert graceful shutdown completes cleanly.
 *
 * In production you would replace the in-memory bus with your real message-bus
 * adapter and the SQLite DB with your persistent PostgreSQL / MySQL connection.
 * The SIGTERM handler shape matches Docker / Kubernetes lifecycle expectations.
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

describe('outbox-container recipe: long-running worker with runContinuously()', () => {
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

  const counterEventType = new EventType({ type: 'COUNTER_INCREMENTED' });

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

  const adapter = new DrizzleSqliteEventStorageAdapter({
    db,
    eventTable,
    outbox: outboxTable,
  });

  assertOutboxEnabled(adapter, { mode: 'throw' });

  counterEventStore.eventStorageAdapter = adapter;
  const connectedEventStore = new ConnectedEventStore(counterEventStore, bus);

  // stop() is permanent — each test that exercises runContinuously needs a
  // fresh relay. This helper mirrors the production setup.
  const makeRelay = () =>
    createOutboxRelay({
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
        onDead: (row, err) => {
          console.warn(
            `[outbox] Row ${row.id} is dead:`,
            err instanceof Error ? err.message : String(err),
          );
        },
        onFail: (row, err, attempts, nextBackoffMs) => {
          console.warn(
            `[outbox] Publish failed for row ${row.id} (attempt ${attempts}, next retry in ${nextBackoffMs}ms):`,
            err instanceof Error ? err.message : String(err),
          );
        },
      },
      options: {
        // Aggressive polling so the test doesn't wait long.
        pollingMs: 50,
        baseMs: 50,
        ceilingMs: 200,
      },
    });

  const receivedMessages: unknown[] = [];
  const originalPublishMessage = bus.publishMessage.bind(bus);

  beforeEach(() => {
    receivedMessages.length = 0;
    bus.publishMessage = originalPublishMessage;
    bsDb.prepare(`DELETE FROM event`).run();
    bsDb.prepare(`DELETE FROM castore_outbox`).run();
  });

  afterAll(() => {
    bsDb.close();
  });

  it('continuously drains outbox rows as they arrive', async () => {
    bus.publishMessage = async message => {
      receivedMessages.push(message);
    };

    const relay = makeRelay();

    // Start the relay in the background. In production this is your `main()`
    // entry point; the SIGTERM handler calls `relay.stop()`.
    const continuousPromise = relay.runContinuously();

    // SQLite shares one connection: wait for the relay to finish its first
    // empty runOnce() + pollingMs sleep so our pushEvent BEGIN doesn't
    // collide with an in-flight claim transaction.
    await new Promise(r => setTimeout(r, 150));

    // Push events while the relay is already running.
    for (let v = 1; v <= 5; v++) {
      await connectedEventStore.pushEvent({
        aggregateId: 'counter-1',
        version: v,
        type: 'COUNTER_INCREMENTED',
        payload: { at: v },
      });
    }

    // Poll until all events are published (deterministic, not wall-clock).
    let attempts = 0;
    while (receivedMessages.length < 5 && attempts < 100) {
      await new Promise(r => setTimeout(r, 25));
      attempts++;
    }

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

    // Graceful shutdown — SIGTERM equivalent.
    await relay.stop();

    // The continuous loop should have resolved cleanly.
    await expect(continuousPromise).resolves.toBeUndefined();
  });

  it('stop() resolves cleanly even when the outbox is empty', async () => {
    const relay = makeRelay();
    const continuousPromise = relay.runContinuously();

    await relay.stop();
    await expect(continuousPromise).resolves.toBeUndefined();
  });
});
