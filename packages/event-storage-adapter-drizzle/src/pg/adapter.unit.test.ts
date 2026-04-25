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

import { ConnectedEventStore } from '@castore/core';

import { makeAdapterConformanceSuite } from '../__tests__/conformance';
import {
  makeCounterBus,
  makeCounterEventStore,
  makeOutboxConformanceSuite,
} from '../__tests__/outboxConformance';
import { makeOutboxFaultInjectionSuite } from '../__tests__/outboxFaultInjection';
import { DrizzleEventAlreadyExistsError } from '../common/error';
import { claimPg } from '../relay';
import type { BoundClaim } from '../relay';
import { DrizzlePgEventStorageAdapter } from './adapter';
import {
  eventColumns,
  eventTable,
  eventTableConstraints,
  outboxTable,
} from './schema';

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

// Outbox conformance — exercises the full relay surface (claim, fencing, TTL,
// admin, registry validation, lifecycle) against the real pg driver. Shares
// the file-level testcontainer with the adapter conformance suite above.

const createPgOutboxSql = sql`
  CREATE TABLE IF NOT EXISTS castore_outbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_name  TEXT NOT NULL,
    aggregate_id    TEXT NOT NULL,
    version         INTEGER NOT NULL,
    created_at      TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
    claim_token     TEXT,
    claimed_at      TIMESTAMPTZ(3),
    processed_at    TIMESTAMPTZ(3),
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    last_attempt_at TIMESTAMPTZ(3),
    dead_at         TIMESTAMPTZ(3),
    CONSTRAINT outbox_aggregate_version_uq UNIQUE (aggregate_name, aggregate_id, version)
  );
`;
const dropPgOutboxSql = sql`DROP TABLE IF EXISTS castore_outbox;`;

const pgOutboxSetup = async () => {
  const eventStore = makeCounterEventStore('counters');
  const bus = makeCounterBus('counters');
  const outboxAdapter = new DrizzlePgEventStorageAdapter({
    db,
    eventTable,
    outbox: outboxTable,
  });
  const connectedEventStore = new ConnectedEventStore(eventStore, bus);
  connectedEventStore.eventStorageAdapter = outboxAdapter;

  return {
    adapter: outboxAdapter,
    db,
    outboxTable,
    connectedEventStore,
    channel: bus,
    claim: (args => claimPg({ db, outboxTable, ...args })) as BoundClaim,
    reset: async () => {
      await db.execute(dropTableSql);
      await db.execute(createTableSql);
      await db.execute(dropPgOutboxSql);
      await db.execute(createPgOutboxSql);
    },
    backdateClaimedAt: async (rowId: string, msAgo: number) => {
      await db.execute(
        sql`UPDATE castore_outbox SET claimed_at = NOW() - ${sql.raw(`INTERVAL '${Math.floor(msAgo)} milliseconds'`)} WHERE id = ${rowId}::uuid`,
      );
    },
    uniqueConstraintExists: async () => {
      const raw: unknown = await db.execute(
        sql`SELECT conname FROM pg_constraint WHERE conname = 'outbox_aggregate_version_uq'`,
      );
      const rows = Array.isArray(raw)
        ? raw
        : ((raw as { rows?: unknown[] }).rows ?? []);

      return rows.length > 0;
    },
    deleteEventRow: async (aggregateId: string) => {
      await db.execute(
        sql`DELETE FROM event WHERE aggregate_id = ${aggregateId}`,
      );
    },
  };
};

const pgOutboxTeardown = async (): Promise<void> => {
  /* container lifecycle is owned by the file, not the factory */
};

makeOutboxConformanceSuite({
  dialectName: 'pg',
  setup: pgOutboxSetup,
  teardown: pgOutboxTeardown,
});

makeOutboxFaultInjectionSuite({
  dialectName: 'pg',
  setup: pgOutboxSetup,
  teardown: pgOutboxTeardown,
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

describe('drizzle pg storage adapter — outbox force-replay idempotency', () => {
  // Regression test: when `force: true` replays an already-outboxed event,
  // the outbox-row insert must NOT violate the unique constraint on
  // (aggregate_name, aggregate_id, version). Before the fix, the event
  // upsert succeeded via ON CONFLICT DO UPDATE but the plain outbox insert
  // threw a duplicate-key error and rolled back the whole transaction.

  const createOutboxSql = sql`
    CREATE TABLE IF NOT EXISTS castore_outbox (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      aggregate_name  TEXT NOT NULL,
      aggregate_id    TEXT NOT NULL,
      version         INTEGER NOT NULL,
      created_at      TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
      claim_token     TEXT,
      claimed_at      TIMESTAMPTZ(3),
      processed_at    TIMESTAMPTZ(3),
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      last_attempt_at TIMESTAMPTZ(3),
      dead_at         TIMESTAMPTZ(3),
      CONSTRAINT outbox_aggregate_version_uq UNIQUE (aggregate_name, aggregate_id, version)
    );
  `;
  const dropOutboxSql = sql`DROP TABLE IF EXISTS castore_outbox;`;

  beforeEach(async () => {
    await db.execute(dropTableSql);
    await db.execute(createTableSql);
    await db.execute(dropOutboxSql);
    await db.execute(createOutboxSql);
  });

  afterAll(async () => {
    await db.execute(dropOutboxSql);
  });

  it('does not roll back the transaction when force-replaying an already-outboxed event', async () => {
    const eventStoreId = 'eventStoreId';
    const aggregateId = randomUUID();
    const initialEvent = {
      aggregateId,
      version: 1,
      type: 'EVENT_TYPE',
      timestamp: '2021-01-01T00:00:00.000Z',
      payload: { v: 1 },
    };
    const replayedEvent = {
      aggregateId,
      version: 1,
      type: 'EVENT_TYPE',
      timestamp: '2021-01-01T00:00:00.000Z',
      payload: { v: 2 },
    };

    const adapter = new DrizzlePgEventStorageAdapter({
      db,
      eventTable,
      outbox: outboxTable,
    });

    // First push: event row + outbox row are created atomically.
    await adapter.pushEvent(initialEvent, { eventStoreId });

    // Force-replay: MUST NOT throw on the outbox unique constraint.
    await expect(
      adapter.pushEvent(replayedEvent, { eventStoreId, force: true }),
    ).resolves.toBeDefined();

    // Event row reflects the replayed payload.
    const { events } = await adapter.getEvents(aggregateId, { eventStoreId });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toStrictEqual({ v: 2 });

    // Outbox still has exactly one pointer row for this (name, id, version):
    // the existing pointer is sufficient since the relay reads the event row
    // at publish time — a second pointer would cause a double-publish.
    const outboxRows = (await db.execute(
      sql`SELECT aggregate_name, aggregate_id, version FROM castore_outbox WHERE aggregate_id = ${aggregateId};`,
    )) as unknown;
    const rows = Array.isArray(outboxRows)
      ? (outboxRows as unknown[])
      : ((outboxRows as { rows?: unknown[] }).rows ?? []);
    expect(rows).toHaveLength(1);
  });
});
