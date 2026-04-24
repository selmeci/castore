import { OUTBOX_GET_EVENT_SYMBOL } from '@castore/core';
import type { OutboxCapability } from '@castore/core';

import {
  dialectNow,
  fencedUpdate,
  type OutboxDialect,
} from '../common/outbox/fencedUpdate';
import { scrubLastError } from '../common/outbox/scrubber';
import type {
  OutboxRow,
  RelayHooks,
  RelayRegistryEntry,
} from '../common/outbox/types';
import { AGGREGATE_MISSING, buildEnvelope } from './envelope';
import { NonRetriableRelayError } from './errors';
import { dispatchOnDead } from './hooks';
import { withTimeout } from './withTimeout';

// Every row reaching `publish()` / dead-transition has been stamped by
// `claim()`; a null token is a contract violation, not a runtime case to
// paper over with `?? ''`. Raised as `NonRetriableRelayError` so
// `runContinuously`'s supervisor aborts the loop instead of spinning forever
// on a deterministic bug.
const requireClaimToken = (row: OutboxRow): string => {
  if (row.claim_token === null) {
    throw new NonRetriableRelayError(
      `Outbox row ${row.id} reached the publish path without a claim_token — invariant violation.`,
    );
  }

  return row.claim_token;
};

/**
 * Dialect-parametric context threaded through every relay operation. The
 * relay factory (U7) builds this once and reuses it for runOnce /
 * runContinuously. Typing the db + outboxTable opaquely keeps publish.ts
 * dialect-agnostic; the per-dialect types surface at construction.
 */
export interface RelayPublishContext {
  dialect: OutboxDialect;
  db: any;
  outboxTable: any;
  adapter: OutboxCapability;
}

/**
 * Outcome of one `publish()` call on a single claimed row.
 *
 * - `ok`: envelope published, `processed_at` stamped via fenced UPDATE.
 * - `dead`: nil-row or missing-registry dead path fired; `onDead` dispatched.
 * - `fenced-no-op`: the row's claim_token rotated between publish and
 *   mark-processed — another worker owns the row now. Caller MUST NOT call
 *   `retry.handleFailure` (would double-count attempts on a row the current
 *   worker no longer owns).
 */
export type PublishOutcome = 'ok' | 'dead' | 'fenced-no-op';

export interface PublishArgs {
  row: OutboxRow;
  registry: ReadonlyMap<string, RelayRegistryEntry>;
  ctx: RelayPublishContext;
  hooks: RelayHooks;
  publishTimeoutMs: number;
}

/**
 * Publish a single claimed outbox row. Publish-channel exceptions propagate
 * to `runOnce` → `retry.handleFailure`. Dead-path transitions (nil-row,
 * missing registry entry, shredded-aggregate) complete here via
 * `fencedUpdate` + `dispatchOnDead` and return `'dead'`.
 */
export const publish = async ({
  row,
  registry,
  ctx,
  hooks,
  publishTimeoutMs,
}: PublishArgs): Promise<PublishOutcome> => {
  return withTimeout(
    signal => publishInner({ row, registry, ctx, hooks }, signal),
    publishTimeoutMs,
    row.id,
  );
};

// `signal` is threaded from `withTimeout` so a future signal-aware core can
// cancel in-flight awaits on timeout; today it's a forward-compat stub.
const publishInner = async (
  { row, registry, ctx, hooks }: Omit<PublishArgs, 'publishTimeoutMs'>,
  signal: AbortSignal,
): Promise<PublishOutcome> => {
  void signal;
  const lookup = ctx.adapter[OUTBOX_GET_EVENT_SYMBOL];
  // A `return undefined` from the lookup is the adapter's explicit signal
  // that the source event row is gone (crypto-shredded) — permanent, route
  // to dead. A THROW is a transient read failure (connection, deadlock);
  // let it propagate so runOnce's retry path handles it with attempts++
  // rather than silently marking the row dead on the first blip.
  const eventDetail = await lookup(
    row.aggregate_name,
    row.aggregate_id,
    row.version,
  );

  if (eventDetail === undefined) {
    return transitionToDead({
      row,
      ctx,
      hooks,
      lastError: 'source event row missing',
    });
  }

  const registryEntry = registry.get(row.aggregate_name);
  if (registryEntry === undefined) {
    return transitionToDead({
      row,
      ctx,
      hooks,
      lastError: `no channel registered for aggregate_name=${row.aggregate_name}`,
    });
  }

  const envelope = await buildEnvelope(row, eventDetail, registryEntry);
  if (envelope === AGGREGATE_MISSING) {
    return transitionToDead({
      row,
      ctx,
      hooks,
      lastError: 'aggregate reconstruction returned no events',
    });
  }

  await registryEntry.channel.publishMessage(envelope);

  const affected = await fencedUpdate({
    dialect: ctx.dialect,
    db: ctx.db,
    outboxTable: ctx.outboxTable,
    rowId: row.id,
    currentClaimToken: requireClaimToken(row),
    set: {
      processedAt: dialectNow(ctx.dialect),
      // Release the claim on the successful-processed path so default-safe
      // admin helpers (`retryRow`, `deleteRow`) — which gate on
      // `claim_token IS NULL` — do not treat an already-processed row as
      // "currently claimed by a worker". Symmetric to the dead-transition
      // release below. The fencing predicate (`WHERE claim_token =
      // currentClaimToken`) still guards this UPDATE against a concurrent
      // TTL-reclaim; only what we write on success changes.
      claimToken: null,
      claimedAt: null,
    },
  });

  return affected === 0 ? 'fenced-no-op' : 'ok';
};

interface TransitionToDeadArgs {
  row: OutboxRow;
  ctx: RelayPublishContext;
  hooks: RelayHooks;
  lastError: string;
}

const transitionToDead = async ({
  row,
  ctx,
  hooks,
  lastError,
}: TransitionToDeadArgs): Promise<PublishOutcome> => {
  const affected = await fencedUpdate({
    dialect: ctx.dialect,
    db: ctx.db,
    outboxTable: ctx.outboxTable,
    rowId: row.id,
    currentClaimToken: requireClaimToken(row),
    set: {
      deadAt: dialectNow(ctx.dialect),
      lastError: scrubLastError(lastError),
      // Release the claim so `retryRow` (default-safe) accepts the dead row
      // without requiring `force: true`. The fencing predicate still guards
      // this UPDATE against concurrent reclaim.
      claimToken: null,
      claimedAt: null,
    },
  });

  if (affected === 0) {
    return 'fenced-no-op';
  }

  await dispatchOnDead(hooks, { row, lastError });

  return 'dead';
};
