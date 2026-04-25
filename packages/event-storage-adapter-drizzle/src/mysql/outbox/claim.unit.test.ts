import { MySqlContainer, StartedMySqlContainer } from '@testcontainers/mysql';
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';

import { outboxTable } from '../schema';
import { claimMysql } from './claim';

let mysqlContainer: StartedMySqlContainer;
let connection: mysql.Connection;
let db: MySql2Database;

const createOutboxDDL = `
  CREATE TABLE castore_outbox (
    id              VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    aggregate_name  VARCHAR(255) NOT NULL,
    aggregate_id    VARCHAR(64) NOT NULL,
    version         INT NOT NULL,
    created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    claim_token     VARCHAR(36),
    claimed_at      DATETIME(3),
    processed_at    DATETIME(3),
    attempts        INT NOT NULL DEFAULT 0,
    last_error      VARCHAR(2048),
    last_attempt_at DATETIME(3),
    dead_at         DATETIME(3),
    CONSTRAINT outbox_aggregate_version_uq UNIQUE (aggregate_name, aggregate_id, version)
  )
`;

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
}, 120_000);

afterAll(async () => {
  await connection.end();
  await mysqlContainer.stop();
});

beforeEach(async () => {
  await connection.query(`DROP TABLE IF EXISTS castore_outbox`);
  await connection.query(createOutboxDDL);
});

interface SeedRow {
  aggregateName: string;
  aggregateId: string;
  version: number;
  claimToken?: string | null;
  claimedAtOffsetMs?: number;
  processedAt?: boolean;
  deadAt?: boolean;
}

const seed = async (row: SeedRow): Promise<string> => {
  const id = randomUUID();
  // Use server-side timestamp expressions so the row's claimed_at shares the
  // same clock as `NOW(3)` in the claim SQL. Passing a JS Date would route
  // through mysql2's local-timezone conversion, which drifts from the
  // server's clock when the driver and container differ on TZ.
  const claimedAtExpr =
    row.claimedAtOffsetMs === undefined
      ? 'NULL'
      : `DATE_ADD(NOW(3), INTERVAL ${Math.floor(row.claimedAtOffsetMs / 1000)} SECOND)`;
  const processedAtExpr = row.processedAt === true ? 'NOW(3)' : 'NULL';
  const deadAtExpr = row.deadAt === true ? 'NOW(3)' : 'NULL';

  await connection.query(
    `INSERT INTO castore_outbox
       (id, aggregate_name, aggregate_id, version,
        claim_token, claimed_at, processed_at, dead_at)
     VALUES (?, ?, ?, ?, ?, ${claimedAtExpr}, ${processedAtExpr}, ${deadAtExpr})`,
    [
      id,
      row.aggregateName,
      row.aggregateId,
      row.version,
      row.claimToken ?? null,
    ],
  );

  return id;
};

describe('claimMysql', () => {
  it('returns [] when aggregateNames is empty', async () => {
    await seed({ aggregateName: 'store', aggregateId: 'a', version: 1 });
    const rows = await claimMysql({
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
    const rows = await claimMysql({
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

  it('enforces per-aggregate FIFO via earliest-per-aggregate subquery', async () => {
    await seed({ aggregateName: 'store', aggregateId: 'a', version: 1 });
    const v2Id = await seed({
      aggregateName: 'store',
      aggregateId: 'a',
      version: 2,
    });
    const rows = await claimMysql({
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
    // Earliest-per-aggregate subquery only considers non-processed AND
    // non-dead rows. Dead v1 drops out of the candidate set, so the minimum
    // version for this aggregate becomes v2 — but the outer eligibility's
    // `NOT EXISTS earlier` predicate would allow v2 if present. We rely on
    // the FIFO block being implemented in the outer predicate as well; the
    // sqlite/pg implementations use `NOT EXISTS earlier`, and mysql uses the
    // composite subquery which already excludes v2 when v1 is dead.
    //
    // Verify the intended semantics: v2 not claimed.
    await seed({
      aggregateName: 'store',
      aggregateId: 'a',
      version: 1,
      deadAt: true,
    });
    await seed({ aggregateName: 'store', aggregateId: 'a', version: 2 });
    const rows = await claimMysql({
      db,
      outboxTable,
      batchSize: 10,
      claimTimeoutMs: 60_000,
      workerClaimToken: 't',
      aggregateNames: ['store'],
    });
    // The earliest subquery ignores dead v1, so v2 would be the MIN for
    // that aggregate — but the `NOT EXISTS earlier` predicate inside the
    // outer eligibility must block v2. This test verifies that guard.
    // (See claim.ts eligibility composition.)
    expect(rows).toHaveLength(0);
  });

  it('re-claims TTL-stale rows; leaves fresh claims alone', async () => {
    await seed({
      aggregateName: 'store',
      aggregateId: 'fresh',
      version: 1,
      claimToken: 'worker-0',
      claimedAtOffsetMs: -1_000,
    });
    const staleId = await seed({
      aggregateName: 'store',
      aggregateId: 'stale',
      version: 1,
      claimToken: 'worker-0',
      claimedAtOffsetMs: -10 * 60_000,
    });
    const rows = await claimMysql({
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

  it('filters by aggregateNames', async () => {
    await seed({ aggregateName: 'in-registry', aggregateId: 'x', version: 1 });
    await seed({ aggregateName: 'other-store', aggregateId: 'y', version: 1 });
    const rows = await claimMysql({
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

  it('respects the batchSize cap when more eligible rows exist', async () => {
    for (let i = 0; i < 7; i++) {
      await seed({
        aggregateName: 'store',
        aggregateId: `agg-${i}`,
        version: 1,
      });
    }

    const rows = await claimMysql({
      db,
      outboxTable,
      batchSize: 3,
      claimTimeoutMs: 60_000,
      workerClaimToken: 't',
      aggregateNames: ['store'],
    });

    expect(rows).toHaveLength(3);
    const [result] = await connection.query(
      `SELECT COUNT(*) AS c FROM castore_outbox WHERE claim_token IS NULL`,
    );
    expect(Number((result as { c: number }[])[0]?.c)).toBe(4);
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
    const rows = await claimMysql({
      db,
      outboxTable,
      batchSize: 10,
      claimTimeoutMs: 60_000,
      workerClaimToken: 't',
      aggregateNames: ['store'],
    });
    expect(rows).toHaveLength(0);
  });

  it('two concurrent claims against the same aggregate return disjoint rowsets', async () => {
    // Symmetric to the pg U4 unit test "two concurrent claims against the
    // same aggregate are serialized". Pins the mysql claim primitive's
    // FOR UPDATE SKIP LOCKED + earliest-per-aggregate subquery against the
    // real driver. Uses a pool so the two transactions run on different
    // physical connections — a single mysql.createConnection would
    // serialize the queries and the test would pass for the wrong reason.
    const pool = mysql.createPool({
      host: mysqlContainer.getHost(),
      port: mysqlContainer.getPort(),
      user: mysqlContainer.getUsername(),
      password: mysqlContainer.getUserPassword(),
      database: mysqlContainer.getDatabase(),
      connectionLimit: 4,
    });
    const poolDb = drizzle(pool);
    try {
      await seed({ aggregateName: 'store', aggregateId: 'a', version: 1 });
      await seed({ aggregateName: 'store', aggregateId: 'a', version: 2 });
      await seed({ aggregateName: 'store', aggregateId: 'a', version: 3 });

      const [first, second] = await Promise.all([
        claimMysql({
          db: poolDb,
          outboxTable,
          batchSize: 10,
          claimTimeoutMs: 60_000,
          workerClaimToken: 'worker-a',
          aggregateNames: ['store'],
        }),
        claimMysql({
          db: poolDb,
          outboxTable,
          batchSize: 10,
          claimTimeoutMs: 60_000,
          workerClaimToken: 'worker-b',
          aggregateNames: ['store'],
        }),
      ]);

      // Earliest-per-aggregate + FOR UPDATE SKIP LOCKED guarantees the
      // winner gets v1 only (FIFO block on v2/v3) and the loser gets
      // nothing — never disjoint partial overlap, never both winning.
      const total = first.length + second.length;
      expect(total).toBe(1);
      const winner = first.length === 1 ? first : second;
      expect(winner[0]?.version).toBe(1);
    } finally {
      await pool.end();
    }
  });
});

// Reference `sql` so the tooling does not drop the unused import — the
// helper is exported but not consumed directly in this test file (all
// SQL goes through mysql2 prepared statements).
void sql;
