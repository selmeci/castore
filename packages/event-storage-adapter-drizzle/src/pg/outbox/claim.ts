import { and, inArray, isNull, or, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import type { OutboxRow } from '../../common/outbox/types';
import type { PgOutboxTableContract } from '../contract';

type AnyPgDatabase = PgDatabase<any, any, any>;

export interface PgClaimArgs {
  db: AnyPgDatabase;
  outboxTable: PgOutboxTableContract;
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
const selectOutboxColumns = (outbox: PgOutboxTableContract) => ({
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
 * pg claim primitive with per-aggregate serialisation via
 * `pg_try_advisory_xact_lock`.
 *
 * Per the parent plan's "Claim-eligibility predicate", pg uses an advisory
 * transaction-scoped lock keyed by `hashtext(aggregate_name || ':' ||
 * aggregate_id)` to serialise concurrent workers against the same
 * aggregate. The lock is released automatically at COMMIT / ROLLBACK; no
 * session-scope leak, no explicit release.
 *
 * Shape:
 *   1. Open a short transaction.
 *   2. UPDATE eligible rows (FIFO exclusion + TTL + aggregate_name filter)
 *      whose per-aggregate advisory lock we can acquire. `RETURNING` hands
 *      back the fenced row snapshots.
 *   3. COMMIT.
 *
 * The advisory lock is cheap compared to the UPDATE; an unclaimed lock
 * collision (different aggregates hashing to the same 32-bit bucket) only
 * serializes those specific aggregates against each other — a throughput
 * cost, never a correctness cost. The collision reality is documented in
 * the relay README (parent R22 docs surface).
 *
 * pg supports `UPDATE ... RETURNING` so we get the rows in one round-trip
 * (see docs/solutions/integration-issues/drizzle-orm-api-gaps-multi-dialect-
 * adapter-2026-04-18.md).
 */
export const claimPg = async (args: PgClaimArgs): Promise<OutboxRow[]> => {
  const {
    db,
    outboxTable: outbox,
    batchSize,
    claimTimeoutMs,
    workerClaimToken,
    aggregateNames,
  } = args;

  if (aggregateNames.length === 0) {
    return [];
  }

  return db.transaction(async tx => {
    const ttlCutoff = sql`NOW() - make_interval(secs => ${claimTimeoutMs / 1000})`;

    const eligibility = and(
      isNull(outbox.processedAt),
      isNull(outbox.deadAt),
      or(isNull(outbox.claimToken), sql`${outbox.claimedAt} < ${ttlCutoff}`),
      inArray(outbox.aggregateName, aggregateNames),
      sql`NOT EXISTS (
        SELECT 1 FROM ${outbox} AS earlier
        WHERE earlier.aggregate_name = ${outbox.aggregateName}
          AND earlier.aggregate_id   = ${outbox.aggregateId}
          AND earlier.version        < ${outbox.version}
          AND (earlier.processed_at IS NULL OR earlier.dead_at IS NOT NULL)
      )`,
      sql`pg_try_advisory_xact_lock(
        hashtext(${outbox.aggregateName} || ':' || ${outbox.aggregateId})
      )`,
    );

    // Eligible-row ids first so the UPDATE's predicate is the narrow
    // primary-key IN (...) check. The advisory-lock predicate runs inside
    // the SELECT so only aggregates we successfully locked are candidates.
    const eligibleIds = (await tx
      .select({ id: outbox.id })
      .from(outbox)
      .where(eligibility)
      .limit(batchSize)) as { id: string }[];

    if (eligibleIds.length === 0) {
      return [];
    }

    const rows = (await tx
      .update(outbox)
      .set({
        claimToken: workerClaimToken,
        claimedAt: sql`NOW()`,
      })
      .where(
        inArray(
          outbox.id,
          eligibleIds.map(r => r.id),
        ),
      )
      .returning(selectOutboxColumns(outbox))) as OutboxRow[];

    return rows;
  });
};
