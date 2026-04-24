---
date: 2026-04-19
topic: g01-transactional-outbox
origin: specs/requirements/2026-04-16-castore-es-gap-analysis-research.md
gap: G-01
---

# G-01 Transactional Outbox (Drizzle adapter)

> **Naming note.** "D1 profile" throughout this doc refers to the Castore gap-analysis deliverable's reference profile (D1 = greenfield finance product with N4 zero-event-loss + N1 GDPR constraints). This is **not** Cloudflare D1. Cloudflare D1 (the serverless SQLite service) is explicitly unsupported in v1 — see §3 Scope Boundaries.

## Problem Frame

Today `ConnectedEventStore.pushEvent` (`packages/core/src/connectedEventStore/connectedEventStore.ts:134`) performs two unrelated async operations back-to-back: the storage adapter writes the event row, then `publishPushedEvent` calls `messageChannel.publishMessage(...)` (e.g. EventBridge `PutEvents`). A process crash, Lambda timeout, EventBridge throttle, or transient network error between the commit and the publish drops the message on the floor with no framework-level retry or detection. In the D1 finance profile this violates the N4 zero-event-loss requirement — a committed `PaymentConfirmed` event can be lost to downstream projections while the database reads "settled", and the only recovery is manual operator intervention.

The same gap exists against every storage adapter in the repo, but this iteration is scoped to `@castore/event-storage-adapter-drizzle` (see `specs/requirements/2026-04-17-event-storage-adapter-drizzle-requirements.md`). Drizzle covers all three target dialects (PostgreSQL, MySQL, SQLite), it is the greenfield default, and `event-storage-adapter-postgres` has an explicit deprecation trigger (drizzle spec R21). Shipping the outbox on drizzle serves every greenfield adopter without doubling maintenance on the legacy adapter.

**G-01 before G-04 (brief rationale).** Gap analysis ranks G-04 (crypto-shredding, §G-04) as the single highest-risk gap. G-01 is sequenced first because (a) it is independent in the DAG — G-04 blocks on G-05 API, not on G-01 — so working G-01 first does not delay G-04; (b) G-01's correctness guarantee is foundational for every downstream consumer, including audit logs G-04 may later encrypt; (c) the drizzle adapter just shipped and its write path is the newest surface — revising it before more gaps land reduces later coordination cost. If OQ-5 (crypto-shredding spike) surfaces a blocking architectural constraint, the team re-opens this sequencing decision at the Phase 1 checkpoint gate (gap analysis §6.5).

**Pattern.** The outbox pattern fixes the dual-write gap by turning the adapter write + the bus publish into two phases separated by a durable commit: `pushEvent` atomically writes the event row and a row in a dedicated `outbox` table in one transaction, then returns. A separate relay worker claims unprocessed outbox rows, publishes them with at-least-once semantics, marks them processed, and exposes a failure surface for operators. The application contract for `pushEvent` loosens from "stored AND published" to "stored AND will eventually be published at-least-once" — an intentional, documented breaking change because the old contract was unsafe anyway.

**v1 vs v1.1 phasing (scope bounded).** The original gap-analysis effort estimate was L (~16 pd). To keep v1 near that estimate and respect the single-maintainer constraint (gap analysis R-11), v1 scope is deliberately bounded: no multi-channel fan-out, admin API limited to `retryRow`/`deleteRow`, lifecycle hooks limited to `onDead`+`onFail`, sweep documented via raw SQL (not exported), relay ships as a sub-entrypoint of the adapter package (not a second package). v1.1 candidates are listed in §7. This trim is deliberate; see Key Decisions for rationale.

**Out of scope (full list in §3).** Rewriting the legacy postgres adapter, other storage adapters (DynamoDB, HTTP, Redux, in-memory), DLQ tables, consumer-side dedup (G-03), Prometheus/OTel exporters, CDC / Debezium / logical replication, outer-transaction composition, Cloudflare D1 / neon-http / PlanetScale serverless.

---

## 1. Requirements

### 1.1 Package layout

- **R1.** The outbox lives inside `@castore/event-storage-adapter-drizzle` (no second package). Each dialect sub-entrypoint `@castore/event-storage-adapter-drizzle/<dialect>` (already exporting `eventColumns`, `eventTable`, `eventTableConstraints`) additionally exports `outboxColumns`, `outboxTable`, and **`outboxTableConstraints`** — the last following the existing `eventTableConstraints` pattern so users who spread `outboxColumns` into their own table get the required UNIQUE + index (R9) by construction. A new sub-entrypoint `@castore/event-storage-adapter-drizzle/relay` (dialect-agnostic) exports the relay factory. The relay imports from the dialect sub-entrypoints, not internal paths, so the repo's `@castore/*/*` ESLint rule is respected via the sub-path export layout. Separating into a dedicated package is a v1.1 candidate if the peer-dep graph grows incompatible with the adapter's.
- **R2.** Users spread `outboxColumns` + `outboxTableConstraints` into their own Drizzle table (custom name, extra columns, extra indexes) or pass `outboxTable` directly. Same contract as `eventColumns` (drizzle spec R8/R9): adapter owns names and types of columns it reads/writes; users may add columns (nullable or with DB defaults) and change the table name. Users run `drizzle-kit` in their own project to materialize the schema.
- **R3.** Adapter constructors gain an optional `outbox` option accepting the user's outbox table. When present, `pushEvent` and `pushEventGroup` insert event rows and outbox rows atomically inside a single Drizzle transaction. When absent, adapter behavior is unchanged (non-breaking extension of the adapter surface).
- **R4.** `@castore/core`, `drizzle-orm`, and each user-chosen message-bus adapter are `peerDependencies`. The relay sub-entrypoint pins no specific bus adapter; the user passes concrete channel instances at relay construction time.

### 1.2 Write-path semantics

- **R5.** `ConnectedEventStore.pushEvent(input, options)` in outbox mode resolves **immediately upon DB commit completion** — the transaction that persists both the event row and the outbox row. It does not wait for publish, and it does not wait for any `onEventPushed` hook registered on the underlying `EventStore`. This is a documented breaking change to the observable behavior of `pushEvent`. Tests and in-process "read-own-write" patterns are affected — see R29 for migration guidance.
- **R6.** In outbox mode, `ConnectedEventStore` skips the fire-and-forget `publishPushedEvent` call in both the `pushEvent` path (line 134) and the `onEventPushed` accessor (lines 162–173). The outbox-mode detection is performed **inside `publishPushedEvent` as its first action**, against `connectedEventStore.getEventStorageAdapter()`: on truthy `Symbol.for('castore.outbox-enabled')`, the function returns immediately without any bus call. This handles the mutable `eventStorageAdapter` setter (connectedEventStore.ts:146–154) per-invocation rather than at construction. `onEventPushed` hooks registered by application code still fire after the DB commit but do **not** trigger `publishPushedEvent` — the relay is the sole source of publishes. Hooks are application-side observers; they must not do blocking work, because `pushEvent` does not wait for them.
- **R7.** `pushEventGroup` in outbox mode writes N event rows and N outbox rows inside a single Drizzle transaction. Either all rows commit or none do. **There is no group-level semantic at the relay or bus level**: each outbox row is published independently, per-aggregate FIFO is preserved per-aggregate but the relay may publish aggregate A's row from the group while aggregate B's row from the same group is still queued (or goes dead). Consumers that need group-level atomicity observe partial-group state on the bus as part of the at-least-once contract — see R16, R22, §2 Success Criteria.
- **R8.** The outbox write path is not exposed through `EventStorageAdapter` interface changes in `@castore/core`. The drizzle adapter handles the insert internally when the `outbox` option is configured. Specifically, `ConnectedEventStore` detects outbox mode via a symbol-tagged capability marker on the adapter instance (`Symbol.for('castore.outbox-enabled')`, set to `true` by the drizzle adapter when the `outbox` option is present). **Adding a method to `EventStorageAdapter` in core is explicitly rejected** — it would ripple to every adapter in the repo.

### 1.3 Outbox row schema

- **R9.** The outbox row is pointer-shaped (no payload column). The relay reads the source event row at publish time via an adapter-internal single-row lookup helper (not exposed through the `EventStorageAdapter` core interface; see R10). Columns (names match the event-table convention in `eventColumns` — `aggregate_name` not `event_store_id`):
  - `id` — UUID PK, default `gen_random_uuid()` on pg / UUID expression on mysql / TEXT UUID on sqlite.
  - `aggregate_name` — matches `eventColumns.aggregateName` on the event table.
  - `aggregate_id` — matches `eventColumns.aggregateId`.
  - `version` — matches `eventColumns.version`.
  - `created_at` — timestamp of commit (DB-authoritative, e.g. `NOW()` / `CURRENT_TIMESTAMP` — never worker-generated).
  - `claim_token` (nullable) — worker ownership token; set when a relay worker claims the row. **Format:** cryptographically-random 128-bit value (e.g. `crypto.randomUUID()` or `crypto.randomBytes(16).toString('hex')`). Not sequential, not predictable. Acts as a **fencing token** for mark-processed / mark-dead UPDATEs (see R14) — not as a security boundary (the DB-level access control in R27 is the anti-impersonation control).
  - `claimed_at` (nullable) — timestamp of claim, DB-authoritative (see R13).
  - `processed_at` (nullable) — timestamp when the bus acknowledged the publish, DB-authoritative.
  - `attempts` (integer, default 0) — total publish attempts, including retries after reclaim.
  - `last_error` (nullable TEXT, max 2048 chars) — see R17.
  - `last_attempt_at` (nullable), DB-authoritative.
  - `dead_at` (nullable) — timestamp of transition to dead state, DB-authoritative.
  - **Unique constraint:** `(aggregate_name, aggregate_id, version)`. No `channel_id`; multi-channel fan-out is deferred to v1.1 (§7).
  - **Required index:** `(aggregate_name, aggregate_id, version)` for FIFO-exclusion queries (see R14); provisioned by `outboxTableConstraints` on all three dialects.
- **R10.** The drizzle adapter exposes a single-row event lookup for the relay, keyed by a capability symbol rather than by a core-interface method: `Symbol.for('castore.outbox.getEventByKey')` on the adapter instance, returning `(aggregate_name, aggregate_id, version) => Promise<EventDetail | undefined>`. This keeps `EventStorageAdapter` in `@castore/core` untouched (R8) and lets the relay sub-entrypoint stay dialect-agnostic (it duck-types on the symbol, not on concrete adapter classes). Naive `getEvents(aggregateId)` would be O(aggregate length) per publish — the symbol-keyed single-row lookup is O(index hit). **Nil-row behavior:** if the lookup returns `undefined` (source event deleted or shredded ahead of the relay), the relay immediately stamps `dead_at` on the outbox row with `last_error = 'source event row missing'`, fires `onDead`, and does NOT retry through `maxAttempts` backoff — the failure is permanent until `retryRow` or `deleteRow`. The nil-row path also preserves per-aggregate FIFO blocking (R16). For `StateCarryingMessage` channels, the relay additionally invokes `connectedEventStore.getAggregate(aggregateId, { maxVersion: version })` — this is unavoidably O(version) replay on every publish; users with high-version hot aggregates should use `NotificationMessage` channels in v1, or wait for G-02 snapshots. If aggregate reconstruction throws `EventDoesNotExistError` (shredded ancestor), the same nil-row dead-path applies.

### 1.4 Channel wiring

- **R11.** The relay is constructed with an explicit registry of `{ eventStoreId, connectedEventStore, channel }` entries. It looks up the right channel and the right `ConnectedEventStore` (for StateCarrying aggregate reconstruction) by the outbox row's `aggregate_name`. v1 assumes exactly one channel per event store. Multi-channel fan-out (several rows per event, each routed to a different channel) is deferred to v1.1; the schema will add `channel_id` at that time, which is a schema migration rather than a forward-compatible hook.
  **Registry validation (at relay construction):**
  - Reject (throw) a registry with duplicate `eventStoreId` entries — this guards against the "two `ConnectedEventStore` wrappers around the same base `EventStore`" pattern, which is unsupported in v1 outbox mode (see R29).
  - Assert that each entry's declared `eventStoreId` matches `connectedEventStore.eventStoreId` — catches misrouting misconfigurations where a registry entry is wired to the wrong store.
  **Missing-entry behavior at runtime:** if the relay claims an outbox row whose `aggregate_name` has no matching registry entry, the relay stamps `dead_at` with `last_error = 'no channel registered for aggregate_name=X'`, fires `onDead`. Operator fixes the registry and calls `retryRow`. FIFO-blocking applies per R16.

### 1.5 Ordering & FIFO

- **R12.** The relay preserves per-aggregate FIFO: events for the same `aggregate_id` are published strictly in ascending `version` order, across `pushEvent` and `pushEventGroup` alike. Cross-aggregate parallelism is allowed. Claim-coordination is dialect-specific and resolved in planning, constrained as follows:
  - **pg:** `pg_try_advisory_xact_lock(hashtext(aggregate_name || ':' || aggregate_id))` inside the claim transaction; lock auto-releases at transaction end (no session-scope leak risk).
  - **mysql:** the claim query MUST select only the **earliest unprocessed-or-expired row per aggregate** before applying `FOR UPDATE SKIP LOCKED` (e.g. `SELECT * FROM outbox o WHERE (aggregate_name, aggregate_id, version) IN (SELECT aggregate_name, aggregate_id, MIN(version) FROM outbox WHERE processed_at IS NULL AND dead_at IS NULL GROUP BY aggregate_name, aggregate_id) FOR UPDATE SKIP LOCKED`). A naive `FOR UPDATE SKIP LOCKED` on all eligible rows would hide a row another worker already holds, and the FIFO-exclusion predicate would mistakenly judge a newer-version row eligible → out-of-order publish race. `GET_LOCK` is not used because it is session-scoped (mysql2 pool leak risk). MySQL minimum supported version is 8.0.1.
  - **sqlite:** single-writer by construction; no explicit per-aggregate lock needed. Cross-aggregate parallelism is not achievable on sqlite — see §2 Success Criteria for the sqlite parallelism exemption.
  The claim transaction is **short-lived** on all dialects: `SELECT ... FOR UPDATE` (or advisory lock) → `UPDATE claim_token, claimed_at` → `COMMIT`. Publish happens **after** the transaction commits. TTL (R13) is the primary recovery mechanism for crash-between-commit-and-publish; holding a pool connection through the bus call would starve the pool.
- **R13.** Claim leases have a TTL. A claimed row whose `claimed_at` is older than `claimTimeoutMs` (relay construction option, default `60_000 ms`) is considered stale and eligible for re-claim by any worker. Re-claim generates a fresh `claim_token`, increments `attempts`, and stamps a new `claimed_at` (so a stuck worker does not grant unlimited free retries). **All timestamps (`claimed_at`, `processed_at`, `last_attempt_at`, `dead_at`) are DB-authoritative — set via the dialect's server-time function (`NOW()` on pg/mysql, `strftime('%s', 'now')` or equivalent on sqlite), never from worker wall-clock.** Worker clocks are not trusted across nodes; cross-worker TTL comparisons always use the DB's clock.
- **R14.** The claim-eligibility query must exclude any row whose `(aggregate_name, aggregate_id)` has an **earlier-version** row that is either unprocessed (still eligible or claimed) or dead. Planning commits to the concrete predicate shape; the requirement is that the row index from R9 makes this query cheap (target: no full scan of outbox on any dialect). A dead earlier-version row therefore blocks all newer rows for the same aggregate until the dead row is resolved — this preserves per-aggregate FIFO at the consumer.

  **Fencing-token rule (critical for correctness under TTL re-claim):** every `UPDATE` the relay performs on an outbox row after claim — mark-processed, mark-dead, increment-attempts — MUST include `WHERE claim_token = $currentToken` in its predicate. If a second worker re-claimed the row during a slow first-worker publish (TTL expired, R13), the re-claim UPDATE rotated `claim_token`. The original worker's follow-up UPDATE therefore no-ops, preventing the "slow-alive-worker double-publish" race — the second worker owns the row and will either succeed (mark processed) or fail (increment attempts → eventually dead). Without the fencing token, TTL-driven re-claim recreates the same double-send hazard that `retryRow` explicitly warns about in R20, but without operator intent.

### 1.6 Failure handling

- **R15.** On publish failure, the relay increments `attempts`, records `last_error` + `last_attempt_at`, releases the claim, and schedules a next attempt via exponential backoff: `min(baseMs * 2^(attempts-1), ceilingMs)` with ±25 % jitter. `baseMs`, `ceilingMs`, and `maxAttempts` are relay-construction options. Suggested defaults: `baseMs = 1_000`, `ceilingMs = 300_000`, `maxAttempts = 10`. Planning pins final numbers after an empirical drain test; these are starting points.
- **R16.** After `attempts >= maxAttempts` the row is stamped `dead_at`, `onDead` fires exactly once per **dead transition** (a retried-and-re-dead row fires `onDead` again for the new transition). A dead row blocks all newer unprocessed rows for the same `(aggregate_name, aggregate_id)` until resolved (see R17). `pushEvent` continues to commit successfully while an aggregate is blocked — the write-side is not throttled; the relay-side backlog is unbounded per aggregate in v1 (acknowledged in §3).
- **R17.** `last_error` is capped at 2048 chars and truncated (not rejected) on overflow. The adapter must not persist error strings that include event payload data — planning owns the scrubbing implementation (e.g. strip JSON fragments beyond a depth threshold) and documents it in the package README. `last_error` is within GDPR erasure scope: `deleteRow` removes it, and planning documents this as part of the erasure surface.

### 1.7 Relay lifecycle

- **R18.** The relay sub-entrypoint exports a factory returning an object with:
  - `runOnce()` — claim up to a configurable batch of eligible rows, publish each, mark processed or increment `attempts`. Resolves when the batch is drained. Intended for cron-driven invocations.
  - `runContinuously()` / `stop()` — supervised loop calling `runOnce()`, sleeping on empty (polling cadence default: 250 ms on pg/mysql, 1000 ms on sqlite). `stop()` supports graceful shutdown — in-flight publishes complete before the returned promise resolves.
  - `retryRow(rowId)` and `deleteRow(rowId)` — minimal admin API (§1.8).
  No built-in scheduler, no Lambda-specific wrapper in v1. The user wires their runtime; the package ships at least two documented recipes (R29).

- **R19.** Lifecycle hooks (v1 subset; rest in v1.1): `onDead({ row, lastError })` and `onFail({ row, error, attempts, nextBackoffMs })`. Both are async; exceptions thrown from a hook are logged and swallowed so a buggy hook cannot stall the relay. Hooks are observability primitives only — operators who need "ack this downstream system from a hook" must use application-level coordination, because a swallowed hook exception will not prevent the outbox from marking the row processed. `onClaim` and `onPublish` are v1.1 candidates — users who need per-publish tracing wrap `runOnce()` externally in the interim.

### 1.8 Admin API (minimal v1)

- **R20.** The relay object exposes exactly two admin methods in v1:
  - `retryRow(rowId)` — clears `attempts`, `last_error`, `last_attempt_at`, `dead_at`, `claim_token`, `claimed_at`; re-enqueues for the next `runOnce`. **Returns** `{ warning: 'at-most-once-not-guaranteed', rowId }` as a structured, machine-actionable return value so admin UIs can surface the duplicate-publish risk programmatically. API doc warning banner: "may re-publish an event that succeeded downstream but failed to mark processed (e.g., network partition between bus ack and DB update). Consumer deduplication (G-03) is not in v1 scope — see §3 Scope Boundaries."
  - `deleteRow(rowId)` — hard-deletes the outbox row. Used for GDPR erasure (§2) or operator cleanup. Deletion does not remove or modify the event row. If the row was blocking a dead-row FIFO wait for its aggregate, deletion unblocks newer rows on the next `runOnce`. **Two distinct caller contexts** share this method today (GDPR erasure path vs. operator cleanup path) — they have different authorization requirements at the caller layer (R21); v1 does not differentiate at the API. Adding an `onDelete` hook and/or a second erasure-specific method is a v1.1 candidate.
  `listDeadRows`, `listPendingRows`, and `forceDead` are deferred to v1.1. Operators can query the outbox table directly via SQL in the interim; the README documents the schema and gives template queries (R29).
- **R21.** Admin API authorization is a caller-side obligation. The package performs no authn/authz. The README must state this explicitly, with a recommendation that callers gate `retryRow` and `deleteRow` behind their own admin / operator controls (e.g., an internal admin UI with authenticated sessions, or an IAM-scoped Lambda that only admins can invoke). Callers are also responsible for emitting audit-log entries when these methods are invoked — the package does not do this. A v1.1 `onDelete` lifecycle hook is planned; until then, audit is purely caller-side.
  **Threat model acknowledgment:** a compromised relay worker with DB write access can set `processed_at` on outbox rows without ever calling the bus (silent event drop, N4 violation), and the R22 liveness query will NOT detect this (fraudulently-processed rows disappear from the age query). The DB-level access control in R27 (dedicated relay DB credentials, network restriction) is the primary control against this. v1 ships no in-band integrity check (e.g., row hash); that is a v1.1 candidate.

### 1.9 Silent-relay detection

- **R22.** The relay package documents supported liveness patterns. Operators query the outbox table for:
  - **Oldest unprocessed non-dead row** (liveness of the relay process): `SELECT min(created_at) FROM <outbox> WHERE processed_at IS NULL AND dead_at IS NULL` — alert on age > N minutes (N is a deployment choice).
  - **Per-aggregate backlog depth** (catches unbounded backlog before it becomes storage-exhaustion — see §3): `SELECT aggregate_name, aggregate_id, count(*) AS depth FROM <outbox> WHERE processed_at IS NULL GROUP BY aggregate_name, aggregate_id ORDER BY depth DESC LIMIT 20`. Alert on depth > M (M is a deployment choice; suggested starting point: 100).
  - **Dead row count per aggregate**: `SELECT aggregate_name, aggregate_id, count(*) FROM <outbox> WHERE dead_at IS NOT NULL GROUP BY aggregate_name, aggregate_id` — a non-zero row here means operator intervention pending.
  The docs (R29) ship template SQL per dialect. The relay does NOT detect the "fraudulently-marked-processed" case (R21); these queries detect the absence-of-publish case, not the false-publish case.
- **R23.** The relay package ships an explicit helper `assertOutboxEnabled(adapter)` the user calls at application start (not a side-effect of constructing the adapter). Behavior: inspects the adapter's `Symbol.for('castore.outbox-enabled')` capability; if falsy and `NODE_ENV === 'production'`, logs `console.warn` (default) or `throw`s (when constructed as `assertOutboxEnabled(adapter, { mode: 'throw' })`). This is an opt-in aid against the "I forgot to pass `outbox`" failure mode. D1 finance adopters should call it with `mode: 'throw'`; non-finance adopters using the drizzle adapter without outbox can skip it entirely. Escalating the default from `warn` to `throw` framework-wide is rejected (breaks non-finance users). The `mode` option gives finance teams a one-line declarative enforcement without writing a full factory wrapper.

### 1.10 Multi-dialect coverage

- **R24.** v1 ships outbox support for pg, mysql, sqlite via the drizzle adapter's existing per-dialect sub-entrypoints. "First-class" means all observable contracts in R5–R23 hold on all three dialects, with the sqlite parallelism exemption documented in §2 Success Criteria (no cross-aggregate parallelism on sqlite).
- **R25.** Supported drivers match drizzle spec R20: `drizzle-orm/node-postgres`, `drizzle-orm/postgres-js`, `drizzle-orm/mysql2` (MySQL 8.0.1+), `drizzle-orm/better-sqlite3`, `drizzle-orm/libsql` (local file / embedded). Non-transactional HTTP/serverless variants (Cloudflare D1, neon-http, PlanetScale serverless) are unsupported — same allow-list as the adapter.

### 1.11 Security & data protection

- **R26.** The outbox table is in the same encryption-at-rest scope as the event table. Classification rationale: `aggregate_id + aggregate_name + timestamps` is a financial-activity fingerprint for natural persons under GDPR when aggregate_id pseudonymizes a customer. Operators apply the same column-level / tablespace / disk-level encryption policy to the outbox table as they do to the event table. This is documented in R29.
- **R27.** Trust boundary to the message bus is a deployment concern, not a framework enforcement. Docs note: the relay worker's AWS credentials (or equivalent for other bus targets) are scoped to least-privilege (`events:PutEvents` for EventBridge per event store, `sqs:SendMessage` per queue, etc.); credential rotation is the deployer's responsibility. In shared-DB deployments the relay worker connects with dedicated DB credentials, not application credentials, and network-level access to the outbox table is restricted to relay worker hosts.

### 1.12 Testing

- **R28.** The drizzle conformance suite in `@castore/lib-test-tools` (drizzle spec R17) is extended with an outbox behavior suite running against all three dialects (`@testcontainers/postgresql`, `@testcontainers/mysql`, in-process sqlite via `better-sqlite3`). Coverage, at minimum:
  - Atomic commit on `pushEvent` and `pushEventGroup`; mid-group failure rolls back all outbox rows.
  - Per-aggregate FIFO under concurrent writers + concurrent relays (pg, mysql); sqlite: per-aggregate FIFO with single relay worker (§2 Success Criteria sqlite parallelism exemption).
  - Crash recovery: kill the relay worker between claim and mark-processed; second worker reclaims after `claimTimeoutMs`; every event is eventually published at-least-once.
  - Max-attempts → `dead_at` transition; `onDead` fires exactly once per transition; retried-then-re-dead fires `onDead` again.
  - Dead row blocks newer same-aggregate rows; `retryRow` unblocks on success; `deleteRow` unblocks on removal.
  - `last_error` length cap and payload-scrub behavior.
  - **Fencing-token correctness (R14)**: simulate a slow worker whose publish exceeds `claimTimeoutMs`; a second worker must re-claim, publish, and mark processed; the original worker's late mark-processed UPDATE must no-op (guarded by `WHERE claim_token = $originalToken`). Event is published exactly the right number of times for at-least-once, in order, without double-publish hazard.
  - **Nil-row (R10)**: simulate deletion/shredding of a source event row while the outbox row is unprocessed; the relay stamps `dead_at` immediately with `last_error = 'source event row missing'` and fires `onDead` exactly once; FIFO block on the aggregate engages.
  - **Registry validation (R11)**: relay constructor rejects duplicate `eventStoreId`; rejects `eventStoreId` mismatch between registry entry and `connectedEventStore.eventStoreId`; runtime missing-entry stamps `dead_at` with the expected `last_error`.
  - Fault-injection test: 100 `pushEvent` calls, kill relay at 30 % commit points (including post-claim before mark-processed), restart, assert no event is missed and per-aggregate order is preserved. (The exact 100 / 30 % numbers are guidance; planning may adjust to whatever the harness can reliably simulate. The load-bearing property is coverage of all three crash points: pre-claim, post-claim-pre-publish, post-publish-pre-mark-processed.)
  - Liveness queries (R22) correctly report age of oldest unprocessed row and per-aggregate backlog depth.

### 1.13 Migration & docs

- **R29.** Docs requirements (`docs/docs/`):
  - New "Transactional outbox" section under the Drizzle adapter page: dual-write problem, pattern, `pushEvent` semantic shift, minimal write-path setup, minimal relay setup, `retryRow`/`deleteRow`, liveness query templates per dialect (R22: age + backlog depth + dead count), PII / `last_error` notes, encryption-at-rest classification, IAM least-privilege note, operator runbook for dead-row resolution (including the GDPR-erasure-vs-blocked-aggregate playbook — see Scope Boundaries).
  - **At least two first-party runtime recipes** (not just sqlite example): a cron-triggered AWS Lambda invoking `runOnce()` on a 1-minute EventBridge schedule, and a long-running ECS/container service invoking `runContinuously()` with a `stop()` on SIGTERM. Recipes live under `demo/` or `packages/event-storage-adapter-drizzle/examples/`.
  - Migration note for callers: `pushEvent` no longer waits for publish in outbox mode. Affected patterns (explicit list):
    - **Integration tests** that assert post-push bus state → use `relay.runOnce()` between write and assertion.
    - **In-process CQRS read-model-after-write** → add a short `await` on the target projection or use optimistic UI.
    - **Operator runbooks** that assume "after API response, the bus has seen it" → rewrite to "after API response, the bus *will* see it".
    - **`onEventPushed` hook users doing real work** (in-process projection writes, cache invalidation, in-process dispatch) → the hook still fires after commit, but runs concurrently with `pushEvent`'s resolution; exceptions in the hook do NOT block `pushEvent` and do NOT prevent the outbox from publishing later. If the hook's side effect is load-bearing, move it to the application layer or wait for a consumer on the bus.
    - **Multi-`ConnectedEventStore` wrappers around one base `EventStore`** (used today to publish to multiple channels per store) → unsupported in v1 outbox mode; the relay registry routes exactly one channel per `eventStoreId`. Migration: either defer to v1.1 multi-channel fan-out, or run the second channel as a separate consumer subscribed to the first channel's bus.
  - No `waitForPublish(eventId)` primitive in v1; if a caller genuinely needs commit-AND-publish-as-one await, it is a v1.1 candidate.
- **R30.** The existing `ConnectedEventStore` behavior for adapters without an outbox (in-memory, postgres legacy, DynamoDB, HTTP, Redux) is unchanged. Users on those adapters continue to use the fire-and-forget publish path.
- **R31.** **Schema migration coordination.** The outbox table migration deploys **with or after** the event-table migration it references. During rolling deploys:
  - All writers run compatible adapter versions — mixed old/new adapter versions against the same outbox is unsupported (one writer would skip outbox insertion while another writes it).
  - Outbox columns reference event columns that already exist. The R10 single-row lookup MUST resolve against the current event-table shape.
  - If the event table gets a column rename or type change, the outbox schema's referenced columns follow in the same migration pass — never a subsequent pass.
  Planning owns the deploy-order playbook in R29 docs.

---

## 2. Success Criteria

Measurable, not narrative. If any item fails on any dialect, v1 is not shippable.

- **Zero-loss under induced failure:** the fault-injection test (R28) passes on pg, mysql, sqlite. Every committed event reaches the bus at-least-once, including under crash-before-claim, crash-between-claim-and-publish, and crash-between-publish-and-mark-processed.
- **Atomicity:** a deliberate mid-`pushEventGroup` failure rolls back the entire transaction including every already-written outbox row. No partial outbox state is observable under any test scenario.
- **Per-aggregate FIFO:** passes with two `runContinuously` relays on pg and mysql; cross-aggregate work parallelizes (wall-clock measurably better than serial). **On sqlite, the parallelism criterion is exempt:** per-aggregate FIFO holds with a single relay worker; running two concurrent relays against the same sqlite DB is not a supported configuration.
- **Claim TTL recovery:** a killed relay worker's claimed rows are reclaimed by a second worker within `claimTimeoutMs + polling cadence`. Reclaim increments `attempts`.
- **Group partial-visibility (acknowledged, not prevented):** a `pushEventGroup` writing events to aggregates A and B may land A's event on the bus while B's goes to `dead_at`. The test suite includes a scenario exercising this and asserting that `onDead` fires for B, the consumer sees A's event but not B's, and `retryRow(B)` + relay replay delivers B. This is the at-least-once contract for groups; consumers that need group atomicity must compensate.
- **Dead-row blocks aggregate:** a poisoned row at version K blocks publish of versions K+1..K+N for the same aggregate; `retryRow(K) → success` releases the block; `deleteRow(K)` releases the block.
- **Lifecycle hooks:** `onFail` fires on every failure, `onDead` fires exactly once per dead transition. Exceptions thrown from a hook are swallowed and logged.
- **`last_error` behavior:** strings exceeding 2048 chars are truncated; a test payload containing event-like JSON fragments is scrubbed before persistence per the planning-time scrubber design.
- **Admin ops:** `retryRow` warning is present in the API docs + README; `deleteRow` removes the row without touching the event. Both ops work cross-dialect.
- **Docs & examples:** new docs section live; at least two runtime recipes (Lambda + container) run without manual intervention; the sqlite greenfield example runs with `pnpm install && pnpm --filter <example> start` and publishes a notification via an in-memory bus.

---

## 3. Scope Boundaries

- **Only drizzle.** `event-storage-adapter-postgres`, DynamoDB, in-memory, HTTP, Redux adapters are untouched.
- **Only 3 dialects.** pg, mysql (8.0.1+), sqlite.
- **Opt-in, not default.** Outbox is enabled by passing `outbox: ...` on the drizzle adapter constructor. A production-only runtime warning (R23) mitigates the "forgot to pass outbox" failure mode but does not enforce it. Teams that require framework-enforced N4 must wrap the adapter in their own factory that mandates the option.
- **At-least-once without consumer dedup.** v1 ships at-least-once delivery. Consumer-side deduplication is G-03, a separate brainstorming cycle. **v1 is not safe for finance workloads without G-03 shipping (or an equivalent consumer-side dedup discipline).** Teams adopting v1 standalone must treat every bus message as potentially-duplicate and dedup by `(aggregate_name, aggregate_id, version)` in projection code. `retryRow` carries an explicit warning banner about this in both the API docs and the README.
- **Group partial-visibility on the bus.** `pushEventGroup` is DB-atomic but publishes per-event to the bus with per-aggregate FIFO only. Consumers observe partial-group state during the window between the first and last publish of a group, and permanent partial state if any row of the group goes dead. This is a known limit of v1; a group-correlation column is a v1.1 candidate.
- **Unbounded per-aggregate backlog.** A dead row blocks all newer rows for its aggregate indefinitely; `pushEvent` continues to commit regardless. This is a silent correctness failure mode if unmonitored — the write path looks healthy while the projection tier falls behind. Operators MUST monitor via R22 (both the age query AND the per-aggregate backlog-depth query) and act on `onDead` (R19). Bounded-backlog / circuit-breaker semantics (reject `pushEvent` when an aggregate has a dead row, or log elevated-severity warning) are v1.1 candidates; v1 ships with monitoring as the only guard.
- **GDPR erasure vs. dead-blocked aggregate.** If an aggregate has a dead outbox row and the same aggregate is subject to GDPR erasure, the erasure operator follows the playbook documented in R29: (1) `deleteRow(deadBlocker)` — accept that this specific bus publish is lost and the consumer never sees that event (compensate application-side if required); (2) let the relay drain the remaining aggregate rows or `deleteRow` them too if the entire aggregate is being erased; (3) shred or delete event rows last. Order matters — shredding first while the outbox still points at unprocessed rows produces a nil-row dead path (R10) but does not leak PII.
- **No multi-channel fan-out.** One channel per event store. Multi-channel is v1.1.
- **Minimal admin API.** Only `retryRow` + `deleteRow`. `listDeadRows`, `listPendingRows`, `forceDead` are v1.1.
- **Minimal hooks.** Only `onDead` + `onFail`. `onClaim`, `onPublish`, `onDelete` are v1.1.
- **No exported sweep API.** v1 documents raw SQL for cleanup; `sweepProcessed()` is v1.1 (with per-aggregate marker design resolved at that time).
- **No `waitForPublish` primitive.** If a caller needs commit-AND-publish-as-one await, it is an Outstanding Question for v1.1.
- **No built-in DLQ table.** Dead rows stay in the outbox with `dead_at` stamped; `onDead` hook is the integration surface for user-owned DLQ routing.
- **No first-party metrics exporter.** Hooks are the observability contract.
- **No group-level message semantics at the bus.** See above.
- **No CDC / Debezium / logical replication.**
- **No framework-enforced authz.** Caller gates admin API (R21).
- **Outer-transaction composition unsupported.** The outbox insert runs inside the adapter-owned transaction; a caller cannot wrap the adapter write in their own outer Drizzle transaction (same as drizzle spec R19).
- **Non-transactional Drizzle drivers unsupported.** Cloudflare D1 (not the same as "D1 finance profile"), neon-http, PlanetScale serverless.
- **Legacy postgres adapter gets no outbox in v1.** Migration path: adopt drizzle adapter first, then enable outbox.

---

## 4. Key Decisions

- **Scope-reduce aggressively to keep v1 near the L estimate.** Dropping `channel_id`, trimming admin API to 2 methods, trimming hooks to 2, deferring sweep export and second-package split together remove the most surface-area without losing the zero-loss core.
- **Outbox lives in the drizzle adapter as sub-entrypoints (not a separate package in v1).** Bus-agnosticism is preserved because the relay sub-entrypoint imports no bus adapter; users pass channel instances in. Splitting into `@castore/event-outbox-relay-drizzle` is a v1.1 option if the peer-dep graph diverges.
- **Pure-outbox `pushEvent` semantics.** Breaking change accepted; the old behavior never honored N4. Migration is mechanical for tests, modest for in-process CQRS patterns; no `waitForPublish` in v1 to avoid inventing an escape hatch before we know who needs it.
- **Pointer-shaped outbox rows.** Single source of truth; natural fit for G-04 shredding and G-05 upcasters; **the bus sees the event as it exists at publish time, not commit time** — operators must sweep processed rows before shredding / upcasting, or shredding must wait for the row to be processed.
- **Per-aggregate FIFO via dialect-native primitives.** Chose `pg_try_advisory_xact_lock` (transaction-scoped, no session leaks) on pg; `SELECT ... FOR UPDATE SKIP LOCKED` on mysql 8.0.1+ (avoids `GET_LOCK`'s session-scope pitfall with connection pools); sqlite serial by construction.
- **Dead-row blocks same-aggregate progress.** Silently advancing past a dead row would violate per-aggregate FIFO from the consumer's viewpoint. Dead rows are loud, visible, and require explicit operator action. Unbounded backlog is the acknowledged cost in v1.
- **Symbol-tagged outbox capability on the adapter.** Detected by `ConnectedEventStore` without modifying `EventStorageAdapter` in core. Adding a method on the core interface is rejected — it would ripple to every adapter in the repo and violates R8.
- **Library-with-`runOnce`, not daemon or Lambda-first.** Topology-neutral; ships two docs recipes (Lambda + container) so day-one adopters don't face a blank page.
- **Opt-in outbox, explicit scope acknowledgment that this leaves an N4 hole in non-compliant callers.** Framework-default outbox was considered; rejected because (a) the `ConnectedEventStore` construction path is already generic, (b) a runtime assertion (R23) + docs + factory-wrapping pattern cover the most common failure mode, (c) forcing outbox onto every adapter breaks non-finance users. Teams with hard N4 enforcement needs wrap the adapter in their own factory.
- **`retryRow` carries an explicit warning banner, not an implementation guard.** Without G-03 consumer dedup, operators accept double-send risk when they retry. Making this loud in the API docs + README is the honest contract for v1.
- **Admin API authorization is caller-side.** The package ships no authn/authz. Operators gate `retryRow` / `deleteRow` behind their own access control — documented, not enforced.
- **Encryption-at-rest classification.** Outbox rows carry pseudonymous fingerprints and fall in the same GDPR scope as the event table.

---

## 5. Alternatives Considered

- **Build outbox into `@castore/core`.** Rejected: makes core storage-aware; every adapter needs to implement or stub a new capability; in-memory adapter cannot implement real outbox. Outbox logic belongs in the storage-adapter-specific package.
- **Self-contained outbox rows with full message envelope.** Rejected: doubles payload storage; conflicts with G-04 (shredding must hit two tables); drift risk with G-05 upcasters.
- **Separate `@castore/event-outbox-relay-drizzle` package in v1.** Rejected for v1 (not forever): two packages triple the release / docs / peer-dep surface on a single-maintainer team. Revisited in v1.1 if the peer-dep graph diverges.
- **Multi-channel fan-out with a `channel_id` column in v1.** Rejected: no v1 consumer; complicates the unique constraint (NULL semantics across dialects); increases the claim-eligibility query surface. Adding `channel_id` later is a schema migration — acceptable cost.
- **Built-in DLQ table.** Rejected: breaks per-aggregate FIFO (the "advance past dead row" is exactly what R14 refuses). Loud failures + `onDead` are the more honest contract.
- **First-party error classifier in v1** (retry only on 5xx/network, permanent-fail on 4xx). Rejected: no production failure data yet; a bad classifier is worse than uniform retry. `onFail` lets users classify externally.
- **`waitForPublish(eventId)` primitive in v1.** Rejected: speculative; no concrete caller identified. Open as v1.1 Outstanding Question.
- **Daemon-only topology.** Rejected: Lambda users need `runOnce`. `runOnce + runContinuously` covers all three target topologies.
- **CDC via Debezium / logical replication.** Rejected: adds Kafka+Debezium operational category; overkill for single-Postgres greenfield.
- **Userland convention + helper library.** Rejected: G-01 is MUST for the D1 profile; "every team reinvents" is the failure mode this fixes.
- **Framework-default outbox on the drizzle adapter.** Rejected in v1; breaks non-finance users and forces all adopters to run a relay. Revisited if the runtime-warning pattern (R23) proves insufficient in practice.

---

## 6. Dependencies / Assumptions

- Drizzle adapter v1 has shipped with the three-dialect schema model (drizzle spec R8/R9/R22). Current branch `feat/event-storage-adapter-drizzle` has landed it (commits `2b3104e`, `e9dafb7`, `205baa9`).
- Message-bus adapters keep their current `publishMessage` surface. No change to bus adapter contracts.
- `ConnectedEventStore` can accept a small, backward-compatible outbox-detection mechanism (symbol capability tag — R8). This is an internal core change but does not alter `EventStorageAdapter`.
- Drizzle's transaction API is adequate on pg, mysql (8.0.1+), sqlite via the allow-listed drivers. Non-transactional drivers remain unsupported.
- Users run `drizzle-kit` in their own project to produce outbox migrations. No embedded migration runner.
- Users on the legacy postgres adapter have no claim on outbox support in v1; migration path is drizzle-first.
- Per-aggregate FIFO is enforceable with `pg_try_advisory_xact_lock` on pg and `SELECT ... FOR UPDATE SKIP LOCKED` on mysql 8.0.1+. Planning verifies Drizzle bindings can express these without raw SQL escapes, or commits to a raw-SQL path per dialect with conformance-suite coverage.
- In shared-DB deployments, relay workers connect with dedicated DB credentials; network-level access is restricted to relay hosts.
- Consumers of relay-delivered messages are expected to dedup by `(aggregate_name, aggregate_id, version)` until G-03 ships.

---

## 7. Outstanding Questions

### Resolve Before Planning

- **[Premise — affects §3, §6, success criteria] G-01 vs. G-03 sequencing given v1 does not close N4 alone.** §3 Scope Boundaries now explicitly states "v1 is not safe for finance workloads without G-03 shipping". The gap analysis originally sequenced G-01 first on the assumption it independently delivers N4 — the revised doc has made the G-01→G-03 coupling explicit. Options:
  (a) **Pull minimal G-03 consumer-dedup helper into this deliverable** (gap analysis estimated G-03 at M ≈ 6 pd; a single documented dedup pattern + test helper is smaller); co-ship → v1 closes N4 end-to-end.
  (b) **Restate G-01 v1 success criterion as "closes the write-side half of N4"** and explicitly ship v1 as not-finance-safe-alone, with G-03 as mandatory follow-up before any production traffic with N4 intent.
  (c) **Re-sequence**: ship G-03 first (it's smaller), then G-01 — delivers N4 sooner but delays the outbox.
  The team must pick before planning begins; currently the doc carries the contradiction that G-01 is the highest-priority N4 gap AND v1 does not achieve N4.
- **[§3] Dead-row unbounded backlog vs. silent correctness failure.** Decision needed: does v1 ship with monitoring-only (current posture) or add a minimal framework guard? Candidate minimal guards: (i) `pushEvent` logs elevated-severity warning when the target aggregate has a dead row; (ii) `pushEvent` throws `AggregateBlockedError` when a configurable per-aggregate dead-row count is exceeded; (iii) framework-default liveness alert threshold in the docs. Current text accepts option (null); (i) is nearly free; (ii) is a scope increment but closes the silent-failure mode for finance.

### Deferred to Planning

- **[§1.5 R12]** Concrete Drizzle binding expressions for `pg_try_advisory_xact_lock` and `FOR UPDATE SKIP LOCKED` without raw SQL escapes. If Drizzle can't express them, lock the raw-SQL path per dialect and exercise in R28.
- **[§1.5 R14]** Exact SQL shape for the per-aggregate claim-eligibility predicate that excludes rows blocked by earlier-version unprocessed/dead rows, and confirmation that the R9 index makes it cheap on each dialect.
- **[§1.6 R17]** Concrete scrubber implementation that strips event-like JSON fragments from `last_error` before persistence. Planning owns the pattern (regex-based, depth-limited parse, or a whitelist of known-safe error shapes per bus adapter).
- **[§1.7 R18]** Final numeric defaults for `baseMs`, `ceilingMs`, `maxAttempts`, `claimTimeoutMs`, polling cadence per dialect, after a brief empirical drain test (~10 k rows, single pg relay on the test harness).
- **[§1.9 R23]** Exact mechanism for the runtime bootstrap assertion — as a separate exported helper (`assertOutboxEnabled()`) the user calls at app start, or as an automatic side-effect of constructing the adapter without `outbox` in `NODE_ENV === 'production'`. Recommend the explicit helper (no hidden side effects).
- **[§1.11 R26]** Whether the README includes a worked example of column-level encryption on the outbox table (with `pgcrypto` on pg, for instance), or just states the classification without implementation guidance. Lean toward stating classification only; implementation is deployer-specific.
- **[§1.13 R29]** Whether the runtime recipe examples live under `demo/` or `packages/event-storage-adapter-drizzle/examples/`. `examples/` is closer to the package (consistent with drizzle's existing `examples/` directory) but less discoverable.
- **[Capability extension pattern]** `Symbol.for('castore.outbox-enabled')` and `Symbol.for('castore.outbox.getEventByKey')` establish a pattern for adapter-level capability signaling without touching `EventStorageAdapter` in core. G-02 (snapshots), G-03 (idempotent writes), G-04 (crypto-shredding) will each add similar capabilities. Planning should decide now whether to (a) document the symbol convention as JSDoc on `EventStorageAdapter` so future adapter authors discover it by reading the interface, (b) introduce a typed `capabilities?: { outbox?: OutboxCapability; ... }` optional field on the adapter interface before the second capability is added, or (c) continue case-by-case. Resolving after one capability is cheap; resolving after four is a migration.
- **[Three-dialect scope]** Does v1 ship all three dialects at first-class parity, or pg-first with mysql/sqlite following as v1.1? Single-maintainer context competes for pd against G-02/G-03/G-04. pg-first compresses v1, loses drizzle-adapter's multi-dialect selling point for a release cycle. Ship-all-three doubles the integration-test cost. Left open for planning to decide with the capacity data the team has.

### v1.1 Candidates (not this deliverable)

- Multi-channel fan-out with a `channel_id` column (schema migration).
- `listDeadRows` / `listPendingRows` / `forceDead` admin methods with pagination.
- `onClaim` / `onPublish` / `onDelete` lifecycle hooks.
- Exported `sweepProcessed(olderThan)` with per-aggregate last-swept marker for FIFO correctness.
- `waitForPublish(eventId, timeoutMs)` primitive for callers needing commit-AND-publish-as-one await.
- Bounded-backlog / circuit-breaker semantics (reject `pushEvent` if aggregate has > N dead-blocked pending rows).
- Split relay into `@castore/event-outbox-relay-drizzle` if peer-dep graph diverges.
- First-party error classifier (retry policy per error class).
- Group-correlation column and cross-aggregate group partial-visibility helpers.

---

## 8. Next Steps

-> `/ce:plan` for structured implementation planning.
