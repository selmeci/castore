import type { Column, SQL } from 'drizzle-orm';
import { asc, desc, eq, sql } from 'drizzle-orm';

import type { EventsQueryOptions } from '@castore/core';

/**
 * Build the `WHERE` fragment array for `getEvents`, narrowing on the
 * aggregate's `(aggregateName, aggregateId)` natural key and optionally
 * restricting by version bounds.
 *
 * Extracted so the per-dialect `getEvents` stays under the repo's
 * `complexity: 8` ESLint limit — building filters + picking the order +
 * conditionally applying `limit` pushes the method over 8 otherwise.
 */
export const buildGetEventsFilters = (params: {
  aggregateNameColumn: Column;
  aggregateIdColumn: Column;
  versionColumn: Column;
  eventStoreId: string;
  aggregateId: string;
  minVersion: number | undefined;
  maxVersion: number | undefined;
}): SQL[] => {
  const filters: SQL[] = [
    eq(params.aggregateNameColumn, params.eventStoreId),
    eq(params.aggregateIdColumn, params.aggregateId),
  ];

  if (params.minVersion !== undefined) {
    filters.push(sql`${params.versionColumn} >= ${params.minVersion}`);
  }
  if (params.maxVersion !== undefined) {
    filters.push(sql`${params.versionColumn} <= ${params.maxVersion}`);
  }

  return filters;
};

/**
 * Pick the `ORDER BY` direction for `getEvents` based on
 * `options.reverse`. Kept alongside `buildGetEventsFilters` for symmetry.
 */
export const buildGetEventsOrder = (
  versionColumn: Column,
  options: EventsQueryOptions | undefined,
): SQL =>
  options?.reverse === true ? desc(versionColumn) : asc(versionColumn);
