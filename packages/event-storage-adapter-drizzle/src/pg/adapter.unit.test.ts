import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import {
  drizzle as drizzleNodePg,
  type NodePgDatabase,
} from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import {
  drizzle as drizzlePostgresJs,
  type PostgresJsDatabase,
} from 'drizzle-orm/postgres-js';
import omit from 'lodash.omit';
import { Pool } from 'pg';
import postgres from 'postgres';

import {
  eventAlreadyExistsErrorCode,
  GroupedEvent,
  type EventStorageAdapter,
} from '@castore/core';

import { DrizzleEventAlreadyExistsError } from '../common/error';
import { DrizzlePgEventStorageAdapter } from './adapter';
import { eventColumns, eventTable, eventTableConstraints } from './schema';

const eventStoreId = 'eventStoreId';

const aggregateIdMock1 = randomUUID();
const aggregate1InitialEventTimestamp = '2021-01-01T00:00:00.000Z';
const aggregateIdMock2 = randomUUID();
const aggregate2InitialEventTimestamp = '2022-01-01T00:00:00.000Z';
const aggregateIdMock3 = randomUUID();
const aggregate3InitialEventTimestamp = '2023-01-01T00:00:00.000Z';
const aggregateIdMock4 = randomUUID();
const aggregate4InitialEventTimestamp = '2024-01-01T00:00:00.000Z';

const eventMock1 = {
  aggregateId: aggregateIdMock1,
  version: 1,
  type: 'EVENT_TYPE',
  timestamp: aggregate1InitialEventTimestamp,
};
const eventMock2 = {
  aggregateId: aggregateIdMock1,
  version: 2,
  type: 'EVENT_TYPE',
  timestamp: aggregate2InitialEventTimestamp,
};

const createTableSql = sql`
  CREATE TABLE IF NOT EXISTS event (
    aggregate_name  TEXT NOT NULL,
    aggregate_id    TEXT NOT NULL,
    version         INTEGER NOT NULL,
    type            TEXT NOT NULL,
    payload         JSONB,
    metadata        JSONB,
    timestamp       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT event_aggregate_version_uq UNIQUE (aggregate_name, aggregate_id, version)
  );
`;
const dropTableSql = sql`DROP TABLE IF EXISTS event;`;

let pgInstance: StartedPostgreSqlContainer;
let connectionString: string;
let pgjsClient: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;
let eventStorageAdapter: DrizzlePgEventStorageAdapter;
let eventStorageAdapterB: DrizzlePgEventStorageAdapter;

beforeAll(async () => {
  pgInstance = await new PostgreSqlContainer('postgres:15.3-alpine').start();
  connectionString = pgInstance.getConnectionUri();
  pgjsClient = postgres(connectionString);
  db = drizzlePostgresJs(pgjsClient);
  eventStorageAdapter = new DrizzlePgEventStorageAdapter({ db, eventTable });
  eventStorageAdapterB = new DrizzlePgEventStorageAdapter({ db, eventTable });
}, 100_000);

beforeEach(async () => {
  await db.execute(createTableSql);
});

afterEach(async () => {
  await db.execute(dropTableSql);
});

afterAll(async () => {
  await pgjsClient.end();
  await pgInstance.stop();
});

describe('drizzle pg storage adapter (postgres-js)', () => {
  describe('methods', () => {
    describe('getEvents / pushEvent', () => {
      it('gets an empty array if there is no event for aggregateId', async () => {
        const response = await eventStorageAdapter.getEvents(aggregateIdMock1, {
          eventStoreId,
        });
        expect(response).toStrictEqual({ events: [] });
      });

      it('throws an error if version already exists', async () => {
        await eventStorageAdapter.pushEvent(eventMock1, { eventStoreId });

        await expect(() =>
          eventStorageAdapter.pushEvent(eventMock1, { eventStoreId }),
        ).rejects.toThrow(DrizzleEventAlreadyExistsError);
      });

      it('attaches code / eventStoreId / aggregateId / version to the error', async () => {
        await eventStorageAdapter.pushEvent(eventMock1, { eventStoreId });

        let thrown: unknown;
        try {
          await eventStorageAdapter.pushEvent(eventMock1, { eventStoreId });
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(DrizzleEventAlreadyExistsError);
        const typed = thrown as DrizzleEventAlreadyExistsError;
        expect(typed.code).toBe(eventAlreadyExistsErrorCode);
        expect(typed.eventStoreId).toBe(eventStoreId);
        expect(typed.aggregateId).toBe(aggregateIdMock1);
        expect(typed.version).toBe(1);
      });

      it('overrides event if force option is set to true', async () => {
        const { event } = await eventStorageAdapter.pushEvent(eventMock1, {
          eventStoreId,
          force: true,
        });
        expect(event).toStrictEqual(eventMock1);

        const newEvent = { ...eventMock1, type: 'EVENT_TYPE_V2' };
        const { event: overridden } = await eventStorageAdapter.pushEvent(
          newEvent,
          { eventStoreId, force: true },
        );
        expect(overridden).toStrictEqual(newEvent);

        const { events } = await eventStorageAdapter.getEvents(
          aggregateIdMock1,
          { eventStoreId },
        );
        expect(events).toStrictEqual([newEvent]);
      });

      it('pushes and gets events correctly', async () => {
        await eventStorageAdapter.pushEvent(eventMock1, { eventStoreId });
        await eventStorageAdapter.pushEvent(eventMock2, { eventStoreId });

        const allEvents = await eventStorageAdapter.getEvents(
          aggregateIdMock1,
          { eventStoreId },
        );
        expect(allEvents).toStrictEqual({ events: [eventMock1, eventMock2] });

        const eventsMaxVersion = await eventStorageAdapter.getEvents(
          aggregateIdMock1,
          { eventStoreId },
          { maxVersion: 1 },
        );
        expect(eventsMaxVersion).toStrictEqual({ events: [eventMock1] });

        const eventsMinVersion = await eventStorageAdapter.getEvents(
          aggregateIdMock1,
          { eventStoreId },
          { minVersion: 2 },
        );
        expect(eventsMinVersion).toStrictEqual({ events: [eventMock2] });

        const eventsLimit = await eventStorageAdapter.getEvents(
          aggregateIdMock1,
          { eventStoreId },
          { limit: 1 },
        );
        expect(eventsLimit).toStrictEqual({ events: [eventMock1] });

        const eventsReverse = await eventStorageAdapter.getEvents(
          aggregateIdMock1,
          { eventStoreId },
          { reverse: true },
        );
        expect(eventsReverse).toStrictEqual({
          events: [eventMock2, eventMock1],
        });

        const eventsReverseAndLimit = await eventStorageAdapter.getEvents(
          aggregateIdMock1,
          { eventStoreId },
          { limit: 1, reverse: true },
        );
        expect(eventsReverseAndLimit).toStrictEqual({ events: [eventMock2] });
      });
    });

    describe('listAggregateIds', () => {
      it('list aggregate Ids', async () => {
        await eventStorageAdapter.pushEvent(eventMock1, { eventStoreId });
        await eventStorageAdapter.pushEvent(
          {
            aggregateId: aggregateIdMock2,
            version: 1,
            type: 'EVENT_TYPE',
            timestamp: aggregate2InitialEventTimestamp,
          },
          { eventStoreId },
        );

        const aggregateIds = await eventStorageAdapter.listAggregateIds({
          eventStoreId,
        });

        expect(aggregateIds).toStrictEqual({
          aggregateIds: [
            {
              aggregateId: aggregateIdMock1,
              initialEventTimestamp: aggregate1InitialEventTimestamp,
            },
            {
              aggregateId: aggregateIdMock2,
              initialEventTimestamp: aggregate2InitialEventTimestamp,
            },
          ],
        });
      });

      it('paginates aggregate Ids', async () => {
        await eventStorageAdapter.pushEvent(eventMock1, { eventStoreId });
        await eventStorageAdapter.pushEvent(
          {
            aggregateId: aggregateIdMock2,
            version: 1,
            type: 'EVENT_TYPE',
            timestamp: aggregate2InitialEventTimestamp,
          },
          { eventStoreId },
        );
        await eventStorageAdapter.pushEvent(
          {
            aggregateId: aggregateIdMock3,
            version: 1,
            type: 'EVENT_TYPE',
            timestamp: aggregate3InitialEventTimestamp,
          },
          { eventStoreId },
        );
        await eventStorageAdapter.pushEvent(
          {
            aggregateId: aggregateIdMock4,
            version: 1,
            type: 'EVENT_TYPE',
            timestamp: aggregate4InitialEventTimestamp,
          },
          { eventStoreId },
        );

        const { aggregateIds, nextPageToken } =
          await eventStorageAdapter.listAggregateIds(
            { eventStoreId },
            { limit: 2 },
          );

        expect(aggregateIds).toStrictEqual([
          {
            aggregateId: aggregateIdMock1,
            initialEventTimestamp: aggregate1InitialEventTimestamp,
          },
          {
            aggregateId: aggregateIdMock2,
            initialEventTimestamp: aggregate2InitialEventTimestamp,
          },
        ]);

        expect(JSON.parse(nextPageToken as string)).toStrictEqual({
          limit: 2,
          lastEvaluatedKey: {
            aggregateId: aggregateIdMock2,
            initialEventTimestamp: aggregate2InitialEventTimestamp,
          },
        });

        const lastAggregateIds = await eventStorageAdapter.listAggregateIds(
          { eventStoreId },
          { pageToken: nextPageToken },
        );

        expect(lastAggregateIds).toStrictEqual({
          aggregateIds: [
            {
              aggregateId: aggregateIdMock3,
              initialEventTimestamp: aggregate3InitialEventTimestamp,
            },
            {
              aggregateId: aggregateIdMock4,
              initialEventTimestamp: aggregate4InitialEventTimestamp,
            },
          ],
        });
      });

      it('applies listAggregateIds options', async () => {
        await eventStorageAdapter.pushEvent(eventMock1, { eventStoreId });
        await eventStorageAdapter.pushEvent(
          {
            aggregateId: aggregateIdMock2,
            version: 1,
            type: 'EVENT_TYPE',
            timestamp: aggregate2InitialEventTimestamp,
          },
          { eventStoreId },
        );
        await eventStorageAdapter.pushEvent(
          {
            aggregateId: aggregateIdMock3,
            version: 1,
            type: 'EVENT_TYPE',
            timestamp: aggregate3InitialEventTimestamp,
          },
          { eventStoreId },
        );
        await eventStorageAdapter.pushEvent(
          {
            aggregateId: aggregateIdMock4,
            version: 1,
            type: 'EVENT_TYPE',
            timestamp: aggregate4InitialEventTimestamp,
          },
          { eventStoreId },
        );

        const { aggregateIds, nextPageToken } =
          await eventStorageAdapter.listAggregateIds(
            { eventStoreId },
            {
              limit: 1,
              initialEventAfter: '2021-02-01T00:00:00.000Z',
              initialEventBefore: '2023-02-01T00:00:00.000Z',
              reverse: true,
            },
          );

        expect(aggregateIds).toStrictEqual([
          {
            aggregateId: aggregateIdMock3,
            initialEventTimestamp: aggregate3InitialEventTimestamp,
          },
        ]);
        expect(JSON.parse(nextPageToken as string)).toStrictEqual({
          limit: 1,
          initialEventAfter: '2021-02-01T00:00:00.000Z',
          initialEventBefore: '2023-02-01T00:00:00.000Z',
          reverse: true,
          lastEvaluatedKey: {
            aggregateId: aggregateIdMock3,
            initialEventTimestamp: aggregate3InitialEventTimestamp,
          },
        });

        const { aggregateIds: lastAggregateIds, nextPageToken: noPageToken } =
          await eventStorageAdapter.listAggregateIds(
            { eventStoreId },
            { pageToken: nextPageToken },
          );

        expect(noPageToken).toBeUndefined();
        expect(lastAggregateIds).toStrictEqual([
          {
            aggregateId: aggregateIdMock2,
            initialEventTimestamp: aggregate2InitialEventTimestamp,
          },
        ]);
      });
    });

    describe('groupEvent', () => {
      it('groups events correctly', () => {
        const groupedEvent = eventStorageAdapter.groupEvent(
          omit(eventMock1, 'timestamp'),
        );

        expect(groupedEvent).toBeInstanceOf(GroupedEvent);
        expect(groupedEvent).toMatchObject({
          event: omit(eventMock1, 'timestamp'),
          eventStorageAdapter: eventStorageAdapter,
        });
      });
    });
  });

  describe('pushEventGroup', () => {
    // @ts-expect-error — we only need it to NOT be an instance of DrizzlePgEventStorageAdapter
    const eventStorageAdapterC: EventStorageAdapter = {};
    eventStorageAdapterC;

    const aggregate2EventMock = {
      aggregateId: aggregateIdMock2,
      version: 1,
      type: 'EVENT_TYPE',
      timestamp: eventMock1.timestamp,
    };

    it('push grouped events correctly', async () => {
      const groupedEvents: [GroupedEvent, ...GroupedEvent[]] = [
        new GroupedEvent({
          event: eventMock1,
          eventStorageAdapter: eventStorageAdapter,
          context: { eventStoreId },
        }),
        new GroupedEvent({
          event: aggregate2EventMock,
          eventStorageAdapter: eventStorageAdapterB,
          context: { eventStoreId },
        }),
      ];

      const eventGroup = await eventStorageAdapter.pushEventGroup(
        { force: true },
        ...groupedEvents,
      );
      expect(eventGroup).toStrictEqual({
        eventGroup: [{ event: eventMock1 }, { event: aggregate2EventMock }],
      });

      const { events: eventsA } = await eventStorageAdapter.getEvents(
        aggregateIdMock1,
        { eventStoreId },
      );
      expect(eventsA).toStrictEqual([eventMock1]);

      const { events: eventsB } = await eventStorageAdapterB.getEvents(
        aggregateIdMock2,
        { eventStoreId },
      );
      expect(eventsB).toStrictEqual([aggregate2EventMock]);
    });

    it('throws if event storage adapter is not DrizzlePgEventStorageAdapter', async () => {
      const groupedEvents: [GroupedEvent, ...GroupedEvent[]] = [
        new GroupedEvent({
          event: eventMock1,
          eventStorageAdapter: eventStorageAdapter,
          context: { eventStoreId },
        }),
        new GroupedEvent({
          event: aggregate2EventMock,
          eventStorageAdapter: eventStorageAdapterC,
          context: { eventStoreId },
        }),
      ];

      await expect(() =>
        eventStorageAdapter.pushEventGroup({}, ...groupedEvents),
      ).rejects.toThrow();
    });

    it('throws if context is missing', async () => {
      const groupedEvents: [GroupedEvent, ...GroupedEvent[]] = [
        new GroupedEvent({
          event: eventMock1,
          eventStorageAdapter: eventStorageAdapter,
          context: { eventStoreId },
        }),
        new GroupedEvent({
          event: aggregate2EventMock,
          eventStorageAdapter: eventStorageAdapterB,
        }),
      ];

      await expect(() =>
        eventStorageAdapter.pushEventGroup({}, ...groupedEvents),
      ).rejects.toThrow();
    });

    it('throws if events have different timestamps', async () => {
      const groupedEvents: [GroupedEvent, ...GroupedEvent[]] = [
        new GroupedEvent({
          event: eventMock1,
          eventStorageAdapter: eventStorageAdapter,
          context: { eventStoreId },
        }),
        new GroupedEvent({
          event: {
            ...aggregate2EventMock,
            timestamp: new Date().toISOString(),
          },
          eventStorageAdapter: eventStorageAdapterB,
          context: { eventStoreId },
        }),
      ];

      await expect(() =>
        eventStorageAdapter.pushEventGroup({}, ...groupedEvents),
      ).rejects.toThrow();
    });

    it('reverts all events if a push has failed', async () => {
      await eventStorageAdapter.pushEvent(eventMock1, { eventStoreId });
      const groupedEvents: [GroupedEvent, ...GroupedEvent[]] = [
        new GroupedEvent({
          event: eventMock1,
          eventStorageAdapter: eventStorageAdapter,
          context: { eventStoreId },
        }),
        new GroupedEvent({
          event: aggregate2EventMock,
          eventStorageAdapter: eventStorageAdapterB,
          context: { eventStoreId },
        }),
      ];

      await expect(() =>
        eventStorageAdapter.pushEventGroup({}, ...groupedEvents),
      ).rejects.toThrow();

      const { events: eventsA } = await eventStorageAdapter.getEvents(
        aggregateIdMock1,
        { eventStoreId },
      );
      expect(eventsA).toStrictEqual([eventMock1]);

      const { events: eventsB } = await eventStorageAdapterB.getEvents(
        aggregateIdMock2,
        { eventStoreId },
      );
      expect(eventsB).toStrictEqual([]);
    });
  });

  describe('extended table', () => {
    const extendedEventsTable = pgTable(
      'events_extended',
      {
        ...eventColumns,
        tenantId: text('tenant_id'),
        correlationId: text('correlation_id'),
      },
      eventTableConstraints,
    );

    const createExtendedSql = sql`
      CREATE TABLE IF NOT EXISTS events_extended (
        aggregate_name   TEXT NOT NULL,
        aggregate_id     TEXT NOT NULL,
        version          INTEGER NOT NULL,
        type             TEXT NOT NULL,
        payload          JSONB,
        metadata         JSONB,
        timestamp        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        tenant_id        TEXT,
        correlation_id   TEXT,
        CONSTRAINT events_extended_aggregate_version_uq
          UNIQUE (aggregate_name, aggregate_id, version)
      );
    `;
    const dropExtendedSql = sql`DROP TABLE IF EXISTS events_extended;`;

    beforeEach(async () => {
      await db.execute(createExtendedSql);
    });
    afterEach(async () => {
      await db.execute(dropExtendedSql);
    });

    it('pushes and reads events without touching extra columns', async () => {
      const adapter = new DrizzlePgEventStorageAdapter({
        db,
        eventTable: extendedEventsTable,
      });

      const { event } = await adapter.pushEvent(eventMock1, { eventStoreId });
      expect(event).toStrictEqual(eventMock1);

      const { events } = await adapter.getEvents(aggregateIdMock1, {
        eventStoreId,
      });
      expect(events).toStrictEqual([eventMock1]);

      // Confirm the user-owned extras exist server-side and were untouched.
      const raw: unknown = await db.execute(
        sql`SELECT tenant_id, correlation_id FROM events_extended WHERE aggregate_id = ${aggregateIdMock1};`,
      );
      // postgres-js returns an array directly; node-postgres returns { rows: [...] }
      const rows: { tenant_id: unknown; correlation_id: unknown }[] =
        Array.isArray(raw)
          ? (raw as { tenant_id: unknown; correlation_id: unknown }[])
          : ((
              raw as {
                rows?: { tenant_id: unknown; correlation_id: unknown }[];
              }
            ).rows ?? []);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tenant_id).toBeNull();
      expect(rows[0]?.correlation_id).toBeNull();
    });
  });

  describe('node-postgres driver coverage', () => {
    let pool: Pool;
    let nodePgDb: NodePgDatabase;
    let nodePgAdapter: DrizzlePgEventStorageAdapter;

    beforeAll(async () => {
      pool = new Pool({ connectionString });
      nodePgDb = drizzleNodePg(pool);
      nodePgAdapter = new DrizzlePgEventStorageAdapter({
        db: nodePgDb,
        eventTable,
      });
    });

    afterAll(async () => {
      await pool.end();
    });

    it('pushes, reads, and detects a duplicate-key error', async () => {
      const { event } = await nodePgAdapter.pushEvent(eventMock1, {
        eventStoreId,
      });
      expect(event).toStrictEqual(eventMock1);

      const { events } = await nodePgAdapter.getEvents(aggregateIdMock1, {
        eventStoreId,
      });
      expect(events).toStrictEqual([eventMock1]);

      await expect(() =>
        nodePgAdapter.pushEvent(eventMock1, { eventStoreId }),
      ).rejects.toBeInstanceOf(DrizzleEventAlreadyExistsError);
    });
  });
});
