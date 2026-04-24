import type { EventDetail } from '~/event/eventDetail';
import type { EventStorageAdapter } from '~/eventStorageAdapter';

/**
 * Symbol-tagged capability markers for storage adapters that implement the
 * transactional-outbox pattern. Adapters set these as own-properties on the
 * instance; `ConnectedEventStore.publishPushedEvent` probes for them
 * per-invocation and skips the fire-and-forget publish when both are present.
 *
 * Using the global registry (`Symbol.for`) rather than a private symbol means
 * cross-realm checks and duplicate-install cases (e.g. two copies of
 * `@castore/core` in a dependency tree) still agree on identity.
 */
export const OUTBOX_ENABLED_SYMBOL = Symbol.for('castore.outbox-enabled');

/**
 * Capability symbol for the single-row event lookup the relay uses at publish
 * time. Keyed by `(aggregateName, aggregateId, version)`. Returns `undefined`
 * when the source event row no longer exists (e.g. crypto-shredded ahead of
 * the relay); the relay treats `undefined` as a permanent dead-row condition.
 *
 * Keeping this on a symbol rather than on `EventStorageAdapter` avoids
 * rippling a new method through every adapter in the repo. See origin R8/R10.
 */
export const OUTBOX_GET_EVENT_SYMBOL = Symbol.for(
  'castore.outbox.getEventByKey',
);

export type OutboxGetEventByKey = (
  aggregateName: string,
  aggregateId: string,
  version: number,
) => Promise<EventDetail | undefined>;

/**
 * Structural shape an adapter MUST satisfy to be recognised as outbox-enabled.
 * The boolean flag guards the short-circuit; the function is what the relay
 * actually calls. Both must be present — see `isOutboxEnabledAdapter` for the
 * rationale.
 */
export interface OutboxCapability {
  readonly [OUTBOX_ENABLED_SYMBOL]: true;
  readonly [OUTBOX_GET_EVENT_SYMBOL]: OutboxGetEventByKey;
}

/**
 * Type predicate for outbox-capable adapters.
 *
 * Returns `true` only when BOTH capability symbols are present and well-typed.
 * A hostile or misconfigured adapter that sets only the boolean would
 * silently short-circuit the publish while failing the relay lookup — this
 * guard prevents that class of bug by construction.
 *
 * The implementation uses typed Symbol indexing via the `OutboxCapability`
 * shape so `@castore/core`'s strict-boolean-expressions rule is satisfied
 * without `any` casts.
 */
export const isOutboxEnabledAdapter = <A extends EventStorageAdapter>(
  adapter: A | undefined,
): adapter is A & OutboxCapability => {
  if (adapter === undefined) {
    return false;
  }

  const indexed = adapter as unknown as Partial<OutboxCapability>;

  return (
    indexed[OUTBOX_ENABLED_SYMBOL] === true &&
    typeof indexed[OUTBOX_GET_EVENT_SYMBOL] === 'function'
  );
};
