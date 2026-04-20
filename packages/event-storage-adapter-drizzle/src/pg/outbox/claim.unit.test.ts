import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { outboxTable } from '../schema';
import { claimPg } from './claim';

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

let pgInstance: StartedPostgreSqlContainer;
let pgjsClient: ReturnType<typeof postgres>;
let db: PostgresJsDatabase;

beforeAll(async () => {
  pgInstance = await new PostgreSqlContainer('postgres:15.3-alpine').start();
  pgjsClient = postgres(pgInstance.getConnectionUri());
  db = drizzle(pgjsClient);
}, 100_000);

afterAll(async () => {
  await pgjsClient.end();
  await pgInstance.stop();
});

beforeEach(async () => {
  await db.execute(dropOutboxSql);
  await db.execute(createOutboxSql);
});

interface SeedRow {
  aggregateName: string;
  aggregateId: string;
  version: number;
  claimToken?: string | null;
  claimedAtOffsetMs?: number; // ms delta from NOW(); negative = past
  processedAt?: boolean;
  deadAt?: boolean;
}

const seed = async (row: SeedRow): Promise<string> => {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO castore_outbox (
      id, aggregate_name, aggregate_id, version,
      claim_token, claimed_at, processed_at, dead_at
    ) VALUES (
      ${id},
      ${row.aggregateName},
      ${row.aggregateId},
      ${row.version},
      ${row.claimToken ?? null},
      ${row.claimedAtOffsetMs === undefined ? null : sql`NOW() + make_interval(secs => ${row.claimedAtOffsetMs / 1000})`},
      ${row.processedAt === true ? sql`NOW()` : null},
      ${row.deadAt === true ? sql`NOW()` : null}
    )
  `);

  return id;
};

describe('claimPg', () => {
  it('returns [] when aggregateNames is empty', async () => {
    await seed({ aggregateName: 'store', aggregateId: 'a', version: 1 });
    const rows = await claimPg({
      db,
      outboxTable,
      batchSize: 10,
      claimTimeoutMs: 60_000,
      workerClaimToken: 't',
      aggregateNames: [],
    });
    expect(rows).toHaveLength(0);
  });

  it('claims eligible rows and fences with the worker token', async () => {
    const id = await seed({
      aggregateName: 'store',
      aggregateId: 'a',
      version: 1,
    });
    const rows = await claimPg({
      db,
      outboxTable,
      batchSize: 10,
      claimTimeoutMs: 60_000,
      workerClaimToken: 'worker-1',
      aggregateNames: ['store'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(id);
    expect(rows[0]?.claim_token).toBe('worker-1');
    expect(rows[0]?.claimed_at).not.toBeNull();
  });

  it('enforces per-aggregate FIFO: v2 not eligible while v1 pending', async () => {
    await seed({ aggregateName: 'store', aggregateId: 'a', version: 1 });
    const v2Id = await seed({
      aggregateName: 'store',
      aggregateId: 'a',
      version: 2,
    });
    const rows = await claimPg({
      db,
      outboxTable,
      batchSize: 10,
      claimTimeoutMs: 60_000,
      workerClaimToken: 't',
      aggregateNames: ['store'],
    });
    const ids = rows.map(r => r.id);
    expect(ids).not.toContain(v2Id);
    expect(ids).toHaveLength(1);
  });

  it('dead earlier row blocks its aggregate', async () => {
    await seed({
      aggregateName: 'store',
      aggregateId: 'a',
      version: 1,
      deadAt: true,
    });
    await seed({ aggregateName: 'store', aggregateId: 'a', version: 2 });
    const rows = await claimPg({
      db,
      outboxTable,
      batchSize: 10,
      claimTimeoutMs: 60_000,
      workerClaimToken: 't',
      aggregateNames: ['store'],
    });
    expect(rows).toHaveLength(0);
  });

  it('re-claims TTL-stale rows; leaves fresh claims alone', async () => {
    await seed({
      aggregateName: 'store',
      aggregateId: 'fresh',
      version: 1,
      claimToken: 'worker-0',
      claimedAtOffsetMs: -1_000, // 1s ago
    });
    const staleId = await seed({
      aggregateName: 'store',
      aggregateId: 'stale',
      version: 1,
      claimToken: 'worker-0',
      claimedAtOffsetMs: -10 * 60_000, // 10 min ago
    });
    const rows = await claimPg({
      db,
      outboxTable,
      batchSize: 10,
      claimTimeoutMs: 60_000,
      workerClaimToken: 'worker-1',
      aggregateNames: ['store'],
    });
    const ids = rows.map(r => r.id);
    expect(ids).toEqual([staleId]);
    expect(rows[0]?.claim_token).toBe('worker-1');
  });

  it('filters by aggregateNames so a relay only claims rows it owns', async () => {
    await seed({ aggregateName: 'in-registry', aggregateId: 'x', version: 1 });
    await seed({ aggregateName: 'other-store', aggregateId: 'y', version: 1 });
    const rows = await claimPg({
      db,
      outboxTable,
      batchSize: 10,
      claimTimeoutMs: 60_000,
      workerClaimToken: 't',
      aggregateNames: ['in-registry'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.aggregate_name).toBe('in-registry');
  });

  it('two concurrent claims against the same aggregate are serialized', async () => {
    // Seed three same-aggregate rows. pg_try_advisory_xact_lock ensures that
    // one worker wins the lock while the other's candidate rows get filtered
    // out (lock NOT acquired → predicate fails). The winner claims v1 only
    // (FIFO block); the loser gets nothing.
    await seed({ aggregateName: 'store', aggregateId: 'a', version: 1 });
    await seed({ aggregateName: 'store', aggregateId: 'a', version: 2 });
    await seed({ aggregateName: 'store', aggregateId: 'a', version: 3 });

    const [first, second] = await Promise.all([
      claimPg({
        db,
        outboxTable,
        batchSize: 10,
        claimTimeoutMs: 60_000,
        workerClaimToken: 'worker-a',
        aggregateNames: ['store'],
      }),
      claimPg({
        db,
        outboxTable,
        batchSize: 10,
        claimTimeoutMs: 60_000,
        workerClaimToken: 'worker-b',
        aggregateNames: ['store'],
      }),
    ]);

    const firstCount = first.length;
    const secondCount = second.length;
    expect(firstCount + secondCount).toBe(1);
    // Winner claimed exactly v1; loser claimed nothing.
    const winnerRows = firstCount === 1 ? first : second;
    expect(winnerRows[0]?.version).toBe(1);
  });

  it('skips processed and dead rows', async () => {
    await seed({
      aggregateName: 'store',
      aggregateId: 'p',
      version: 1,
      processedAt: true,
    });
    await seed({
      aggregateName: 'store',
      aggregateId: 'd',
      version: 1,
      deadAt: true,
    });
    const rows = await claimPg({
      db,
      outboxTable,
      batchSize: 10,
      claimTimeoutMs: 60_000,
      workerClaimToken: 't',
      aggregateNames: ['store'],
    });
    expect(rows).toHaveLength(0);
  });
});
