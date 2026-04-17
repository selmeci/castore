/* eslint-disable complexity */
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';
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
import type { PgEventTableContract } from './contract';

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

type DrizzlePgGroupedEvent = GroupedEvent & {
  eventStorageAdapter: DrizzlePgEventStorageAdapter;
};

const hasDrizzlePgAdapter = (
  groupedEvent: GroupedEvent,
): groupedEvent is DrizzlePgGroupedEvent =>
  groupedEvent.eventStorageAdapter instanceof DrizzlePgEventStorageAdapter;

const hasContext = (
  groupedEvent: GroupedEvent,
): groupedEvent is GroupedEvent & {
  context: NonNullable<GroupedEvent['context']>;
} => groupedEvent.context !== undefined;

/**
 * Port of the in-memory adapter's `parseGroupedEvents`:
 * - verifies every grouped event uses a DrizzlePgEventStorageAdapter
 * - verifies every grouped event carries `context`
 * - harmonizes timestamps across the group: any event without a timestamp
 *   inherits the group's shared timestamp; any mismatching timestamp throws
 */
const parseGroupedEvents = (
  ...groupedEventsInput: GroupedEvent[]
): {
  groupedEvents: (DrizzlePgGroupedEvent & {
    context: NonNullable<GroupedEvent['context']>;
  })[];
  timestamp?: string;
} => {
  let timestampInfos:
    | { timestamp: string; groupedEventIndex: number }
    | undefined;
  const groupedEvents: (DrizzlePgGroupedEvent & {
    context: NonNullable<GroupedEvent['context']>;
  })[] = [];

  groupedEventsInput.forEach((groupedEvent, groupedEventIndex) => {
    if (!hasDrizzlePgAdapter(groupedEvent)) {
      throw new Error(
        `Event group event #${groupedEventIndex} is not connected to a DrizzlePgEventStorageAdapter`,
      );
    }

    if (!hasContext(groupedEvent)) {
      throw new Error(`Event group event #${groupedEventIndex} misses context`);
    }

    if (
      groupedEvent.event.timestamp !== undefined &&
      timestampInfos === undefined
    ) {
      timestampInfos = {
        timestamp: groupedEvent.event.timestamp,
        groupedEventIndex,
      };
    }

    groupedEvents.push(
      groupedEvent as DrizzlePgGroupedEvent & {
        context: NonNullable<GroupedEvent['context']>;
      },
    );
  });

  if (timestampInfos !== undefined) {
    const _timestampInfos = timestampInfos;
    groupedEvents.forEach((groupedEvent, groupedEventIndex) => {
      if (groupedEvent.event.timestamp === undefined) {
        groupedEvent.event.timestamp = _timestampInfos.timestamp;
      } else if (groupedEvent.event.timestamp !== _timestampInfos.timestamp) {
        throw new Error(
          `Event group events #${groupedEventIndex} and #${_timestampInfos.groupedEventIndex} have different timestamps`,
        );
      }
    });
  }

  return {
    groupedEvents,
    ...(timestampInfos !== undefined
      ? { timestamp: timestampInfos.timestamp }
      : {}),
  };
};

type PgEventRow = {
  aggregate_name?: unknown;
  aggregate_id: unknown;
  version: unknown;
  type: unknown;
  payload: unknown;
  metadata: unknown;
  timestamp: unknown;
};

type AnyPgDatabaseOrTx = PgDatabase<any, any, any>;

const isDuplicateKeyError = (err: unknown): boolean => {
  // Walk the error and any `.cause` / `.sourceError` / `.originalError`
  // the driver may have placed the real pg error on. Drizzle 0.45 with
  // postgres-js and node-postgres both surface `.code === '23505'` directly
  // on the thrown object; the walk is defensive against driver upgrades
  // that may one day wrap the error on a `.cause` chain.
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (code === '23505') {
      return true;
    }
    current =
      (current as { cause?: unknown }).cause ??
      (current as { sourceError?: unknown }).sourceError ??
      (current as { originalError?: unknown }).originalError;
  }

  return false;
};

const toIsoString = (value: unknown): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    // Some driver configurations return a TIMESTAMPTZ as an already-formatted
    // string; normalise to ISO-8601.
    const asDate = new Date(value);
    if (!Number.isNaN(asDate.getTime())) {
      return asDate.toISOString();
    }

    return value;
  }
  throw new Error(`Unexpected timestamp value: ${String(value)}`);
};

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

  private toEventDetail(row: PgEventRow): EventDetail {
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

    let res: PgEventRow[];
    try {
      if (options.force) {
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
          .returning({
            aggregate_id: this.eventTable.aggregateId,
            version: this.eventTable.version,
            type: this.eventTable.type,
            payload: this.eventTable.payload,
            metadata: this.eventTable.metadata,
            timestamp: this.eventTable.timestamp,
          })) as PgEventRow[];
      } else {
        res = (await tx.insert(this.eventTable).values(values).returning({
          aggregate_id: this.eventTable.aggregateId,
          version: this.eventTable.version,
          type: this.eventTable.type,
          payload: this.eventTable.payload,
          metadata: this.eventTable.metadata,
          timestamp: this.eventTable.timestamp,
        })) as PgEventRow[];
      }
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new DrizzleEventAlreadyExistsError({
          eventStoreId: options.eventStoreId,
          aggregateId,
          version,
        });
      }
      throw err;
    }

    const insertedEvent = res[0];
    if (!insertedEvent) {
      throw new Error('Failed to insert event');
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

    const rows = (await query) as PgEventRow[];

    return {
      events: rows.map(row => this.toEventDetail(row)),
    };
  }

  async pushEventGroup(
    options: { force?: boolean },
    groupedEvent_0: GroupedEvent,
    ...rest: GroupedEvent[]
  ): Promise<{ eventGroup: { event: EventDetail }[] }> {
    const { groupedEvents } = parseGroupedEvents(groupedEvent_0, ...rest);

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

    // Two-query approach (see plan: CTE is optional for this dialect; two
    // queries are observationally identical from the caller's perspective and
    // cleaner to express in Drizzle without raw SQL).
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
      .select({ remaining: sql<number>`count(*)::int` })
      .from(this.eventTable)
      .where(and(...pageFilters))) as { remaining: number }[];
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
