/* eslint-disable complexity */
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';
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
import { makeParseGroupedEvents } from '../common/parseGroupedEvents';
import { toIsoString } from '../common/toIsoString';
import { walkErrorCauses } from '../common/walkErrorCauses';
import type { MysqlEventTableContract } from './contract';

export type ParsedPageToken = {
  limit?: number;
  initialEventAfter?: string | undefined;
  initialEventBefore?: string | undefined;
  reverse?: boolean | undefined;
  lastEvaluatedKey?:
    | {
        aggregateId: string;
        initialEventTimestamp: string;
      }
    | undefined;
};

type MysqlEventRow = {
  aggregate_id: unknown;
  version: unknown;
  type: unknown;
  payload: unknown;
  metadata: unknown;
  timestamp: unknown;
};

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

  private toEventDetail(row: MysqlEventRow): EventDetail {
    const eventDetail = {
      aggregateId: row.aggregate_id as string,
      version: Number(row.version),
      type: row.type as string,
      payload: row.payload as unknown | null,
      metadata: row.metadata as unknown | null,
      timestamp: toIsoString(row.timestamp),
    };
    if (!eventDetail.payload) {
      delete (eventDetail as { payload?: unknown }).payload;
    }
    if (!eventDetail.metadata) {
      delete (eventDetail as { metadata?: unknown }).metadata;
    }

    return eventDetail as EventDetail;
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
      if (options.force) {
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
      .limit(1)) as MysqlEventRow[];

    const insertedEvent = rows[0];
    if (!insertedEvent) {
      throw new Error('Failed to retrieve inserted event');
    }

    return { event: this.toEventDetail(insertedEvent) };
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
    const filters = [
      eq(this.eventTable.aggregateName, context.eventStoreId),
      eq(this.eventTable.aggregateId, aggregateId),
    ];

    if (options?.minVersion !== undefined) {
      filters.push(sql`${this.eventTable.version} >= ${options.minVersion}`);
    }
    if (options?.maxVersion !== undefined) {
      filters.push(sql`${this.eventTable.version} <= ${options.maxVersion}`);
    }

    const order = options?.reverse
      ? desc(this.eventTable.version)
      : asc(this.eventTable.version);

    const baseQuery = this.db
      .select(this.selectColumns())
      .from(this.eventTable)
      .where(and(...filters))
      .orderBy(order);

    const query =
      options?.limit !== undefined ? baseQuery.limit(options.limit) : baseQuery;

    const rows = (await query) as MysqlEventRow[];

    return {
      events: rows.map(row => this.toEventDetail(row)),
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

  private parseInputs({
    inputOptions,
  }: {
    inputOptions: ListAggregateIdsOptions | undefined;
  }) {
    let pageTokenParsed: ParsedPageToken = {};

    if (typeof inputOptions?.pageToken === 'string') {
      try {
        pageTokenParsed = JSON.parse(inputOptions.pageToken) as ParsedPageToken;
      } catch (error) {
        console.error(error);
        throw new Error('Invalid page token');
      }
    }

    return {
      limit: pageTokenParsed.limit ?? inputOptions?.limit,
      initialEventAfter:
        pageTokenParsed.initialEventAfter ?? inputOptions?.initialEventAfter,
      initialEventBefore:
        pageTokenParsed.initialEventBefore ?? inputOptions?.initialEventBefore,
      reverse: pageTokenParsed.reverse ?? inputOptions?.reverse,
      lastEvaluatedKey: pageTokenParsed.lastEvaluatedKey,
    };
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
    } = this.parseInputs({ inputOptions: options });

    // Two-query approach (matches the pg adapter — observationally identical
    // from the caller's perspective). MySQL 8 supports CTEs natively but the
    // two-query shape is easier to express in Drizzle without raw SQL and
    // produces byte-identical pageToken output.
    const baseFilters = [
      eq(this.eventTable.aggregateName, context.eventStoreId),
      eq(this.eventTable.version, 1),
    ];
    if (initialEventAfter !== undefined) {
      baseFilters.push(
        gt(this.eventTable.timestamp, new Date(initialEventAfter)),
      );
    }
    if (initialEventBefore !== undefined) {
      baseFilters.push(
        lt(this.eventTable.timestamp, new Date(initialEventBefore)),
      );
    }

    const pageFilters = [...baseFilters];
    if (lastEvaluatedKey?.initialEventTimestamp !== undefined) {
      const cursor = new Date(lastEvaluatedKey.initialEventTimestamp);
      pageFilters.push(
        reverse
          ? lt(this.eventTable.timestamp, cursor)
          : gt(this.eventTable.timestamp, cursor),
      );
    }

    const countRows = (await this.db
      .select({ remaining: sql<number>`count(*)` })
      .from(this.eventTable)
      .where(and(...pageFilters))) as { remaining: unknown }[];
    const remainingCount = Number(countRows[0]?.remaining ?? 0);

    const order = reverse
      ? desc(this.eventTable.timestamp)
      : asc(this.eventTable.timestamp);

    const pageBase = this.db
      .select({
        aggregate_id: this.eventTable.aggregateId,
        timestamp: this.eventTable.timestamp,
      })
      .from(this.eventTable)
      .where(and(...pageFilters))
      .orderBy(order);

    const pageQuery = limit !== undefined ? pageBase.limit(limit) : pageBase;
    const pageRows = (await pageQuery) as {
      aggregate_id: unknown;
      timestamp: unknown;
    }[];

    const aggregateIds = pageRows.map(row => ({
      aggregateId: row.aggregate_id as string,
      initialEventTimestamp: toIsoString(row.timestamp),
    }));

    const hasNextPage = limit === undefined ? false : remainingCount > limit;

    const parsedNextPageToken: ParsedPageToken = {
      limit: options?.limit,
      initialEventAfter: options?.initialEventAfter,
      initialEventBefore: options?.initialEventBefore,
      reverse: options?.reverse,
      lastEvaluatedKey: aggregateIds.at(-1),
    };

    return {
      aggregateIds,
      ...(hasNextPage
        ? { nextPageToken: JSON.stringify(parsedNextPageToken) }
        : {}),
    };
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
