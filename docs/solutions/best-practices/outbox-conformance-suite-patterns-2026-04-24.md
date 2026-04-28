---
title: "Transactional outbox cross-dialect conformance + fault-injection patterns"
date: 2026-04-24
category: best-practices
module: event-storage-adapter-drizzle
problem_type: best_practice
component: testing
severity: medium
applies_when:
  - "Writing cross-dialect conformance tests for a multi-dialect SQL adapter with shared behavioral contract"
  - "Injecting deterministic faults into an outbox / queue / message-relay system to prove at-least-once semantics"
  - "Simulating crash-between-claim-and-publish recovery without killing a Node process"
  - "Introspecting dialect-specific unique-constraint metadata for schema-contract assertions"
tags:
  - drizzle-orm
  - transactional-outbox
  - conformance-suite
  - fault-injection
  - cross-dialect-testing
  - fencing-token
  - at-least-once
---

# Transactional outbox conformance + fault-injection patterns

## Context

This note captures cross-dialect testing patterns that shipped with G-01
(transactional outbox) in `@castore/event-storage-adapter-drizzle`, covering
~25 conformance scenarios and 4 fault-injection scenarios that run
byte-identically against pg, mysql, and sqlite. The underlying decisions —
fencing-token predicate, DB-authoritative timestamps, per-aggregate FIFO
primitives — are documented in the G-01 parent plan; this note is about the
testing patterns used to prove them.

## Patterns

### 1. Setup contract is a dialect-agnostic object, not a base class

The conformance factory (`makeOutboxConformanceSuite`) and fault-injection
factory (`makeOutboxFaultInjectionSuite`) both accept the same
`{ adapter, db, outboxTable, connectedEventStore, channel, claim, reset,
backdateClaimedAt, uniqueConstraintExists, deleteEventRow }` setup closure.
Per-dialect test files extract the setup once and pass the same binding to
both factories. This keeps dialect-specific SQL (TTL backdating, DDL
introspection, raw event-row deletion for the nil-row dead path) out of the
factory bodies and lets each factory stay dialect-parametric.

### 2. Simulate crash-between-claim-and-publish via direct `claim()` call

The parent plan sketched the fault-injection harness as "drop relay
references, let GC claim, create fresh relay." In practice, calling the
bound `claim()` closure directly — with a specific `workerClaimToken` —
puts a row into the exact `claim_token + claimed_at` state that a "crashed
relay" would leave behind. No process kill, no timer mocking, no reference
tracking. Pair with `backdateClaimedAt()` to fast-forward past TTL so a
fresh relay can reclaim.

This is not a perfect simulation — it skips any in-flight publish that
"kind of happened before the crash" — but it's sufficient for proving
TTL-reclaim + FIFO + bounded-duplicate invariants. The dropped-reference
approach in the parent plan would add Node-GC non-determinism that hurts
test stability without improving coverage.

### 3. DB-authoritative time makes `vi.useFakeTimers()` useless

`claimed_at`, `processed_at`, and `dead_at` are stamped by `dialectNow()`
— `NOW()` on pg, `NOW(3)` on mysql, `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
on sqlite. Advancing Node's clock does not travel into the DB. The only way
to simulate TTL advancement in a conformance test is a manual
`UPDATE outbox SET claimed_at = …` against the real DB with a dialect-
specific backdate expression. This is the `backdateClaimedAt` helper every
per-dialect setup provides.

### 4. SQLite doesn't preserve CONSTRAINT names through PRAGMA

A declared `CONSTRAINT outbox_aggregate_version_uq UNIQUE (…)` surfaces
through `PRAGMA index_list` as an auto-named index (`sqlite_autoindex_*`)
with `unique=1`. To verify the constraint exists, walk `index_list` and
call `PRAGMA index_info(<index>)` for each `unique=1` row, then check
that the column set matches. pg (via `pg_constraint.conname`) and mysql
(via `SHOW INDEX WHERE Key_name = 'outbox_aggregate_version_uq'`) DO
preserve names and can match directly.

### 5. Fencing-token assertions check row counts, not end-state

The load-bearing invariant is "stale worker's mark-processed no-ops."
Proving this requires asserting `fencedUpdate()` returns `0` for the stale
token AND `1` for the fresh token, on the same row, in the same test.
Checking `row.processed_at != null` alone is insufficient — both workers
could have stamped it, and the end state would still pass a naive
assertion. Always assert the affected-row count from `fencedUpdate()`
directly, not just the resulting row shape.

### 6. Per-dialect timestamp drivers reject JS ISO strings

Pg `timestamptz` and mysql `datetime(3)` (with `mode: 'string'`) reject
a JS `new Date().toISOString()` value wholesale (`ER_TRUNCATED_WRONG_VALUE`
on mysql, driver-level rejection on pg). Use `dialectNow()` as a SQL
fragment in `.set({ processedAt: dialectNow(dialect), … })` — never
substitute a JS string for a server-time column.

## Ratified defaults

The U9 + U10 suites ran against these production defaults unchanged:

| Knob             | Value       | Rationale |
|------------------|-------------|-----------|
| `baseMs`         | 250ms       | First backoff — small enough that transient failures clear quickly |
| `ceilingMs`      | 60,000ms    | Max backoff — prevents runaway waits |
| `maxAttempts`    | 10          | Survives a short bus outage; caps blast radius |
| `claimTimeoutMs` | 300,000ms   | 5 min — long enough for a deployment rollover |
| `publishTimeoutMs` | 150,000ms | 2.5 min — half of `claimTimeoutMs` so fencing has a full half-window of slack |
| `pollingMs`      | 250ms       | Fast polling when the queue is empty |
| `batchSize`      | 50          | Bounded claim footprint per iteration |

No adjustment required — every conformance and fault-injection scenario
passes against these values across pg + mysql + sqlite.

### Empirical drain — OQ1

The G-01 sub-plan's OQ1 asked for a one-off drain measurement against a
single pg relay with a no-op bus to either ratify the table above or
adjust within the parent R15/R18/R14 envelope. Closing the OQ ratifies
the table — every percentile sits well inside the envelope.

Harness: the `it.skip(...)` benchmark at
`packages/event-storage-adapter-drizzle/src/pg/adapter.unit.test.ts`
under `describe('drizzle pg outbox relay — numeric defaults drain
benchmark (OQ1, manual)', …)`. Seeds 10,000 outbox rows × 100
aggregates, mocks `channel.publishMessage` to resolve immediately,
drains under default relay options, and reports inter-publish gap
percentiles as the per-row turnaround proxy.

Captured run (postgres 15.3-alpine testcontainer, postgres-js, default
pool, single relay):

| Metric                       | Value                  |
|------------------------------|------------------------|
| Total rows                   | 10,000                 |
| Seed wallclock               | ~6.2s                  |
| Drain wallclock              | ~56.8s                 |
| Throughput                   | ~176 rows/sec          |
| Drain iterations (`runOnce`) | 213                    |
| Per-row turnaround p50       | 6.29ms                 |
| Per-row turnaround p95       | 7.69ms                 |
| Per-row turnaround p99       | 19.39ms                |

The p99 (19.39ms) is roughly four orders of magnitude below
`publishTimeoutMs` (150,000ms) — the SQL-only path leaves the entire
publish-window budget for the bus side of the world. `claimTimeoutMs`
(300,000ms) likewise has more than enough headroom for the
batch-of-50 claim → publish → mark cycle observed here, and `baseMs` /
`ceilingMs` only enter the picture when publishes fail (they did not,
by construction, in this run). The benchmark stays committed as
`it.skip(...)` so this measurement can be re-taken on demand without
adding pg-testcontainer load to CI.

## pg advisory-lock collision behavior — OQ2

The G-01 sub-plan's OQ2 asked for an empirical advisory-lock collision
measurement. Closing the OQ as a write-up — the collision model is
already pinned by an in-tree test, and an empirical-rate harness at
N>2 is itself deferred (see "Out of scope" below).

### Lock-id derivation

`packages/event-storage-adapter-drizzle/src/pg/outbox/claim.ts:75-78`
constructs the advisory lock as:

```sql
pg_try_advisory_xact_lock(
  hashtext(aggregate_name || ':' || aggregate_id)
)
```

The single-argument form takes a 32-bit integer key. Two aggregates
hash to the same key only when `hashtext('A:1') == hashtext('B:7')`
— a textbook 32-bit hash collision, expected at ~50% probability
around √(2³²) ≈ 65,536 distinct aggregates by birthday-paradox math
but vanishingly small at the per-claim-batch scale (`batchSize: 50`)
the relay actually runs at.

The lock is transaction-scoped (`_xact_`), so it releases on COMMIT
or ROLLBACK with no session-state leak. No explicit `pg_advisory_unlock`
call is needed and there is no path that holds the lock across `runOnce`
boundaries.

### Two collision modes (correctness vs. throughput)

| Mode | What collides | Relay impact | Tested by |
|---|---|---|---|
| **Same-aggregate, N concurrent claimers** (correctness-load-bearing) | The `try_advisory_xact_lock` call against the same `(name, id)` from N transactions in flight at once. Exactly one tx acquires; N-1 see the predicate fail, the row is filtered out of their candidate set, the UPDATE returns 0 rows. | Per-aggregate FIFO is preserved. The "loser" simply claims nothing for that aggregate this round; it picks up next pollingMs tick. | `pg/outbox/claim.unit.test.ts:199-233` ("two concurrent claims against the same aggregate are serialized") proves the N=2 case: `firstCount + secondCount === 1`, winner gets v1 only, loser gets nothing. |
| **Different-aggregate, hashtext-bucket collision** (throughput-only) | Two aggregates whose `hashtext(name||':'||id)` happens to coincide on the 32-bit space. While one holds the advisory lock, the other's `try_advisory_xact_lock` returns false even though the rows are independent. | One aggregate's claim attempt no-ops this round and tries again next pollingMs tick. No correctness impact — the per-aggregate FIFO subquery already handles ordering, and the "missed" aggregate stays eligible. | Not exercised in unit tests because it is a probabilistic-throughput knob, not an invariant. The relay-source comment at `pg/outbox/claim.ts:36-40` explicitly classifies this as a "throughput cost, never a correctness cost". |

The single in-tree test at N=2 is the load-bearing proof: it shows
exactly-one-winner under same-aggregate contention. By the same lock
semantics, scaling to N concurrent same-aggregate claimers gives the
expected per-attempt collision rate of `(N-1)/N` for that aggregate's
contenders, with throughput recovered on the next tick. No new test
or measurement was required to close OQ2 against the success-criteria
bar set by parent §2.

### Out of scope

A bespoke pg-only stress harness measuring per-tick `try_advisory_xact_lock`
return-value rates at N=4, N=8, N=16 against M same-aggregate rows
would produce empirical numbers — but it adds new flake surface (real
concurrency timing, container CPU contention) without raising the bar
on any §2 success criterion. Treat that as a future exercise if a
production incident motivates it; do not block G-01 closeout on it.

## mysql vs pg fault-injection divergence — OQ3

The G-01 sub-plan's OQ3 asked for a "deferred-to-implementation
findings" subsection capturing any pass/fail or timing/error-shape
divergence between the two server dialects in the U10 fault-injection
suite. Source of truth: the existing scenarios in
`packages/event-storage-adapter-drizzle/src/__tests__/outboxFaultInjection.ts`
and the fault-injection-tagged commits on this branch (`git log
--grep "fault-injection"`: `364daf1`, `19b3404`, `5dd4bb2`,
`99d12f9`, `e96ef02`).

### Top-line: zero pass/fail divergence

Each of the four fault-injection scenarios passes byte-identically on
pg + mysql + sqlite (with the sqlite carve-out, see below):

| Scenario | What it proves | Dialect parity |
|---|---|---|
| crash post-claim-pre-publish (3 sub-cases: orphaned, mid-`handleFailure`, post-`publishTimeoutMs` pre-retry) | TTL reclaim recovers every claim-orphaned row; total publishes ≤ `maxAttempts + 1` | identical |
| `maxAttempts` exhaustion (100% failure) | Every row → `dead_at`; `onDead` once/row; `onFail` `(maxAttempts-1)` × row | identical |
| FIFO preserved under crash+recover (per-aggregate v1..v3) | Bus receives `[1, 2, 3]` even with a mid-aggregate crash on v1 | identical |
| No stuck rows under mixed workload (100 × 10) | Every row is `processed_at` OR `dead_at`; per-aggregate bus FIFO monotonically non-decreasing | identical |

The factory-shaped suite (`makeOutboxFaultInjectionSuite`) takes one
dialect-agnostic setup contract and runs every scenario uniformly — no
dialect-conditional `it.skip` exists in the suite body. That is the
primary OQ3 finding: U10 didn't fork along dialect lines.

### Implementation-level divergences (relay layer absorbs them)

The dialects DO differ at the relay's mechanism layer; the test surface
is uniform because the relay normalises across them. Captured here so
future debugging of an actual pass/fail divergence has the right
mental model:

| Concern | pg | mysql | sqlite |
|---|---|---|---|
| **Claim primitive** | `pg_try_advisory_xact_lock(hashtext(name\|\|':'\|\|id))` predicate inside the SELECT (`pg/outbox/claim.ts:75`); winner does `UPDATE ... RETURNING` in one round-trip. | Earliest-per-aggregate subquery `(name, id, MIN(version))` + `FOR UPDATE SKIP LOCKED` raw fragment (`mysql/outbox/claim.ts`); two-step SELECT ids → UPDATE because mysql lacks `RETURNING`. | Single-writer transaction; no concurrent-claim contention by construction. |
| **fencedUpdate result-shape** | `.returning({id})` → `rows.length` (`common/outbox/fencedUpdate.ts:69`). | `extractMysqlAffectedRows` parses `[ResultSetHeader, FieldPacket[]]` from `mysql2`; throws `NonRetriableRelayError` if neither tuple-shape nor header-direct-shape matches (`fencedUpdate.ts:116-134`). The supervisor classifier uses that error class to abort `runContinuously` instead of looping on a deterministic driver-shape regression. | `.returning()` like pg; no shape-detection branch. |
| **dialectNow precision** | `NOW()` — timestamptz, microseconds. | `NOW(3)` — datetime(3), milliseconds. | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` — ISO string, milliseconds. |
| **Driver lock-error surface** (not actually exercised in U10) | Advisory-lock contention surfaces as `false` from `pg_try_advisory_xact_lock` — never as an exception. Serialisation failure (`40001`) and deadlock (`40P01`) do not arise here because `claimPg` runs at READ COMMITTED. | `FOR UPDATE` contention can surface as `ER_LOCK_WAIT_TIMEOUT` (1205) past `innodb_lock_wait_timeout`, but `SKIP LOCKED` short-circuits — locked rows are filtered out, no exception raised. `ER_LOCK_DEADLOCK` (1213) is theoretically possible on circular waits and would propagate as a driver error if it happened. | n/a — single writer. |
| **`DrizzleQueryError` wrapping (parent R13)** | `postgres-js` raw errors bubble up; drizzle wraps some paths (`drizzle.execute(sql\`…\`)` errors) but not all. | `mysql2` raw errors with `code: 'ER_*'` + numeric `errno`; drizzle wraps similarly to pg. | `better-sqlite3` raw errors. |

U10's assertions key off the relay's typed error surface
(`OutboxPublishTimeoutError`, `OutboxRowNotFoundError`,
`RetryRowClaimedError`, `NonRetriableRelayError`) rather than driver
error classes or message strings. That's why dialect-specific lock-
error wrapping doesn't cause test divergence — the relay translates
every meaningful failure into a typed class before the test sees it.

### sqlite carve-out

`makeOutboxFaultInjectionSuite`'s docstring explicitly carves sqlite
out of two-concurrent-relay and cross-aggregate-parallelism scenarios
per parent §2 — sqlite's single-writer model would force sequential
execution and the scenarios would prove nothing about real
concurrency. The crash-simulation scenarios (which build the post-
crash state directly via `ctx.claim()` + `backdateClaimedAt` rather
than through real concurrency) DO run on sqlite, because they only
depend on the row state-machine transitions, not on parallel workers.

### Timing tolerance — mysql is the long pole

Commit `99d12f9` documents the suite-runtime tuning: the mixed-
workload scenario was given a 30-second test timeout because mysql
solo run is ~3s and full-suite ~5s. pg is comparable; sqlite is
fastest. The 30s envelope covers all three with margin and is the
only timing knob that needed dialect-aware sizing.

### Out of scope

A bespoke fault-injection-divergence stress harness (e.g. running
the same scenario at 10× the row count specifically to expose any
mysql-only timing regressions) was not built — every scenario already
passes within the 30s envelope. Re-open if a production incident
reveals a dialect-specific failure that the existing assertions miss.

## Related learnings

- `docs/solutions/integration-issues/drizzle-orm-api-gaps-multi-dialect-adapter-2026-04-18.md` — mysql's UPDATE-lacks-`.returning()` gotcha; shapes how `fencedUpdate` extracts affected-row counts per dialect.
- `docs/solutions/best-practices/multi-dialect-adapter-package-patterns-2026-04-18.md` — shared conformance factory pattern; container lifecycle owned by per-dialect file. This note extends that pattern to the outbox relay's factory.
