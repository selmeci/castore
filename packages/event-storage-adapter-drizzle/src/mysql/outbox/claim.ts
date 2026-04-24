import { and, inArray, isNull, or, sql } from 'drizzle-orm';
import type { MySqlDatabase } from 'drizzle-orm/mysql-core';

import { selectOutboxColumns } from '../../common/outbox/selectColumns';
import type { OutboxRow } from '../../common/outbox/types';
import type { MysqlOutboxTableContract } from '../contract';

type AnyMySqlDatabase = MySqlDatabase<any, any, any, any>;

export interface MysqlClaimArgs {
  db: AnyMySqlDatabase;
  outboxTable: MysqlOutboxTableContract;
  batchSize: number;
  claimTimeoutMs: number;
  workerClaimToken: string;
  aggregateNames: string[];
}

/**
 * mysql claim primitive.
 *
 * MySQL lacks `UPDATE ... RETURNING`, so the claim is three steps inside a
 * single transaction:
 *   1. SELECT earliest-per-aggregate eligible row ids with `FOR UPDATE SKIP
 *      LOCKED` — the composite-key subquery rules out any risk of racing on
 *      non-earliest rows (a naive SKIP LOCKED would hide v1 held by another
 *      worker and hand v2 to us, breaking FIFO).
 *   2. UPDATE those ids to stamp the worker's fresh claim_token + `NOW(3)`.
 *   3. SELECT back the updated rows via the same ids (no RETURNING).
 *
 * See docs/solutions/integration-issues/drizzle-orm-api-gaps-multi-dialect-
 * adapter-2026-04-18.md for the "mysql has no UPDATE-returning; pre-fetch +
 * UPDATE-by-id" pattern already in use in the adapter proper.
 */
export const claimMysql = async (
  args: MysqlClaimArgs,
): Promise<OutboxRow[]> => {
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
    // MySQL's INTERVAL requires a parse-time expression, so inline the
    // microsecond count as a raw SQL fragment rather than a bound parameter.
    // Using microseconds (1ms = 1000us) preserves sub-second precision that
    // `INTERVAL N SECOND` with an integer argument would silently drop for
    // TTLs below 1 second. Safe from injection: explicit integer coercion.
    const micros = Math.max(0, Math.floor(claimTimeoutMs * 1000));
    const ttlCutoff = sql`DATE_SUB(NOW(3), INTERVAL ${sql.raw(String(micros))} MICROSECOND)`;

    // The `earliest-per-aggregate` subquery: for each aggregate, take only
    // MIN(version) among non-processed, non-dead rows. Candidates must
    // already be the earliest per-aggregate; SKIP LOCKED then lets
    // concurrent workers pick disjoint aggregates.
    const earliestSubquery = sql`(
      SELECT o2.aggregate_name, o2.aggregate_id, MIN(o2.version) AS version
      FROM ${outbox} o2
      WHERE o2.processed_at IS NULL
        AND o2.dead_at IS NULL
      GROUP BY o2.aggregate_name, o2.aggregate_id
    )`;

    const eligibility = and(
      isNull(outbox.processedAt),
      isNull(outbox.deadAt),
      or(isNull(outbox.claimToken), sql`${outbox.claimedAt} < ${ttlCutoff}`),
      inArray(outbox.aggregateName, aggregateNames),
      // Earliest-per-aggregate candidate set (excludes already-processed /
      // dead rows from the MIN computation, so SKIP LOCKED won't race on
      // a non-earliest row).
      sql`(${outbox.aggregateName}, ${outbox.aggregateId}, ${outbox.version})
          IN (SELECT aggregate_name, aggregate_id, version FROM ${earliestSubquery} AS earliest)`,
      // Redundant-looking NOT EXISTS guard that pg / sqlite also apply —
      // covers the "dead v1 blocks v2" case which the earliest-subquery's
      // `dead_at IS NULL` filter silently opens up (dead v1 drops out of
      // MIN, letting v2 become MIN; this guard re-closes the FIFO block).
      sql`NOT EXISTS (
        SELECT 1 FROM ${outbox} AS earlier
        WHERE earlier.aggregate_name = ${outbox.aggregateName}
          AND earlier.aggregate_id   = ${outbox.aggregateId}
          AND earlier.version        < ${outbox.version}
          AND (earlier.processed_at IS NULL OR earlier.dead_at IS NOT NULL)
      )`,
    );

    // FOR UPDATE SKIP LOCKED via raw SQL fragment — drizzle 0.45 has no
    // first-class helper, and this is the pattern the parent plan's Key
    // Decisions pre-approves.
    const candidateIds = (await tx.execute(
      sql`SELECT ${outbox.id} AS id FROM ${outbox}
          WHERE ${eligibility}
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED`,
    )) as unknown;

    const ids = extractIds(candidateIds);
    if (ids.length === 0) {
      return [];
    }

    await tx
      .update(outbox)
      .set({
        claimToken: workerClaimToken,
        claimedAt: sql`NOW(3)`,
      })
      .where(inArray(outbox.id, ids));

    return (await tx
      .select(selectOutboxColumns(outbox))
      .from(outbox)
      .where(inArray(outbox.id, ids))) as OutboxRow[];
  });
};

/**
 * mysql2 returns `[rows, fields]` for SELECT; each row is an object keyed by
 * the SELECT alias (`id` in our case). We only need the id projection.
 */
const extractIds = (raw: unknown): string[] => {
  const rows = Array.isArray(raw) ? raw[0] : raw;
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map(row => (row as { id?: unknown }).id)
    .filter((v): v is string => typeof v === 'string');
};
