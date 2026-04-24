import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { vi } from 'vitest';

import type { OutboxCapability } from '@castore/core';
import { OUTBOX_ENABLED_SYMBOL, OUTBOX_GET_EVENT_SYMBOL } from '@castore/core';

import type { OutboxRow } from '../common/outbox/types';
import { outboxTable } from '../sqlite/schema';
import { handleFailure } from './retry';

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

const stubAdapter: OutboxCapability = {
  [OUTBOX_ENABLED_SYMBOL]: true,
  [OUTBOX_GET_EVENT_SYMBOL]: async () => undefined,
};

const makeRow = (overrides: Partial<OutboxRow> = {}): OutboxRow => ({
  id: randomUUID(),
  aggregate_name: 'store',
  aggregate_id: 'a',
  version: 1,
  created_at: new Date().toISOString(),
  claim_token: 'worker-1',
  claimed_at: new Date().toISOString(),
  processed_at: null,
  attempts: 0,
  last_error: null,
  last_attempt_at: null,
  dead_at: null,
  ...overrides,
});

describe('handleFailure', () => {
  let bs: Database.Database;
  let db: ReturnType<typeof drizzle>;

  const seedRow = async (row: OutboxRow): Promise<void> => {
    await db.insert(outboxTable).values({
      id: row.id,
      aggregateName: row.aggregate_name,
      aggregateId: row.aggregate_id,
      version: row.version,
      claimToken: row.claim_token,
      claimedAt: row.claimed_at,
      attempts: row.attempts,
    });
  };

  const ctx = () => ({
    dialect: 'sqlite' as const,
    db,
    outboxTable,
    adapter: stubAdapter,
  });

  const options = { baseMs: 100, ceilingMs: 30_000, maxAttempts: 3 };

  beforeEach(() => {
    bs = new Database(':memory:');
    bs.prepare(createOutboxDDL).run();
    db = drizzle(bs);
  });

  afterEach(() => {
    bs.close();
  });

  it('increments attempts, releases claim, and calls onFail before maxAttempts', async () => {
    const row = makeRow();
    await seedRow(row);
    const onFail = vi.fn();

    await handleFailure({
      row,
      error: new Error('bus unavailable'),
      ctx: ctx(),
      hooks: { onFail },
      options,
    });

    const persisted = bs
      .prepare('SELECT * FROM castore_outbox WHERE id = ?')
      .get(row.id) as {
      attempts: number;
      last_error: string;
      claim_token: string | null;
      claimed_at: string | null;
      dead_at: string | null;
    };

    expect(persisted.attempts).toBe(1);
    expect(persisted.last_error).toBe('bus unavailable');
    expect(persisted.claim_token).toBeNull();
    expect(persisted.claimed_at).toBeNull();
    expect(persisted.dead_at).toBeNull();

    expect(onFail).toHaveBeenCalledOnce();
    const call = onFail.mock.calls[0]?.[0] as unknown as {
      attempts: number;
      nextBackoffMs: number;
    };
    expect(call.attempts).toBe(1);
    // First-attempt backoff is baseMs (100) ± 25% jitter. Tight range asserts
    // the exponent is interpreted as attempts-1 (not attempts) and baseMs is
    // actually honored — a regression that returned a constant would escape
    // a bare `toBeGreaterThan(0)` assertion.
    expect(call.nextBackoffMs).toBeGreaterThanOrEqual(75);
    expect(call.nextBackoffMs).toBeLessThanOrEqual(125);
  });

  it('nextBackoffMs scales exponentially and clamps to ceilingMs', async () => {
    // Attempts=1 → baseMs=100 (±25% jitter → 75-125).
    // Attempts=5 → 100 * 2^4 = 1600 (±25% jitter → 1200-2000).
    // Attempts=50 → clamped to ceilingMs=30_000 (±25% jitter → 22_500-37_500).
    const onFail = vi.fn();
    const tierOptions = { baseMs: 100, ceilingMs: 30_000, maxAttempts: 100 };

    for (const attempts of [1, 5, 50]) {
      const row = makeRow({ attempts: attempts - 1 });
      await seedRow(row);
      await handleFailure({
        row,
        error: new Error('boom'),
        ctx: ctx(),
        hooks: { onFail },
        options: tierOptions,
      });
      // Reset DB for next iteration.
      bs.prepare('DELETE FROM castore_outbox').run();
    }

    const callMs = (i: number): number =>
      (onFail.mock.calls[i]?.[0] as unknown as { nextBackoffMs: number })
        .nextBackoffMs;
    expect(callMs(0)).toBeGreaterThanOrEqual(75);
    expect(callMs(0)).toBeLessThanOrEqual(125);
    expect(callMs(1)).toBeGreaterThanOrEqual(1200);
    expect(callMs(1)).toBeLessThanOrEqual(2000);
    expect(callMs(2)).toBeGreaterThanOrEqual(22_500);
    expect(callMs(2)).toBeLessThanOrEqual(37_500);
  });

  it('transitions to dead when attempts reach maxAttempts and calls onDead', async () => {
    const row = makeRow({ attempts: 2 }); // one more failure → dead
    await seedRow(row);
    const onDead = vi.fn();
    const onFail = vi.fn();

    await handleFailure({
      row,
      error: new Error('terminal'),
      ctx: ctx(),
      hooks: { onDead, onFail },
      options,
    });

    const persisted = bs
      .prepare('SELECT * FROM castore_outbox WHERE id = ?')
      .get(row.id) as {
      attempts: number;
      dead_at: string | null;
      claim_token: string | null;
      claimed_at: string | null;
    };

    expect(persisted.attempts).toBe(3);
    expect(persisted.dead_at).not.toBeNull();
    // Dead rows must also release the claim so `retryRow` (default-safe)
    // accepts them without requiring `force: true`.
    expect(persisted.claim_token).toBeNull();
    expect(persisted.claimed_at).toBeNull();

    expect(onDead).toHaveBeenCalledOnce();
    expect(onFail).not.toHaveBeenCalled();
  });

  it('is a no-op when claim_token rotated (fenced UPDATE affects 0 rows)', async () => {
    const row = makeRow({ claim_token: 'stale-token' });
    // Seed the row with a DIFFERENT claim_token so the fenced UPDATE misses.
    await db.insert(outboxTable).values({
      id: row.id,
      aggregateName: row.aggregate_name,
      aggregateId: row.aggregate_id,
      version: row.version,
      claimToken: 'current-token',
      claimedAt: new Date().toISOString(),
    });

    const onFail = vi.fn();
    const onDead = vi.fn();

    await handleFailure({
      row,
      error: new Error('boom'),
      ctx: ctx(),
      hooks: { onFail, onDead },
      options,
    });

    const persisted = bs
      .prepare('SELECT * FROM castore_outbox WHERE id = ?')
      .get(row.id) as { attempts: number; claim_token: string | null };
    expect(persisted.attempts).toBe(0); // untouched
    expect(persisted.claim_token).toBe('current-token');
    expect(onFail).not.toHaveBeenCalled();
    expect(onDead).not.toHaveBeenCalled();
  });

  it('scrubs payload-like JSON from the error message before persisting', async () => {
    const row = makeRow();
    await seedRow(row);

    await handleFailure({
      row,
      error: new Error('downstream failed: {"customer":{"ssn":"123-45-6789"}}'),
      ctx: ctx(),
      hooks: {},
      options,
    });

    const persisted = bs
      .prepare('SELECT last_error FROM castore_outbox WHERE id = ?')
      .get(row.id) as { last_error: string };

    expect(persisted.last_error).not.toContain('123-45-6789');
    expect(persisted.last_error).toContain('customer');
  });

  it('swallows onFail hook exceptions', async () => {
    const row = makeRow();
    await seedRow(row);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onFail = vi.fn().mockRejectedValue(new Error('hook boom'));

    await expect(
      handleFailure({
        row,
        error: new Error('publish failed'),
        ctx: ctx(),
        hooks: { onFail },
        options,
      }),
    ).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
