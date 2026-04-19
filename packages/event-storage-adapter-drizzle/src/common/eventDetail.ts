import type { EventDetail } from '@castore/core';

import { toIsoString } from './toIsoString';

/**
 * Canonical shape of a selected row from any dialect's event table. Every
 * adapter's `selectColumns()` returns these six columns; casting the driver
 * rows to `DrizzleEventRow` lets `buildEventDetail` stay dialect-agnostic.
 *
 * The fields are typed as `unknown` because Drizzle's column-level codecs
 * differ per dialect (`json` vs `jsonb` vs `text({ mode: 'json' })`, `Date`
 * vs ISO-string for timestamps). Each adapter is responsible for ensuring
 * its `selectColumns()` maps to driver output that satisfies the casts
 * performed here.
 */
export type DrizzleEventRow = {
  aggregate_id: unknown;
  version: unknown;
  type: unknown;
  payload: unknown;
  metadata: unknown;
  timestamp: unknown;
};

/**
 * Converts a selected event row into an `EventDetail`. Identical semantics
 * across pg / mysql / sqlite, so it lives here instead of being duplicated
 * in each adapter.
 *
 * Note: `payload` / `metadata` are dropped only when the DB stored SQL NULL
 * (JS `null` / `undefined`). Falsy JSON values (`false`, `0`, `''`) are legal
 * payloads and must round-trip through the adapter unchanged — the explicit
 * `=== null || === undefined` check is load-bearing.
 */
export const buildEventDetail = (row: DrizzleEventRow): EventDetail => {
  const eventDetail = {
    aggregateId: row.aggregate_id as string,
    version: Number(row.version),
    type: row.type as string,
    payload: row.payload as unknown | null,
    metadata: row.metadata as unknown | null,
    timestamp: toIsoString(row.timestamp),
  };
  if (eventDetail.payload === null || eventDetail.payload === undefined) {
    delete (eventDetail as { payload?: unknown }).payload;
  }
  if (eventDetail.metadata === null || eventDetail.metadata === undefined) {
    delete (eventDetail as { metadata?: unknown }).metadata;
  }

  return eventDetail as EventDetail;
};
