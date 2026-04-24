/**
 * Thrown when `assertOutboxEnabled(adapter, { mode: 'throw' })` observes an
 * adapter without both outbox capability symbols. D1 finance callers pass
 * `mode: 'throw'` at app bootstrap to fail fast on misconfiguration (parent
 * R23). Preserves an optional `cause` so the caller can keep structured
 * diagnostic context.
 */
export class OutboxNotEnabledError extends Error {
  readonly name = 'OutboxNotEnabledError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Thrown by `retryRow(rowId)` when the target row is currently claimed by a
 * worker (`claim_token IS NOT NULL` and TTL still valid). Clearing a live
 * claim would guarantee a double publish; the operator must either wait for
 * the claim TTL to expire or pass `{ force: true }` to accept the hazard.
 * See parent R20 + U7 defaults.
 */
export class RetryRowClaimedError extends Error {
  readonly name = 'RetryRowClaimedError';
  readonly rowId: string;

  constructor(rowId: string) {
    super(
      `Outbox row ${rowId} is currently claimed by a worker; refusing to retry. Pass { force: true } to accept at-most-once-not-guaranteed.`,
    );
    this.rowId = rowId;
  }
}

/**
 * Thrown by the relay's per-row publish path when a single publish exceeds
 * `publishTimeoutMs`. Routes through the normal retry path (attempts++);
 * a hung bus cannot pin a worker beyond this bound.
 */
export class OutboxPublishTimeoutError extends Error {
  readonly name = 'OutboxPublishTimeoutError';
  readonly rowId: string;
  readonly timeoutMs: number;

  constructor(rowId: string, timeoutMs: number) {
    super(
      `Outbox row ${rowId} publish exceeded ${timeoutMs}ms — aborting and routing to retry.`,
    );
    this.rowId = rowId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown by `createOutboxRelay` when `publishTimeoutMs >= claimTimeoutMs`.
 * A publish that outlives the claim TTL cannot guarantee fencing: another
 * worker will reclaim and re-publish while this one is still in-flight.
 * The factory fails fast instead of allowing a silent double-publish mode.
 */
export class InvalidPublishTimeoutError extends Error {
  readonly name = 'InvalidPublishTimeoutError';

  constructor(publishTimeoutMs: number, claimTimeoutMs: number) {
    super(
      `publishTimeoutMs (${publishTimeoutMs}ms) must be less than claimTimeoutMs (${claimTimeoutMs}ms) to preserve the fencing-token guarantee.`,
    );
  }
}

/**
 * Thrown by `retryRow` / `deleteRow` when the target `rowId` is not in the
 * outbox table. Typed so callers can discriminate "row missing" from other
 * admin failures via `instanceof`.
 */
export class OutboxRowNotFoundError extends Error {
  readonly name = 'OutboxRowNotFoundError';
  readonly rowId: string;

  constructor(rowId: string) {
    super(`Outbox row ${rowId} not found.`);
    this.rowId = rowId;
  }
}

/**
 * Thrown by `createOutboxRelay` when the registry array contains the same
 * `eventStoreId` twice — would silently drop one of the channels at runtime.
 */
export class DuplicateEventStoreIdError extends Error {
  readonly name = 'DuplicateEventStoreIdError';
  readonly eventStoreId: string;

  constructor(eventStoreId: string) {
    super(`Duplicate eventStoreId "${eventStoreId}" in outbox relay registry.`);
    this.eventStoreId = eventStoreId;
  }
}

/**
 * Thrown by `createOutboxRelay` when a registry entry's declared
 * `eventStoreId` disagrees with its `connectedEventStore.eventStoreId` —
 * the relay would publish under the wrong id.
 */
export class RegistryEntryMismatchError extends Error {
  readonly name = 'RegistryEntryMismatchError';
  readonly declared: string;
  readonly actual: string;

  constructor(declared: string, actual: string) {
    super(
      `Registry entry declares eventStoreId "${declared}" but connectedEventStore.eventStoreId is "${actual}".`,
    );
    this.declared = declared;
    this.actual = actual;
  }
}

/**
 * Thrown by `createOutboxRelay` when a registry entry's `channel` is not a
 * `NotificationMessageChannel` or `StateCarryingMessageChannel`. Any other
 * channel class (e.g. `AggregateExistsMessageChannel`) would pass
 * construction and then dead-transition every row at publish time — this
 * guard fails fast at factory time instead.
 */
export class UnsupportedChannelTypeError extends Error {
  readonly name = 'UnsupportedChannelTypeError';
  readonly eventStoreId: string;

  constructor(eventStoreId: string) {
    super(
      `Unsupported channel type on registry entry for eventStoreId="${eventStoreId}". Expected NotificationMessageChannel or StateCarryingMessageChannel.`,
    );
    this.eventStoreId = eventStoreId;
  }
}

/**
 * Thrown by `runContinuously()` when it is invoked on a relay whose `stop()`
 * has already been called. `stop()` is permanent: it latches a durable flag
 * on the relay state so a subsequent `runContinuously()` cannot silently
 * start a fresh loop — including the pre-start case where `stop()` was
 * called before `runContinuously()` was ever invoked. Construct a fresh
 * `createOutboxRelay()` to resume publishing.
 */
export class RelayStoppedError extends Error {
  readonly name = 'RelayStoppedError';

  constructor() {
    super(
      'relay has been stopped — construct a fresh createOutboxRelay() to restart',
    );
  }
}

/**
 * Thrown by the relay when one of its own internal invariants is violated —
 * e.g. a claimed row reaching the publish path without a `claim_token`, or
 * the mysql driver returning an unrecognised result shape from an
 * `UPDATE`. These are *deterministic* bugs in the relay (or in a consumer
 * that drove it off-contract), not transient DB conditions: retrying with
 * backoff will never clear them, it will just spin the worker forever.
 *
 * Raising this class (rather than a plain `Error`) lets
 * `runContinuously`'s supervisor classifier treat the failure like the
 * built-in programming errors (`TypeError`, `RangeError`, …): re-throw out
 * of the loop so the runtime manager can restart on fixed code or page an
 * operator. Supervisors / process managers consuming the relay can also
 * `instanceof`-match this class to distinguish "relay bug" from any plain
 * `Error` surfaced by a consumer channel.
 */
export class NonRetriableRelayError extends Error {
  readonly name = 'NonRetriableRelayError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
