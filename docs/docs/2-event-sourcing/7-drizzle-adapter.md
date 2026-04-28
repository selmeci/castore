---
sidebar_position: 7
---

# Drizzle Adapter & Outbox

The [`@castore/event-storage-adapter-drizzle`](https://www.npmjs.com/package/@castore/event-storage-adapter-drizzle) package provides `EventStorageAdapter` implementations for PostgreSQL, MySQL, and SQLite via [Drizzle ORM](https://orm.drizzle.team). This page covers the transactional outbox feature, which closes the N4 zero-event-loss gap for SQL-backed event stores.

## The dual-write problem

In a standard `ConnectedEventStore` setup, `pushEvent` writes the event to the database and then publishes it to the message bus as two separate operations. A crash, Lambda timeout, or network partition between the commit and the publish drops the message with no framework-level retry. For finance and other loss-sensitive workloads, this violates the N4 guarantee.

The outbox pattern solves this by turning the dual-write into two phases separated by a durable commit:

1. **Write phase:** `pushEvent` atomically inserts both the event row and an outbox row in a single database transaction.
2. **Publish phase:** A separate relay process drains the outbox table and publishes messages to the bus, with per-aggregate FIFO ordering, automatic retry, and dead-row surfacing.

## Minimal write-path setup

Enable outbox by passing an `outbox` table to the adapter constructor. You can use the prebuilt `outboxTable`, or spread both `outboxColumns` and `outboxTableConstraints` into your own table (the `outbox_aggregate_version_uq` constraint is load-bearing).

```ts
import { DrizzlePgEventStorageAdapter, eventTable, outboxTable } from '@castore/event-storage-adapter-drizzle/pg';

const adapter = new DrizzlePgEventStorageAdapter({
  db,
  eventTable,
  outbox: outboxTable, // enables outbox mode
});
```

When `outbox` is present, the adapter sets capability symbols on its instance. Core detects them inside `publishPushedEvent` and short-circuits the fire-and-forget publish path. The relay becomes the sole publisher.

### Schema migration coordination

Add the outbox table in the same migration as (or after) the event table. The outbox table carries a unique constraint `outbox_aggregate_version_uq` on `(aggregate_name, aggregate_id, version)` that enforces idempotency at the write side.

Recommended rollout order for an existing Drizzle deployment:

1. Add the outbox table via `drizzle-kit` migration.
2. Deploy writer processes with the `outbox` option passed to the adapter.
3. Deploy relay workers.
4. Validate liveness queries (see below).
5. Cut over downstream consumers to expect at-least-once delivery.

## Minimal relay setup

Import the relay factory and the dialect-specific claim primitive from the `./relay` sub-entrypoint:

```ts
import {
  createOutboxRelay,
  claimPg,
  assertOutboxEnabled,
} from '@castore/event-storage-adapter-drizzle/relay';

assertOutboxEnabled(adapter, { mode: 'throw' });

const relay = createOutboxRelay({
  dialect: 'pg',
  adapter,
  db,
  outboxTable,
  claim: claimPg,
  registry: [
    {
      eventStoreId: 'USERS',
      connectedEventStore: usersConnectedEventStore,
      channel: usersBus,
    },
  ],
  hooks: {
    onDead: ({ row, lastError }) => {
      // Wire to your alerting system
      console.error(`[outbox] dead row ${row.id}:`, lastError);
    },
    onFail: ({ row, attempts, nextBackoffMs }) => {
      console.warn(
        `[outbox] retry ${attempts} for ${row.id}, next in ${nextBackoffMs}ms`,
      );
    },
  },
});
```

**Run modes:**

- **`await relay.runOnce()`** — claim, publish, and mark one batch, then return. Ideal for cron-triggered Lambdas.
- **`await relay.runContinuously()`** — supervised loop that polls until `relay.stop()` is called. Ideal for long-running containers. Call `stop()` in your SIGTERM handler.

## Liveness queries

Monitor relay health with three DB-authoritative queries. PostgreSQL and MySQL use DB-side server time; for SQLite the `created_at` value is client-authored (the schema uses `.$defaultFn(() => new Date().toISOString())`), so age measurements can be skewed if writers and relays run on hosts with divergent clocks.

### Age (oldest unprocessed row)

```sql
-- PostgreSQL
SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) * 1000 AS age_ms
FROM castore_outbox
WHERE processed_at IS NULL AND dead_at IS NULL;

-- MySQL
SELECT TIMESTAMPDIFF(MICROSECOND, MIN(created_at), NOW(3)) / 1000 AS age_ms
FROM castore_outbox
WHERE processed_at IS NULL AND dead_at IS NULL;

-- SQLite (note: julianday('now') is DB-side, but created_at is client-generated ISO-8601 text)
SELECT CAST((julianday('now') - julianday(MIN(created_at))) * 86400000 AS INTEGER) AS age_ms
FROM castore_outbox
WHERE processed_at IS NULL AND dead_at IS NULL;
```

### Depth (unprocessed row count)

```sql
SELECT COUNT(*) AS depth
FROM castore_outbox
WHERE processed_at IS NULL AND dead_at IS NULL;
```

### Dead-count

```sql
SELECT COUNT(*) AS dead_count
FROM castore_outbox
WHERE dead_at IS NOT NULL;
```

## PII & `last_error`

Error messages persisted to the `last_error` column are automatically scrubbed before storage. JSON-like fragments are parsed to depth 3 and all leaf values replaced with `'<redacted>'`. Keys are preserved for shape debugging. This prevents accidental PII leakage from bus-level errors into the outbox table.

If a downstream service rejects a message and returns an error containing customer data, the relay stores only the structural shape, not the values.

## Encryption-at-rest classification

The outbox table stores pointer-shaped rows (no payload column). Payload data lives only in the event table, which inherits your existing encryption-at-rest policy. The `last_error` column may contain scrubbed string fragments — classify it at the same tier as application logs.

## IAM least-privilege note

Segregate DB roles between writers and relay workers:

```sql
-- Writer role (app processes that push events)
GRANT INSERT, UPDATE, SELECT ON castore_outbox TO writer_role;
GRANT INSERT, UPDATE, SELECT ON event TO writer_role;

-- Relay role (outbox relay workers only)
GRANT SELECT, UPDATE, DELETE ON castore_outbox TO relay_role;
GRANT SELECT ON event TO relay_role;
```

## Operator runbook

### Dead-row resolution

1. Query `dead_count` liveness query. If > 0, inspect `last_error`:
   ```sql
   SELECT id, aggregate_name, aggregate_id, version, last_error, attempts, dead_at
   FROM castore_outbox
   WHERE dead_at IS NOT NULL;
   ```
2. If the error is transient (network blip, downstream service unavailable), call `retryRow(id)`.
3. If the error is permanent (schema mismatch, missing registry entry, deleted aggregate), call `deleteRow(id)` to unblock newer versions of the same aggregate.

### GDPR erasure playbook

1. Do NOT delete the event row unless your legal team requires it — the event table is the source of truth.
2. Call `deleteRow(id)` on the outbox row only. This removes the pointer without touching the event.
3. If you must also erase the event, delete from the event table first, then `deleteRow` the outbox row. The relay's nil-row dead path will catch any race where the outbox row is claimed between the two deletes.

### `retryRow` hazard

`retryRow` defaults to rejecting with `RetryRowClaimedError` when the row has a non-null `claim_token` (a worker currently owns it). Passing `{ force: true }` clears the claim anyway, accepting a potential double-publish. Always prefer waiting for TTL reclaim over forcing.

## Known limits

- **v1 closes the write-side half of N4.** Consumer-side deduplication (G-03) is mandatory before any production traffic with N4 intent. The relay delivers at-least-once; duplicates are expected after crashes or TTL reclaims.
- **Unbounded backlog.** There is no framework-level guard that prevents `pushEvent` when the outbox depth exceeds a threshold. Use the liveness queries and wire your own alerting / circuit breaker.
- **Multi-wrapper unsupported.** One relay registry entry per `eventStoreId`. If you need multiple channels for the same store, that is a v1.1 candidate.
- **StateCarrying on hot aggregates.** Reconstructing aggregate state for every publish on a busy aggregate is expensive. Consider `NotificationMessageChannel` or the snapshot helper (G-02) for high-volume aggregates.
- **No built-in DLQ table.** Dead rows stay in the outbox table. Use `retryRow` or `deleteRow` to manage them.
- **No multi-channel fan-out.** One channel per `eventStoreId` in the registry.
