import { eq } from 'drizzle-orm';

import type { DeleteRowResult, RetryRowResult } from '../common/outbox/types';
import { RetryRowClaimedError } from './errors';
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
 */
export const retryRow = async (
  ctx: Pick<RelayPublishContext, 'db' | 'outboxTable'>,
  rowId: string,
  options: RetryRowOptions = {},
): Promise<RetryRowResult> => {
  const { db, outboxTable } = ctx;
  const rows = (await db
    .select({ claim_token: outboxTable.claimToken })
    .from(outboxTable)
    .where(eq(outboxTable.id, rowId))
    .limit(1)) as { claim_token: string | null }[];

  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Outbox row ${rowId} not found.`);
  }

  if (row.claim_token !== null && options.force !== true) {
    throw new RetryRowClaimedError(rowId);
  }

  await db
    .update(outboxTable)
    .set({
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
      deadAt: null,
      claimToken: null,
      claimedAt: null,
    })
    .where(eq(outboxTable.id, rowId));

  return {
    warning: 'at-most-once-not-guaranteed',
    rowId,
    forced: options.force === true,
  };
};

/**
 * Delete an outbox row. Useful for GDPR erasure, or for unblocking an
 * aggregate whose dead v1 no longer has downstream value. The event row
 * itself is untouched.
 */
export const deleteRow = async (
  ctx: Pick<RelayPublishContext, 'db' | 'outboxTable'>,
  rowId: string,
): Promise<DeleteRowResult> => {
  const { db, outboxTable } = ctx;
  await db.delete(outboxTable).where(eq(outboxTable.id, rowId));

  return { rowId };
};
