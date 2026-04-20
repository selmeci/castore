import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { outboxTable } from '../schema';
import { claimSqlite } from './claim';

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

interface SeedRow {
  aggregateName: string;
  aggregateId: string;
  version: number;
  claimToken?: string | null;
  claimedAt?: string | null;
  processedAt?: string | null;
  deadAt?: string | null;
}

describe('claimSqlite', () => {
  let bs: Database.Database;
  let db: ReturnType<typeof drizzle>;

  const seed = async (row: SeedRow): Promise<string> => {
    const id = randomUUID();
    await db.insert(outboxTable).values({
      id,
      aggregateName: row.aggregateName,
      aggregateId: row.aggregateId,
      version: row.version,
      claimToken: row.claimToken ?? null,
      claimedAt: row.claimedAt ?? null,
      processedAt: row.processedAt ?? null,
      deadAt: row.deadAt ?? null,
    });

    return id;
  };

  beforeEach(() => {
    bs = new Database(':memory:');
    bs.prepare(createOutboxDDL).run();
    db = drizzle(bs);
  });

  afterEach(() => {
    bs.close();
  });

  it('returns [] when aggregateNames is empty', async () => {
    await seed({ aggregateName: 'store', aggregateId: 'a', version: 1 });

    const rows = await claimSqlite({
      db,
      outboxTable,
      batchSize: 10,
      claimTimeoutMs: 60_000,
      workerClaimToken: 't',
      aggregateNames: [],
    });

    expect(rows).toHaveLength(0);
  });

  it('claims eligible rows and fences them with the worker token', async () => {
    const id = await seed({
      aggregateName: 'store',
      aggregateId: 'a',
      version: 1,
    });

    const rows = await claimSqlite({
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

  it('excludes rows whose aggregate has an earlier unprocessed row (FIFO)', async () => {
    await seed({ aggregateName: 'store', aggregateId: 'a', version: 1 });
    const v2Id = await seed({
      aggregateName: 'store',
      aggregateId: 'a',
      version: 2,
    });

    const rows = await claimSqlite({
      db,
      outboxTable,
      batchSize: 10,
      claimTimeoutMs: 60_000,
      workerClaimToken: 't',
      aggregateNames: ['store'],
    });

    const ids = rows.map(r => r.id);
    expect(ids).not.toContain(v2Id);
    expect(ids).toHaveLength(1); // only v1 is eligible
  });

  it('leaves sibling aggregates independent (cross-aggregate parallelism on read)', async () => {
    await seed({ aggregateName: 'store', aggregateId: 'a', version: 1 });
    await seed({ aggregateName: 'store', aggregateId: 'b', version: 1 });

    const rows = await claimSqlite({
      db,
      outboxTable,
      batchSize: 10,
      claimTimeoutMs: 60_000,
      workerClaimToken: 't',
      aggregateNames: ['store'],
    });

    expect(rows).toHaveLength(2);
  });

  it('dead earlier row blocks the aggregate (FIFO block on dead v1)', async () => {
    await seed({
      aggregateName: 'store',
      aggregateId: 'a',
      version: 1,
      deadAt: new Date().toISOString(),
    });
    await seed({ aggregateName: 'store', aggregateId: 'a', version: 2 });

    const rows = await claimSqlite({
      db,
      outboxTable,
      batchSize: 10,
      claimTimeoutMs: 60_000,
      workerClaimToken: 't',
      aggregateNames: ['store'],
    });

    expect(rows).toHaveLength(0);
  });

  it('filters by aggregateNames so a relay only claims rows it owns', async () => {
    await seed({ aggregateName: 'in-registry', aggregateId: 'x', version: 1 });
    await seed({ aggregateName: 'other-store', aggregateId: 'y', version: 1 });

    const rows = await claimSqlite({
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

  it('skips rows claimed within TTL, reclaims after TTL expires', async () => {
    // Fresh claim — inside TTL, not eligible.
    await seed({
      aggregateName: 'store',
      aggregateId: 'fresh',
      version: 1,
      claimToken: 'worker-0',
      claimedAt: new Date().toISOString(),
    });
    // Old claim — past TTL, eligible for re-claim.
    const staleId = await seed({
      aggregateName: 'store',
      aggregateId: 'stale',
      version: 1,
      claimToken: 'worker-0',
      claimedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });

    const rows = await claimSqlite({
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

  it('skips processed rows and rows in dead state', async () => {
    await seed({
      aggregateName: 'store',
      aggregateId: 'p',
      version: 1,
      processedAt: new Date().toISOString(),
    });
    await seed({
      aggregateName: 'store',
      aggregateId: 'd',
      version: 1,
      deadAt: new Date().toISOString(),
    });

    const rows = await claimSqlite({
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
