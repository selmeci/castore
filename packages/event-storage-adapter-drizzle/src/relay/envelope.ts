import {
  NotificationMessageChannel,
  StateCarryingMessageChannel,
} from '@castore/core';
import type { EventDetail } from '@castore/core';

import type { OutboxRow, RelayRegistryEntry } from '../common/outbox/types';

/**
 * Sentinel returned by `buildEnvelope` when a StateCarrying reconstruction
 * yields `aggregate === undefined` — every event up to `maxVersion` has been
 * crypto-shredded. The caller routes this through the nil-row dead path.
 */
export const AGGREGATE_MISSING = 'aggregate-missing';

export type Envelope =
  | { eventStoreId: string; event: EventDetail }
  | { eventStoreId: string; event: EventDetail; aggregate: unknown };

/**
 * Build the message envelope the registered channel expects:
 *   - Notification channel   → `{ eventStoreId, event }`
 *   - StateCarrying channel  → `{ eventStoreId, event, aggregate }` (the
 *     aggregate is reconstructed at the given version via the registry
 *     entry's connectedEventStore)
 *
 * Throws for an unknown channel class — the factory-time registry validation
 * should have caught it; a defensive throw here prevents a silently-dropped
 * message if validation is ever relaxed.
 */
export const buildEnvelope = async (
  row: OutboxRow,
  eventDetail: EventDetail,
  entry: RelayRegistryEntry,
): Promise<Envelope | typeof AGGREGATE_MISSING> => {
  if (entry.channel instanceof NotificationMessageChannel) {
    return { eventStoreId: entry.eventStoreId, event: eventDetail };
  }

  if (entry.channel instanceof StateCarryingMessageChannel) {
    const { aggregate } = await entry.connectedEventStore.getAggregate(
      row.aggregate_id,
      { maxVersion: row.version },
    );
    if (aggregate === undefined) {
      return AGGREGATE_MISSING;
    }

    return { eventStoreId: entry.eventStoreId, event: eventDetail, aggregate };
  }

  throw new Error(
    `Unsupported channel type on registry entry for eventStoreId=${entry.eventStoreId}`,
  );
};
