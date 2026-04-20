import { computeBackoffMs } from '../common/outbox/backoff';
import { dialectNow, fencedUpdate } from '../common/outbox/fencedUpdate';
import { scrubLastError } from '../common/outbox/scrubber';
import type {
  OutboxRow,
  RelayHooks,
  RelayOptions,
} from '../common/outbox/types';
import { dispatchOnDead, dispatchOnFail } from './hooks';
import type { RelayPublishContext } from './publish';

/**
 * Numeric knobs the retry path needs. These are a subset of `RelayOptions`
 * exposed with concrete (non-optional) types; the factory resolves defaults
 * before passing into the retry layer.
 */
export type RetryOptions = Required<
  Pick<RelayOptions, 'baseMs' | 'ceilingMs' | 'maxAttempts'>
>;

export interface HandleFailureArgs {
  row: OutboxRow;
  error: unknown;
  ctx: RelayPublishContext;
  hooks: RelayHooks;
  options: RetryOptions;
}

/**
 * Route one row's publish failure through the attempts++ / release-claim /
 * maybe-dead transition.
 *
 * All mutating UPDATEs go through `fencedUpdate` — when the row's
 * claim_token rotated during the slow publish (a concurrent worker
 * TTL-reclaimed us), the UPDATE affects 0 rows and we treat the whole
 * path as a no-op. The new owning worker is authoritative.
 */
export const handleFailure = async ({
  row,
  error,
  ctx,
  hooks,
  options,
}: HandleFailureArgs): Promise<void> => {
  const attempts = row.attempts + 1;
  const scrubbed = scrubLastError(error);
  const exhausted = attempts >= options.maxAttempts;

  const set: Record<string, unknown> = {
    attempts,
    lastError: scrubbed,
    lastAttemptAt: dialectNow(ctx.dialect),
  };

  if (exhausted) {
    set.deadAt = dialectNow(ctx.dialect);
  } else {
    // Release the claim so the next runOnce can re-claim after backoff.
    set.claimToken = null;
    set.claimedAt = null;
  }

  const affected = await fencedUpdate({
    dialect: ctx.dialect,
    db: ctx.db,
    outboxTable: ctx.outboxTable,
    rowId: row.id,
    currentClaimToken: row.claim_token ?? '',
    set,
  });

  if (affected === 0) {
    // Another worker rotated the claim_token; don't fire hooks — the new
    // owning worker will run its own failure path under its own token.
    return;
  }

  if (exhausted) {
    await dispatchOnDead(hooks, { row, lastError: scrubbed });

    return;
  }

  const nextBackoffMs = computeBackoffMs({
    baseMs: options.baseMs,
    ceilingMs: options.ceilingMs,
    attempts,
  });
  await dispatchOnFail(hooks, { row, error, attempts, nextBackoffMs });
};
