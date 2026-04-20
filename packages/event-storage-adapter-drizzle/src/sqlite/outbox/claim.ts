import { and, inArray, isNull, or, sql } from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

import type { OutboxRow } from '../../common/outbox/types';
import type { SqliteOutboxTableContract } from '../contract';

type AnySQLiteDatabase = BaseSQLiteDatabase<'sync' | 'async', any, any, any>;

export interface SqliteClaimArgs {
  db: AnySQLiteDatabase;
  outboxTable: SqliteOutboxTableContract;
  batchSize: number;
  claimTimeoutMs: number;
  workerClaimToken: string;
  aggregateNames: string[];
}

/**
 * Explicit snake_case column mapping so the UPDATE's `RETURNING` shape
 * matches `OutboxRow` — callers of the relay read `row.claim_token` etc.,
 * not Drizzle's camelCase column names.
 */
const selectOutboxColumns = (outbox: SqliteOutboxTableContract) => ({
  id: outbox.id,
  aggregate_name: outbox.aggregateName,
  aggregate_id: outbox.aggregateId,
  version: outbox.version,
  created_at: outbox.createdAt,
  claim_token: outbox.claimToken,
  claimed_at: outbox.claimedAt,
  processed_at: outbox.processedAt,
  attempts: outbox.attempts,
  last_error: outbox.lastError,
  last_attempt_at: outbox.lastAttemptAt,
  dead_at: outbox.deadAt,
});

/**
 * sqlite claim primitive.
 *
 * SQLite's single-writer model serialises everything at the DB level, so the
 * per-aggregate FIFO guarantee reduces to the claim-eligibility predicate
 * alone — no advisory-lock, no SKIP LOCKED. Cross-aggregate parallelism on
 * sqlite is explicitly exempt from the parent success criteria.
 *
 * Shape:
 *   1. SELECT eligible row ids (FIFO exclusion + TTL eligibility +
 *      aggregate_name filter + batchSize cap).
 *   2. UPDATE them to stamp the worker's fresh claim_token + DB-now
 *      claimed_at, and return the row snapshots via RETURNING.
 *
 * The SELECT + UPDATE run inside a raw `BEGIN`/`COMMIT` so no other writer
 * interleaves with us. better-sqlite3 rejects promise-returning callbacks
 * passed to `db.transaction()` (see docs/solutions learning), so we use the
 * raw pattern already established in the sqlite adapter.
 */
export const claimSqlite = async (
  args: SqliteClaimArgs,
): Promise<OutboxRow[]> => {
  const { db, outboxTable: outbox, workerClaimToken } = args;

  if (args.aggregateNames.length === 0) {
    return [];
  }

  await db.run(sql`BEGIN`);
  try {
    const selected = await selectEligibleRows(args);

    if (selected.length === 0) {
      await db.run(sql`COMMIT`);

      return [];
    }

    const ids = selected.map(r => r.id);

    const updated = (await db
      .update(outbox)
      .set({
        claimToken: workerClaimToken,
        claimedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      })
      .where(inArray(outbox.id, ids))
      .returning(selectOutboxColumns(outbox))) as OutboxRow[];

    await db.run(sql`COMMIT`);

    return updated;
  } catch (err) {
    try {
      await db.run(sql`ROLLBACK`);
    } catch (rollbackErr) {
      console.error(
        '[claimSqlite] ROLLBACK failed; connection state is undefined:',
        rollbackErr,
      );
    }
    throw err;
  }
};

const selectEligibleRows = async (
  args: SqliteClaimArgs,
): Promise<{ id: string }[]> => {
  const { db, outboxTable: outbox, batchSize, claimTimeoutMs } = args;

  // SQLite's date/time modifiers accept '±N.NNN seconds'; there is no
  // 'milliseconds' modifier. Convert ms → seconds-with-ms-decimal. Math.max
  // guards against negative input (would silently shift forward in time).
  const seconds = (Math.max(0, claimTimeoutMs) / 1000).toFixed(3);
  const cutoffModifier = `'-${seconds} seconds'`;
  const ttlCutoff = sql`strftime('%Y-%m-%dT%H:%M:%fZ','now', ${sql.raw(cutoffModifier)})`;

  const eligibility = and(
    isNull(outbox.processedAt),
    isNull(outbox.deadAt),
    or(isNull(outbox.claimToken), sql`${outbox.claimedAt} < ${ttlCutoff}`),
    inArray(outbox.aggregateName, args.aggregateNames),
    sql`NOT EXISTS (
      SELECT 1 FROM ${outbox} AS earlier
      WHERE earlier.aggregate_name = ${outbox.aggregateName}
        AND earlier.aggregate_id   = ${outbox.aggregateId}
        AND earlier.version        < ${outbox.version}
        AND (earlier.processed_at IS NULL OR earlier.dead_at IS NOT NULL)
    )`,
  );

  return (await db
    .select({ id: outbox.id })
    .from(outbox)
    .where(eligibility)
    .limit(batchSize)) as { id: string }[];
};
