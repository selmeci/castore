import type {
  ConnectedEventStore,
  NotificationMessageChannel,
  StateCarryingMessageChannel,
} from '@castore/core';

/**
 * DB row shape for an outbox entry. Timestamps are kept as strings because
 * sqlite stores ISO-8601 text and pg/mysql serialize to ISO on the wire when
 * the adapter reads via Drizzle's `{ mode: 'string' }` datetime option.
 */
export interface OutboxRow {
  id: string;
  aggregate_name: string;
  aggregate_id: string;
  version: number;
  created_at: string;
  claim_token: string | null;
  claimed_at: string | null;
  processed_at: string | null;
  attempts: number;
  last_error: string | null;
  last_attempt_at: string | null;
  dead_at: string | null;
}

/**
 * Channel types the relay recognises when building publish envelopes.
 * `AggregateExistsMessageChannel` is deliberately NOT included in v1 — see
 * origin §3 and `publish.ts`.
 */
export type RelayChannel =
  | NotificationMessageChannel
  | StateCarryingMessageChannel;

/**
 * One entry in the relay's registry — maps an outbox row's `aggregate_name`
 * (= logical `eventStoreId`) to the ConnectedEventStore that owns the
 * aggregates and the channel the relay should publish to.
 */
export interface RelayRegistryEntry {
  eventStoreId: string;
  connectedEventStore: ConnectedEventStore;
  channel: RelayChannel;
}

/**
 * Tunables passed at relay construction. All fields optional; defaults are
 * owned by the relay factory (see `relay/factory.ts`).
 */
export interface RelayOptions {
  /** Milliseconds of the first backoff; scales as `base * 2^(attempts-1)`. */
  baseMs?: number;
  /** Hard ceiling for backoff; backoff never exceeds this even with jitter. */
  ceilingMs?: number;
  /** After this many failures the row transitions to `dead_at`. */
  maxAttempts?: number;
  /** Time after which a stale claim is eligible for re-claim. */
  claimTimeoutMs?: number;
  /** Sleep between empty `runOnce` iterations in `runContinuously`. */
  pollingMs?: number;
  /** Max rows claimed per `runOnce` batch. */
  batchSize?: number;
}

export type OnDeadHook = (args: {
  row: OutboxRow;
  lastError: string;
}) => Promise<void> | void;

export type OnFailHook = (args: {
  row: OutboxRow;
  error: unknown;
  attempts: number;
  nextBackoffMs: number;
}) => Promise<void> | void;

export interface RelayHooks {
  onDead?: OnDeadHook;
  onFail?: OnFailHook;
}

/**
 * Structured return of `retryRow` — surfaces the double-publish hazard in a
 * machine-actionable shape rather than only in documentation.
 */
export interface RetryRowResult {
  warning: 'at-most-once-not-guaranteed';
  rowId: string;
  forced: boolean;
}

export interface DeleteRowResult {
  rowId: string;
}
