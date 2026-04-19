/**
 * Integration demo: a team with a pre-existing Drizzle schema adopts Castore.
 *
 * Plot:
 *   1. The app already has a `users` table defined in Drizzle, with drizzle-kit
 *      presumed to own its migrations. We materialize that table against a
 *      real Postgres testcontainer and insert one baseline user — simulating
 *      a pre-existing production DB.
 *   2. We add a NEW Drizzle table `app_events` that SPREADS `eventColumns`
 *      from `@castore/event-storage-adapter-drizzle/pg` and tacks on a
 *      user-owned `tenant_id` extra column. The user's drizzle-kit setup
 *      would normally generate + apply this migration; for the demo we
 *      hand-write the DDL (the adopt shape is what matters, not the CLI).
 *   3. We construct `DrizzlePgEventStorageAdapter({ db, eventTable: appEvents })`
 *      against the user-owned extended table.
 *   4. We wire an `EventStore` + `Command` (mirroring the `demo/blueprint`
 *      pattern) on top of the adapter.
 *   5. The command pushes events. We assert the events round-trip correctly
 *      AND that the pre-existing `users` table is still untouched (baseline
 *      row still present, still the only row).
 *
 * If you are adopting Castore on an existing Drizzle codebase, this file is
 * the shape to copy: your `users` schema stays put, you add an event table
 * that spreads `eventColumns`, and you construct the adapter against it.
 */
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { Command, EventStore, EventType, tuple } from '@castore/core';

import {
  DrizzlePgEventStorageAdapter,
  eventColumns,
  eventTableConstraints,
} from '../src/pg';

// ---------------------------------------------------------------------------
// 1. Pre-existing user-owned schema (imagine this file was in your repo long
//    before Castore showed up). Drizzle-kit owns these migrations in real life.
// ---------------------------------------------------------------------------
const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// 2. User-extended event table. This is the ONLY Castore-specific schema bit
//    the adopting team writes: spread `eventColumns`, pick a custom table
//    name, add their own columns (here: `tenant_id`), pass the
//    `eventTableConstraints` helper for the required unique index.
// ---------------------------------------------------------------------------
const appEvents = pgTable(
  'app_events',
  {
    ...eventColumns,
    tenantId: text('tenant_id'),
  },
  eventTableConstraints,
);

// ---------------------------------------------------------------------------
// 3. Castore event type + store + command — mirrors demo/blueprint patterns
//    but uses plain core primitives so the example has zero extra deps.
// ---------------------------------------------------------------------------
type UserAggregate = {
  aggregateId: string;
  version: number;
  email: string;
};

const userRegisteredEvent = new EventType<'USER_REGISTERED', { email: string }>(
  {
    type: 'USER_REGISTERED',
  },
);

// Construct the EventStore at module scope without an adapter — exactly how
// demo/blueprint does it. The adapter is attached in `beforeAll` once the
// testcontainer is up. In production you would assign the adapter once at
// module-load after your db client finishes constructing.
const usersEventStore = new EventStore({
  eventStoreId: 'USERS',
  eventTypes: [userRegisteredEvent],
  reducer: (_agg: UserAggregate, event): UserAggregate => ({
    aggregateId: event.aggregateId,
    version: event.version,
    email: event.payload.email,
  }),
});

const registerUserCommand = new Command({
  commandId: 'REGISTER_USER',
  requiredEventStores: tuple(usersEventStore),
  handler: async (input: { userId: string; email: string }, eventStores) => {
    const [store] = eventStores;
    await store.pushEvent({
      aggregateId: input.userId,
      version: 1,
      type: 'USER_REGISTERED',
      payload: { email: input.email },
    });

    return { userId: input.userId };
  },
});

// ---------------------------------------------------------------------------
// 4. The test itself — runs as part of the package's vitest suite.
// ---------------------------------------------------------------------------
describe('drizzle-integration example: adopt Castore on an existing Drizzle schema', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase;
  let adapter: DrizzlePgEventStorageAdapter;

  const baselineUserId = randomUUID();
  const baselineEmail = 'baseline@example.com';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15.3-alpine').start();
    client = postgres(container.getConnectionUri());
    db = drizzle(client);

    // In real adopter code: `drizzle-kit` apply handles all DDL. For this
    // self-contained demo we hand-roll the two tables — the value of the
    // demo is proving the SHAPES work end-to-end, not exercising the CLI.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS users (
        id          TEXT PRIMARY KEY,
        email       TEXT NOT NULL UNIQUE,
        created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      );
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS app_events (
        aggregate_name  TEXT NOT NULL,
        aggregate_id    TEXT NOT NULL,
        version         INTEGER NOT NULL,
        type            TEXT NOT NULL,
        payload         JSONB,
        metadata        JSONB,
        timestamp       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        tenant_id       TEXT,
        CONSTRAINT event_aggregate_version_uq
          UNIQUE (aggregate_name, aggregate_id, version)
      );
    `);

    // Pre-existing data the adopting team already has in production. We
    // assert below that Castore does NOT touch this row.
    await db.insert(users).values({ id: baselineUserId, email: baselineEmail });

    // Wire the adapter against the user-owned extended events table.
    adapter = new DrizzlePgEventStorageAdapter({
      db,
      eventTable: appEvents,
    });
    usersEventStore.eventStorageAdapter = adapter;
  }, 100_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  it('pushes events through an EventStore + Command and leaves pre-existing users intact', async () => {
    // Sanity: the pre-existing users table has exactly the one baseline row.
    const usersBefore = await db.select().from(users);
    expect(usersBefore).toHaveLength(1);
    expect(usersBefore[0]?.id).toBe(baselineUserId);
    expect(usersBefore[0]?.email).toBe(baselineEmail);

    // Execute the command. The command emits an event via the adapter; the
    // adapter writes into `app_events` (not `users`).
    const newUserId = randomUUID();
    const output = await registerUserCommand.handler(
      { userId: newUserId, email: 'new@example.com' },
      [usersEventStore],
    );
    expect(output).toStrictEqual({ userId: newUserId });

    // The event round-trips via getEvents.
    const { events } = await adapter.getEvents(newUserId, {
      eventStoreId: 'USERS',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      aggregateId: newUserId,
      version: 1,
      type: 'USER_REGISTERED',
      payload: { email: 'new@example.com' },
    });
    expect(typeof events[0]?.timestamp).toBe('string');

    // The aggregate reduces correctly through the full EventStore API.
    const { aggregate } = await usersEventStore.getAggregate(newUserId);
    expect(aggregate).toStrictEqual({
      aggregateId: newUserId,
      version: 1,
      email: 'new@example.com',
    });

    // The user-owned `tenant_id` extra column is preserved server-side and
    // untouched by the adapter (NULL because we didn't pass one).
    const raw = (await db.execute(
      sql`SELECT tenant_id FROM app_events WHERE aggregate_id = ${newUserId};`,
    )) as unknown as { tenant_id: unknown }[];
    const rows = Array.isArray(raw)
      ? raw
      : ((raw as { rows?: { tenant_id: unknown }[] }).rows ?? []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBeNull();

    // CRITICAL assertion: the pre-existing `users` table is untouched. The
    // baseline row is still the only row, still identical. Castore only
    // wrote to its own events table.
    const usersAfter = await db
      .select()
      .from(users)
      .where(eq(users.id, baselineUserId));
    expect(usersAfter).toHaveLength(1);
    expect(usersAfter[0]?.email).toBe(baselineEmail);

    const allUsers = await db.select().from(users);
    expect(allUsers).toHaveLength(1);
  });
});
