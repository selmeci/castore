import { describe, expect, it } from 'vitest';

import { buildListAggregateIdsOutput } from './listAggregateIds';

const mkRow = (
  aggregateId: string,
  timestamp: string,
): { aggregate_id: unknown; timestamp: unknown } => ({
  aggregate_id: aggregateId,
  timestamp,
});

const resolvedInputs = {
  limit: undefined,
  initialEventAfter: undefined,
  initialEventBefore: undefined,
  reverse: undefined,
};

describe('buildListAggregateIdsOutput', () => {
  it('emits nextPageToken when there is genuinely more to fetch', () => {
    const output = buildListAggregateIdsOutput({
      rows: [
        mkRow('a-1', '2026-04-19T00:00:00.000Z'),
        mkRow('a-2', '2026-04-19T00:00:01.000Z'),
      ],
      limit: 2,
      remainingCount: 5,
      resolvedInputs: { ...resolvedInputs, limit: 2 },
    });

    expect(output.aggregateIds).toHaveLength(2);
    expect(output.nextPageToken).toBeDefined();
    const decoded = JSON.parse(output.nextPageToken as string) as {
      lastEvaluatedKey: { aggregateId: string };
    };
    expect(decoded.lastEvaluatedKey.aggregateId).toBe('a-2');
  });

  it('omits nextPageToken when remainingCount does not exceed limit', () => {
    const output = buildListAggregateIdsOutput({
      rows: [mkRow('a-1', '2026-04-19T00:00:00.000Z')],
      limit: 5,
      remainingCount: 1,
      resolvedInputs: { ...resolvedInputs, limit: 5 },
    });

    expect(output.aggregateIds).toHaveLength(1);
    expect(output.nextPageToken).toBeUndefined();
  });

  it('omits nextPageToken when limit is undefined', () => {
    const output = buildListAggregateIdsOutput({
      rows: [mkRow('a-1', '2026-04-19T00:00:00.000Z')],
      limit: undefined,
      remainingCount: 1,
      resolvedInputs,
    });

    expect(output.nextPageToken).toBeUndefined();
  });

  it('omits nextPageToken when limit is zero even if remainingCount is positive', () => {
    // `remainingCount > 0` alone previously emitted a token whose
    // `lastEvaluatedKey` was the empty row set's `at(-1)` (undefined),
    // producing a cursor that decoded back to page one and looped callers.
    const output = buildListAggregateIdsOutput({
      rows: [],
      limit: 0,
      remainingCount: 10,
      resolvedInputs: { ...resolvedInputs, limit: 0 },
    });

    expect(output.aggregateIds).toHaveLength(0);
    expect(output.nextPageToken).toBeUndefined();
  });

  it('omits nextPageToken when limit is negative', () => {
    const output = buildListAggregateIdsOutput({
      rows: [],
      limit: -1,
      remainingCount: 10,
      resolvedInputs: { ...resolvedInputs, limit: -1 },
    });

    expect(output.nextPageToken).toBeUndefined();
  });

  it('omits nextPageToken when the returned row set is empty', () => {
    // Defensive: even if a caller somehow produced a positive limit with
    // remainingCount > limit but zero fetched rows (e.g. filter drift between
    // count and page queries), we must not emit a token whose lastEvaluatedKey
    // is undefined.
    const output = buildListAggregateIdsOutput({
      rows: [],
      limit: 10,
      remainingCount: 100,
      resolvedInputs: { ...resolvedInputs, limit: 10 },
    });

    expect(output.nextPageToken).toBeUndefined();
  });
});
