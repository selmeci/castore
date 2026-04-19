import { and, eq, sql } from 'drizzle-orm';
import type { MySqlDatabase } from 'drizzle-orm/mysql-core';

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
import type { MysqlEventTableContract } from './contract';

type AnyMySqlDatabaseOrTx = MySqlDatabase<any, any, any, any>;

// mysql2 surfaces duplicate-key violations with `code === 'ER_DUP_ENTRY'` and
// `errno === 1062`. Drizzle 0.45 wraps mysql2 errors inside `DrizzleQueryError`
// whose `.cause` carries the original driver error — `walkErrorCauses` handles
// that traversal.
const isDuplicateKeyError = (err: unknown): boolean =>
  walkErrorCauses(err, node => {
    const code = (node as { code?: unknown }).code;
    const errno = (node as { errno?: unknown }).errno;

    return code === 'ER_DUP_ENTRY' || errno === 1062;
  });

const coerceMysqlTimestamp = (iso: string): Date => new Date(iso);

export class DrizzleMysqlEventStorageAdapter implements EventStorageAdapter {
  private db: AnyMySqlDatabaseOrTx;
  private eventTable: MysqlEventTableContract;

  constructor({
    db,
    eventTable,
  }: {
    db: MySqlDatabase<any, any, any, any>;
    eventTable: MysqlEventTableContract;
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
      // mysql2 rejects raw ISO-8601 strings with a trailing `Z`, but accepts
      // a JS Date object. Local-timezone shifts applied by mysql2 on write
      // and read cancel out during the round-trip (see `toIsoString`).
      values.timestamp = new Date(timestamp);
    }

    return values;
  }

  private buildForceUpdateSet(
    event: OptionalTimestamp<EventDetail>,
  ): Record<string, unknown> {
    // MySQL `VALUES(col)` inside `ON DUPLICATE KEY UPDATE` references the
    // would-be-inserted value for `col`. The `new_row.col` alias form was
    // added in 8.0.20 but the `VALUES()` form still works through 8.x and
    // is more portable.
    const set: Record<string, unknown> = {
      type: sql`VALUES(${this.eventTable.type})`,
      payload: sql`VALUES(${this.eventTable.payload})`,
      metadata: sql`VALUES(${this.eventTable.metadata})`,
    };
    set.timestamp =
      event.timestamp !== undefined
        ? sql`VALUES(${this.eventTable.timestamp})`
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
    tx: AnyMySqlDatabaseOrTx,
    event: OptionalTimestamp<EventDetail>,
    options: PushEventOptions,
  ): Promise<{ event: EventDetail }> {
    const { aggregateId, version } = event;
    const values = this.buildInsertValues(options.eventStoreId, event);

    try {
      if (options.force === true) {
        await tx
          .insert(this.eventTable)
          .values(values)
          .onDuplicateKeyUpdate({ set: this.buildForceUpdateSet(event) });
      } else {
        await tx.insert(this.eventTable).values(values);
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

    // MySQL lacks RETURNING; re-SELECT the row by natural key to obtain the
    // fully populated row (including the server-generated timestamp). The
    // SELECT happens on the same `tx` as the INSERT, so within a
    // pushEventGroup call it's phantom-read-safe against concurrent writers.
    const rows = (await tx
      .select(this.selectColumns())
      .from(this.eventTable)
      .where(
        and(
          eq(this.eventTable.aggregateName, options.eventStoreId),
          eq(this.eventTable.aggregateId, aggregateId),
          eq(this.eventTable.version, version),
        ),
      )
      .limit(1)) as DrizzleEventRow[];

    const insertedEvent = rows[0];
    if (!insertedEvent) {
      throw new Error('Failed to retrieve inserted event');
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
    const { groupedEvents } = parseDrizzleMysqlGroupedEvents(
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

    // Two-query approach (matches the pg adapter — observationally identical
    // from the caller's perspective). MySQL 8 supports CTEs natively but the
    // two-query shape is easier to express in Drizzle without raw SQL and
    // produces byte-identical pageToken output.
    const baseFilters = buildBaseFilters({
      aggregateNameColumn: this.eventTable.aggregateName,
      versionColumn: this.eventTable.version,
      timestampColumn: this.eventTable.timestamp,
      eventStoreId: context.eventStoreId,
      initialEventAfter,
      initialEventBefore,
      coerceTimestamp: coerceMysqlTimestamp,
    });

    const cursorPredicate = buildCursorPredicate({
      aggregateIdColumn: this.eventTable.aggregateId,
      timestampColumn: this.eventTable.timestamp,
      lastEvaluatedKey,
      reverse: reverse === true,
      coerceTimestamp: coerceMysqlTimestamp,
    });

    const pageFilters = [
      ...baseFilters,
      ...(cursorPredicate !== undefined ? [cursorPredicate] : []),
    ];

    const countRows = (await this.db
      .select({ remaining: sql<number>`count(*)` })
      .from(this.eventTable)
      .where(and(...pageFilters))) as { remaining: unknown }[];
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
 * storage adapter is a `DrizzleMysqlEventStorageAdapter` (R13), plus the
 * context + timestamp-coherence checks shared across all dialects.
 *
 * Declared after the class so the `instanceof` check closes over the final
 * class reference (avoids TDZ hazards in the hoisted declaration).
 */
const parseDrizzleMysqlGroupedEvents = makeParseGroupedEvents(
  DrizzleMysqlEventStorageAdapter,
  'DrizzleMysqlEventStorageAdapter',
);
