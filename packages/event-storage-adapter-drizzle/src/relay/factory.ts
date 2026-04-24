import { isOutboxEnabledAdapter } from '@castore/core';
import type { EventStorageAdapter } from '@castore/core';

import type { OutboxDialect } from '../common/outbox/fencedUpdate';
import type {
  DeleteRowResult,
  RelayHooks,
  RelayOptions,
  RelayRegistryEntry,
  RetryRowResult,
} from '../common/outbox/types';
import {
  deleteRow as deleteRowImpl,
  retryRow as retryRowImpl,
  type DeleteRowOptions,
  type RetryRowOptions,
} from './admin';
import { OutboxNotEnabledError } from './errors';
import {
  buildRegistryMap,
  DEFAULT_RELAY_OPTIONS,
  resolveOptions,
} from './factoryInternals';
import type { RelayPublishContext } from './publish';
import { makeStop, runContinuously } from './runContinuously';
import {
  runOnce,
  type BoundClaim,
  type RelayState,
  type RunOnceResult,
} from './runOnce';

export { DEFAULT_RELAY_OPTIONS };

export interface CreateOutboxRelayArgs {
  dialect: OutboxDialect;
  adapter: EventStorageAdapter;
  // `db` and `outboxTable` are intentionally `any`: the factory is dialect-
  // agnostic and accepts a pg / mysql / sqlite Drizzle `db` handle plus the
  // matching dialect's `outboxTable` contract. A shared union would couple
  // this module to all three dialect imports and break tree-shaking for
  // consumers of a single dialect. The per-dialect types are recovered at
  // the call sites inside `claim`, `fencedUpdate`, and admin helpers.
  db: any;
  outboxTable: any;
  claim: BoundClaim;
  registry: RelayRegistryEntry[];
  hooks?: RelayHooks;
  options?: RelayOptions;
}

export interface OutboxRelay {
  runOnce: () => Promise<RunOnceResult>;
  runContinuously: () => Promise<void>;
  stop: () => Promise<void>;
  retryRow: (
    rowId: string,
    options?: RetryRowOptions,
  ) => Promise<RetryRowResult>;
  deleteRow: (
    rowId: string,
    options?: DeleteRowOptions,
  ) => Promise<DeleteRowResult>;
}

/**
 * Build an outbox relay bound to a specific dialect, db, outbox table, and
 * channel registry. The returned object is the public surface of the
 * relay; internally it threads a single `RelayState` through runOnce /
 * runContinuously so runtime options stay consistent.
 *
 * Validation performed at construction (see `factoryInternals.ts`):
 *   1. Adapter exposes both outbox capability symbols (R11 / parent R23).
 *   2. No duplicate `eventStoreId` in the registry.
 *   3. Each registry entry's `eventStoreId` matches its connectedEventStore.
 *   4. Each registry entry's `channel` is Notification or StateCarrying.
 *   5. `publishTimeoutMs < claimTimeoutMs` (fencing invariant).
 *
 * The registry is deep-copied into a frozen lookup Map at construction; post-
 * construction mutations to the caller's array have no effect.
 */
export const createOutboxRelay = (args: CreateOutboxRelayArgs): OutboxRelay => {
  if (!isOutboxEnabledAdapter(args.adapter)) {
    throw new OutboxNotEnabledError(
      'createOutboxRelay requires an adapter with the outbox capability. Construct the adapter with an `outbox` table.',
    );
  }

  const options = resolveOptions(args.options);
  const registryMap = buildRegistryMap(args.registry);

  const ctx: RelayPublishContext = {
    dialect: args.dialect,
    db: args.db,
    outboxTable: args.outboxTable,
    adapter: args.adapter,
  };

  const state: RelayState = {
    ctx,
    registry: registryMap,
    hooks: args.hooks ?? {},
    options,
    claim: args.claim,
    stopping: false,
    wakeController: new AbortController(),
  };

  let loopPromise: Promise<void> | undefined;

  return {
    runOnce: () => runOnce(state),
    runContinuously: () => {
      // Reject re-entry while a loop is in flight. Silently overwriting
      // `loopPromise` would orphan the first loop (still running, no longer
      // awaited by `stop()`) and double the publish load until the shared
      // `state.stopping` flag eventually terminates both.
      if (loopPromise !== undefined && !state.stopping) {
        throw new Error(
          'runContinuously() is already running. Call stop() first, or use runOnce() for ad-hoc invocations.',
        );
      }
      state.stopping = false;
      // Replace any aborted wake controller from a previous stop() cycle
      // so this loop's sleeps can wake on a fresh abort signal.
      state.wakeController = new AbortController();
      loopPromise = runContinuously(state);

      return loopPromise;
    },
    stop: async () => {
      if (loopPromise === undefined) {
        // stop() called before runContinuously(): latch the flag so a
        // later runContinuously() is also a no-op via the re-entry check
        // above. Callers who want to re-run must construct a fresh relay.
        state.stopping = true;

        return;
      }
      await makeStop(state, loopPromise).stop();
      loopPromise = undefined;
    },
    retryRow: (rowId, retryOptions) =>
      retryRowImpl(
        { dialect: args.dialect, db: args.db, outboxTable: args.outboxTable },
        rowId,
        retryOptions,
      ),
    deleteRow: (rowId, deleteOptions) =>
      deleteRowImpl(
        { dialect: args.dialect, db: args.db, outboxTable: args.outboxTable },
        rowId,
        deleteOptions,
      ),
  };
};
