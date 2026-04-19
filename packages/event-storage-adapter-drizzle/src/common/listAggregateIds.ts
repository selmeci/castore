import type { Column, SQL } from 'drizzle-orm';
import { and, asc, desc, eq, gt, lt, or } from 'drizzle-orm';

import type { ListAggregateIdsOutput } from '@castore/core';

import type { ParsedPageToken } from './pageToken';
import { toIsoString } from './toIsoString';

/**
 * Generic shape of the timestamp cursor value stored in a page token.
 * Dialects map this through a transform: pg / mysql pass it through
 * `new Date(...)`; sqlite uses the raw ISO string (driver rejects `Date`).
 */
type TimestampCoercer<T> = (iso: string) => T;

/**
 * Build the `WHERE` fragment for the base `version = 1` scan, optionally
 * restricted by `initialEventAfter` / `initialEventBefore` bounds.
 *
 * The dialect-specific `coerceTimestamp` lets sqlite pass the ISO string
 * straight through while pg / mysql wrap it in a `Date`.
 */
export const buildBaseFilters = <T>(params: {
  aggregateNameColumn: Column;
  versionColumn: Column;
  timestampColumn: Column;
  eventStoreId: string;
  initialEventAfter: string | undefined;
  initialEventBefore: string | undefined;
  coerceTimestamp: TimestampCoercer<T>;
}): SQL[] => {
  const filters: SQL[] = [
    eq(params.aggregateNameColumn, params.eventStoreId),
    eq(params.versionColumn, 1),
  ];
  if (params.initialEventAfter !== undefined) {
    filters.push(
      gt(
        params.timestampColumn,
        params.coerceTimestamp(params.initialEventAfter),
      ),
    );
  }
  if (params.initialEventBefore !== undefined) {
    filters.push(
      lt(
        params.timestampColumn,
        params.coerceTimestamp(params.initialEventBefore),
      ),
    );
  }

  return filters;
};

/**
 * Build the composite-cursor predicate used to resume a page, or return
 * `undefined` if there is no cursor to apply.
 *
 * The cursor orders on `(timestamp, aggregateId)` so a page boundary that
 * lands on a timestamp collision neither skips nor duplicates rows on the
 * next page — the aggregateId tiebreaker is load-bearing for correctness.
 */
export const buildCursorPredicate = <T>(params: {
  aggregateIdColumn: Column;
  timestampColumn: Column;
  lastEvaluatedKey: ParsedPageToken['lastEvaluatedKey'];
  reverse: boolean;
  coerceTimestamp: TimestampCoercer<T>;
}): SQL | undefined => {
  if (params.lastEvaluatedKey?.initialEventTimestamp === undefined) {
    return undefined;
  }

  const tsCursor = params.coerceTimestamp(
    params.lastEvaluatedKey.initialEventTimestamp,
  );
  const idCursor = params.lastEvaluatedKey.aggregateId;

  return params.reverse
    ? or(
        lt(params.timestampColumn, tsCursor),
        and(
          eq(params.timestampColumn, tsCursor),
          lt(params.aggregateIdColumn, idCursor),
        ),
      )
    : or(
        gt(params.timestampColumn, tsCursor),
        and(
          eq(params.timestampColumn, tsCursor),
          gt(params.aggregateIdColumn, idCursor),
        ),
      );
};

/**
 * Build the `ORDER BY` clause array for the paging query — ascending by
 * `(timestamp, aggregateId)` or descending when `reverse` is true.
 */
export const buildOrderBy = (params: {
  aggregateIdColumn: Column;
  timestampColumn: Column;
  reverse: boolean;
}): SQL[] =>
  params.reverse
    ? [desc(params.timestampColumn), desc(params.aggregateIdColumn)]
    : [asc(params.timestampColumn), asc(params.aggregateIdColumn)];

/**
 * Assemble the final `ListAggregateIdsOutput` from the raw page rows and the
 * resolved input values. Emits the *resolved* values (options ?? prev-token)
 * into `nextPageToken` so page-3+ tokens retain `limit`, the
 * `initialEventAfter` / `initialEventBefore` bounds, and `reverse` when the
 * caller supplied them only on the first call.
 */
export const buildListAggregateIdsOutput = (params: {
  rows: { aggregate_id: unknown; timestamp: unknown }[];
  limit: number | undefined;
  remainingCount: number;
  resolvedInputs: {
    limit: number | undefined;
    initialEventAfter: string | undefined;
    initialEventBefore: string | undefined;
    reverse: boolean | undefined;
  };
}): ListAggregateIdsOutput => {
  const aggregateIds = params.rows.map(row => ({
    aggregateId: row.aggregate_id as string,
    initialEventTimestamp: toIsoString(row.timestamp),
  }));

  const hasNextPage =
    params.limit === undefined ? false : params.remainingCount > params.limit;

  const parsedNextPageToken: ParsedPageToken = {
    limit: params.resolvedInputs.limit,
    initialEventAfter: params.resolvedInputs.initialEventAfter,
    initialEventBefore: params.resolvedInputs.initialEventBefore,
    reverse: params.resolvedInputs.reverse,
    lastEvaluatedKey: aggregateIds.at(-1),
  };

  return {
    aggregateIds,
    ...(hasNextPage
      ? { nextPageToken: JSON.stringify(parsedNextPageToken) }
      : {}),
  };
};
