---
date: 2026-04-28
topic: g02-snapshots-drizzle
origin: specs/requirements/2026-04-16-castore-es-gap-analysis-research.md
gap: G-02
---

# G-02 Snapshots (Drizzle adapter)

## Problem Frame

`EventStore.getAggregate` (`packages/core/src/eventStore/eventStore.ts:242`) replays the entire aggregate stream from version 1 on every call. For long-lived aggregates — financial accounts, multi-year subscriptions, IoT device histories — replay cost grows linearly with stream length. At ~thousands of events the cost becomes a latency outlier; at tens of thousands the command-handler path approaches Lambda timeout territory. The upstream docs acknowledge the gap and point users to a userland convention (periodic snapshot via message-bus listener), but that convention is untyped, untested, and re-invented per project.

Castore has no framework-level snapshot primitive today. There is no `getLastSnapshot` / `putSnapshot` adapter contract, no snapshot column on the events table, no `snapshotPolicy` on `EventStore`, and no integration in `getAggregate`. (Verified: a grep for `snapshot|Snapshot|getLastSnapshot|cachedAggregate` across `packages/**/src/**/*.ts` returns 0 functional matches; the docs page `docs/docs/3-reacting-to-events/5-snapshots.md` describes the userland convention only, and references to "snapshot" inside `packages/event-storage-adapter-drizzle/src/.../outbox/claim.ts` are about outbox row claim snapshots, not event-store snapshots.)

This iteration is scoped to `@castore/event-storage-adapter-drizzle` (PostgreSQL, MySQL, SQLite) plus the in-memory adapter, with minimal additions to `@castore/core`. Drizzle is the greenfield default and covers the three target SQL dialects in one package; in-memory keeps test parity. The legacy `@castore/event-storage-adapter-postgres` is out of scope (deprecation trigger documented in the drizzle adapter spec, R21).

**Beyond the hot-path fix.** Snapshots in v1 are scoped to performance optimization for `getAggregate`. The chosen storage shape — one *latest* row per aggregate — is intentionally selected so that row reads naturally as a "current materialized state" surface in a follow-up milestone (cross-aggregate queries / projection layer over snapshot rows). v1 does **not** ship that query layer; it only lays the substrate without painting a corner. A bounded snapshot history (K-ring) for debug / one-off replay was considered for v1 and explicitly cut to keep the adapter and conformance surface aligned with v1's stated goal — see §3 Scope Boundaries and §7 v1.1 Candidates.

**Pattern.** The adapter contract gains two optional methods (`getLastSnapshot`, `putSnapshot`). `EventStore.getAggregate` checks for a snapshot first and replays only the delta (`minVersion: snapshot.version + 1`) over the snapshot's state. Snapshot writes are driven primarily by an **opt-in synchronous policy** on `EventStore` (`snapshotPolicy: { everyNEvents: N, stateRev: "<v>" }`); a manual `EventStore.saveSnapshot(aggregateId, options?)` API exists for backfill and operational use. Stale snapshots are guarded by a `state_rev` column compared on read, with an opt-in `verifyOnRead` mode catching consumer mistakes (forgotten `stateRev` bumps).

**Relationship to G-01 (outbox).** G-02 has no hard dependency on the outbox; the snapshot table is independent of the events and outbox tables. G-02 deliberately does **not** introduce a background relay worker in v1 — work stays synchronous in the `pushEvent` path. If a relay-style refresh is later warranted, the outbox primitives shipped in PRs #5–#7 are reusable, but no commitment is made now.

---

## 1. Requirements

### 1.1 Adapter contract (core)

- R1. `EventStorageAdapter` (`packages/core/src/eventStorageAdapter.ts`) gains two optional methods:
  - `getLastSnapshot({ eventStoreId, aggregateId })` returning `Promise<Snapshot<STATE> | undefined>`.
  - `putSnapshot({ eventStoreId, aggregateId, version, stateRev, state })` returning `Promise<void>`.
  Adapters that omit them keep working — `getAggregate` falls back to full replay (R7). The method signatures and the `Snapshot` shape are normative; column types per dialect are a planning concern.
- R2. `Snapshot` carries at minimum `aggregateId`, `version`, `stateRev`, `state`, `createdAt`. The `STATE` type parameter binds to the EventStore's `AGGREGATE` type. State serialization is JSON; the framework runs no application-side serialization hooks (the consumer's reducer must produce JSON-serializable state — same constraint as today's event payloads).

### 1.2 Storage shape

- R3. Snapshot storage is **latest-only**. For each `(eventStoreId, aggregateId)` the adapter maintains exactly one *latest* row, upserted on every `putSnapshot`. This row is the natural "current materialized state" substrate for a future cross-aggregate query layer (see R10's success-criterion cross-reference and the Problem Frame).
- R4. `getLastSnapshot` returns the latest row. A bounded history (K-ring) of recent snapshots and any `getSnapshotHistory` API are deferred to v1.1 (see §7 v1.1 Candidates) — they were not load-bearing for v1's hot-path goal.
- R5. Write semantics: `putSnapshot` MUST be safe under concurrent calls. "Highest committed version wins" eventually — a write at a lower version MUST NOT overwrite a latest row already written at a higher version. The concrete mechanism (versioned upsert, advisory lock, etc.) is a planning concern.

### 1.3 Read path (`getAggregate`)

- R6. `EventStore.getAggregate(aggregateId, options?)` transparently uses a snapshot when one exists and is compatible:
  - call `adapter.getLastSnapshot({ eventStoreId, aggregateId })`,
  - if a snapshot is returned and its `stateRev` matches the EventStore's configured `stateRev`, fold events from `minVersion: snapshot.version + 1` over `snapshot.state`,
  - otherwise replay from version 1 with `undefined` as initial state (today's behaviour).
  - The returned `events` array contains the events that were folded over the returned aggregate — i.e. the **delta only** when a snapshot was used. Callers that need the full history of an aggregate must pass `{ skipSnapshot: true }` (R8) to bypass the snapshot path.
- R7. Adapters without `getLastSnapshot` (legacy adapters) MUST keep working — the call is treated as "no snapshot" and full replay proceeds.
- R8. `getAggregate(id, { skipSnapshot: true })` opts out of snapshot read for that call (always full replay; full event history returned). Use cases: projection rebuild, debug verification that the reducer produces the same state with and without snapshot, callers that need the complete `events` array.
- R9. A snapshot whose `stateRev` does not match the EventStore's configured `stateRev` is silently treated as "no snapshot" (full replay). The first mismatch per `(eventStoreId, aggregateId)` per process MUST be logged at **warn** level so operators detect stateRev bumps at deploy time; subsequent mismatches for the same key may be logged at debug. The mismatch is the documented mechanism for reducer-shape evolution, not a fault condition — only its silent-at-debug logging level changes here.

### 1.4 Trigger model

- R10. `EventStore` accepts a new optional config field `snapshotPolicy: { everyNEvents: number; stateRev: string }`. When set, after each successful `pushEvent` the framework decides whether to write a snapshot. The contract guarantees that no aggregate goes more than `everyNEvents` events past its last snapshot. The mechanism is normative: the framework reads the last snapshot version on each `pushEvent` (with a per-aggregate-per-process cache to amortize cost) and writes a snapshot when `event.version - lastSnapshotVersion >= everyNEvents`. The cache-miss cost (cold processes, new Lambda invocations) is one extra read per `pushEvent` until the cache populates — see §6. On trigger, the framework calls `adapter.putSnapshot` synchronously inside `pushEvent`'s flow, before `pushEvent` resolves.
- R11. A `putSnapshot` failure MUST NOT fail the surrounding `pushEvent`. The framework logs at warn level and proceeds. Snapshots are a performance optimization; correctness lives in the events table.
- R12. `EventStore.saveSnapshot(aggregateId, options?: { state?: STATE; version?: number; allowNoop?: boolean })` is exposed as a manual API independent of `snapshotPolicy`, callable any time with or without a policy configured. When `state`+`version` are both supplied, the framework writes them directly. When either is absent, the framework calls `getAggregate` internally and writes the result. Primary uses: (a) backfill of existing long-lived aggregates at first deployment of v1, (b) operator/script tooling, (c) custom triggers from `onEventPushed` hooks (where `nextAggregate` and `event.version` are already in hand).
- R13. `EventStore.saveSnapshot` MUST throw `SnapshotNotSupportedError` (or equivalent) when called against an adapter that does not implement `putSnapshot`. Consumers who write generic code that may run against either snapshot-capable or non-snapshot adapters opt in to the silent-no-op path via `saveSnapshot(aggregateId, { allowNoop: true })`.
- R14. For `pushEventGroup` (atomic multi-aggregate writes), snapshot policy evaluation runs **after** the atomic group commits, individually per aggregate in the group. This preserves the multi-aggregate atomic boundary (snapshot writes never enter the same transaction as event writes) and applies R10's `everyNEvents` guarantee to each aggregate independently. Per-aggregate `putSnapshot` failures still follow R11 (log + proceed; never fail the group post-commit).
- R15. `ConnectedEventStore` forwards `saveSnapshot` to the wrapped `EventStore`. `snapshotPolicy` triggers fire identically whether the store is wrapped in `ConnectedEventStore` or not (see §6 for the wrapped-store timing contract). Snapshot writes do **not** generate message-channel publishes — snapshots are storage-layer artifacts, not domain events. This forwarding is explicit and required because `ConnectedEventStore` enumerates each EventStore method individually rather than transparently proxying.

### 1.5 Stale-snapshot safety

- R16. Each snapshot row carries a `state_rev` column. The value is the EventStore's configured `stateRev`. When `snapshotPolicy` is configured, `stateRev` lives there. For standalone `saveSnapshot` calls without a policy, `EventStore` accepts a top-level `stateRev` field. There is **no silent default**: if neither `snapshotPolicy.stateRev` nor a top-level `stateRev` is set when `saveSnapshot` is called, the call MUST throw a clear configuration error rather than writing a silently-mismatching snapshot.
- R17. Consumers bump `stateRev` (e.g. `"1"` → `"2"`) when making a breaking change to the reducer or aggregate shape. Existing snapshots with older revs become non-matching (R9) and are ignored on read; they are not auto-deleted in v1 (whether and how to GC them is deferred to planning).
- R18. Documentation MUST surface the `stateRev` contract prominently in the snapshot user guide, with explicit guidance for the silent-corruption failure mode of a forgotten `stateRev` bump (see §6 named risk and R19's verification mode). A consumer who relies on `snapshotPolicy` without bumping `stateRev` after reducer changes is on the same correctness footing as a consumer who never bumps schema migration versions — explicit, not implicit.
- R19. `EventStore` accepts an optional `verifyOnRead: number` field (probability `0..1`, default `0`) that, on each `getAggregate` call, with the configured probability runs both the snapshot path and the no-snapshot path and warns when the resulting aggregate states diverge. Intended for dev/staging environments and CI tests; production typically leaves it at `0`. Closes the silent-correctness loophole the §5 rejection of "YAGNI on stale-snapshot safety" already committed to closing.

### 1.6 Multi-adapter coverage

- R20. All three drizzle dialects ship together in v1: PostgreSQL (jsonb-based state column), MySQL (json), SQLite (text). Sub-entrypoints `@castore/event-storage-adapter-drizzle/<dialect>` export `snapshotColumns`, `snapshotTable`, and `snapshotTableConstraints`, following the established outbox pattern (G-01 R1–R2).
- R21. Adapter constructors for all three drizzle dialects gain an optional `snapshot` option accepting the user's snapshot table — symmetric to the existing `outbox` option.
- R22. The in-memory adapter ships full snapshot support backed by an in-memory `Map` keyed by `(eventStoreId, aggregateId)` holding the latest row per key (parity with R3).
- R23. A snapshot **conformance harness** (analogous to `outboxConformance.ts`) exercises the contract against all four adapters in CI: round-trip put/get, `state_rev` matching/mismatching with R9 log-level expectations, "highest-version-wins" concurrency, graceful no-op when `allowNoop: true` is used against an adapter without `putSnapshot`, throw behavior when `allowNoop` is absent, `verifyOnRead` divergence detection, policy trigger semantics under `pushEvent` and `pushEventGroup`, and end-to-end `getAggregate` performance via a fixture stream.

### 1.7 Migration & docs

- R24. `pushEvent` behaviour is **not** breaking — adapters without snapshot support keep working unchanged. `getAggregate`'s return shape is **not** breaking, but the semantic content of the `events` field changes when a snapshot is used (see R6: delta-only). Callers that depended on `events` being the full history must adopt `{ skipSnapshot: true }` (R8); this is documented as a behavioural shift in the migration guide.
- R25. The drizzle schema additions are additive (a new table). Consumers adopt v1 by adding the snapshot table to their drizzle migrations and (optionally) configuring `snapshotPolicy`. Existing event and outbox tables are unchanged.
- R26. The user-facing docs page `docs/docs/3-reacting-to-events/5-snapshots.md` is rewritten from "userland convention via bus listener" to "framework feature, configure `snapshotPolicy`". The legacy bus-listener pattern is mentioned only as historical context.

---

## 2. Success Criteria

- A consumer with a 10 000-event aggregate sees `getAggregate` latency drop by more than an order of magnitude after configuring `snapshotPolicy: { everyNEvents: 100, stateRev: "1" }` and letting one snapshot land — with no other code changes in command handlers.
- A consumer can opt into manual `saveSnapshot` only (no policy configured) and snapshots are written exactly when called, never otherwise; `getAggregate` still uses them transparently.
- A consumer who bumps `stateRev` from `"1"` to `"2"` after changing their reducer sees the next `getAggregate` call replay the full stream (with R9's first-mismatch warn log surfaced for operators), and a fresh snapshot at the new rev is written on the next policy trigger or `saveSnapshot` call.
- A CI test enabling `verifyOnRead: 1.0` and *deliberately* skipping a `stateRev` bump after a reducer change MUST detect the divergence — guards the silent-correctness regression introduced by snapshots themselves (R19).
- The v1 snapshot table layout supports `SELECT aggregate_id, state, version FROM <snapshot> WHERE event_store_id = ?` as the cross-aggregate primitive, executable in all three dialects with the v1 schema, with no index additions required in v1. Establishes that the substrate claim (Problem Frame "Beyond the hot-path fix") is real, not aspirational.
- All four adapters (drizzle pg, drizzle mysql, drizzle sqlite, in-memory) pass the same conformance harness in CI with no dialect-specific skips.
- A planning agent can read this document and the gap-analysis research (`specs/requirements/2026-04-16-castore-es-gap-analysis-research.md` §G-02) and produce an implementation plan without inventing product behaviour or scope.

---

## 3. Scope Boundaries

- The legacy `@castore/event-storage-adapter-postgres` adapter is out of scope (drizzle is the supported SQL adapter; legacy adapter is on its own deprecation track).
- Other storage adapters (DynamoDB, HTTP, Redux) are out of scope for v1.
- **Background relay worker** for asynchronous snapshot refresh is out of scope. Reusing outbox primitives for this is feasible but deferred until synchronous policy is shown to be insufficient under measurement.
- **Cross-aggregate query / materialized-view API** over snapshot rows is out of scope. The latest-row layout enables this in a future milestone; v1 only ships the substrate.
- **Indexes on the JSON state column** for query performance are out of scope. v1 indexes only `(event_store_id, aggregate_id)` plus whatever PK the dialect requires.
- **Bounded snapshot history (K-ring)** and any `getSnapshotHistory` framework API are out of scope for v1 (v1.1 candidates) — the latest row is the only required artifact for the hot-path goal.
- **Reducer fingerprint / source-hash auto-invalidation** is rejected (auto-magic; brittle on cosmetic refactors). `stateRev` is the explicit alternative.
- **Per-event-type version invalidation** is rejected for v1 (event types do not carry versions today; adding that is a separate spec).
- **Snapshot TTL / retention policies** are out of scope. Long-term GC of mismatched-rev snapshots is deferred to planning.
- **Multi-aggregate / cross-aggregate snapshots** (e.g. a "saga snapshot") are out of scope. v1 snapshots are per-aggregate, same boundary as `getAggregate`.
- **Encrypted-at-rest snapshot state** beyond what the underlying DB column natively supports is out of scope (G-04 territory).
- **Async hooks on snapshot writes** (e.g. `onSnapshotPushed`) are out of scope for v1.

---

## 4. Key Decisions

- **Optional adapter methods over a separate snapshot store package.** Keeps the EventStore facade unchanged for consumers and avoids forcing adapters to ship a no-op wrapper. Adapters that want snapshot capability implement two methods; others stay valid.
- **Latest-only storage shape.** The latest row is the substrate for the future cross-aggregate query layer the user explicitly signaled (current materialized state per aggregate). Bounded debug history was considered and cut: it serves no v1 consumer, adds a non-trivial dialect-specific upsert+evict design problem, and adds a conformance test dimension — all without supporting the v1 hot-path goal.
- **Auto-policy as the primary trigger; manual `saveSnapshot` as secondary.** The user's intent is "if I enable it on the store, it just happens" — making the policy path the documented main flow. The manual API stays for backfill of existing long aggregates at first deploy, ops use, and custom triggers from `onEventPushed` (hence the dual-shape signature in R12 — accepts both `aggregateId` only and pre-computed `state`+`version`, eliminating API churn risk in v1.1).
- **Synchronous policy (in `pushEvent`) over background relay in v1.** Lower complexity, no extra moving parts, no extra schema for dirty markers. Hot-path latency added by the snapshot write is paid only every Nth `pushEvent`. The R10 mechanism (read+per-aggregate-per-process cache) is normative because the brainstorm preferred the strong backfill guarantee; the cache-miss cost is acknowledged in §6. Background relay (and async-after-publish for `ConnectedEventStore`) are v1.1 candidates if measurements warrant.
- **`stateRev` string as the staleness fence (not auto-fingerprint).** Explicit consumer ownership of the contract; matches the same mental model as schema migration versions. Avoids the false invalidation that source-hash approaches cause on cosmetic changes. Combined with `verifyOnRead` (R19) as the dev/CI safety net for forgotten bumps, the silent-correctness loophole `§5 Alternatives Considered` rejected ("YAGNI on stale-snapshot safety") is closed.
- **`getAggregate` opt-out via `skipSnapshot: true` rather than a separate method.** Smaller API delta; transparent default matches the gap-analysis intent that snapshot benefit is invisible to callers. The `events` array semantic shift (full history → delta-only when a snapshot is used) is documented in R24 as the migration concern.
- **Throw-by-default on `saveSnapshot` against snapshot-incapable adapters.** Backfill scripts (R12a) — the use case most likely to encounter the missing-feature edge — get a loud failure rather than a silent no-op. Consumers writing adapter-agnostic generic code opt into the silent path via `allowNoop: true`.
- **Include the in-memory adapter in v1 (parity over minimalism).** Even though optional methods would let in-memory remain unchanged, parity simplifies the conformance harness and means consumers writing in-memory unit tests get to exercise the same snapshot path as production.
- **Divergence from upstream on snapshots-as-framework-feature.** Upstream `castore-dev/castore` removed snapshots from the framework (PR #161, merged 2023-10-06) and the discussion (issue #181) remains open. The most plausible upstream objections are coupling reducer evolution to a `state_rev` string, conflating the event store with a read-model store, and the semantic ambiguity of "snapshot" vs "aggregate cache." This fork accepts those costs deliberately, driven by the D1 finance profile (N5 long aggregate streams) where O(n) replay is a hard correctness/SLA risk. v1's design choices address the upstream concerns directly: optional adapter methods preserve non-snapshot adapters, `stateRev` is consumer-owned and explicit, `verifyOnRead` (R19) closes the silent-correctness loophole, and snapshot writes never publish to the message channel (R15) — keeping the event store and read-model store conceptually separate. Future upstream merges will need to reconcile this divergence; the maintenance cost is accepted.

---

## 5. Alternatives Considered

- **Separate `@castore/snapshot-*` package wrapping `EventStore`.** Rejected — wrapping a concrete class forces consumers to know which `EventStore` they hold (raw vs snapshotted vs connected vs both), and composition with `ConnectedEventStore` is awkward.
- **Append-only snapshot history.** Rejected for v1 — without retention it grows unboundedly, and the user's "future materialized view" direction is better served by a stable latest row than by a `DISTINCT ON` / `ROW_NUMBER` query over history.
- **Latest + bounded history (K-ring).** Considered for v1 and cut. Adds non-trivial adapter complexity (concurrency-safe upsert+evict in one statement per dialect) and a conformance test dimension (K-bound enforcement), all for a debug capability the framework does not expose via API. Latest-only is the v1 surface; K-ring is a v1.1 candidate (§7) accompanied by a `getSnapshotHistory` API if/when it becomes load-bearing.
- **YAGNI on stale-snapshot safety (just doc the risk).** Rejected — silent correctness bugs at deploy time of a reducer change are exactly the failure mode this feature must not introduce. The state-rev stamp + R19 `verifyOnRead` together close that loophole explicitly.
- **Reducer source-hash auto-invalidation.** Rejected — invalidates on cosmetic refactors; opaque to operators.
- **Per-event-type version map.** Rejected — requires event types to carry versions, which is a separate change with its own design.
- **External cache (Redis) for current state.** Rejected — cache invalidation, cold-start divergence, and cache-vs-store consistency bugs; the canonical place for a snapshot is the same store as the events.
- **Background snapshot relay (analogous to outbox).** Deferred — viable if synchronous policy proves to add latency outliers in production. v1 commits to the simpler shape.
- **Manual API only (no policy).** Considered as a strict-minimal v1 — rejected because the user explicitly wanted automatic behaviour to be the primary flow, and manual-only puts the burden of remembering-to-call on every command handler.
- **Storage primitives only (no API on `EventStore`).** Rejected — breaks the castore principle that consumers interact via `EventStore`, not via the adapter directly.
- **Modulo-only trigger semantics (`event.version % N === 0`).** Considered as a cheaper alternative to R10's read+cache mechanism. Rejected for v1 — it does not deliver the "no aggregate goes more than `everyNEvents` past last snapshot" guarantee for backfilled aggregates (an aggregate at version 250 at first-deploy with `everyNEvents: 100` waits 50 events for its first modulo-aligned snapshot). The brainstorm explicitly preferred the stronger guarantee; the cache amortizes most of the read cost.
- **Snapshot writes generate message-channel publishes.** Rejected — snapshots are storage-layer artifacts, not domain events. Publishing them via the bus would conflate two distinct concerns and create downstream `onEventPushed`-shaped surprises (R15).

---

## 6. Dependencies / Assumptions

- The outbox feature shipped in PRs #5–#7 introduces no constraints on snapshot work; the two tables are independent, and no shared transaction is required between event row, outbox row, and snapshot row.
- The drizzle adapter's existing sub-entrypoint pattern (`pg`, `mysql`, `sqlite`) is reused — no new packaging strategy.
- The `EventStore` class (`packages/core/src/eventStore/eventStore.ts:25`) is concrete, not an interface (gap analysis R-01). v1 adds methods directly to the class and wires `ConnectedEventStore` to forward them (R15). The forwarding requirement is explicit because `ConnectedEventStore` enumerates each `EventStore` method individually rather than transparently proxying.
- The reducer is assumed to be deterministic and to produce JSON-serializable state. This is already a de-facto requirement of `pushEvent` / `getAggregate`; v1 adds no new constraint.
- "Highest version wins" concurrency semantics for `putSnapshot` (R5) require a concurrency-safe upsert per dialect. The exact SQL is a planning concern (see §7); single-statement upsert is straightforward in PostgreSQL (`ON CONFLICT … DO UPDATE … WHERE excluded.version > version`) and SQLite (similar), but **not** straightforward in MySQL — `ON DUPLICATE KEY UPDATE` lacks a per-row WHERE clause, so the implementation will need `IF(VALUES(version) > version, …)` patterns, an advisory lock, or a two-statement transaction. R5's contract is preserved; the mechanism is honestly deferred.
- R10's `everyNEvents` mechanism is read-on-each-`pushEvent` with a per-aggregate-per-process cache. Cold processes (new Lambda invocations, fresh worker startups, horizontal scale-out) pay one extra read per `pushEvent` per aggregate until the cache populates. For deployments where this constant overhead is unacceptable, the cache layer itself is a planning concern (cache size, eviction strategy) but the per-process model bounds blast radius.
- **Silent-corruption named risk (forgotten `stateRev` bump).** A consumer changes the reducer in a breaking way and forgets to bump `stateRev`. R9 finds no mismatch (the stamps still match), no log fires, and `getAggregate` quietly folds new events over a stale-shape snapshot — silent incorrectness in production. Without snapshots this failure mode does not exist (every read replays from events). v1 mitigates this with three layers: (a) `verifyOnRead` (R19) as opt-in dev/CI verification, (b) prominent `stateRev` documentation including a checklist for reducer changes (R18), (c) a §2 success criterion that exercises the verifyOnRead-catches-forgotten-bump case in CI.
- **`ConnectedEventStore` snapshot timing.** Within `ConnectedEventStore` flows the order is: event commit → policy check → `putSnapshot` (synchronous) → `pushEvent` resolves → message-channel publish. Bus/queue subscribers wait for snapshot persistence on every Nth event; expected added publish latency = `putSnapshot` p50 × `1/everyNEvents`. v1 accepts this trade in exchange for synchronous-policy simplicity (§4 Key Decisions). Async-after-publish is a v1.1 candidate (§7) if measurements show subscribers are sensitive to the added Nth-event latency.
- **Substrate fitness.** The v1 latest-row layout is sized for a single-event-store cross-aggregate scan (the §2 success criterion's `WHERE event_store_id = ?` primitive). Future cross-aggregate query workloads requiring projected indexable columns (e.g. `tenant_id`, `status`) will be additive — `ALTER TABLE` not full rewrite — preserving the v1 substrate as the foundation rather than a temporary stepping stone.
- Consumer projects own their drizzle migrations and run `drizzle-kit` themselves — same pattern as the outbox table.

---

## 7. Outstanding Questions

### Resolve Before Planning

(none)

### Deferred to Planning

- [Affects R3, R5][Technical] Exact tabular shape per dialect: PK choice, index strategy (the `(event_store_id, aggregate_id)` PK plus whatever the dialect requires), JSON column types (jsonb / json / text), and concurrency-safe upsert SQL per dialect — including the MySQL fallback strategy (advisory lock vs `IF(VALUES(version) > version, …)` vs two-statement transaction).
- [Affects R10][Technical] Per-aggregate-per-process cache implementation details — cache key shape, max size, eviction strategy, invalidation on `putSnapshot` failure. The mechanism (read+cache) is normative; only its operational shape is open.
- [Affects R12][Technical] When called from an `onEventPushed` hook with `nextAggregate` already in hand, document the recommended pattern (`saveSnapshot(id, { state: nextAggregate, version: event.version })`) so consumers don't redundantly invoke `getAggregate` from within the hook.
- [Affects R15][Technical] Whether and when to GC snapshot rows whose `state_rev` no longer matches any current EventStore's `stateRev` — lazy on read, periodic background sweep, or operator-only.
- [Affects R19][Technical] `verifyOnRead` divergence reporting shape — log only, structured event hook, throw — and behavior under partial divergence (e.g. `state` differs but other fields match).
- [Affects R23][Technical] Concrete conformance test list and shared harness placement under `packages/event-storage-adapter-drizzle/src/__tests__/`. Specifically: how the harness exercises "highest-version-wins" concurrency (in-process Promise.all is insufficient for true cross-connection contention; planning should pick between separate worker processes, child connections, or accepting the in-process approximation).
- [Affects R26][Technical] Whether the legacy bus-listener docs page is rewritten in this same PR or in a docs follow-up.
- [Affects R10, R11][Technical] Logging strategy for snapshot warn/info events (existing castore convention vs introducing a logger interface) — likely follow today's adapter conventions.

### Residual concerns from review

- Latency-drop success criterion assumes JSON deserialization of large state is cheap relative to event replay; for very wide aggregates with kilobytes of state this may not hold and the success criterion may be unmeetable. (adversarial, anchor 50)
- If background relay (G-01-style async) is added in v1.1, consumers who adopted synchronous `snapshotPolicy` in v1 will face either an additive opt-in or a breaking config rename — the migration path should be decided before v1.1, not at v1.1 ship time. (product-lens, anchor 50)
- Whether snapshot writes should ever generate any message-channel publishes is decided here as "no" (R15). If a future use case emerges (e.g. a "snapshot-published" downstream signal for cache warmup), R15 will need an opt-in flag. (feasibility, anchor 50)

### v1.1 Candidates (not this deliverable)

- Background relay worker for snapshot refresh (analog of outbox relay).
- **Async-after-publish** policy mode for `ConnectedEventStore` — moves snapshot write off the publish hot path if measurements warrant.
- **Bounded snapshot history (K-ring)** with `getSnapshotHistory(aggregateId)` API for debug and one-off replay.
- Cross-aggregate query / materialized-view API over latest snapshot rows.
- Indexes on JSON-state columns for view queries.
- Per-event-type version map for finer-grained invalidation.
- TTL / retention worker for stale-rev snapshot rows.
- Snapshot encryption-at-rest (G-04 dependency).
- `onSnapshotPushed` hook on `EventStore` / `ConnectedEventStore`.

---

## 8. Next Steps

`-> /ce-plan` for structured implementation planning. Reference this document and the gap-analysis research §G-02 (`specs/requirements/2026-04-16-castore-es-gap-analysis-research.md`, lines 1161–1245).
