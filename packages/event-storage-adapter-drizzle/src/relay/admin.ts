import { and, eq, isNull } from 'drizzle-orm';

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
  ctx: Pick<RelayPublishContext, 'db' | 'outboxTable'>,
  rowId: string,
  options: RetryRowOptions = {},
): Promise<RetryRowResult> => {
  const { db, outboxTable } = ctx;

  if (options.force === true) {
    return forceRetry({ db, outboxTable }, rowId);
  }

  const affected = await conditionalClearUnclaimed({ db, outboxTable }, rowId);
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
  const existing = (await db
    .select({ claim_token: outboxTable.claimToken })
    .from(outboxTable)
    .where(eq(outboxTable.id, rowId))
    .limit(1)) as { claim_token: string | null }[];

  if (existing[0] === undefined) {
    throw new OutboxRowNotFoundError(rowId);
  }

  throw new RetryRowClaimedError(rowId);
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
  ctx: Pick<RelayPublishContext, 'db' | 'outboxTable'>,
  rowId: string,
): Promise<number> => {
  const { db, outboxTable } = ctx;
  const rows = (await db
    .update(outboxTable)
    .set(resetSet)
    .where(and(eq(outboxTable.id, rowId), isNull(outboxTable.claimToken)))
    .returning({ id: outboxTable.id })) as { id: string }[];

  return rows.length;
};

const forceRetry = async (
  ctx: Pick<RelayPublishContext, 'db' | 'outboxTable'>,
  rowId: string,
): Promise<RetryRowResult> => {
  const { db, outboxTable } = ctx;
  const rows = (await db
    .update(outboxTable)
    .set(resetSet)
    .where(eq(outboxTable.id, rowId))
    .returning({ id: outboxTable.id })) as { id: string }[];

  if (rows.length === 0) {
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
  ctx: Pick<RelayPublishContext, 'db' | 'outboxTable'>,
  rowId: string,
  options: DeleteRowOptions = {},
): Promise<DeleteRowResult> => {
  const { db, outboxTable } = ctx;

  if (options.force === true) {
    await db.delete(outboxTable).where(eq(outboxTable.id, rowId));

    return { rowId };
  }

  // Default-safe: atomic conditional DELETE — only proceeds when the row
  // exists AND is not claimed. 0 rows affected disambiguates (not found
  // vs claimed) via a targeted SELECT.
  const deleted = (await db
    .delete(outboxTable)
    .where(and(eq(outboxTable.id, rowId), isNull(outboxTable.claimToken)))
    .returning({ id: outboxTable.id })) as { id: string }[];

  if (deleted.length >= 1) {
    return { rowId };
  }

  const existing = (await db
    .select({ claim_token: outboxTable.claimToken })
    .from(outboxTable)
    .where(eq(outboxTable.id, rowId))
    .limit(1)) as { claim_token: string | null }[];

  if (existing[0] === undefined) {
    throw new OutboxRowNotFoundError(rowId);
  }

  throw new RetryRowClaimedError(rowId);
};
