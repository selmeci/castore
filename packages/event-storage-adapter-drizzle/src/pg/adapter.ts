import { and, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { GroupedEvent } from '@castore/core';
import type {
  EventDetail,
  EventsQueryOptions,
  EventStorageAdapter,
  EventStoreContext,
  ListAggregateIdsOptions,
  ListAggregateIdsOutput,
  OptionalTimestamp,
  PushEventOptions,
} from '@castore/core';

import { DrizzleEventAlreadyExistsError } from '../common/error';
import type { DrizzleEventRow } from '../common/eventDetail';
import { buildEventDetail } from '../common/eventDetail';
import {
  buildGetEventsFilters,
  buildGetEventsOrder,
} from '../common/getEvents';
import {
  buildBaseFilters,
  buildCursorPredicate,
  buildListAggregateIdsOutput,
  buildOrderBy,
} from '../common/listAggregateIds';
import { parsePageToken } from '../common/pageToken';
import { makeParseGroupedEvents } from '../common/parseGroupedEvents';
import { walkErrorCauses } from '../common/walkErrorCauses';
import type { PgEventTableContract } from './contract';

type AnyPgDatabaseOrTx = PgDatabase<any, any, any>;

// pg SQLSTATE 23505 = unique_violation. Both `postgres-js` and `node-postgres`
// surface `.code === '23505'` directly on the thrown error; the walk through
// `cause`/`sourceError`/`originalError` is defensive against future Drizzle
// versions that may wrap the driver error.
const isDuplicateKeyError = (err: unknown): boolean =>
  walkErrorCauses(err, node => (node as { code?: unknown }).code === '23505');

const coercePgTimestamp = (iso: string): Date => new Date(iso);

export class DrizzlePgEventStorageAdapter implements EventStorageAdapter {
  private db: AnyPgDatabaseOrTx;
  private eventTable: PgEventTableContract;

  constructor({
    db,
    eventTable,
  }: {
    db: PgDatabase<any, any, any>;
    eventTable: PgEventTableContract;
  }) {
    this.db = db;
    this.eventTable = eventTable;
  }

  private buildInsertValues(
    aggregateName: string,
    event: OptionalTimestamp<EventDetail>,
  ): Record<string, unknown> {
    const { aggregateId, version, type, payload, metadata, timestamp } = event;
    const values: Record<string, unknown> = {
      aggregateName,
      aggregateId,
      version,
      type,
      payload: payload ?? null,
      metadata: metadata ?? null,
    };
    if (timestamp !== undefined) {
      values.timestamp = new Date(timestamp);
    }

    return values;
  }

  private buildForceUpdateSet(
    event: OptionalTimestamp<EventDetail>,
  ): Record<string, unknown> {
    const set: Record<string, unknown> = {
      type: sql`EXCLUDED.type`,
      payload: sql`EXCLUDED.payload`,
      metadata: sql`EXCLUDED.metadata`,
    };
    set.timestamp =
      event.timestamp !== undefined
        ? sql`EXCLUDED.timestamp`
        : sql`CURRENT_TIMESTAMP(3)`;

    return set;
  }

  private selectColumns() {
    return {
      aggregate_id: this.eventTable.aggregateId,
      version: this.eventTable.version,
      type: this.eventTable.type,
      payload: this.eventTable.payload,
      metadata: this.eventTable.metadata,
      timestamp: this.eventTable.timestamp,
    };
  }

  private async pushEventInTx(
    tx: AnyPgDatabaseOrTx,
    event: OptionalTimestamp<EventDetail>,
    options: PushEventOptions,
  ): Promise<{ event: EventDetail }> {
    const { aggregateId, version } = event;
    const values = this.buildInsertValues(options.eventStoreId, event);

    let res: DrizzleEventRow[];
    try {
      if (options.force === true) {
        res = (await tx
          .insert(this.eventTable)
          .values(values)
          .onConflictDoUpdate({
            target: [
              this.eventTable.aggregateName,
              this.eventTable.aggregateId,
              this.eventTable.version,
            ],
            set: this.buildForceUpdateSet(event),
          })
          .returning(this.selectColumns())) as DrizzleEventRow[];
      } else {
        res = (await tx
          .insert(this.eventTable)
          .values(values)
          .returning(this.selectColumns())) as DrizzleEventRow[];
      }
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new DrizzleEventAlreadyExistsError({
          eventStoreId: options.eventStoreId,
          aggregateId,
          version,
          cause: err,
        });
      }
      throw err;
    }

    const insertedEvent = res[0];
    if (!insertedEvent) {
      throw new Error('Failed to insert event');
    }

    return { event: buildEventDetail(insertedEvent) };
  }

  async pushEvent(
    eventDetail: OptionalTimestamp<EventDetail>,
    options: PushEventOptions,
  ): Promise<{ event: EventDetail }> {
    return this.pushEventInTx(this.db, eventDetail, options);
  }

  async getEvents(
    aggregateId: string,
    context: EventStoreContext,
    options?: EventsQueryOptions,
  ): Promise<{ events: EventDetail[] }> {
    const filters = buildGetEventsFilters({
      aggregateNameColumn: this.eventTable.aggregateName,
      aggregateIdColumn: this.eventTable.aggregateId,
      versionColumn: this.eventTable.version,
      eventStoreId: context.eventStoreId,
      aggregateId,
      minVersion: options?.minVersion,
      maxVersion: options?.maxVersion,
    });

    const baseQuery = this.db
      .select(this.selectColumns())
      .from(this.eventTable)
      .where(and(...filters))
      .orderBy(buildGetEventsOrder(this.eventTable.version, options));

    const query =
      options?.limit !== undefined ? baseQuery.limit(options.limit) : baseQuery;

    const rows = (await query) as DrizzleEventRow[];

    return {
      events: rows.map(row => buildEventDetail(row)),
    };
  }

  async pushEventGroup(
    options: { force?: boolean },
    groupedEvent_0: GroupedEvent,
    ...rest: GroupedEvent[]
  ): Promise<{ eventGroup: { event: EventDetail }[] }> {
    const { groupedEvents } = parseDrizzlePgGroupedEvents(
      groupedEvent_0,
      ...rest,
    );

    const results = await this.db.transaction(async tx => {
      const inner: { event: EventDetail }[] = [];
      for (const groupedEvent of groupedEvents) {
        const {
          eventStorageAdapter: groupedAdapter,
          event,
          context,
        } = groupedEvent;
        const response = await groupedAdapter.pushEventInTx(tx, event, {
          eventStoreId: context.eventStoreId,
          force: options.force,
        });
        inner.push(response);
      }

      return inner;
    });

    return { eventGroup: results };
  }

  groupEvent(eventDetail: OptionalTimestamp<EventDetail>): GroupedEvent {
    return new GroupedEvent({ event: eventDetail, eventStorageAdapter: this });
  }

  async listAggregateIds(
    context: EventStoreContext,
    options?: ListAggregateIdsOptions,
  ): Promise<ListAggregateIdsOutput> {
    const {
      limit,
      initialEventAfter,
      initialEventBefore,
      reverse,
      lastEvaluatedKey,
    } = parsePageToken(options);

    // Two-query approach (see plan: CTE is optional for this dialect; two
    // queries are observationally identical from the caller's perspective
    // and cleaner to express in Drizzle without raw SQL).
    const baseFilters = buildBaseFilters({
      aggregateNameColumn: this.eventTable.aggregateName,
      versionColumn: this.eventTable.version,
      timestampColumn: this.eventTable.timestamp,
      eventStoreId: context.eventStoreId,
      initialEventAfter,
      initialEventBefore,
      coerceTimestamp: coercePgTimestamp,
    });

    const cursorPredicate = buildCursorPredicate({
      aggregateIdColumn: this.eventTable.aggregateId,
      timestampColumn: this.eventTable.timestamp,
      lastEvaluatedKey,
      reverse: reverse === true,
      coerceTimestamp: coercePgTimestamp,
    });

    const pageFilters = [
      ...baseFilters,
      ...(cursorPredicate !== undefined ? [cursorPredicate] : []),
    ];

    const countRows = (await this.db
      .select({ remaining: sql<number>`count(*)::int` })
      .from(this.eventTable)
      .where(and(...pageFilters))) as { remaining: number }[];
    const remainingCount = Number(countRows[0]?.remaining ?? 0);

    const pageBase = this.db
      .select({
        aggregate_id: this.eventTable.aggregateId,
        timestamp: this.eventTable.timestamp,
      })
      .from(this.eventTable)
      .where(and(...pageFilters))
      .orderBy(
        ...buildOrderBy({
          aggregateIdColumn: this.eventTable.aggregateId,
          timestampColumn: this.eventTable.timestamp,
          reverse: reverse === true,
        }),
      );

    const pageQuery = limit !== undefined ? pageBase.limit(limit) : pageBase;
    const pageRows = (await pageQuery) as {
      aggregate_id: unknown;
      timestamp: unknown;
    }[];

    return buildListAggregateIdsOutput({
      rows: pageRows,
      limit,
      remainingCount,
      resolvedInputs: {
        limit,
        initialEventAfter,
        initialEventBefore,
        reverse,
      },
    });
  }
}

/**
 * Class-bound `parseGroupedEvents` — enforces that every grouped event's
 * storage adapter is a `DrizzlePgEventStorageAdapter` (R13), plus the
 * context + timestamp-coherence checks shared across all dialects.
 *
 * Declared after the class so the `instanceof` check closes over the final
 * class reference (avoids TDZ hazards in the hoisted declaration).
 */
const parseDrizzlePgGroupedEvents = makeParseGroupedEvents(
  DrizzlePgEventStorageAdapter,
  'DrizzlePgEventStorageAdapter',
);
