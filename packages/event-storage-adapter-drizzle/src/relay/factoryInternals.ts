import type { RelayOptions, RelayRegistryEntry } from '../common/outbox/types';
import { isSupportedChannel } from './envelope';
import {
  DuplicateEventStoreIdError,
  InvalidPublishTimeoutError,
  RegistryEntryMismatchError,
  UnsupportedChannelTypeError,
} from './errors';

const DEFAULT_CLAIM_TIMEOUT_MS = 5 * 60_000;

export const DEFAULT_RELAY_OPTIONS: Required<RelayOptions> = {
  baseMs: 250,
  ceilingMs: 60_000,
  maxAttempts: 10,
  // Claim TTL has to be generous enough to cover a slow bus publish; short
  // enough that a stuck worker's rows rotate to another worker in bounded
  // time. 5 minutes is the conservative starting point (parent §Deferred to
  // Implementation); tune via conformance suite.
  claimTimeoutMs: DEFAULT_CLAIM_TIMEOUT_MS,
  pollingMs: 250,
  batchSize: 50,
  // Hard cap on a single publish (lookup + channel + fenced mark-processed).
  // Default to half the claim TTL so a hung bus is observable before TTL
  // reclaim would race us. Must stay strictly below claimTimeoutMs to
  // preserve fencing (enforced by `resolveOptions`).
  publishTimeoutMs: Math.floor(DEFAULT_CLAIM_TIMEOUT_MS / 2),
};

/**
 * Merge user options over defaults AND enforce cross-field invariants.
 * `publishTimeoutMs` must stay strictly below `claimTimeoutMs` so fencing
 * holds — a publish that outlives the claim TTL can be reclaimed by
 * another worker while this one is still in flight (parent R14).
 */
export const resolveOptions = (
  userOptions: RelayOptions | undefined,
): Required<RelayOptions> => {
  const merged = { ...DEFAULT_RELAY_OPTIONS, ...(userOptions ?? {}) };
  // When the caller tunes `claimTimeoutMs` without touching
  // `publishTimeoutMs`, re-derive the default ratio from their TTL rather
  // than inheriting the static 150s default that could now be too large.
  if (
    userOptions?.publishTimeoutMs === undefined &&
    userOptions?.claimTimeoutMs !== undefined
  ) {
    merged.publishTimeoutMs = Math.floor(userOptions.claimTimeoutMs / 2);
  }
  if (merged.publishTimeoutMs >= merged.claimTimeoutMs) {
    throw new InvalidPublishTimeoutError(
      merged.publishTimeoutMs,
      merged.claimTimeoutMs,
    );
  }

  return merged;
};

/**
 * Validate a registry array at construction and freeze the lookup Map.
 * Rejects duplicate eventStoreIds, mismatched id-vs-connectedEventStore,
 * and unsupported channel classes. Defensive-copies each entry so
 * post-construction mutations on the caller's array have no effect.
 */
export const buildRegistryMap = (
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
