import { randomUUID } from 'crypto';

import type {
  OutboxRow,
  RelayOptions,
  RelayHooks,
  RelayRegistryEntry,
} from '../common/outbox/types';
import { publish, type RelayPublishContext } from './publish';
import { handleFailure } from './retry';

/**
 * Per-dialect claim primitive bound to the relay's db + outboxTable.
 * Matches the public signature of `claimPg` / `claimMysql` / `claimSqlite`
 * minus their per-dialect `db` and `outboxTable` — the factory binds those
 * at construction time.
 */
export type BoundClaim = (args: {
  workerClaimToken: string;
  aggregateNames: string[];
  batchSize: number;
  claimTimeoutMs: number;
}) => Promise<OutboxRow[]>;

export interface RelayState {
  ctx: RelayPublishContext;
  registry: ReadonlyMap<string, RelayRegistryEntry>;
  hooks: RelayHooks;
  options: Required<RelayOptions>;
  claim: BoundClaim;
  /** Mutated by `stop()` to halt `runContinuously`. */
  stopping: boolean;
  /**
   * Durable counterpart to `stopping`. Latched to `true` by every `stop()`
   * call (pre-start early-return AND post-loop completion) and never
   * cleared for the lifetime of the relay. `runContinuously()`'s entry
   * check throws `RelayStoppedError` when it is set, so a caller who
   * `stop()`s before ever starting — or who tries to restart after a
   * completed stop — gets a loud failure instead of a silently-dropped
   * intent or a surprise fresh loop. Construct a new relay to resume.
   */
  stopped?: boolean;
  /**
   * Aborted by `stop()` in addition to flipping `stopping = true`. The
   * `runContinuously` sleep awaits this signal alongside its `setTimeout`
   * so shutdown wakes instantly instead of waiting up to one `pollingMs`
   * tick. The `stopping` boolean remains the authoritative "should I keep
   * looping?" check for every other call site.
   */
  wakeController?: AbortController;
}

export interface RunOnceResult {
  claimed: number;
  processed: number;
  dead: number;
  failed: number;
  fencedNoOps: number;
}

/**
 * Claim-publish-mark cycle.
 *
 * Every invocation generates a fresh `workerClaimToken` so two concurrent
 * `runOnce` calls on the same relay instance claim disjoint rowsets.
 *
 * The per-row loop is intentionally sequential: within a claim batch,
 * per-aggregate order is already preserved by the claim eligibility
 * predicate, but publishing rows in parallel would require additional
 * per-aggregate serialisation — deferred to v1.1 alongside the fan-out
 * admin API.
 */
export const runOnce = async (state: RelayState): Promise<RunOnceResult> => {
  const aggregateNames = [...state.registry.keys()];
  if (aggregateNames.length === 0) {
    return emptyResult();
  }

  const workerClaimToken = randomUUID();
  const rows = await state.claim({
    workerClaimToken,
    aggregateNames,
    batchSize: state.options.batchSize,
    claimTimeoutMs: state.options.claimTimeoutMs,
  });

  const result: RunOnceResult = { ...emptyResult(), claimed: rows.length };

  for (const row of rows) {
    if (state.stopping) {
      break;
    }
    await processOne(row, state, result);
  }

  return result;
};

const processOne = async (
  row: OutboxRow,
  state: RelayState,
  result: RunOnceResult,
): Promise<void> => {
  try {
    const outcome = await publish({
      row,
      registry: state.registry,
      ctx: state.ctx,
      hooks: state.hooks,
      publishTimeoutMs: state.options.publishTimeoutMs,
    });
    if (outcome === 'ok') {
      result.processed += 1;
    } else if (outcome === 'dead') {
      result.dead += 1;
    } else {
      result.fencedNoOps += 1;
    }
  } catch (error) {
    result.failed += 1;
    // Guard handleFailure's own DB call so a second-level failure
    // (connection severed between publish-fail and the fencedUpdate that
    // would increment attempts) does not terminate the whole batch and
    // stall sibling rows for a full TTL. The row stays with its claim_token
    // populated; TTL reclaim picks it up on the next relay cycle.
    try {
      await handleFailure({
        row,
        error,
        ctx: state.ctx,
        hooks: state.hooks,
        options: state.options,
      });
    } catch (secondaryError) {
      console.error(
        `[outbox relay] handleFailure failed for row ${row.id}; row will be TTL-reclaimed:`,
        secondaryError,
      );
    }
  }
};

const emptyResult = (): RunOnceResult => ({
  claimed: 0,
  processed: 0,
  dead: 0,
  failed: 0,
  fencedNoOps: 0,
});
