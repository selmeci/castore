import type { GroupedEvent } from '@castore/core';

type GroupedEventWithAdapter<A> = GroupedEvent & {
  eventStorageAdapter: A;
};

type GroupedEventWithContext<A> = GroupedEventWithAdapter<A> & {
  context: NonNullable<GroupedEvent['context']>;
};

/**
 * Factory that produces a dialect-bound `parseGroupedEvents`:
 *
 * 1. Verifies every grouped event's `eventStorageAdapter` is an instance of
 *    `AdapterClass` (the class-identity check from R13 — each dialect adapter
 *    only accepts grouped events bound to an instance of its own class).
 * 2. Verifies every grouped event carries a `context`.
 * 3. Harmonises timestamps across the group: any event without an explicit
 *    timestamp inherits the group's shared timestamp; any event whose
 *    timestamp disagrees with the group's shared timestamp throws.
 *
 * Ported from `packages/event-storage-adapter-in-memory/src/adapter.ts`; the
 * dialect-agnostic body is kept here so pg / mysql / sqlite adapters all share
 * byte-identical semantics.
 */
export const makeParseGroupedEvents = <A>(
  AdapterClass: abstract new (...args: any[]) => A,
  adapterName: string,
): ((...groupedEventsInput: GroupedEvent[]) => {
  groupedEvents: GroupedEventWithContext<A>[];
  timestamp?: string;
}) => {
  const hasAdapter = (
    groupedEvent: GroupedEvent,
  ): groupedEvent is GroupedEventWithAdapter<A> =>
    groupedEvent.eventStorageAdapter instanceof AdapterClass;

  const hasContext = (
    groupedEvent: GroupedEvent,
  ): groupedEvent is GroupedEvent & {
    context: NonNullable<GroupedEvent['context']>;
  } => groupedEvent.context !== undefined;

  return (...groupedEventsInput: GroupedEvent[]) => {
    let timestampInfos:
      | { timestamp: string; groupedEventIndex: number }
      | undefined;
    const groupedEvents: GroupedEventWithContext<A>[] = [];

    groupedEventsInput.forEach((groupedEvent, groupedEventIndex) => {
      if (!hasAdapter(groupedEvent)) {
        throw new Error(
          `Event group event #${groupedEventIndex} is not connected to a ${adapterName}`,
        );
      }

      if (!hasContext(groupedEvent)) {
        throw new Error(
          `Event group event #${groupedEventIndex} misses context`,
        );
      }

      if (
        groupedEvent.event.timestamp !== undefined &&
        timestampInfos === undefined
      ) {
        timestampInfos = {
          timestamp: groupedEvent.event.timestamp,
          groupedEventIndex,
        };
      }

      groupedEvents.push(groupedEvent as GroupedEventWithContext<A>);
    });

    if (timestampInfos !== undefined) {
      const _timestampInfos = timestampInfos;
      groupedEvents.forEach((groupedEvent, groupedEventIndex) => {
        if (groupedEvent.event.timestamp === undefined) {
          groupedEvent.event.timestamp = _timestampInfos.timestamp;
        } else if (groupedEvent.event.timestamp !== _timestampInfos.timestamp) {
          throw new Error(
            `Event group events #${groupedEventIndex} and #${_timestampInfos.groupedEventIndex} have different timestamps`,
          );
        }
      });
    }

    return {
      groupedEvents,
      ...(timestampInfos !== undefined
        ? { timestamp: timestampInfos.timestamp }
        : {}),
    };
  };
};
