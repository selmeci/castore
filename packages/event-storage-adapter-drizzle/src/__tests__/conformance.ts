import { randomUUID } from 'crypto';
import omit from 'lodash.omit';

import {
  eventAlreadyExistsErrorCode,
  GroupedEvent,
  type EventStorageAdapter,
} from '@castore/core';

import { DrizzleEventAlreadyExistsError } from '../common/error';

export type ConformanceSetupResult<A extends EventStorageAdapter> = {
  adapterA: A;
  adapterB: A;
  /** Truncate / drop-and-recreate the event table between tests. */
  reset: () => Promise<void>;
};

export type ConformanceSetup<A extends EventStorageAdapter> = {
  dialectName: string;
  adapterClass: abstract new (...args: any[]) => A;
  setup: () => Promise<ConformanceSetupResult<A>>;
  teardown: () => Promise<void>;
};

/**
 * Dialect-agnostic conformance suite. Every scenario here must pass byte-
 * identically against pg, mysql, and sqlite adapters — that is the guarantee
 * R17 / R18 demand.
 *
 * Call at the top level of a per-dialect `*.unit.test.ts` file:
 *
 *     makeAdapterConformanceSuite({
 *       dialectName: 'pg',
 *       adapterClass: DrizzlePgEventStorageAdapter,
 *       setup: async () => ({ adapterA, adapterB, reset }),
 *       teardown: async () => { ... },
 *     });
 *
 * The per-dialect file owns the testcontainer / in-process DB lifecycle via
 * the `setup` and `teardown` callbacks; the factory only wires
 * `beforeAll` / `beforeEach` / `afterAll` and the assertions.
 */
export const makeAdapterConformanceSuite = <A extends EventStorageAdapter>(
  config: ConformanceSetup<A>,
): void => {
  const { dialectName, adapterClass, setup, teardown } = config;

  describe(`drizzle ${dialectName} storage adapter — conformance`, () => {
    const eventStoreId = 'eventStoreId';

    const aggregateIdMock1 = randomUUID();
    const aggregate1InitialEventTimestamp = '2021-01-01T00:00:00.000Z';
    const aggregateIdMock2 = randomUUID();
    const aggregate2InitialEventTimestamp = '2022-01-01T00:00:00.000Z';
    const aggregateIdMock3 = randomUUID();
    const aggregate3InitialEventTimestamp = '2023-01-01T00:00:00.000Z';
    const aggregateIdMock4 = randomUUID();
    const aggregate4InitialEventTimestamp = '2024-01-01T00:00:00.000Z';

    const eventMock1 = {
      aggregateId: aggregateIdMock1,
      version: 1,
      type: 'EVENT_TYPE',
      timestamp: aggregate1InitialEventTimestamp,
    };
    const eventMock2 = {
      aggregateId: aggregateIdMock1,
      version: 2,
      type: 'EVENT_TYPE',
      timestamp: aggregate2InitialEventTimestamp,
    };

    let adapterA: A;
    let adapterB: A;
    let reset: () => Promise<void>;

    beforeAll(async () => {
      const ctx = await setup();
      adapterA = ctx.adapterA;
      adapterB = ctx.adapterB;
      reset = ctx.reset;
    }, 100_000);

    beforeEach(async () => {
      await reset();
    });

    afterAll(async () => {
      await teardown();
    });

    describe('getEvents / pushEvent', () => {
      it('gets an empty array if there is no event for aggregateId', async () => {
        const response = await adapterA.getEvents(aggregateIdMock1, {
          eventStoreId,
        });
        expect(response).toStrictEqual({ events: [] });
      });

      it('throws an error if version already exists', async () => {
        await adapterA.pushEvent(eventMock1, { eventStoreId });

        await expect(() =>
          adapterA.pushEvent(eventMock1, { eventStoreId }),
        ).rejects.toThrow(DrizzleEventAlreadyExistsError);
      });

      it('attaches code / eventStoreId / aggregateId / version to the error', async () => {
        await adapterA.pushEvent(eventMock1, { eventStoreId });

        let thrown: unknown;
        try {
          await adapterA.pushEvent(eventMock1, { eventStoreId });
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(DrizzleEventAlreadyExistsError);
        const typed = thrown as DrizzleEventAlreadyExistsError;
        expect(typed.code).toBe(eventAlreadyExistsErrorCode);
        expect(typed.eventStoreId).toBe(eventStoreId);
        expect(typed.aggregateId).toBe(aggregateIdMock1);
        expect(typed.version).toBe(1);
        // Original driver error is preserved on `.cause` for triage.
        expect(typed.cause).toBeDefined();
      });

      it('overrides event if force option is set to true', async () => {
        const { event } = await adapterA.pushEvent(eventMock1, {
          eventStoreId,
          force: true,
        });
        expect(event).toStrictEqual(eventMock1);

        const newEvent = { ...eventMock1, type: 'EVENT_TYPE_V2' };
        const { event: overridden } = await adapterA.pushEvent(newEvent, {
          eventStoreId,
          force: true,
        });
        expect(overridden).toStrictEqual(newEvent);

        const { events } = await adapterA.getEvents(aggregateIdMock1, {
          eventStoreId,
        });
        expect(events).toStrictEqual([newEvent]);
      });

      it('pushes and gets events correctly', async () => {
        await adapterA.pushEvent(eventMock1, { eventStoreId });
        await adapterA.pushEvent(eventMock2, { eventStoreId });

        const allEvents = await adapterA.getEvents(aggregateIdMock1, {
          eventStoreId,
        });
        expect(allEvents).toStrictEqual({ events: [eventMock1, eventMock2] });

        const eventsMaxVersion = await adapterA.getEvents(
          aggregateIdMock1,
          { eventStoreId },
          { maxVersion: 1 },
        );
        expect(eventsMaxVersion).toStrictEqual({ events: [eventMock1] });

        const eventsMinVersion = await adapterA.getEvents(
          aggregateIdMock1,
          { eventStoreId },
          { minVersion: 2 },
        );
        expect(eventsMinVersion).toStrictEqual({ events: [eventMock2] });

        const eventsLimit = await adapterA.getEvents(
          aggregateIdMock1,
          { eventStoreId },
          { limit: 1 },
        );
        expect(eventsLimit).toStrictEqual({ events: [eventMock1] });

        const eventsReverse = await adapterA.getEvents(
          aggregateIdMock1,
          { eventStoreId },
          { reverse: true },
        );
        expect(eventsReverse).toStrictEqual({
          events: [eventMock2, eventMock1],
        });

        const eventsReverseAndLimit = await adapterA.getEvents(
          aggregateIdMock1,
          { eventStoreId },
          { limit: 1, reverse: true },
        );
        expect(eventsReverseAndLimit).toStrictEqual({ events: [eventMock2] });
      });
    });

    describe('listAggregateIds', () => {
      it('list aggregate Ids', async () => {
        await adapterA.pushEvent(eventMock1, { eventStoreId });
        await adapterA.pushEvent(
          {
            aggregateId: aggregateIdMock2,
            version: 1,
            type: 'EVENT_TYPE',
            timestamp: aggregate2InitialEventTimestamp,
          },
          { eventStoreId },
        );

        const aggregateIds = await adapterA.listAggregateIds({
          eventStoreId,
        });

        expect(aggregateIds).toStrictEqual({
          aggregateIds: [
            {
              aggregateId: aggregateIdMock1,
              initialEventTimestamp: aggregate1InitialEventTimestamp,
            },
            {
              aggregateId: aggregateIdMock2,
              initialEventTimestamp: aggregate2InitialEventTimestamp,
            },
          ],
        });
      });

      it('paginates aggregate Ids', async () => {
        await adapterA.pushEvent(eventMock1, { eventStoreId });
        await adapterA.pushEvent(
          {
            aggregateId: aggregateIdMock2,
            version: 1,
            type: 'EVENT_TYPE',
            timestamp: aggregate2InitialEventTimestamp,
          },
          { eventStoreId },
        );
        await adapterA.pushEvent(
          {
            aggregateId: aggregateIdMock3,
            version: 1,
            type: 'EVENT_TYPE',
            timestamp: aggregate3InitialEventTimestamp,
          },
          { eventStoreId },
        );
        await adapterA.pushEvent(
          {
            aggregateId: aggregateIdMock4,
            version: 1,
            type: 'EVENT_TYPE',
            timestamp: aggregate4InitialEventTimestamp,
          },
          { eventStoreId },
        );

        const { aggregateIds, nextPageToken } = await adapterA.listAggregateIds(
          { eventStoreId },
          { limit: 2 },
        );

        expect(aggregateIds).toStrictEqual([
          {
            aggregateId: aggregateIdMock1,
            initialEventTimestamp: aggregate1InitialEventTimestamp,
          },
          {
            aggregateId: aggregateIdMock2,
            initialEventTimestamp: aggregate2InitialEventTimestamp,
          },
        ]);

        expect(JSON.parse(nextPageToken as string)).toStrictEqual({
          limit: 2,
          lastEvaluatedKey: {
            aggregateId: aggregateIdMock2,
            initialEventTimestamp: aggregate2InitialEventTimestamp,
          },
        });

        const lastAggregateIds = await adapterA.listAggregateIds(
          { eventStoreId },
          { pageToken: nextPageToken },
        );

        expect(lastAggregateIds).toStrictEqual({
          aggregateIds: [
            {
              aggregateId: aggregateIdMock3,
              initialEventTimestamp: aggregate3InitialEventTimestamp,
            },
            {
              aggregateId: aggregateIdMock4,
              initialEventTimestamp: aggregate4InitialEventTimestamp,
            },
          ],
        });
      });

      it('applies listAggregateIds options', async () => {
        await adapterA.pushEvent(eventMock1, { eventStoreId });
        await adapterA.pushEvent(
          {
            aggregateId: aggregateIdMock2,
            version: 1,
            type: 'EVENT_TYPE',
            timestamp: aggregate2InitialEventTimestamp,
          },
          { eventStoreId },
        );
        await adapterA.pushEvent(
          {
            aggregateId: aggregateIdMock3,
            version: 1,
            type: 'EVENT_TYPE',
            timestamp: aggregate3InitialEventTimestamp,
          },
          { eventStoreId },
        );
        await adapterA.pushEvent(
          {
            aggregateId: aggregateIdMock4,
            version: 1,
            type: 'EVENT_TYPE',
            timestamp: aggregate4InitialEventTimestamp,
          },
          { eventStoreId },
        );

        const { aggregateIds, nextPageToken } = await adapterA.listAggregateIds(
          { eventStoreId },
          {
            limit: 1,
            initialEventAfter: '2021-02-01T00:00:00.000Z',
            initialEventBefore: '2023-02-01T00:00:00.000Z',
            reverse: true,
          },
        );

        expect(aggregateIds).toStrictEqual([
          {
            aggregateId: aggregateIdMock3,
            initialEventTimestamp: aggregate3InitialEventTimestamp,
          },
        ]);
        expect(JSON.parse(nextPageToken as string)).toStrictEqual({
          limit: 1,
          initialEventAfter: '2021-02-01T00:00:00.000Z',
          initialEventBefore: '2023-02-01T00:00:00.000Z',
          reverse: true,
          lastEvaluatedKey: {
            aggregateId: aggregateIdMock3,
            initialEventTimestamp: aggregate3InitialEventTimestamp,
          },
        });

        const { aggregateIds: lastAggregateIds, nextPageToken: noPageToken } =
          await adapterA.listAggregateIds(
            { eventStoreId },
            { pageToken: nextPageToken },
          );

        expect(noPageToken).toBeUndefined();
        expect(lastAggregateIds).toStrictEqual([
          {
            aggregateId: aggregateIdMock2,
            initialEventTimestamp: aggregate2InitialEventTimestamp,
          },
        ]);
      });
    });

    describe('groupEvent', () => {
      it('groups events correctly', () => {
        const groupedEvent = adapterA.groupEvent(omit(eventMock1, 'timestamp'));

        expect(groupedEvent).toBeInstanceOf(GroupedEvent);
        expect(groupedEvent).toMatchObject({
          event: omit(eventMock1, 'timestamp'),
          eventStorageAdapter: adapterA,
        });
        expect(groupedEvent.eventStorageAdapter).toBeInstanceOf(adapterClass);
      });
    });

    describe('pushEventGroup', () => {
      const aggregate2EventMock = {
        aggregateId: aggregateIdMock2,
        version: 1,
        type: 'EVENT_TYPE',
        timestamp: eventMock1.timestamp,
      };

      it('push grouped events correctly', async () => {
        const groupedEvents: [GroupedEvent, ...GroupedEvent[]] = [
          new GroupedEvent({
            event: eventMock1,
            eventStorageAdapter: adapterA,
            context: { eventStoreId },
          }),
          new GroupedEvent({
            event: aggregate2EventMock,
            eventStorageAdapter: adapterB,
            context: { eventStoreId },
          }),
        ];

        const eventGroup = await adapterA.pushEventGroup(
          { force: true },
          ...groupedEvents,
        );
        expect(eventGroup).toStrictEqual({
          eventGroup: [{ event: eventMock1 }, { event: aggregate2EventMock }],
        });

        const { events: eventsA } = await adapterA.getEvents(aggregateIdMock1, {
          eventStoreId,
        });
        expect(eventsA).toStrictEqual([eventMock1]);

        const { events: eventsB } = await adapterB.getEvents(aggregateIdMock2, {
          eventStoreId,
        });
        expect(eventsB).toStrictEqual([aggregate2EventMock]);
      });

      it(`throws if event storage adapter is not an instance of the expected class`, async () => {
        // A minimal stand-in whose only relevant property is that it is NOT
        // an instance of `adapterClass`. Using `{}` is sufficient for the
        // class-identity check `instanceof adapterClass` to return false.
        const foreignAdapter = {} as EventStorageAdapter;

        const groupedEvents: [GroupedEvent, ...GroupedEvent[]] = [
          new GroupedEvent({
            event: eventMock1,
            eventStorageAdapter: adapterA,
            context: { eventStoreId },
          }),
          new GroupedEvent({
            event: aggregate2EventMock,
            eventStorageAdapter: foreignAdapter,
            context: { eventStoreId },
          }),
        ];

        await expect(() =>
          adapterA.pushEventGroup({}, ...groupedEvents),
        ).rejects.toThrow();
      });

      it('throws if context is missing', async () => {
        const groupedEvents: [GroupedEvent, ...GroupedEvent[]] = [
          new GroupedEvent({
            event: eventMock1,
            eventStorageAdapter: adapterA,
            context: { eventStoreId },
          }),
          new GroupedEvent({
            event: aggregate2EventMock,
            eventStorageAdapter: adapterB,
          }),
        ];

        await expect(() =>
          adapterA.pushEventGroup({}, ...groupedEvents),
        ).rejects.toThrow();
      });

      it('throws if events have different timestamps', async () => {
        const groupedEvents: [GroupedEvent, ...GroupedEvent[]] = [
          new GroupedEvent({
            event: eventMock1,
            eventStorageAdapter: adapterA,
            context: { eventStoreId },
          }),
          new GroupedEvent({
            event: {
              ...aggregate2EventMock,
              timestamp: new Date().toISOString(),
            },
            eventStorageAdapter: adapterB,
            context: { eventStoreId },
          }),
        ];

        await expect(() =>
          adapterA.pushEventGroup({}, ...groupedEvents),
        ).rejects.toThrow();
      });

      it('reverts all events if a push has failed', async () => {
        await adapterA.pushEvent(eventMock1, { eventStoreId });
        const groupedEvents: [GroupedEvent, ...GroupedEvent[]] = [
          new GroupedEvent({
            event: eventMock1,
            eventStorageAdapter: adapterA,
            context: { eventStoreId },
          }),
          new GroupedEvent({
            event: aggregate2EventMock,
            eventStorageAdapter: adapterB,
            context: { eventStoreId },
          }),
        ];

        await expect(() =>
          adapterA.pushEventGroup({}, ...groupedEvents),
        ).rejects.toThrow();

        const { events: eventsA } = await adapterA.getEvents(aggregateIdMock1, {
          eventStoreId,
        });
        expect(eventsA).toStrictEqual([eventMock1]);

        const { events: eventsB } = await adapterB.getEvents(aggregateIdMock2, {
          eventStoreId,
        });
        expect(eventsB).toStrictEqual([]);
      });
    });
  });
};
