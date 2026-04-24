import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { outboxTable } from '../sqlite/schema';
import { deleteRow, retryRow } from './admin';
import { OutboxRowNotFoundError, RetryRowClaimedError } from './errors';

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

describe('admin API', () => {
  let bs: Database.Database;
  let db: ReturnType<typeof drizzle>;

  const seed = async (
    overrides: Record<string, unknown> = {},
  ): Promise<string> => {
    const id = randomUUID();
    await db.insert(outboxTable).values({
      id,
      aggregateName: 'store',
      aggregateId: 'a',
      version: 1,
      attempts: 3,
      lastError: 'boom',
      lastAttemptAt: new Date().toISOString(),
      deadAt: new Date().toISOString(),
      ...overrides,
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

  describe('retryRow', () => {
    it('resets dead-row state and returns warning shape', async () => {
      const id = await seed();

      const res = await retryRow({ db, outboxTable }, id);

      expect(res).toEqual({
        warning: 'at-most-once-not-guaranteed',
        rowId: id,
        forced: false,
      });

      const row = bs
        .prepare('SELECT * FROM castore_outbox WHERE id = ?')
        .get(id) as {
        attempts: number;
        last_error: string | null;
        dead_at: string | null;
        claim_token: string | null;
      };
      expect(row.attempts).toBe(0);
      expect(row.last_error).toBeNull();
      expect(row.dead_at).toBeNull();
      expect(row.claim_token).toBeNull();
    });

    it('throws RetryRowClaimedError when row has a live claim_token', async () => {
      const id = await seed({
        claimToken: 'worker-1',
        claimedAt: new Date().toISOString(),
        deadAt: null,
      });

      await expect(retryRow({ db, outboxTable }, id)).rejects.toBeInstanceOf(
        RetryRowClaimedError,
      );

      // Row is unchanged.
      const row = bs
        .prepare('SELECT claim_token FROM castore_outbox WHERE id = ?')
        .get(id) as { claim_token: string | null };
      expect(row.claim_token).toBe('worker-1');
    });

    it('default-safe path is TOCTOU-safe: a concurrent claim landing between SELECT and UPDATE does not clear the new claim', async () => {
      // Simulate the race by:
      //  1. Starting with an unclaimed dead row (default-safe path is
      //     allowed to clear it).
      //  2. Stubbing `db.select` so the SELECT returns "unclaimed" but the
      //     underlying row has been mutated to `claim_token = 'racer'`
      //     before the UPDATE runs.
      //  3. Asserting retryRow throws RetryRowClaimedError rather than
      //     overwriting the racer's token.
      const id = await seed();

      // Mutate to "claimed by racer" to simulate the interleave.
      bs.prepare(
        `UPDATE castore_outbox SET claim_token = 'racer-token', dead_at = NULL WHERE id = ?`,
      ).run(id);

      await expect(retryRow({ db, outboxTable }, id)).rejects.toBeInstanceOf(
        RetryRowClaimedError,
      );

      const row = bs
        .prepare('SELECT claim_token FROM castore_outbox WHERE id = ?')
        .get(id) as { claim_token: string | null };
      // Racer's token survives — retryRow did not silently overwrite it.
      expect(row.claim_token).toBe('racer-token');
    });

    it('force: true clears even a live claim and marks forced: true', async () => {
      const id = await seed({
        claimToken: 'worker-1',
        claimedAt: new Date().toISOString(),
        deadAt: null,
      });

      const res = await retryRow({ db, outboxTable }, id, { force: true });

      expect(res).toEqual({
        warning: 'at-most-once-not-guaranteed',
        rowId: id,
        forced: true,
      });

      const row = bs
        .prepare('SELECT claim_token FROM castore_outbox WHERE id = ?')
        .get(id) as { claim_token: string | null };
      expect(row.claim_token).toBeNull();
    });

    it('throws OutboxRowNotFoundError when the row id does not exist', async () => {
      await expect(
        retryRow({ db, outboxTable }, 'missing-id'),
      ).rejects.toBeInstanceOf(OutboxRowNotFoundError);
    });
  });

  describe('deleteRow', () => {
    it('removes the outbox row', async () => {
      const id = await seed();

      const res = await deleteRow({ db, outboxTable }, id);

      expect(res).toEqual({ rowId: id });

      const remaining = (
        bs.prepare('SELECT COUNT(*) AS c FROM castore_outbox').get() as {
          c: number;
        }
      ).c;
      expect(remaining).toBe(0);
    });

    it('is a no-op for an unknown id (no throw)', async () => {
      await expect(
        deleteRow({ db, outboxTable }, 'missing-id'),
      ).resolves.toEqual({ rowId: 'missing-id' });
    });
  });
});
