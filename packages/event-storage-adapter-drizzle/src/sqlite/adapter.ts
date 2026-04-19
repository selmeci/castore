import { and, sql } from 'drizzle-orm';
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
import type { SqliteEventTableContract } from './contract';

type AnySQLiteDatabaseOrTx = BaseSQLiteDatabase<
  'sync' | 'async',
  any,
  any,
  any
>;

// Only accept the extended SQLITE_CONSTRAINT_UNIQUE code. better-sqlite3
// sets it directly on the root `SqliteError`. libsql sets the generic
// parent `SQLITE_CONSTRAINT` on its top-level `LibsqlError` but places the
// specific code on `.cause` — `walkErrorCauses` traverses into it. Matching
// only the UNIQUE code avoids misclassifying NOT NULL / CHECK / FK
// violations on user-extended tables as EventAlreadyExistsError.
const isDuplicateKeyError = (err: unknown): boolean =>
  walkErrorCauses(
    err,
    node => (node as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE',
  );

// SQLite stores timestamps as fixed-width ISO-8601 strings, so lexicographic
// comparison matches chronological order — pass the ISO string directly.
// SQLite drivers reject `Date` instances as bind parameters.
const coerceSqliteTimestamp = (iso: string): string => iso;

export class DrizzleSqliteEventStorageAdapter implements EventStorageAdapter {
  private db: AnySQLiteDatabaseOrTx;
  private eventTable: SqliteEventTableContract;

  // Serializes `pushEventGroup` calls on this adapter instance. SQLite does
  // not nest transactions on a single shared handle, and this adapter wraps
  // the group in raw `BEGIN` / `COMMIT` statements on `this.db` — so two
  // overlapping callers would both enter `BEGIN` and corrupt transaction
  // state. pg/mysql do not need this: Drizzle's `db.transaction()` pulls a
  // dedicated connection from the pool per call. `.then(run, run)` chains
  // the next call regardless of the previous result, so a rejected prior
  // call never poisons later ones; `.catch` on the stored queue swallows
  // the rejection so the chain stays alive.
  private pushEventGroupQueue: Promise<unknown> = Promise.resolve();

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

  private buildForceUpdateSet(): Record<string, unknown> {
    // `excluded.<col>` (SQLite 3.35+) references the would-be-inserted value
    // for each column, including the schema's `$defaultFn`-generated
    // timestamp when the caller did not supply one. Using `excluded.*`
    // unconditionally keeps the update consistent with the insert's view
    // of the row — no application-space `new Date()` drift between force
    // updates in the same group.
    return {
      type: sql`excluded.type`,
      payload: sql`excluded.payload`,
      metadata: sql`excluded.metadata`,
      timestamp: sql`excluded.timestamp`,
    };
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
            set: this.buildForceUpdateSet(),
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
    const run = async (): Promise<{ eventGroup: { event: EventDetail }[] }> => {
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
          // Surface rollback failures to stderr so production triage can
          // spot a connection stuck mid-transaction. The original error is
          // still what the caller receives, but a failed ROLLBACK means
          // the `db` handle's transaction state is undefined — callers
          // should treat it as suspect and obtain a fresh connection.
          console.error(
            '[DrizzleSqliteEventStorageAdapter] ROLLBACK failed; connection state is undefined:',
            rollbackErr,
          );
        }
        throw err;
      }
    };

    const result = this.pushEventGroupQueue.then(run, run);
    this.pushEventGroupQueue = result.catch(() => undefined);

    return result;
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

    // Two-query approach (matches pg / mysql). SQLite stores timestamps as
    // fixed-width ISO-8601 strings, so lexicographic comparison matches
    // chronological order — pass the ISO string directly, no `new Date(...)`
    // (SQLite drivers reject `Date` instances as bind parameters).
    const baseFilters = buildBaseFilters({
      aggregateNameColumn: this.eventTable.aggregateName,
      versionColumn: this.eventTable.version,
      timestampColumn: this.eventTable.timestamp,
      eventStoreId: context.eventStoreId,
      initialEventAfter,
      initialEventBefore,
      coerceTimestamp: coerceSqliteTimestamp,
    });

    const cursorPredicate = buildCursorPredicate({
      aggregateIdColumn: this.eventTable.aggregateId,
      timestampColumn: this.eventTable.timestamp,
      lastEvaluatedKey,
      reverse: reverse === true,
      coerceTimestamp: coerceSqliteTimestamp,
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
