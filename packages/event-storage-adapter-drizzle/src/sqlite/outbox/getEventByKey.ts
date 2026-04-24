import { and, eq } from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

import type { EventDetail } from '@castore/core';

import type { DrizzleEventRow } from '../../common/eventDetail';
import { buildEventDetail } from '../../common/eventDetail';
import type { SqliteEventTableContract } from '../contract';

type AnySQLiteDatabase = BaseSQLiteDatabase<'sync' | 'async', any, any, any>;

/**
 * Factory returning a single-row event lookup keyed by
 * `(aggregate_name, aggregate_id, version)`. See the pg twin for the full
 * rationale.
 */
export const makeSqliteGetEventByKey =
  (db: AnySQLiteDatabase, eventTable: SqliteEventTableContract) =>
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
