import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { outboxTable } from '../../sqlite/schema';
import { extractMysqlAffectedRows, fencedUpdate } from './fencedUpdate';

/**
 * Tests the fencing-token rule (parent R14):
 *   - Matching claim_token → UPDATE affects 1 row.
 *   - Rotated claim_token → UPDATE affects 0 rows; caller must treat as no-op.
 *
 * Uses sqlite for speed (no testcontainer dependency per sub-plan Success
 * Criteria). pg / mysql dialect paths are covered by the per-dialect claim
 * tests and later by the conformance sub-plan.
 */

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

describe('fencedUpdate', () => {
  let bs: Database.Database;
  let db: ReturnType<typeof drizzle>;

  const seedRow = async (
    rowId: string,
    claimToken: string | null,
  ): Promise<void> => {
    await db.insert(outboxTable).values({
      id: rowId,
      aggregateName: 'store',
      aggregateId: randomUUID(),
      version: 1,
      claimToken,
      claimedAt: claimToken === null ? null : new Date().toISOString(),
    });
  };

  beforeEach(() => {
    bs = new Database(':memory:');
    bs.prepare(createOutboxDDL).run();
    db = drizzle(bs);
  });

  afterEach(() => {
    bs.close();
  });

  it('updates the row when claim_token still matches', async () => {
    const rowId = randomUUID();
    const token = 'token-1';
    await seedRow(rowId, token);

    const affected = await fencedUpdate({
      dialect: 'sqlite',
      db,
      outboxTable,
      rowId,
      currentClaimToken: token,
      set: { processedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')` },
    });

    expect(affected).toBe(1);

    const rows = bs
      .prepare('SELECT processed_at FROM castore_outbox WHERE id = ?')
      .all(rowId) as { processed_at: string | null }[];
    expect(rows[0]?.processed_at).not.toBeNull();
  });

  it('is a no-op when another worker rotated the claim_token', async () => {
    const rowId = randomUUID();
    await seedRow(rowId, 'rotated-token');

    const affected = await fencedUpdate({
      dialect: 'sqlite',
      db,
      outboxTable,
      rowId,
      currentClaimToken: 'stale-token',
      set: { processedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')` },
    });

    expect(affected).toBe(0);

    const rows = bs
      .prepare('SELECT processed_at FROM castore_outbox WHERE id = ?')
      .all(rowId) as { processed_at: string | null }[];
    expect(rows[0]?.processed_at).toBeNull();
  });

  it('is a no-op when claim_token is null and we pass any value', async () => {
    const rowId = randomUUID();
    await seedRow(rowId, null);

    const affected = await fencedUpdate({
      dialect: 'sqlite',
      db,
      outboxTable,
      rowId,
      currentClaimToken: 'any-token',
      set: { processedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')` },
    });

    expect(affected).toBe(0);

    const rows = bs
      .prepare('SELECT processed_at FROM castore_outbox WHERE id = ?')
      .all(rowId) as { processed_at: string | null }[];
    expect(rows[0]?.processed_at).toBeNull();
  });

  it('supports setting multiple columns in one call', async () => {
    const rowId = randomUUID();
    const token = 'multi-col-token';
    await seedRow(rowId, token);

    const affected = await fencedUpdate({
      dialect: 'sqlite',
      db,
      outboxTable,
      rowId,
      currentClaimToken: token,
      set: {
        attempts: 1,
        lastError: 'boom',
        lastAttemptAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        claimToken: null,
        claimedAt: null,
      },
    });

    expect(affected).toBe(1);

    const rows = bs
      .prepare(
        'SELECT attempts, last_error, claim_token, claimed_at FROM castore_outbox WHERE id = ?',
      )
      .all(rowId) as {
      attempts: number;
      last_error: string | null;
      claim_token: string | null;
      claimed_at: string | null;
    }[];
    expect(rows[0]).toMatchObject({
      attempts: 1,
      last_error: 'boom',
      claim_token: null,
      claimed_at: null,
    });
  });
});

/**
 * Guards the mysql result-shape normaliser against silent fallback. A
 * driver/pool combo that returns something we don't recognise must surface
 * as a loud error, not a 0-affected-rows no-op that looks identical to
 * "row fenced out".
 */
describe('extractMysqlAffectedRows', () => {
  it('reads affectedRows from the [ResultSetHeader, FieldPacket[]] tuple', () => {
    expect(extractMysqlAffectedRows([{ affectedRows: 1 }, []])).toBe(1);
  });

  it('reads affectedRows from a bare header object', () => {
    expect(extractMysqlAffectedRows({ affectedRows: 3 })).toBe(3);
  });

  it('throws with function name + truncated preview on unknown shape', () => {
    expect(() => extractMysqlAffectedRows({ rowsAffected: 1 })).toThrow(
      /extractMysqlAffectedRows.*rowsAffected/,
    );
  });

  it('throws when the tuple head is not header-like', () => {
    expect(() => extractMysqlAffectedRows([{ foo: 'bar' }, []])).toThrow(
      /extractMysqlAffectedRows/,
    );
  });
});
