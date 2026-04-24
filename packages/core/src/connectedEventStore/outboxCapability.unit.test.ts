import type { EventStorageAdapter } from '~/eventStorageAdapter';

import {
  isOutboxEnabledAdapter,
  OUTBOX_ENABLED_SYMBOL,
  OUTBOX_GET_EVENT_SYMBOL,
} from './outboxCapability';

const buildAdapter = (
  overrides: Partial<Record<symbol, unknown>> = {},
): EventStorageAdapter => {
  const adapter = {
    getEvents: vi.fn(),
    pushEvent: vi.fn(),
    pushEventGroup: vi.fn(),
    groupEvent: vi.fn(),
    listAggregateIds: vi.fn(),
    ...overrides,
  };

  return adapter as unknown as EventStorageAdapter;
};

describe('isOutboxEnabledAdapter', () => {
  it('returns false when the adapter is undefined', () => {
    expect(isOutboxEnabledAdapter(undefined)).toBe(false);
  });

  it('returns false when neither symbol is set', () => {
    expect(isOutboxEnabledAdapter(buildAdapter())).toBe(false);
  });

  it('returns false when only the enabled flag is set (no lookup fn)', () => {
    const adapter = buildAdapter({ [OUTBOX_ENABLED_SYMBOL]: true });

    expect(isOutboxEnabledAdapter(adapter)).toBe(false);
  });

  it('returns false when the lookup fn is not actually a function', () => {
    const adapter = buildAdapter({
      [OUTBOX_ENABLED_SYMBOL]: true,
      [OUTBOX_GET_EVENT_SYMBOL]: 'not-a-fn',
    });

    expect(isOutboxEnabledAdapter(adapter)).toBe(false);
  });

  it('returns false when the enabled flag is explicitly false', () => {
    const adapter = buildAdapter({
      [OUTBOX_ENABLED_SYMBOL]: false,
      [OUTBOX_GET_EVENT_SYMBOL]: () => Promise.resolve(undefined),
    });

    expect(isOutboxEnabledAdapter(adapter)).toBe(false);
  });

  it('returns true when both symbols are present and well-typed', () => {
    const adapter = buildAdapter({
      [OUTBOX_ENABLED_SYMBOL]: true,
      [OUTBOX_GET_EVENT_SYMBOL]: () => Promise.resolve(undefined),
    });

    expect(isOutboxEnabledAdapter(adapter)).toBe(true);
  });

  it('narrows the TS type so the lookup fn is callable without casts', async () => {
    const lookup = vi.fn(
      (aggregateName: string, aggregateId: string, version: number) =>
        Promise.resolve({
          aggregateId,
          version,
          type: aggregateName,
          timestamp: '2026-01-01T00:00:00.000Z',
        }),
    );

    const adapter = buildAdapter({
      [OUTBOX_ENABLED_SYMBOL]: true,
      [OUTBOX_GET_EVENT_SYMBOL]: lookup,
    });

    if (isOutboxEnabledAdapter(adapter)) {
      const event = await adapter[OUTBOX_GET_EVENT_SYMBOL]('n', 'a', 1);
      expect(event?.version).toBe(1);
      expect(lookup).toHaveBeenCalledWith('n', 'a', 1);
    } else {
      throw new Error('predicate should have narrowed to true');
    }
  });

  it('uses the global symbol registry (Symbol.for identity)', () => {
    expect(OUTBOX_ENABLED_SYMBOL).toBe(Symbol.for('castore.outbox-enabled'));
    expect(OUTBOX_GET_EVENT_SYMBOL).toBe(
      Symbol.for('castore.outbox.getEventByKey'),
    );
  });
});
