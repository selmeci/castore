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
import { vi } from 'vitest';

import { ConnectedEventStore } from '@castore/core';

import { makeAdapterConformanceSuite } from '../__tests__/conformance';
import {
  makeCounterBus,
  makeCounterEventStore,
  makeOutboxConformanceSuite,
} from '../__tests__/outboxConformance';
import { makeOutboxFaultInjectionSuite } from '../__tests__/outboxFaultInjection';
import { DrizzleEventAlreadyExistsError } from '../common/error';
import { claimPg, createOutboxRelay } from '../relay';
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

// OQ1 from specs/plans/2026-04-24-001-feat-g01-outbox-conformance-plan.md.
//
// Drain throughput / per-row turnaround benchmark used to ratify the relay's
// numeric defaults (`baseMs`, `ceilingMs`, `maxAttempts`, `claimTimeoutMs`,
// `publishTimeoutMs`, `pollingMs`, `batchSize`) recorded in
// `docs/solutions/best-practices/outbox-conformance-suite-patterns-2026-04-24.md`.
//
// Committed as `it.skip(...)` so Vitest never runs it on CI — a 10k-row pg
// testcontainer drain is I/O-flaky on shared runners and not worth gating
// PRs on. Run manually:
//
//   1. Replace `it.skip(` with `it(` in the body below.
//   2. From the package directory:
//      `pnpm vitest run pg/adapter.unit.test.ts -t "drain"`
//   3. Capture the `OQ1_DRAIN_BENCHMARK ...` line from console output.
//   4. Restore `it.skip(`.
//
// Do NOT swap to `describe.skipIf(!process.env.RUN_BENCHMARK)` or any other
// env gate — that invites "let's just run it once on CI" pressure that
// re-introduces the flake risk we are avoiding here. If a future need for
// repeatable benchmarks appears, that is a separate decision.
describe('drizzle pg outbox relay — numeric defaults drain benchmark (OQ1, manual)', () => {
  const TOTAL_AGGREGATES = 100;
  const EVENTS_PER_AGGREGATE = 100; // 10_000 rows total

  const percentile = (sorted: number[], p: number): number => {
    if (sorted.length === 0) {
      return 0;
    }
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));

    return sorted[idx] ?? 0;
  };

  it.skip('drain ~10k pg rows: throughput / p50 / p95 / p99', async () => {
    const ctx = await pgOutboxSetup();
    await ctx.reset();

    // Seed phase: 10_000 events distributed across 100 aggregates. Per-
    // aggregate version sequencing keeps the optimistic-concurrency check
    // happy; cross-aggregate seeding runs in parallel up to the postgres-js
    // pool cap. Seed wallclock is logged separately so the headline drain
    // metric is not skewed by INSERT cost.
    const seedStart = performance.now();
    const aggregateIds = Array.from({ length: TOTAL_AGGREGATES }, () =>
      randomUUID(),
    );
    await Promise.all(
      aggregateIds.map(async aggregateId => {
        for (let v = 1; v <= EVENTS_PER_AGGREGATE; v += 1) {
          await ctx.connectedEventStore.pushEvent(
            {
              aggregateId,
              version: v,
              type: 'COUNTER_INCREMENTED',
              timestamp: new Date(Date.now() + v).toISOString(),
              payload: { at: v },
            },
            { force: false },
          );
        }
      }),
    );
    const seedMs = performance.now() - seedStart;
    const totalRows = TOTAL_AGGREGATES * EVENTS_PER_AGGREGATE;

    // Inter-publish gap proxies per-row end-to-end SQL overhead (claim +
    // fencedUpdate + mark-processed) when the bus side is a no-op. p50/p95/
    // p99 of this distribution are what the doc table cites for
    // publishTimeoutMs headroom — the publish itself is mocked to resolve
    // immediately, so the gap reflects relay-internal cost, not bus cost.
    const interPublishMs: number[] = [];
    let lastPublishAt: number | null = null;
    vi.spyOn(ctx.channel, 'publishMessage').mockImplementation((async () => {
      const now = performance.now();
      if (lastPublishAt !== null) {
        interPublishMs.push(now - lastPublishAt);
      }
      lastPublishAt = now;
    }) as never);

    // Default relay options — that is what we are validating. Do NOT
    // override any knob from the parent §K-Defaults table here.
    const relay = createOutboxRelay({
      dialect: 'pg',
      adapter: ctx.adapter,
      db: ctx.db,
      outboxTable: ctx.outboxTable,
      claim: ctx.claim,
      registry: [
        {
          eventStoreId: ctx.connectedEventStore.eventStoreId,
          connectedEventStore: ctx.connectedEventStore,
          channel: ctx.channel,
        },
      ],
    });

    // Drain to settlement. claim returning 0 rows means there is nothing
    // left in CLAIMABLE state — every row is processed_at OR dead_at.
    const drainStart = performance.now();
    let totalProcessed = 0;
    let iterations = 0;
    for (;;) {
      const result = await relay.runOnce();
      iterations += 1;
      totalProcessed += result.processed;
      if (result.claimed === 0) {
        break;
      }
    }
    const drainMs = performance.now() - drainStart;

    expect(totalProcessed).toBe(totalRows);

    interPublishMs.sort((a, b) => a - b);
    const summary = {
      totalRows,
      seedMs: Math.round(seedMs),
      drainMs: Math.round(drainMs),
      throughputRowsPerSec: Math.round((totalRows / drainMs) * 1000),
      iterations,
      perRowTurnaroundMs: {
        p50: Number(percentile(interPublishMs, 0.5).toFixed(2)),
        p95: Number(percentile(interPublishMs, 0.95).toFixed(2)),
        p99: Number(percentile(interPublishMs, 0.99).toFixed(2)),
      },
    };

    console.log('OQ1_DRAIN_BENCHMARK', JSON.stringify(summary));
  }, 600_000);
});
