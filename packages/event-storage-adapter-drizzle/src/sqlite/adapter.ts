/* eslint-disable complexity */
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

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
import type { SqliteEventTableContract } from './contract';

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

type SqliteEventRow = {
  aggregate_id: unknown;
  version: unknown;
  type: unknown;
  payload: unknown;
  metadata: unknown;
  timestamp: unknown;
};

type AnySQLiteDatabaseOrTx = BaseSQLiteDatabase<
  'sync' | 'async',
  any,
  any,
  any
>;

// Both `better-sqlite3` and `@libsql/client` surface unique-constraint
// violations as errors whose `.code` is either `SQLITE_CONSTRAINT_UNIQUE`
// (the extended result code, present on the root `SqliteError` from
// better-sqlite3 and on libsql's `.cause`) or the parent `SQLITE_CONSTRAINT`
// (libsql's top-level `LibsqlError` uses this coarser code). The walk through
// `cause` / `sourceError` / `originalError` handles Drizzle's occasional
// `DrizzleQueryError` wrapping as well.
const isDuplicateKeyError = (err: unknown): boolean =>
  walkErrorCauses(err, node => {
    const code = (node as { code?: unknown }).code;

    return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT';
  });

export class DrizzleSqliteEventStorageAdapter implements EventStorageAdapter {
  private db: AnySQLiteDatabaseOrTx;
  private eventTable: SqliteEventTableContract;

  constructor({
    db,
    eventTable,
  }: {
    db: BaseSQLiteDatabase<'sync' | 'async', any, any, any>;
    eventTable: SqliteEventTableContract;
  }) {
    this.db = db;
    this.eventTable = eventTable;
  }

  private toEventDetail(row: SqliteEventRow): EventDetail {
    const eventDetail = {
      aggregateId: row.aggregate_id as string,
      version: Number(row.version),
      type: row.type as string,
      // `text(..., { mode: 'json' }).$type<unknown>()` makes Drizzle parse /
      // stringify JSON transparently, so `row.payload` / `row.metadata` are
      // already JS values here, not JSON strings.
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
      // Timestamp column is `text` with an ISO-8601 client-side default; pass
      // the caller's ISO string straight through. SQLite drivers reject `Date`
      // instances as bind parameters.
      values.timestamp = timestamp;
    }

    return values;
  }

  private buildForceUpdateSet(
    event: OptionalTimestamp<EventDetail>,
  ): Record<string, unknown> {
    // SQLite 3.35+ supports `INSERT ... ON CONFLICT ... DO UPDATE` with the
    // `excluded` pseudo-table. Both lowercase and uppercase are accepted by
    // SQLite's parser; we use lowercase because that's the form in the
    // official docs.
    const set: Record<string, unknown> = {
      type: sql`excluded.type`,
      payload: sql`excluded.payload`,
      metadata: sql`excluded.metadata`,
    };
    set.timestamp =
      event.timestamp !== undefined
        ? sql`excluded.timestamp`
        : sql`${new Date().toISOString()}`;

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
    tx: AnySQLiteDatabaseOrTx,
    event: OptionalTimestamp<EventDetail>,
    options: PushEventOptions,
  ): Promise<{ event: EventDetail }> {
    const { aggregateId, version } = event;
    const values = this.buildInsertValues(options.eventStoreId, event);

    let res: SqliteEventRow[];
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
          })) as SqliteEventRow[];
      } else {
        res = (await tx.insert(this.eventTable).values(values).returning({
          aggregate_id: this.eventTable.aggregateId,
          version: this.eventTable.version,
          type: this.eventTable.type,
          payload: this.eventTable.payload,
          metadata: this.eventTable.metadata,
          timestamp: this.eventTable.timestamp,
        })) as SqliteEventRow[];
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

    const rows = (await query) as SqliteEventRow[];

    return {
      events: rows.map(row => this.toEventDetail(row)),
    };
  }

  async pushEventGroup(
    options: { force?: boolean },
    groupedEvent_0: GroupedEvent,
    ...rest: GroupedEvent[]
  ): Promise<{ eventGroup: { event: EventDetail }[] }> {
    const { groupedEvents } = parseDrizzleSqliteGroupedEvents(
      groupedEvent_0,
      ...rest,
    );

    // Raw BEGIN/COMMIT/ROLLBACK issued through `db.run(sql\`...\`)` is the
    // portable way to wrap the group in a transaction: better-sqlite3's
    // `db.transaction()` is synchronous and rejects promise-returning
    // callbacks, while libsql's is async — but both drivers accept raw
    // transaction statements equally, and each grouped-event `pushEventInTx`
    // is itself async. `db.run()` returns the driver result directly on
    // better-sqlite3 (non-thenable) and a Promise on libsql; `await` is a
    // no-op on the former and resolves the latter.
    await this.db.run(sql`BEGIN`);
    try {
      const inner: { event: EventDetail }[] = [];
      for (const groupedEvent of groupedEvents) {
        const {
          eventStorageAdapter: groupedAdapter,
          event,
          context,
        } = groupedEvent;
        const response = await groupedAdapter.pushEventInTx(this.db, event, {
          eventStoreId: context.eventStoreId,
          force: options.force,
        });
        inner.push(response);
      }
      await this.db.run(sql`COMMIT`);

      return { eventGroup: inner };
    } catch (err) {
      try {
        await this.db.run(sql`ROLLBACK`);
      } catch (rollbackErr) {
        // Surface rollback failures to stderr so production triage can spot
        // a connection stuck mid-transaction. The original error is still
        // what the caller receives, but a failed ROLLBACK means the `db`
        // handle's transaction state is undefined — callers should treat
        // it as suspect and obtain a fresh connection.
        console.error(
          '[DrizzleSqliteEventStorageAdapter] ROLLBACK failed; connection state is undefined:',
          rollbackErr,
        );
      }
      throw err;
    }
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

    // Two-query approach (matches pg / mysql). SQLite stores timestamps as
    // fixed-width ISO-8601 strings, so lexicographic comparison matches
    // chronological order — pass the ISO string directly, no `new Date(...)`
    // (SQLite drivers reject `Date` instances as bind parameters).
    const baseFilters = [
      eq(this.eventTable.aggregateName, context.eventStoreId),
      eq(this.eventTable.version, 1),
    ];
    if (initialEventAfter !== undefined) {
      baseFilters.push(gt(this.eventTable.timestamp, initialEventAfter));
    }
    if (initialEventBefore !== undefined) {
      baseFilters.push(lt(this.eventTable.timestamp, initialEventBefore));
    }

    const pageFilters = [...baseFilters];
    if (lastEvaluatedKey?.initialEventTimestamp !== undefined) {
      const cursor = lastEvaluatedKey.initialEventTimestamp;
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
 * storage adapter is a `DrizzleSqliteEventStorageAdapter` (R13), plus the
 * context + timestamp-coherence checks shared across all dialects.
 *
 * Declared after the class so the `instanceof` check closes over the final
 * class reference (avoids TDZ hazards in the hoisted declaration).
 */
const parseDrizzleSqliteGroupedEvents = makeParseGroupedEvents(
  DrizzleSqliteEventStorageAdapter,
  'DrizzleSqliteEventStorageAdapter',
);
