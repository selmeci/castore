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
import { Pool } from 'pg';
import postgres from 'postgres';

import { makeAdapterConformanceSuite } from '../__tests__/conformance';
import { DrizzleEventAlreadyExistsError } from '../common/error';
import { DrizzlePgEventStorageAdapter } from './adapter';
import { eventColumns, eventTable, eventTableConstraints } from './schema';

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

// The testcontainer + postgres-js client live at the file level so the
// conformance suite AND the dialect-local describe blocks (extended table,
// node-postgres driver) share one running container. The factory's
// setup/teardown handlers below simply build adapters and a reset fn against
// the shared `db`; spinning the container up/down is owned by the file.
let pgInstance: StartedPostgreSqlContainer;
let connectionString: string;
let pgjsClient: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;

beforeAll(async () => {
  pgInstance = await new PostgreSqlContainer('postgres:15.3-alpine').start();
  connectionString = pgInstance.getConnectionUri();
  pgjsClient = postgres(connectionString);
  db = drizzlePostgresJs(pgjsClient);
}, 100_000);

afterAll(async () => {
  await pgjsClient.end();
  await pgInstance.stop();
});

makeAdapterConformanceSuite({
  dialectName: 'pg',
  adapterClass: DrizzlePgEventStorageAdapter,
  setup: async () => ({
    adapterA: new DrizzlePgEventStorageAdapter({ db, eventTable }),
    adapterB: new DrizzlePgEventStorageAdapter({ db, eventTable }),
    reset: async () => {
      await db.execute(dropTableSql);
      await db.execute(createTableSql);
    },
  }),
  teardown: async () => {
    /* container lifecycle is owned by the file, not the factory */
  },
});

// Dialect-specific scenarios live below — they are NOT part of the shared
// conformance suite because their setup / assertions touch postgres-specific
// column types or a second driver.

describe('drizzle pg storage adapter — extended table', () => {
  const eventStoreId = 'eventStoreId';
  const aggregateIdMock1 = randomUUID();
  const eventMock1 = {
    aggregateId: aggregateIdMock1,
    version: 1,
    type: 'EVENT_TYPE',
    timestamp: '2021-01-01T00:00:00.000Z',
  };

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

describe('drizzle pg storage adapter — node-postgres driver coverage', () => {
  const eventStoreId = 'eventStoreId';
  const aggregateIdMock1 = randomUUID();
  const eventMock1 = {
    aggregateId: aggregateIdMock1,
    version: 1,
    type: 'EVENT_TYPE',
    timestamp: '2021-01-01T00:00:00.000Z',
  };

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
    // This block runs after the conformance suite finished and its `reset`
    // dropped+recreated the `event` table, so start clean here too.
    await db.execute(dropTableSql);
    await db.execute(createTableSql);
  });

  afterAll(async () => {
    await pool.end();
    await db.execute(dropTableSql);
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
