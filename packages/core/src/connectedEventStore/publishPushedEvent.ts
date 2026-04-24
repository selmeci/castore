import type {
  EventStoreAggregate,
  EventStoreEventDetails,
} from '~/eventStore/generics';
import {
  NotificationMessageChannel,
  StateCarryingMessageChannel,
} from '~/messaging';

import type { ConnectedEventStore } from './connectedEventStore';
import { isOutboxEnabledAdapter } from './outboxCapability';

export const publishPushedEvent = async <
  CONNECTED_EVENT_STORE extends ConnectedEventStore,
>(
  connectedEventStore: CONNECTED_EVENT_STORE,
  message: {
    event: EventStoreEventDetails<CONNECTED_EVENT_STORE>;
    nextAggregate?: EventStoreAggregate<CONNECTED_EVENT_STORE>;
  },
): Promise<void> => {
  // Outbox short-circuit: when the storage adapter exposes the outbox
  // capability, the relay — not this fire-and-forget publish — is the sole
  // source of bus messages. Use the non-throwing property getter rather than
  // `getEventStorageAdapter()` so the legacy no-adapter path still works
  // (see origin R30 + the adapter's mutable setter at connectedEventStore.ts).
  if (isOutboxEnabledAdapter(connectedEventStore.eventStorageAdapter)) {
    return;
  }

  const { event, nextAggregate } = message;

  if (
    connectedEventStore.messageChannel instanceof NotificationMessageChannel
  ) {
    await connectedEventStore.messageChannel.publishMessage({
      eventStoreId: connectedEventStore.eventStoreId,
      event,
    });
  }

  if (
    connectedEventStore.messageChannel instanceof StateCarryingMessageChannel
  ) {
    let aggregate: EventStoreAggregate<CONNECTED_EVENT_STORE> | undefined =
      nextAggregate;

    if (aggregate === undefined) {
      const { aggregateId, version } = event;
      aggregate = (
        await connectedEventStore.getAggregate(aggregateId, {
          maxVersion: version,
        })
      ).aggregate;
    }

    await connectedEventStore.messageChannel.publishMessage({
      eventStoreId: connectedEventStore.eventStoreId,
      event,
      aggregate,
    });
  }
};
