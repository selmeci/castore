import { and, eq, isNull } from 'drizzle-orm';

import { extractMysqlAffectedRows } from '../common/outbox/fencedUpdate';
import type { DeleteRowResult, RetryRowResult } from '../common/outbox/types';
import { OutboxRowNotFoundError, RetryRowClaimedError } from './errors';
import type { RelayPublishContext } from './publish';

export interface RetryRowOptions {
  /**
   * When `true`, clear `claim_token` / `claimed_at` even if the row is
   * currently claimed by a worker. Operator accepts the at-most-once-not-
   * guaranteed hazard; the worker's in-flight publish may double-send (R20).
   */
  force?: boolean;
}

/**
 * Admin-helper context: same `dialect` + `db` + `outboxTable` triple the
 * relay threads through publish. Dialect is load-bearing: MySQL rejects
 * `UPDATE/DELETE ... RETURNING`, so the helpers branch on it to pick between
 * `.returning()` (pg / sqlite) and the affected-rows-header path (mysql).
 */
export type AdminContext = Pick<
  RelayPublishContext,
  'dialect' | 'db' | 'outboxTable'
>;

/**
 * Execute an UPDATE/DELETE builder and return the affected-row count,
 * branching on dialect: pg/sqlite chain `.returning({ id })`; mysql reads
 * `affectedRows` off the ResultSetHeader (mirrors `fencedUpdate`).
 */
const runAffecting = async (
  ctx: AdminContext,
  builder: any,
): Promise<number> => {
  if (ctx.dialect === 'mysql') {
    return extractMysqlAffectedRows(await builder);
  }
  const rows = (await builder.returning({ id: ctx.outboxTable.id })) as {
    id: string;
  }[];

  return rows.length;
};

/**
 * Reset a dead (or otherwise stuck) outbox row so the next `runOnce` picks
 * it up again. Default-safe: refuses rows with a live `claim_token` to
 * avoid racing a worker mid-publish.
 *
 * TOCTOU-safe: the default-safe path uses a single conditional UPDATE with
 * `WHERE id = $rowId AND claim_token IS NULL`. The DB atomically rejects
 * the UPDATE when a worker claim lands between the caller's intent and the
 * row mutation, so we never overwrite a fresh claim and never emit
 * `at-most-once-not-guaranteed` for a still-live row. A 0-row result is
 * disambiguated with a re-SELECT (not found vs claimed).
 */
export const retryRow = async (
  ctx: AdminContext,
  rowId: string,
  options: RetryRowOptions = {},
): Promise<RetryRowResult> => {
  if (options.force === true) {
    return forceRetry(ctx, rowId);
  }

  const affected = await conditionalClearUnclaimed(ctx, rowId);
  if (affected >= 1) {
    return {
      warning: 'at-most-once-not-guaranteed',
      rowId,
      forced: false,
    };
  }

  // 0 rows affected → either the id is unknown, or the row is currently
  // claimed. Disambiguate with a targeted SELECT so callers get the typed
  // `RetryRowClaimedError` vs `OutboxRowNotFoundError` distinction.
  throw await resolveMissingOrClaimedError(ctx, rowId);
};

const resetSet = {
  attempts: 0,
  lastError: null,
  lastAttemptAt: null,
  deadAt: null,
  claimToken: null,
  claimedAt: null,
};

const conditionalClearUnclaimed = async (
  ctx: AdminContext,
  rowId: string,
): Promise<number> => {
  const { db, outboxTable } = ctx;
  const builder = db
    .update(outboxTable)
    .set(resetSet)
    .where(and(eq(outboxTable.id, rowId), isNull(outboxTable.claimToken)));

  return runAffecting(ctx, builder);
};

const forceRetry = async (
  ctx: AdminContext,
  rowId: string,
): Promise<RetryRowResult> => {
  const { db, outboxTable } = ctx;
  const builder = db
    .update(outboxTable)
    .set(resetSet)
    .where(eq(outboxTable.id, rowId));

  const affected = await runAffecting(ctx, builder);
  if (affected === 0) {
    throw new OutboxRowNotFoundError(rowId);
  }

  return {
    warning: 'at-most-once-not-guaranteed',
    rowId,
    forced: true,
  };
};

export interface DeleteRowOptions {
  /**
   * When `true`, delete the row even if it is currently claimed by a
   * worker. Operator accepts that any in-flight publish will land on the
   * bus with no matching DB trace — `onDead` will never fire for this
   * row, operator-side reconciliation is the only recourse. The default
   * (`force: false`) refuses claimed rows.
   */
  force?: boolean;
}

/**
 * Delete an outbox row. Useful for GDPR erasure, or for unblocking an
 * aggregate whose dead v1 no longer has downstream value. The event row
 * itself is untouched.
 *
 * Default-safe: refuses rows with a live `claim_token` to avoid leaving
 * an in-flight worker publishing to the bus with no DB row to correlate
 * against. Pass `{ force: true }` to accept the orphaned-message hazard.
 */
export const deleteRow = async (
  ctx: AdminContext,
  rowId: string,
  options: DeleteRowOptions = {},
): Promise<DeleteRowResult> => {
  const { db, outboxTable } = ctx;

  if (options.force === true) {
    // Forced path issues a plain DELETE with no `.returning()` chain, so
    // it's already dialect-agnostic. We intentionally do not re-SELECT to
    // confirm the row existed — the no-op-for-unknown-id contract is part
    // of the documented force semantics.
    await db.delete(outboxTable).where(eq(outboxTable.id, rowId));

    return { rowId };
  }

  // Default-safe: atomic conditional DELETE — only proceeds when the row
  // exists AND is not claimed. 0 rows affected disambiguates (not found
  // vs claimed) via a targeted SELECT.
  const builder = db
    .delete(outboxTable)
    .where(and(eq(outboxTable.id, rowId), isNull(outboxTable.claimToken)));

  const deletedCount = await runAffecting(ctx, builder);
  if (deletedCount >= 1) {
    return { rowId };
  }

  throw await resolveMissingOrClaimedError(ctx, rowId);
};

/**
 * Disambiguate a 0-row conditional UPDATE/DELETE with a targeted SELECT:
 * missing (`OutboxRowNotFoundError`) vs claimed (`RetryRowClaimedError`).
 * Returns (not throws) so callers end with `throw await ...` and TS's
 * `noImplicitReturns` sees the branch as terminal.
 */
const resolveMissingOrClaimedError = async (
  ctx: AdminContext,
  rowId: string,
): Promise<OutboxRowNotFoundError | RetryRowClaimedError> => {
  const { db, outboxTable } = ctx;
  const existing = (await db
    .select({ claim_token: outboxTable.claimToken })
    .from(outboxTable)
    .where(eq(outboxTable.id, rowId))
    .limit(1)) as { claim_token: string | null }[];

  return existing[0] === undefined
    ? new OutboxRowNotFoundError(rowId)
    : new RetryRowClaimedError(rowId);
};
