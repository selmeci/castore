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
  type RetryRowOptions,
} from './admin';
import { isSupportedChannel } from './envelope';
import {
  DuplicateEventStoreIdError,
  OutboxNotEnabledError,
  RegistryEntryMismatchError,
  UnsupportedChannelTypeError,
} from './errors';
import type { RelayPublishContext } from './publish';
import { makeStop, runContinuously } from './runContinuously';
import {
  runOnce,
  type BoundClaim,
  type RelayState,
  type RunOnceResult,
} from './runOnce';

export const DEFAULT_RELAY_OPTIONS: Required<RelayOptions> = {
  baseMs: 250,
  ceilingMs: 60_000,
  maxAttempts: 10,
  // Claim TTL has to be generous enough to cover a slow bus publish; short
  // enough that a stuck worker's rows rotate to another worker in bounded
  // time. 5 minutes is the conservative starting point (parent §Deferred to
  // Implementation); tune via conformance suite.
  claimTimeoutMs: 5 * 60_000,
  pollingMs: 250,
  batchSize: 50,
};

export interface CreateOutboxRelayArgs {
  dialect: OutboxDialect;
  adapter: EventStorageAdapter;
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
  deleteRow: (rowId: string) => Promise<DeleteRowResult>;
}

/**
 * Build an outbox relay bound to a specific dialect, db, outbox table, and
 * channel registry. The returned object is the public surface of the
 * relay; internally it threads a single `RelayState` through runOnce /
 * runContinuously so runtime options stay consistent.
 *
 * Validation performed at construction:
 *   1. Adapter exposes both outbox capability symbols (R11 / parent R23).
 *   2. No duplicate `eventStoreId` in the registry.
 *   3. Every registry entry's `eventStoreId` matches
 *      `connectedEventStore.eventStoreId`.
 *
 * The registry is deep-copied into a frozen lookup Map at construction
 * (parent §Open Questions - "Registry defensive-copy at construction").
 * Mutating the caller's array post-construction has no effect.
 */
export const createOutboxRelay = (args: CreateOutboxRelayArgs): OutboxRelay => {
  if (!isOutboxEnabledAdapter(args.adapter)) {
    throw new OutboxNotEnabledError(
      'createOutboxRelay requires an adapter with the outbox capability. Construct the adapter with an `outbox` table.',
    );
  }

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
    options: { ...DEFAULT_RELAY_OPTIONS, ...(args.options ?? {}) },
    claim: args.claim,
    stopping: false,
  };

  let loopPromise: Promise<void> | undefined;

  return {
    runOnce: () => runOnce(state),
    runContinuously: () => {
      state.stopping = false;
      loopPromise = runContinuously(state);

      return loopPromise;
    },
    stop: async () => {
      if (loopPromise === undefined) {
        state.stopping = true;

        return;
      }
      await makeStop(state, loopPromise).stop();
    },
    retryRow: (rowId, options) =>
      retryRowImpl(
        { db: args.db, outboxTable: args.outboxTable },
        rowId,
        options,
      ),
    deleteRow: rowId =>
      deleteRowImpl({ db: args.db, outboxTable: args.outboxTable }, rowId),
  };
};

const buildRegistryMap = (
  entries: RelayRegistryEntry[],
): ReadonlyMap<string, RelayRegistryEntry> => {
  const map = new Map<string, RelayRegistryEntry>();
  for (const entry of entries) {
    if (map.has(entry.eventStoreId)) {
      throw new DuplicateEventStoreIdError(entry.eventStoreId);
    }
    if (entry.connectedEventStore.eventStoreId !== entry.eventStoreId) {
      throw new RegistryEntryMismatchError(
        entry.eventStoreId,
        entry.connectedEventStore.eventStoreId,
      );
    }
    if (!isSupportedChannel(entry.channel)) {
      throw new UnsupportedChannelTypeError(entry.eventStoreId);
    }
    map.set(entry.eventStoreId, { ...entry });
  }

  return map;
};
