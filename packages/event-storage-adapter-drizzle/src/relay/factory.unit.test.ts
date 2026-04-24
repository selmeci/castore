import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import {
  ConnectedEventStore,
  EventStore,
  EventType,
  NotificationMessageBus,
  OUTBOX_ENABLED_SYMBOL,
  OUTBOX_GET_EVENT_SYMBOL,
} from '@castore/core';
import type { EventDetail, EventStorageAdapter } from '@castore/core';

import type { RelayRegistryEntry } from '../common/outbox/types';
import { claimSqlite } from '../sqlite/outbox/claim';
import { outboxTable } from '../sqlite/schema';
import {
  DuplicateEventStoreIdError,
  OutboxNotEnabledError,
  RegistryEntryMismatchError,
  UnsupportedChannelTypeError,
} from './errors';
import { createOutboxRelay } from './factory';

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
const countersStore = new EventStore({
  eventStoreId: 'counters',
  eventTypes: [eventType],
  reducer: (_agg, event: EventDetail) => ({
    aggregateId: event.aggregateId,
    version: event.version,
  }),
});
const pokemonsStore = new EventStore({
  eventStoreId: 'pokemons',
  eventTypes: [eventType],
  reducer: (_agg, event: EventDetail) => ({
    aggregateId: event.aggregateId,
    version: event.version,
  }),
});

const makeOutboxAdapter = (): EventStorageAdapter =>
  ({
    [OUTBOX_ENABLED_SYMBOL]: true,
    [OUTBOX_GET_EVENT_SYMBOL]: async (
      _name: string,
      id: string,
      version: number,
    ) => ({
      aggregateId: id,
      version,
      type: 'COUNTER_INCREMENTED',
      timestamp: '2026-04-20T00:00:00.000Z',
    }),
  }) as unknown as EventStorageAdapter;

describe('createOutboxRelay', () => {
  let bs: Database.Database;
  let db: ReturnType<typeof drizzle>;

  const claim: Parameters<typeof createOutboxRelay>[0]['claim'] = args =>
    claimSqlite({ db, outboxTable, ...args });

  beforeEach(() => {
    bs = new Database(':memory:');
    bs.prepare(createOutboxDDL).run();
    db = drizzle(bs);
  });

  afterEach(() => {
    bs.close();
  });

  it('rejects an adapter without the outbox capability', () => {
    const bus = new NotificationMessageBus({
      messageBusId: 'b',
      sourceEventStores: [countersStore],
    });
    expect(() =>
      createOutboxRelay({
        dialect: 'sqlite',
        adapter: {} as EventStorageAdapter,
        db,
        outboxTable,
        claim,
        registry: [
          {
            eventStoreId: 'counters',
            connectedEventStore: new ConnectedEventStore(countersStore, bus),
            channel: bus,
          },
        ],
      }),
    ).toThrow(OutboxNotEnabledError);
  });

  it('rejects duplicate eventStoreId in registry', () => {
    const bus = new NotificationMessageBus({
      messageBusId: 'b',
      sourceEventStores: [countersStore],
    });
    const entry = {
      eventStoreId: 'counters',
      connectedEventStore: new ConnectedEventStore(countersStore, bus),
      channel: bus,
    };
    expect(() =>
      createOutboxRelay({
        dialect: 'sqlite',
        adapter: makeOutboxAdapter(),
        db,
        outboxTable,
        claim,
        registry: [entry, { ...entry }],
      }),
    ).toThrow(DuplicateEventStoreIdError);
  });

  it('rejects mismatched eventStoreId vs connectedEventStore.eventStoreId', () => {
    const bus = new NotificationMessageBus({
      messageBusId: 'b',
      sourceEventStores: [countersStore],
    });
    expect(() =>
      createOutboxRelay({
        dialect: 'sqlite',
        adapter: makeOutboxAdapter(),
        db,
        outboxTable,
        claim,
        registry: [
          {
            eventStoreId: 'different-id',
            connectedEventStore: new ConnectedEventStore(countersStore, bus),
            channel: bus,
          },
        ],
      }),
    ).toThrow(RegistryEntryMismatchError);
  });

  it('rejects a registry entry whose channel is neither Notification nor StateCarrying', () => {
    const bogusChannel = {
      messageChannelType: 'bogus',
      messageChannelId: 'bogus',
      publishMessage: async () => undefined,
    } as unknown as RelayRegistryEntry['channel'];
    expect(() =>
      createOutboxRelay({
        dialect: 'sqlite',
        adapter: makeOutboxAdapter(),
        db,
        outboxTable,
        claim,
        registry: [
          {
            eventStoreId: 'counters',
            connectedEventStore: new ConnectedEventStore(
              countersStore,
              new NotificationMessageBus({
                messageBusId: 'unused',
                sourceEventStores: [countersStore],
              }),
            ),
            channel: bogusChannel,
          },
        ],
      }),
    ).toThrow(UnsupportedChannelTypeError);
  });

  it('constructs with a valid single-entry registry', () => {
    const bus = new NotificationMessageBus({
      messageBusId: 'b',
      sourceEventStores: [countersStore],
    });
    expect(() =>
      createOutboxRelay({
        dialect: 'sqlite',
        adapter: makeOutboxAdapter(),
        db,
        outboxTable,
        claim,
        registry: [
          {
            eventStoreId: 'counters',
            connectedEventStore: new ConnectedEventStore(countersStore, bus),
            channel: bus,
          },
        ],
      }),
    ).not.toThrow();
  });

  it('defensive-copies the registry array so post-construction mutations have no effect', async () => {
    const counterBus = new NotificationMessageBus({
      messageBusId: 'bus-c',
      sourceEventStores: [countersStore],
    });
    const pokemonsBus = new NotificationMessageBus({
      messageBusId: 'bus-p',
      sourceEventStores: [pokemonsStore],
    });
    const registry: RelayRegistryEntry[] = [
      {
        eventStoreId: 'counters',
        connectedEventStore: new ConnectedEventStore(
          countersStore,
          counterBus,
        ) as unknown as RelayRegistryEntry['connectedEventStore'],
        channel: counterBus as unknown as RelayRegistryEntry['channel'],
      },
    ];

    const relay = createOutboxRelay({
      dialect: 'sqlite',
      adapter: makeOutboxAdapter(),
      db,
      outboxTable,
      claim,
      registry,
    });

    // Mutate the caller's array — relay must not pick up the new entry.
    registry.push({
      eventStoreId: 'pokemons',
      connectedEventStore: new ConnectedEventStore(
        pokemonsStore,
        pokemonsBus,
      ) as unknown as RelayRegistryEntry['connectedEventStore'],
      channel: pokemonsBus as unknown as RelayRegistryEntry['channel'],
    });

    // Seed a row under the not-in-relay store; relay must filter it out.
    await db.insert(outboxTable).values({
      id: randomUUID(),
      aggregateName: 'pokemons',
      aggregateId: 'p1',
      version: 1,
    });

    const result = await relay.runOnce();
    expect(result.claimed).toBe(0);
  });

  it('rejects a second runContinuously() call while the first loop is still running', async () => {
    const bus = new NotificationMessageBus({
      messageBusId: 'b',
      sourceEventStores: [countersStore],
    });
    const relay = createOutboxRelay({
      dialect: 'sqlite',
      adapter: makeOutboxAdapter(),
      db,
      outboxTable,
      claim,
      registry: [
        {
          eventStoreId: 'counters',
          connectedEventStore: new ConnectedEventStore(countersStore, bus),
          channel: bus,
        },
      ],
      options: { pollingMs: 25 },
    });

    const loop = relay.runContinuously();
    expect(() => relay.runContinuously()).toThrow(/already running/);

    await relay.stop();
    await loop;
  });

  it('runContinuously() can be restarted after stop() completes', async () => {
    const bus = new NotificationMessageBus({
      messageBusId: 'b',
      sourceEventStores: [countersStore],
    });
    const relay = createOutboxRelay({
      dialect: 'sqlite',
      adapter: makeOutboxAdapter(),
      db,
      outboxTable,
      claim,
      registry: [
        {
          eventStoreId: 'counters',
          connectedEventStore: new ConnectedEventStore(countersStore, bus),
          channel: bus,
        },
      ],
      options: { pollingMs: 25 },
    });

    const first = relay.runContinuously();
    await relay.stop();
    await first;

    // Restart must succeed after stop() has resolved.
    const second = relay.runContinuously();
    await relay.stop();
    await second;
  });

  it('exposes retryRow and deleteRow bound to the relay db + table', async () => {
    const bus = new NotificationMessageBus({
      messageBusId: 'b',
      sourceEventStores: [countersStore],
    });
    const relay = createOutboxRelay({
      dialect: 'sqlite',
      adapter: makeOutboxAdapter(),
      db,
      outboxTable,
      claim,
      registry: [
        {
          eventStoreId: 'counters',
          connectedEventStore: new ConnectedEventStore(countersStore, bus),
          channel: bus,
        },
      ],
    });

    // Seed a dead row.
    const rowId = randomUUID();
    await db.insert(outboxTable).values({
      id: rowId,
      aggregateName: 'counters',
      aggregateId: 'a',
      version: 1,
      attempts: 3,
      deadAt: new Date().toISOString(),
    });

    const retryResult = await relay.retryRow(rowId);
    expect(retryResult.warning).toBe('at-most-once-not-guaranteed');

    await relay.deleteRow(rowId);
    const count = (
      bs.prepare('SELECT COUNT(*) AS c FROM castore_outbox').get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(0);
  });
});
