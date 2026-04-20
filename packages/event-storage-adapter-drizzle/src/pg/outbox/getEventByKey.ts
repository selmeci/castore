import { and, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import type { EventDetail } from '@castore/core';

import type { DrizzleEventRow } from '../../common/eventDetail';
import { buildEventDetail } from '../../common/eventDetail';
import type { PgEventTableContract } from '../contract';

type AnyPgDatabase = PgDatabase<any, any, any>;

/**
 * Factory returning a single-row event lookup keyed by
 * `(aggregate_name, aggregate_id, version)`. Used by the outbox relay at
 * publish time; index-hit O(1) rather than the O(aggregate-length) cost of
 * `getEvents(aggregateId)`.
 *
 * Returns `undefined` when the row is missing (crypto-shredded ahead of the
 * relay) — the relay stamps `dead_at` in that case (see origin R10).
 */
export const makePgGetEventByKey =
  (db: AnyPgDatabase, eventTable: PgEventTableContract) =>
  async (
    aggregateName: string,
    aggregateId: string,
    version: number,
  ): Promise<EventDetail | undefined> => {
    const rows = (await db
      .select({
        aggregate_id: eventTable.aggregateId,
        version: eventTable.version,
        type: eventTable.type,
        payload: eventTable.payload,
        metadata: eventTable.metadata,
        timestamp: eventTable.timestamp,
      })
      .from(eventTable)
      .where(
        and(
          eq(eventTable.aggregateName, aggregateName),
          eq(eventTable.aggregateId, aggregateId),
          eq(eventTable.version, version),
        ),
      )
      .limit(1)) as DrizzleEventRow[];

    const row = rows[0];

    return row === undefined ? undefined : buildEventDetail(row);
  };
