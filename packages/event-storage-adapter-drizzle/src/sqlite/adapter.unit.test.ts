import { createClient } from '@libsql/client';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { drizzle as drizzleBetterSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleLibsql } from 'drizzle-orm/libsql';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { makeAdapterConformanceSuite } from '../__tests__/conformance';
import { DrizzleEventAlreadyExistsError } from '../common/error';
import { DrizzleSqliteEventStorageAdapter } from './adapter';
import { eventColumns, eventTable, eventTableConstraints } from './schema';

// The shared better-sqlite3 in-process DB + drizzle handle live at the file
// level so the conformance suite AND the dialect-local describe blocks
// (JSON round-trip, extended table) share one DB. The factory's
// `setup`/`teardown` callbacks only build adapters and a reset fn against the
// shared `db`; DB lifecycle (open / close) is owned by this file.
let bsDb: Database.Database;
let db: ReturnType<typeof drizzleBetterSqlite>;
let adapterA: DrizzleSqliteEventStorageAdapter;
let adapterB: DrizzleSqliteEventStorageAdapter;

const createEventTableSql = `
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
`;

const resetEventTable = async (): Promise<void> => {
  bsDb.exec(`DROP TABLE IF EXISTS event`);
  bsDb.exec(createEventTableSql);
};

beforeAll(async () => {
  bsDb = new Database(':memory:');
  db = drizzleBetterSqlite(bsDb);
  adapterA = new DrizzleSqliteEventStorageAdapter({ db, eventTable });
  adapterB = new DrizzleSqliteEventStorageAdapter({ db, eventTable });
});

afterAll(async () => {
  bsDb.close();
});

makeAdapterConformanceSuite({
  dialectName: 'sqlite',
  adapterClass: DrizzleSqliteEventStorageAdapter,
  setup: async () => ({
    adapterA,
    adapterB,
    reset: resetEventTable,
  }),
  teardown: async () => {
    /* DB lifecycle is owned by the file, not the factory */
  },
});

// Dialect-local scenarios: JSON round-trip, extended table, libsql driver.

describe('drizzle sqlite storage adapter - JSON round-trip', () => {
  const eventStoreId = 'eventStoreId';

  beforeEach(async () => {
    await resetEventTable();
  });

  it('round-trips null, arrays, and nested JSON payloads', async () => {
    const aggregateId = randomUUID();
    const payload = {
      a: null,
      b: [1, 2, 3],
      c: { nested: 'pi', arr: [{ x: true }] },
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
    expect(events[0]?.payload).toStrictEqual(payload);
    expect(events[0]?.metadata).toStrictEqual(metadata);
  });
});

describe('drizzle sqlite storage adapter - extended table', () => {
  const eventStoreId = 'eventStoreId';
  const aggregateIdMock1 = randomUUID();
  const eventMock1 = {
    aggregateId: aggregateIdMock1,
    version: 1,
    type: 'EVENT_TYPE',
    timestamp: '2021-01-01T00:00:00.000Z',
  };

  // A standalone better-sqlite3 DB + drizzle handle dedicated to the
  // extended-table test. Using a second in-memory DB keeps the extra column
  // fully isolated from the main conformance-suite `event` table.
  let extBsDb: Database.Database;
  let extDb: ReturnType<typeof drizzleBetterSqlite>;

  const extendedEventsTable = sqliteTable(
    'events_extended',
    {
      ...eventColumns,
      tenantId: text('tenant_id'),
    },
    eventTableConstraints,
  );

  const createExtendedSql = `
    CREATE TABLE IF NOT EXISTS events_extended (
      aggregate_name   TEXT NOT NULL,
      aggregate_id     TEXT NOT NULL,
      version          INTEGER NOT NULL,
      type             TEXT NOT NULL,
      payload          TEXT,
      metadata         TEXT,
      timestamp        TEXT NOT NULL,
      tenant_id        TEXT,
      CONSTRAINT events_extended_aggregate_version_uq
        UNIQUE (aggregate_name, aggregate_id, version)
    )
  `;

  beforeAll(() => {
    extBsDb = new Database(':memory:');
    extDb = drizzleBetterSqlite(extBsDb);
    extBsDb.exec(createExtendedSql);
  });

  afterAll(() => {
    extBsDb.close();
  });

  it('pushes and reads events without touching extra columns', async () => {
    const adapter = new DrizzleSqliteEventStorageAdapter({
      db: extDb,
      eventTable: extendedEventsTable,
    });

    const { event } = await adapter.pushEvent(eventMock1, { eventStoreId });
    expect(event).toStrictEqual(eventMock1);
    // The returned EventDetail must NOT expose the user's extras.
    expect(event as Record<string, unknown>).not.toHaveProperty('tenantId');

    const { events } = await adapter.getEvents(aggregateIdMock1, {
      eventStoreId,
    });
    expect(events).toStrictEqual([eventMock1]);

    // Server-side: the adapter doesn't know about `tenant_id`, so the row
    // should carry NULL there. Confirms the extra column is truly extra.
    const rows = extBsDb
      .prepare(`SELECT tenant_id FROM events_extended WHERE aggregate_id = ?`)
      .all(aggregateIdMock1) as { tenant_id: unknown }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBeNull();
  });
});

describe('drizzle sqlite storage adapter - libsql driver coverage', () => {
  const eventStoreId = 'eventStoreId';
  const aggregateIdMock1 = randomUUID();
  const eventMock1 = {
    aggregateId: aggregateIdMock1,
    version: 1,
    type: 'EVENT_TYPE',
    timestamp: '2021-01-01T00:00:00.000Z',
  };

  let libsqlClient: ReturnType<typeof createClient>;
  let libsqlDb: ReturnType<typeof drizzleLibsql>;
  let libsqlAdapter: DrizzleSqliteEventStorageAdapter;

  beforeAll(async () => {
    // libsql supports `:memory:` via the local sqlite3 client, which keeps the
    // test fully in-process (no temp-file bookkeeping).
    libsqlClient = createClient({ url: ':memory:' });
    libsqlDb = drizzleLibsql(libsqlClient);
    libsqlAdapter = new DrizzleSqliteEventStorageAdapter({
      db: libsqlDb,
      eventTable,
    });
    await libsqlClient.execute(`DROP TABLE IF EXISTS event`);
    await libsqlClient.execute(createEventTableSql);
  });

  afterAll(() => {
    libsqlClient.close();
  });

  it('pushes, reads, and detects a duplicate-key error on libsql', async () => {
    const { event } = await libsqlAdapter.pushEvent(eventMock1, {
      eventStoreId,
    });
    expect(event).toStrictEqual(eventMock1);

    const { events } = await libsqlAdapter.getEvents(aggregateIdMock1, {
      eventStoreId,
    });
    expect(events).toStrictEqual([eventMock1]);

    // Second push at the same natural key must surface as
    // DrizzleEventAlreadyExistsError - confirms libsql's error-code shape
    // (SQLITE_CONSTRAINT at the top level / SQLITE_CONSTRAINT_UNIQUE on
    // its .cause) is handled by walkErrorCauses.
    await expect(() =>
      libsqlAdapter.pushEvent(eventMock1, { eventStoreId }),
    ).rejects.toBeInstanceOf(DrizzleEventAlreadyExistsError);
  });
});
