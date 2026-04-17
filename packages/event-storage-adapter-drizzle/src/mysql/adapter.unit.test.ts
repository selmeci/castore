import { MySqlContainer, StartedMySqlContainer } from '@testcontainers/mysql';
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import { mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import mysql from 'mysql2/promise';

import { makeAdapterConformanceSuite } from '../__tests__/conformance';
import { DrizzleMysqlEventStorageAdapter } from './adapter';
import { eventColumns, eventTable, eventTableConstraints } from './schema';

// Shared testcontainer + mysql2 connection at file scope — the conformance
// factory and the dialect-local describes below share one running container.
// The factory's `setup`/`teardown` callbacks only build adapters and a reset
// fn against the shared `db`; container lifecycle is owned here.
let mysqlContainer: StartedMySqlContainer;
let connection: mysql.Connection;
let db: MySql2Database;
let adapterA: DrizzleMysqlEventStorageAdapter;
let adapterB: DrizzleMysqlEventStorageAdapter;

const createEventTableSql = `
  CREATE TABLE event (
    aggregate_name  VARCHAR(255) NOT NULL,
    aggregate_id    VARCHAR(64) NOT NULL,
    version         INT NOT NULL,
    type            VARCHAR(255) NOT NULL,
    payload         JSON,
    metadata        JSON,
    timestamp       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT event_aggregate_version_uq UNIQUE (aggregate_name, aggregate_id, version)
  )
`;

const resetEventTable = async (): Promise<void> => {
  await connection.query(`DROP TABLE IF EXISTS event`);
  await connection.query(createEventTableSql);
};

beforeAll(async () => {
  mysqlContainer = await new MySqlContainer('mysql:8.0.36').start();
  connection = await mysql.createConnection({
    host: mysqlContainer.getHost(),
    port: mysqlContainer.getPort(),
    user: mysqlContainer.getUsername(),
    password: mysqlContainer.getUserPassword(),
    database: mysqlContainer.getDatabase(),
    multipleStatements: true,
  });
  db = drizzle(connection);
  adapterA = new DrizzleMysqlEventStorageAdapter({ db, eventTable });
  adapterB = new DrizzleMysqlEventStorageAdapter({ db, eventTable });
}, 120_000);

afterAll(async () => {
  await connection.end();
  await mysqlContainer.stop();
});

makeAdapterConformanceSuite({
  dialectName: 'mysql',
  adapterClass: DrizzleMysqlEventStorageAdapter,
  setup: async () => ({
    adapterA,
    adapterB,
    reset: resetEventTable,
  }),
  teardown: async () => {
    /* container lifecycle is owned by the file, not the factory */
  },
});

// Dialect-local scenarios — JSON round-trip parity and extended-table.

describe('drizzle mysql storage adapter — JSON round-trip', () => {
  const eventStoreId = 'eventStoreId';

  beforeEach(async () => {
    await resetEventTable();
  });

  it('round-trips Unicode and nested JSON payloads', async () => {
    const aggregateId = randomUUID();
    const payload = {
      name: 'тест',
      greek: 'π',
      nested: {
        a: [1, 2, 3],
        b: 'π',
        c: { deep: true, tag: 'ünïcødé' },
      },
      empty: null,
    };
    const metadata = { actor: 'user-1', when: '2024-01-01T00:00:00.000Z' };

    await adapterA.pushEvent(
      {
        aggregateId,
        version: 1,
        type: 'EVENT_TYPE',
        timestamp: '2021-01-01T00:00:00.000Z',
        payload,
        metadata,
      },
      { eventStoreId },
    );

    const { events } = await adapterA.getEvents(aggregateId, { eventStoreId });
    expect(events).toHaveLength(1);
    // Parsed-value equivalence (MySQL's JSON reorders keys — not byte-equal).
    expect(events[0]?.payload).toStrictEqual(payload);
    expect(events[0]?.metadata).toStrictEqual(metadata);
  });
});

describe('drizzle mysql storage adapter — extended table', () => {
  const eventStoreId = 'eventStoreId';
  const aggregateIdMock1 = randomUUID();
  const eventMock1 = {
    aggregateId: aggregateIdMock1,
    version: 1,
    type: 'EVENT_TYPE',
    timestamp: '2021-01-01T00:00:00.000Z',
  };

  const extendedEventsTable = mysqlTable(
    'events_extended',
    {
      ...eventColumns,
      tenantId: varchar('tenant_id', { length: 64 }),
      correlationId: varchar('correlation_id', { length: 36 })
        .notNull()
        .default(sql`(UUID())`),
    },
    eventTableConstraints,
  );

  const createExtendedSql = `
    CREATE TABLE IF NOT EXISTS events_extended (
      aggregate_name   VARCHAR(255) NOT NULL,
      aggregate_id     VARCHAR(64) NOT NULL,
      version          INT NOT NULL,
      type             VARCHAR(255) NOT NULL,
      payload          JSON,
      metadata         JSON,
      timestamp        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      tenant_id        VARCHAR(64),
      correlation_id   VARCHAR(36) NOT NULL DEFAULT (UUID()),
      CONSTRAINT events_extended_aggregate_version_uq
        UNIQUE (aggregate_name, aggregate_id, version)
    )
  `;
  const dropExtendedSql = `DROP TABLE IF EXISTS events_extended`;

  beforeEach(async () => {
    await connection.query(dropExtendedSql);
    await connection.query(createExtendedSql);
  });
  afterEach(async () => {
    await connection.query(dropExtendedSql);
  });

  it('pushes and reads events without touching extra columns', async () => {
    const adapter = new DrizzleMysqlEventStorageAdapter({
      db,
      eventTable: extendedEventsTable,
    });

    const { event } = await adapter.pushEvent(eventMock1, { eventStoreId });
    expect(event).toStrictEqual(eventMock1);
    // The returned EventDetail should NOT expose the user's extras.
    expect(event as Record<string, unknown>).not.toHaveProperty('tenantId');
    expect(event as Record<string, unknown>).not.toHaveProperty(
      'correlationId',
    );

    const { events } = await adapter.getEvents(aggregateIdMock1, {
      eventStoreId,
    });
    expect(events).toStrictEqual([eventMock1]);

    // Server-side: confirm extras exist and the defaulted `correlation_id`
    // was populated by the DB (non-null UUID), and `tenant_id` is null
    // because the adapter doesn't know about it.
    const [rows] = (await connection.query(
      `SELECT tenant_id, correlation_id FROM events_extended WHERE aggregate_id = '${aggregateIdMock1}'`,
    )) as [{ tenant_id: unknown; correlation_id: unknown }[], unknown];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBeNull();
    expect(typeof rows[0]?.correlation_id).toBe('string');
    expect(String(rows[0]?.correlation_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
