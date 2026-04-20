import { vi } from 'vitest';

import type { EventStorageAdapter } from '~/eventStorageAdapter';
import { pokemonsEventStore } from '~/eventStore/eventStore.fixtures.test';

import {
  notificationMessageQueue,
  pokemonsEventStoreWithNotificationMessageQueue,
  pokemonsEventStoreWithStateCarryingMessageBus,
  stateCarryingMessageBus,
} from './connectedEventStore.fixtures.test';
import {
  OUTBOX_ENABLED_SYMBOL,
  OUTBOX_GET_EVENT_SYMBOL,
} from './outboxCapability';
import { publishPushedEvent } from './publishPushedEvent';

const aggregateId = 'pokemon-1';
const event = {
  aggregateId,
  type: 'POKEMON_CAUGHT',
  version: 2,
  timestamp: '2022-01-01T00:00:00.000Z',
} as const;

const previousEvent = {
  aggregateId,
  type: 'POKEMON_APPEARED',
  version: 1,
  timestamp: '2021-01-01T00:00:00.000Z',
  payload: { name: 'Pikachu', level: 30 },
} as const;

const v2Aggregate = pokemonsEventStore.buildAggregate([previousEvent, event]);

const buildAdapter = (
  overrides: Partial<Record<symbol, unknown>> = {},
): EventStorageAdapter =>
  ({
    getEvents: vi.fn(),
    pushEvent: vi.fn(),
    pushEventGroup: vi.fn(),
    groupEvent: vi.fn(),
    listAggregateIds: vi.fn(),
    ...overrides,
  }) as unknown as EventStorageAdapter;

describe('publishPushedEvent — outbox short-circuit', () => {
  beforeEach(() => {
    pokemonsEventStoreWithNotificationMessageQueue.eventStorageAdapter =
      undefined;
    pokemonsEventStoreWithStateCarryingMessageBus.eventStorageAdapter =
      undefined;
  });

  afterEach(() => {
    pokemonsEventStoreWithNotificationMessageQueue.eventStorageAdapter =
      undefined;
    pokemonsEventStoreWithStateCarryingMessageBus.eventStorageAdapter =
      undefined;
  });

  it('skips publish on NotificationMessageChannel when the adapter has both symbols', async () => {
    pokemonsEventStoreWithNotificationMessageQueue.eventStorageAdapter =
      buildAdapter({
        [OUTBOX_ENABLED_SYMBOL]: true,
        [OUTBOX_GET_EVENT_SYMBOL]: () => Promise.resolve(undefined),
      });

    const spy = vi
      .spyOn(notificationMessageQueue, 'publishMessage')
      .mockResolvedValue();
    spy.mockClear();

    await publishPushedEvent(pokemonsEventStoreWithNotificationMessageQueue, {
      event,
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it('skips publish on StateCarryingMessageChannel when the adapter has both symbols', async () => {
    pokemonsEventStoreWithStateCarryingMessageBus.eventStorageAdapter =
      buildAdapter({
        [OUTBOX_ENABLED_SYMBOL]: true,
        [OUTBOX_GET_EVENT_SYMBOL]: () => Promise.resolve(undefined),
      });

    const spy = vi
      .spyOn(stateCarryingMessageBus, 'publishMessage')
      .mockResolvedValue();
    spy.mockClear();

    await publishPushedEvent(pokemonsEventStoreWithStateCarryingMessageBus, {
      event,
      nextAggregate: v2Aggregate,
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it('falls through to legacy publish when the enabled flag is absent', async () => {
    pokemonsEventStoreWithNotificationMessageQueue.eventStorageAdapter =
      buildAdapter();

    const spy = vi
      .spyOn(notificationMessageQueue, 'publishMessage')
      .mockResolvedValue();
    spy.mockClear();

    await publishPushedEvent(pokemonsEventStoreWithNotificationMessageQueue, {
      event,
    });

    expect(spy).toHaveBeenCalledOnce();
  });

  it('falls through to legacy publish when only the boolean is set (missing fn)', async () => {
    pokemonsEventStoreWithNotificationMessageQueue.eventStorageAdapter =
      buildAdapter({ [OUTBOX_ENABLED_SYMBOL]: true });

    const spy = vi
      .spyOn(notificationMessageQueue, 'publishMessage')
      .mockResolvedValue();
    spy.mockClear();

    await publishPushedEvent(pokemonsEventStoreWithNotificationMessageQueue, {
      event,
    });

    expect(spy).toHaveBeenCalledOnce();
  });

  it('does not throw when no adapter is configured (legacy no-adapter path)', async () => {
    pokemonsEventStoreWithNotificationMessageQueue.eventStorageAdapter =
      undefined;

    const spy = vi
      .spyOn(notificationMessageQueue, 'publishMessage')
      .mockResolvedValue();
    spy.mockClear();

    await expect(
      publishPushedEvent(pokemonsEventStoreWithNotificationMessageQueue, {
        event,
      }),
    ).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledOnce();
  });

  it('re-probes per invocation when the adapter setter swaps the adapter', async () => {
    const outboxAdapter = buildAdapter({
      [OUTBOX_ENABLED_SYMBOL]: true,
      [OUTBOX_GET_EVENT_SYMBOL]: () => Promise.resolve(undefined),
    });
    const legacyAdapter = buildAdapter();

    const spy = vi
      .spyOn(notificationMessageQueue, 'publishMessage')
      .mockResolvedValue();
    spy.mockClear();

    pokemonsEventStoreWithNotificationMessageQueue.eventStorageAdapter =
      outboxAdapter;
    await publishPushedEvent(pokemonsEventStoreWithNotificationMessageQueue, {
      event,
    });
    expect(spy).not.toHaveBeenCalled();

    pokemonsEventStoreWithNotificationMessageQueue.eventStorageAdapter =
      legacyAdapter;
    await publishPushedEvent(pokemonsEventStoreWithNotificationMessageQueue, {
      event,
    });
    expect(spy).toHaveBeenCalledOnce();
  });
});
