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

      const res = await retryRow({ dialect: 'sqlite', db, outboxTable }, id);

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

      await expect(
        retryRow({ dialect: 'sqlite', db, outboxTable }, id),
      ).rejects.toBeInstanceOf(RetryRowClaimedError);

      // Row is unchanged.
      const row = bs
        .prepare('SELECT claim_token FROM castore_outbox WHERE id = ?')
        .get(id) as { claim_token: string | null };
      expect(row.claim_token).toBe('worker-1');
    });

    it('default-safe path refuses when a concurrent claim has already landed', async () => {
      // This test exercises the DB-level predicate, not a JS-level race
      // window. The implementation issues a single conditional UPDATE
      // (`WHERE id = ? AND claim_token IS NULL`), so the race is eliminated
      // in SQL — there is no JS-level SELECT-then-UPDATE window to
      // interleave. We simulate the end state a concurrent claim produces
      // (claim_token populated before retryRow runs) and assert the
      // conditional UPDATE's `WHERE ... AND claim_token IS NULL` predicate
      // refuses the write. The existing "live claim_token" test one above
      // covers the same error surface; this one additionally verifies that
      // none of the reset fields (attempts, last_error, dead_at) changed —
      // positive evidence that the UPDATE never ran, not just that the
      // caller received an error.
      const seededDeadAt = new Date().toISOString();
      const seededLastAttemptAt = new Date().toISOString();
      const id = await seed({
        deadAt: seededDeadAt,
        lastAttemptAt: seededLastAttemptAt,
      });

      // Pre-populate `claim_token` to represent the "a concurrent worker
      // claim already landed" end state. The conditional UPDATE must refuse
      // because `claim_token IS NULL` no longer holds.
      bs.prepare(
        `UPDATE castore_outbox SET claim_token = 'racer-token' WHERE id = ?`,
      ).run(id);

      await expect(
        retryRow({ dialect: 'sqlite', db, outboxTable }, id),
      ).rejects.toBeInstanceOf(RetryRowClaimedError);

      const row = bs
        .prepare(
          'SELECT claim_token, attempts, last_error, dead_at, last_attempt_at FROM castore_outbox WHERE id = ?',
        )
        .get(id) as {
        claim_token: string | null;
        attempts: number;
        last_error: string | null;
        dead_at: string | null;
        last_attempt_at: string | null;
      };
      // Racer's token survives — retryRow did not silently overwrite it.
      expect(row.claim_token).toBe('racer-token');
      // Reset fields are unchanged from the seeded values — positive
      // evidence the conditional UPDATE never ran (vs. ran and then
      // errored). If the `WHERE claim_token IS NULL` predicate regressed,
      // these would be zeroed/nulled by `resetSet`.
      expect(row.attempts).toBe(3);
      expect(row.last_error).toBe('boom');
      expect(row.dead_at).toBe(seededDeadAt);
      expect(row.last_attempt_at).toBe(seededLastAttemptAt);
    });

    it('force: true clears even a live claim and marks forced: true', async () => {
      const id = await seed({
        claimToken: 'worker-1',
        claimedAt: new Date().toISOString(),
        deadAt: null,
      });

      const res = await retryRow({ dialect: 'sqlite', db, outboxTable }, id, {
        force: true,
      });

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
        retryRow({ dialect: 'sqlite', db, outboxTable }, 'missing-id'),
      ).rejects.toBeInstanceOf(OutboxRowNotFoundError);
    });
  });

  describe('deleteRow', () => {
    it('removes the outbox row', async () => {
      const id = await seed();

      const res = await deleteRow({ dialect: 'sqlite', db, outboxTable }, id);

      expect(res).toEqual({ rowId: id });

      const remaining = (
        bs.prepare('SELECT COUNT(*) AS c FROM castore_outbox').get() as {
          c: number;
        }
      ).c;
      expect(remaining).toBe(0);
    });

    it('default-safe throws when row is currently claimed by a worker', async () => {
      const id = await seed({
        claimToken: 'worker-1',
        claimedAt: new Date().toISOString(),
        deadAt: null,
      });
      await expect(
        deleteRow({ dialect: 'sqlite', db, outboxTable }, id),
      ).rejects.toBeInstanceOf(RetryRowClaimedError);
      const row = bs
        .prepare('SELECT claim_token FROM castore_outbox WHERE id = ?')
        .get(id) as { claim_token: string | null };
      // Row is not deleted; worker's claim survives.
      expect(row.claim_token).toBe('worker-1');
    });

    it('force: true deletes even a claimed row (operator accepts hazard)', async () => {
      const id = await seed({
        claimToken: 'worker-1',
        claimedAt: new Date().toISOString(),
        deadAt: null,
      });
      await deleteRow({ dialect: 'sqlite', db, outboxTable }, id, {
        force: true,
      });
      const count = (
        bs.prepare('SELECT COUNT(*) AS c FROM castore_outbox').get() as {
          c: number;
        }
      ).c;
      expect(count).toBe(0);
    });

    it('throws OutboxRowNotFoundError for an unknown id (default-safe)', async () => {
      await expect(
        deleteRow({ dialect: 'sqlite', db, outboxTable }, 'missing-id'),
      ).rejects.toBeInstanceOf(OutboxRowNotFoundError);
    });

    it('force: true is a no-op for an unknown id (no throw)', async () => {
      await expect(
        deleteRow({ dialect: 'sqlite', db, outboxTable }, 'missing-id', {
          force: true,
        }),
      ).resolves.toEqual({ rowId: 'missing-id' });
    });
  });

  // MySQL Drizzle rejects `.returning()` on UPDATE/DELETE (driver-level), so
  // the admin helpers must NOT chain `.returning()` on the mysql branch and
  // must instead read `affectedRows` off the ResultSetHeader. Integration
  // coverage against a real mysql DB lives in the conformance sub-plan;
  // these mocks verify the dialect branch in isolation.
  //
  // The mocks make `.where(...)` resolve DIRECTLY to a ResultSetHeader. If
  // admin.ts ever added back `.returning()` on this branch, the test would
  // fail with "builder.returning is not a function" — which is exactly the
  // driver-level error we're defending against.
  describe('mysql dialect branch', () => {
    const header = [{ affectedRows: 1 }, []];

    const makeMysqlDbMock = (): {
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
      select: ReturnType<typeof vi.fn>;
    } => ({
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(header),
        }),
      }),
      delete: vi
        .fn()
        .mockReturnValue({ where: vi.fn().mockResolvedValue(header) }),
      select: vi.fn(),
    });

    it('retryRow on mysql: returns success from ResultSetHeader.affectedRows (no `.returning()`)', async () => {
      const mysqlDb = makeMysqlDbMock();
      await expect(
        retryRow({ dialect: 'mysql', db: mysqlDb, outboxTable }, 'row-1'),
      ).resolves.toEqual({
        warning: 'at-most-once-not-guaranteed',
        rowId: 'row-1',
        forced: false,
      });
    });

    it('deleteRow on mysql: returns success from ResultSetHeader.affectedRows (no `.returning()`)', async () => {
      const mysqlDb = makeMysqlDbMock();
      await expect(
        deleteRow({ dialect: 'mysql', db: mysqlDb, outboxTable }, 'row-1'),
      ).resolves.toEqual({ rowId: 'row-1' });
    });
  });
});
