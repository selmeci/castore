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
