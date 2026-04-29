---
title: "feat(snapshots): G-02 snapshots for the drizzle adapter"
type: feat
status: active
date: 2026-04-29
deepened: 2026-04-29
origin: specs/requirements/2026-04-28-g02-snapshots-drizzle-requirements.md
---

# feat(snapshots): G-02 snapshots for the drizzle adapter

## Overview

Add framework-level snapshot support to castore. `EventStorageAdapter` gains two optional methods (`getLastSnapshot`, `putSnapshot`) and `EventStore` gains a `snapshotPolicy` config + a `saveSnapshot(aggregateId, options?)` method + an opt-in `verifyOnRead` divergence-detection mode. `getAggregate` transparently uses snapshots when available and replays only the delta. The drizzle adapter (pg, mysql, sqlite) and the in-memory adapter ship full implementations; a shared conformance harness (hosted in `@castore/lib-test-tools`) exercises the contract across all four backends. Read path is opt-out (`skipSnapshot: true`); write path is auto-policy primary, manual `saveSnapshot` secondary; staleness is fenced by an explicit consumer-owned `stateRev` string with `verifyOnRead` as the dev/CI safety net for forgotten bumps.

---

## Problem Frame

`EventStore.getAggregate` (`packages/core/src/eventStore/eventStore.ts:242`) replays the entire stream from version 1 on every call. For long-lived aggregates — financial accounts, multi-year subscriptions — replay cost grows linearly with stream length and risks Lambda timeouts at tens of thousands of events. Castore has no framework-level snapshot primitive today; the upstream docs point at a userland convention (periodic snapshot via message-bus listener) that is untyped and re-invented per project. Upstream `castore-dev/castore` removed snapshots from the framework (PR #161) and the discussion (issue #181) remains open. This fork adopts snapshots deliberately, driven by the D1 finance profile (N5 long aggregate streams), and addresses the upstream design objections directly: optional adapter methods preserve non-snapshot adapters, `stateRev` is consumer-owned and explicit, `verifyOnRead` closes the silent-correctness loophole, and snapshot writes never publish to the message channel. (See origin: `specs/requirements/2026-04-28-g02-snapshots-drizzle-requirements.md` Problem Frame and §4 Key Decisions "Divergence from upstream on snapshots-as-framework-feature".)

---

## Requirements Trace

This plan traces every numbered requirement (R1–R26), the §2 success criteria, and the §6 dependencies/assumptions from the origin requirements doc to one or more implementation units. (Note: U1 was folded into U2 during the 2026-04-29 deepening pass; the U1 ID is intentionally vacant.)

- R1 (adapter contract: optional `getLastSnapshot`/`putSnapshot`) → U2
- R2 (`Snapshot<STATE>` type) → U2
- R3 (latest-only storage shape per active `state_rev`) → U6, U7, U8, U9, U10
- R4 (`getLastSnapshot` returns latest) → U2, U6, U7, U8, U9, U10
- R5 (highest-version-wins concurrency) → U6, U7, U8, U9, U10
- R6 (`getAggregate` snapshot integration; `events` is delta-only when a snapshot is used) → U2
- R7 (graceful fallback for adapters without `getLastSnapshot`) → U2, U11
- R8 (`skipSnapshot: true` opt-out) → U2
- R9 (state_rev mismatch: silent fall-back; first-mismatch warn log) → U2, U11
- R10 (`snapshotPolicy` synchronous trigger; read+cache mechanism normative) → U3
- R11 (`putSnapshot` failure does not fail `pushEvent`) → U3, U11
- R12 (`saveSnapshot(aggregateId, options?)` dual-shape signature) → U3
- R13 (`saveSnapshot` throws when adapter lacks `putSnapshot`; `allowNoop` opt-in) → U3
- R14 (`pushEventGroup` snapshot semantics: post-commit per-aggregate) → U4
- R15 (`ConnectedEventStore` forwards `saveSnapshot`; no message-channel publish on snapshot) → U5
- R16 (no silent `stateRev` default; throw when neither `snapshotPolicy.stateRev` nor top-level set; explicit precedence rule) → U2, U3
- R17 (consumers bump `stateRev` on reducer break — documented behaviour) → U12
- R18 (docs surface `stateRev` contract + checklist) → U12
- R19 (`verifyOnRead` opt-in divergence detection) → U2
- R20 (drizzle pg/mysql/sqlite ship together; per-dialect schema exports) → U6, U7, U8, U9
- R21 (drizzle adapter constructor `snapshot?:` option per dialect) → U7, U8, U9
- R22 (in-memory adapter snapshot impl) → U10
- R23 (conformance harness across all four adapters, hosted in `@castore/lib-test-tools`) → U11
- R24 (`getAggregate` events-array semantic shift documented) → U2, U12
- R25 (drizzle schema additions are additive) → U6, U7, U8, U9
- R26 (rewrite `docs/docs/3-reacting-to-events/5-snapshots.md`) → U12
- §2 success criteria — order-of-magnitude (>10×) latency drop, manual-only flow correctness, stateRev bump full-replay + warn log, verifyOnRead catches forgotten-bump in CI, cross-aggregate primitive runnable on v1 schema, all four adapters pass conformance — covered by U2/U3/U11/U12 with the >10× SC enforced at assertion level (see U7/U11 perf scenarios)
- §6 silent-corruption named risk → U2 (verifyOnRead implementation), U12 (named risk callout in docs)
- §6 cache-miss cost note → U3 (cache implementation surfaces and respects this)
- §6 ConnectedEventStore timing contract → U5
- §6 substrate fitness assumption (cross-aggregate primitive runnable on v1 schema) → U11 (conformance asserts the SQL primitive)
- §7 v1.1 candidates carried forward into the same section in this plan, not renumbered

---

## Scope Boundaries

This plan implements v1 as scoped in the origin doc. It does not pursue any of the following:

- Background relay worker for asynchronous snapshot refresh (origin §3; this plan keeps trigger synchronous in `pushEvent`).
- Cross-aggregate query / materialized-view API over snapshot rows (the v1 schema enables it; the API itself is v1.1).
- Indexes on the JSON state column for query performance.
- Bounded snapshot history (K-ring) and `getSnapshotHistory(aggregateId)` API — explicitly cut from v1 storage shape.
- Reducer fingerprint / source-hash auto-invalidation, per-event-type version invalidation, snapshot TTL/retention, multi-aggregate (saga) snapshots, encrypted-at-rest snapshot state, async hooks on snapshot writes — all rejected or deferred in origin §3.
- `@castore/event-storage-adapter-postgres` (legacy) snapshot integration — the legacy adapter is on its own deprecation track (drizzle adapter spec R21).
- DynamoDB / HTTP / Redux storage adapters — v1 ships drizzle + in-memory only.
- Async-after-publish trigger mode for `ConnectedEventStore` — accepted as a v1 latency trade; v1.1 candidate if measurements warrant.

### Deferred to Follow-Up Work

- v1.1 candidates list carried forward from origin §7 — `getSnapshotHistory` API, async-after-publish, K-ring history, cross-aggregate query API, JSON-state indexes, per-event-type version map, TTL/retention worker, encryption-at-rest, `onSnapshotPushed` hook.
- A `/ce-compound` learning capturing G-02 patterns (highest-version-wins upsert per dialect, optional-contract typing on `EventStore.saveSnapshot`, conformance scenarios that proved load-bearing) once v1 lands. Recommendation from learnings researcher; not blocking this plan.

---

## Context & Research

### Relevant Code and Patterns

The G-01 outbox feature (PRs #5–#7) is the structural twin and the primary pattern to mirror. Snapshots are an additive sibling of the outbox-row mechanic — different table, different concurrency contract, but the same packaging shape.

**Per-dialect file layout to mirror** (`packages/event-storage-adapter-drizzle/src/`):
- `pg/`, `mysql/`, `sqlite/` — each owns `adapter.ts`, `adapter.unit.test.ts`, `contract.ts`, `index.ts`, `schema.ts`, `schema.type.test.ts`. Snapshots add `getLastSnapshot`/`putSnapshot` directly to `adapter.ts` (single owner of all read/write primitives) plus the schema/contract additions.
- `common/` — shared dialect-agnostic helpers (`error.ts`, `walkErrorCauses.ts`). New `common/snapshot/` will host the dialect-agnostic helpers (per-dialect upsert SQL builders, `SnapshotColumnTable` structural type, `selectSnapshotColumns` projection helper, error classification adapter). The shared `type Dialect = 'pg' | 'mysql' | 'sqlite'` will be extracted from `common/outbox/fencedUpdate.ts` into `common/dialect.ts` and reused by both outbox and snapshot helpers (deduplication driven by U6).
- The conformance harness lives in `@castore/lib-test-tools` (new sub-entrypoint `./snapshot-conformance`), NOT in the drizzle adapter's `__tests__/`. Drizzle's `__tests__/` is not in the package's `exports` map and is blocked by the ESLint `CASTORE_INTERNAL_IMPORT_REGEX`; the in-memory adapter cannot legitimately import from it. Hosting in `lib-test-tools` is the only choice that keeps the harness as a single source of truth without duplication.

**Per-dialect schema export pattern to mirror** (`pg/schema.ts:90-142` for outbox):
- `snapshotColumns` is a record of Drizzle column builders (no table wrapper) — users may spread into a custom `*Table(...)` call to add extras.
- `snapshotTableConstraints` is a generic third-arg callback `<TTable>(table) => [IndexBuilder]` with a stable PK / unique-constraint name (`snapshot_aggregate_pk`).
- `snapshotTable` is a prebuilt `pgTable / mysqlTable / sqliteTable('castore_snapshots', snapshotColumns, snapshotTableConstraints)` for the simple case.
- Per-dialect column-type choices: pg uses `jsonb` for state + `timestamp(precision: 3, withTimezone: true)`; mysql uses `json` + `datetime(fsp: 3, mode: 'string')` with `CURRENT_TIMESTAMP(3)` default; sqlite uses `text({ mode: 'json' }).$type<unknown>()` + `text` ISO-8601 with `$defaultFn(() => new Date().toISOString())`.

**Per-dialect upsert pattern** (concurrency-safe "highest-version-wins"):
- pg: `INSERT ... ON CONFLICT (event_store_id, aggregate_id) DO UPDATE SET ... WHERE excluded.version > snapshots.version`. Single statement.
- sqlite: `INSERT ... ON CONFLICT (event_store_id, aggregate_id) DO UPDATE SET ... WHERE excluded.version > snapshots.version`. Single statement; no enclosing transaction needed (single statement is atomic).
- mysql: row-aliasing form (modern, MySQL 8.0.20+): `INSERT ... AS new ON DUPLICATE KEY UPDATE version = IF(new.version > version, new.version, version), state_rev = IF(new.version > version, new.state_rev, state_rev), state = IF(new.version > version, new.state, state), created_at = IF(new.version > version, new.created_at, created_at)`. **Do NOT use the deprecated `VALUES(...)` reference inside `ON DUPLICATE KEY UPDATE`** — it is deprecated since MySQL 8.0.20 and slated for removal. The two-statement `INSERT IGNORE` + conditional `UPDATE ... WHERE version < ?` pattern remains as the actual fallback if drizzle-orm 0.45's `sql` template tag does not handle `INSERT ... AS new` correctly (verify in U8).

**Adapter constructor option pattern** (`pg/adapter.ts:51-82` for outbox):
- `constructor({ db, eventTable, outbox, snapshot? })` — adds an optional `snapshot?: PgSnapshotTableContract` field symmetric to the existing `outbox?:` option.

**Core class shape** (`packages/core/src/eventStore/eventStore.ts:25-298`):
- Concrete class, methods bound as **arrow-function instance fields** in the constructor (lines 167-296). New `saveSnapshot` MUST be bound as an arrow-function instance field (matching the existing pushEvent/getAggregate pattern), NOT a class method, so that `ConnectedEventStore` can copy the reference safely via direct field assignment without breaking `this`.
- File is already at the 200-line max-lines cap (`/* eslint-disable max-lines */` at line 1 — currently 299 lines). New snapshot logic is extracted into sibling modules under `packages/core/src/eventStore/snapshot/` rather than swelling the file further.
- `getAggregate` (lines 242-253) is the integration point for R6. `pushEvent` (lines 187-216) is where the synchronous policy trigger lives. The static `pushEventGroup` (lines 42-109) is where R14's post-commit per-aggregate logic lives.
- `connectedEventStore.ts:115-144` enumerates each forwarded method explicitly (no Proxy). Adding `saveSnapshot` requires explicit forwarding.
- `eventStorageAdapter.ts` is currently a plain interface with no optional methods. R1 introduces the optional-method pattern.

**Vitest config** (`commonConfiguration/vite.config.js`): only `*.unit.test.{ts,...}` are executed. `*.type.test.ts` is checked by `tsc --noEmit` via `pnpm test-type` and uses `expectTypeOf` + `@ts-expect-error`.

**ESLint sub-entrypoint allow-list** (`eslint.config.js:14-16`): the regex `^@castore/(?!event-storage-adapter-drizzle/(?:pg|mysql|sqlite|relay)$)[^/]+/.+` allows exactly four sub-paths for the drizzle adapter. **The `@castore/lib-test-tools` package will need a new `./snapshot-conformance` sub-entrypoint** — verify whether the regex needs an update for `lib-test-tools` sub-entrypoints (it should not, since the regex is scoped to `event-storage-adapter-drizzle` only; confirm during U11).

### Institutional Learnings

(All from `docs/solutions/`, surfaced by the learnings researcher in Phase 1.1.)

- `docs/solutions/integration-issues/drizzle-orm-api-gaps-multi-dialect-adapter-2026-04-18.md` — MySQL has no `INSERT ... RETURNING`; better-sqlite3 rejects `db.transaction(async cb)`; per-driver error wrapping requires `walkErrorCauses` (`src/common/walkErrorCauses.ts`). Directly informs U7 (mysql) and U8 (sqlite) implementations. **Caveat (added 2026-04-29 review):** the linked doc was written before MySQL's deprecation of `VALUES(...)` inside `ON DUPLICATE KEY UPDATE` was widely adopted; this plan supersedes the doc's implied syntax with row-aliasing — capture in a follow-up `/ce-compound` learning.
- `docs/solutions/best-practices/multi-dialect-adapter-package-patterns-2026-04-18.md` — the four-pattern playbook: generic constraints helper, phantom type parameter on contracts, shared conformance test factory, falsy-aware nullable-JSON handling. Drives U6 (common helpers), U7–U9 (per-dialect contracts), U11 (conformance harness shape).
- `docs/solutions/best-practices/outbox-conformance-suite-patterns-2026-04-24.md` — setup contract is a dialect-agnostic object (not a base class); container lifecycle stays at file scope; DB-authoritative timestamps defeat `vi.useFakeTimers()`; sqlite carve-outs are explicit, not implicit; mysql is the long-pole on test runtime; sqlite doesn't preserve constraint names through `PRAGMA index_list`. Drives U11's harness shape.
- `docs/solutions/developer-experience/pnpm10-eslint9-native-deps-allow-list-2026-04-18.md` — no new native deps anticipated; the existing sub-entrypoint regex covers our needs (no expansion required for the drizzle adapter; `lib-test-tools` sub-entrypoint addition to verify in U11).
- `docs/solutions/workflow-issues/ce-resolve-pr-feedback-parallel-dispatch-file-overlap-2026-04-19.md` — relevant only at PR-review time. Plan-side implication: keep dialect implementations cohesive enough that PR-feedback-resolver dispatch does not silently overwrite cross-dialect refactors.

### External References

External research was skipped per Phase 1.2 — the local outbox precedent and the institutional learnings cover dialect-specific patterns and conformance harness shape. The drizzle-orm 0.45 docs are linked from the institutional doc above when needed (e.g. for `ON CONFLICT` / row-aliasing syntax across dialects).

---

## Key Technical Decisions

- **Optional methods on `EventStorageAdapter`, not a capability symbol.** R1 calls for two methods on the adapter interface as `?:` optionals. `EventStore` runtime-checks `typeof adapter.getLastSnapshot === 'function'`. This is simpler than the outbox capability-symbol pattern (which existed because the outbox needed a capability flag in addition to method presence). For snapshots, method presence IS the capability.
- **Latest-only table per active `state_rev`.** R3 specifies one row per `(event_store_id, aggregate_id)`. Stale-rev rows from a previous `stateRev` are not auto-deleted in v1 (origin §7 deferred GC to v1.1) — so in practice the table may transiently contain multiple rows for one aggregate when a `stateRev` bump has happened: one current-rev row plus stale-rev rows that the read path silently ignores per R9. This is not a contradiction of R3; it is the explicit operational consequence of GC-deferral. Captured here so reviewers and implementers see it.
- **Per-aggregate-per-process LRU cache for the policy mechanism.** R10's "no aggregate goes more than `everyNEvents` past last snapshot" is normative *for the read+cache mechanism on `pushEvent` / `pushEventGroup` paths*; flexible operational details (LRU eviction strategy, cache-on-failure behavior, bounded size default of 1000 with `snapshotPolicy.cacheSize` override) are planning-time decisions documented in §7. Cache stores `Math.max(currentCacheVal, event.version)` on `putSnapshot` success — never regresses, may briefly lag if a concurrent writer landed a higher version, but always points to a real snapshot version (the DB upsert's `WHERE excluded.version > version` is the authoritative guard).
- **stateRev resolution precedence (explicit).** When both `snapshotPolicy.stateRev` and a top-level `EventStore.stateRev` are set, **`snapshotPolicy.stateRev` wins**. When only one is set, that one is used. When neither is set and `saveSnapshot` is called, the call throws `StateRevNotConfiguredError`. R10 normatively requires `snapshotPolicy` to carry `stateRev`, so the both-present case arises only when a consumer also sets the top-level field defensively for `saveSnapshot` calls outside the policy path; documenting the precedence avoids accidental cross-contamination.
- **Snapshot writes happen after event commit, before `pushEvent` resolves; in `pushEventGroup`, after the atomic group commits.** R14 makes this explicit. `ConnectedEventStore.publishPushedEvent` therefore runs after snapshot persistence — acknowledged in origin §6 as a deliberate latency trade.
- **`saveSnapshot` dual-shape signature with `allowNoop`.** `(aggregateId, options?: { state?: STATE; version?: number; allowNoop?: boolean })`. Framework-computes when `state`/`version` absent. Throws `SnapshotNotSupportedError` against adapters without `putSnapshot` unless `allowNoop: true`. Closes both deferred questions from origin §7.
- **`saveSnapshot` is bound as an arrow-function instance field in `EventStore`**, matching the existing `pushEvent`/`getAggregate` pattern (`eventStore.ts:177-296`). This is load-bearing for `ConnectedEventStore` forwarding (U5) — direct method-reference assignment (`this.saveSnapshot = eventStore.saveSnapshot`) only preserves `this` when the source is an arrow bound at construction. Class-method binding is explicitly disallowed for this surface.
- **`stateRev` lives on `EventStore` (top-level optional) AND/OR `snapshotPolicy.stateRev`.** Resolution order documented above. No silent default.
- **`verifyOnRead: number` (probability 0..1, default 0).** On each `getAggregate`, with the configured probability, run both the snapshot path and `getAggregate({ skipSnapshot: true })` and compare aggregates via `node:util` `isDeepStrictEqual` (NOT `JSON.stringify`-based equality — order-sensitive on object keys, drops undefined-valued keys, mishandles BigInt/Date/Map/Set). On divergence, log at warn level (no throw — divergence detection is observational). Cost amplification: a positive verifyOnRead sample pays the FULL no-snapshot replay path on top of the snapshot path. For a 10K-event aggregate at p=0.01, one in 100 reads pays ~10K-event latency. Production callers should use ε-level probabilities (`0.001` or lower) on long-stream stores; CI tests can run `verifyOnRead: 1.0` because their fixtures are short. Documented in U2 + U12.
- **R9 first-mismatch logging is per-process, per-`(eventStoreId, aggregateId)`.** Use a `Set<string>` of seen mismatch keys, augment lookup at the warn-level call site. Subsequent mismatches for the same key fall back to debug.
- **Snapshot reads are unconditional in `getAggregate` v1 (transparent default).** The snapshot fetch runs on every `getAggregate` call (unless `skipSnapshot: true`) regardless of whether `snapshotPolicy` is configured. This is the origin's "transparent default" position and is preserved here. Whether to gate this on opt-in (and shift the consumer cost) is captured in §7 "From 2026-04-29 plan review" — it re-opens an origin-accepted design choice and warrants explicit user judgment, not a silent flip during deepening.
- **Per-dialect upsert SQL choice.** pg/sqlite use the per-row WHERE in `ON CONFLICT DO UPDATE`. mysql uses **single-statement row-aliasing** (`INSERT ... AS new ON DUPLICATE KEY UPDATE col = IF(new.version > version, new.col, col)`) — modern, MySQL 8.0.20+, forward-compatible. The deprecated `VALUES(...)` form is explicitly NOT used. Two-statement `INSERT IGNORE` + conditional `UPDATE` is the fallback if drizzle-orm 0.45's `sql` template tag does not handle `INSERT ... AS new` correctly.
- **Conformance suite includes a `pushEventGroup` snapshot scenario.** Origin Apply'd Finding 5 to make `pushEventGroup` post-commit per-aggregate semantics normative.
- **Performance assertion enforces the §2 SC literally.** U7 and U11 perf scenarios assert `withSnapshot < cold/10` (matching the "more than an order of magnitude" wording), not the laxer `< cold/2`. If testcontainer noise makes 10× flaky, switch to a longer fixture stream or a wall-time budget; do not weaken the assertion.
- **Docs page rewrite + drizzle adapter README update both land in U12, unconditionally.** Both surfaces are part of Phase C; no follow-up doc-only PR is implied.
- **Phase A is internal-only.** Phase A's core changes (U2, U3, U4, U5) ship without exposing the new symbols (`saveSnapshot`, `snapshotPolicy`, `verifyOnRead`) from `@castore/core`'s public `index.ts`. Public exports flip on in Phase B's first adapter PR (when at least one adapter exercises the contract end-to-end). This preserves the multi-PR cadence without releasing a publicly-callable API that throws `SnapshotNotSupportedError` on every adapter.

---

## Open Questions

### Resolved During Planning

- **Per-dialect upsert SQL.** Resolved per Key Technical Decisions: pg/sqlite use `ON CONFLICT DO UPDATE ... WHERE excluded.version > version`; mysql uses single-statement row-aliasing form (NOT deprecated `VALUES(...)`). Two-statement transaction is fallback only if row-aliasing templating fails under drizzle.
- **Cache implementation details.** Per-aggregate-per-process LRU with default max `1000` per EventStore. Size configurable via `snapshotPolicy.cacheSize`. Cache stores `Math.max(currentCacheVal, event.version)` on success — never regresses.
- **stateRev resolution precedence.** snapshotPolicy.stateRev wins when both are set; throw when neither; explicit test scenario in U3.
- **`saveSnapshot` from `onEventPushed` hook pattern.** Document recommended pattern in user docs (U12): `saveSnapshot(id, { state: nextAggregate, version: event.version })`. The dual-shape signature exists precisely for this hot-path use case.
- **`verifyOnRead` divergence reporting shape.** Log only at warn level (no structured event hook in v1). No throw — divergence detection is observational. Use `node:util` `isDeepStrictEqual` (NOT `JSON.stringify`-based equality).
- **Conformance harness placement.** `@castore/lib-test-tools` (new sub-entrypoint `./snapshot-conformance`) — NOT inside the drizzle adapter's `__tests__/`. This is the only choice that keeps the harness as a single source of truth that both drizzle and in-memory adapter test files can legitimately import.
- **Logging strategy.** Follow the existing castore convention — use `console.warn` directly (matches today's outbox warn-on-failure pattern). No new logger interface in v1.
- **GC for stale-rev rows.** Deferred to v1.1 — origin §7 entry preserved as v1.1 candidate. v1 leaves stale-rev rows in place; they cost storage but don't affect correctness (R9 silently fall-back path ignores them at read time).
- **Phase A→B inter-phase state.** Phase A is internal-only (no public-API export until Phase B's first adapter ships). Public `index.ts` does not export the new symbols during Phase A; export-flip lands with the first adapter PR in Phase B. Documented in §Phased Delivery.
- **Drizzle adapter README update timing.** In U12, unconditionally. Phase C delivers both the user-facing concept docs and the per-package README updates.

### Deferred to Implementation

- **MySQL row-aliasing template support under drizzle 0.45.** The single-statement `INSERT ... AS new ON DUPLICATE KEY UPDATE` form may need raw-SQL escapes if drizzle's `sql` template tag mishandles the alias clause. Verify against testcontainer mysql before declaring U8 done. If templating fails, fall back to two-statement `INSERT IGNORE` + conditional `UPDATE ... WHERE version < ?` and document the choice in code comments + a `/ce-compound` learning post-G-02.
- **In-process vs cross-connection concurrency in conformance.** The harness asserts highest-version-wins via `Promise.all([putSnapshot(v1), putSnapshot(v2)])` against the same connection (in-process approximation). True cross-connection contention testing requires either separate worker processes or a child connection pool; implementation may pick one or accept the in-process approximation. Origin §7 flagged this; planning leaves the choice to implementation.
- **Sqlite carve-out for `verifyOnRead` concurrency tests.** If conformance runs `verifyOnRead` scenarios that need concurrent writers, sqlite's single-writer model requires an explicit carve-out (similar to `outboxFaultInjection.ts`). Implementation discovers whether the conformance scenarios actually need concurrency or whether sequential exercise is sufficient.
- **Cache-eviction integration with `putSnapshot` failure.** Cache invalidates on `putSnapshot` success only; on failure the cache is left in its prior state, so the next pushEvent re-evaluates the threshold (eventually self-heals). Whether to also invalidate on every Nth pushEvent regardless is a small operational decision left to implementation.
- **Lib-test-tools sub-entrypoint ESLint regex check.** Adding `./snapshot-conformance` to `@castore/lib-test-tools` should not require updating the `event-storage-adapter-drizzle`-scoped regex, but verify with a cross-package import probe in U11.

### From 2026-04-29 plan review (deferred for implementer / reviewer judgment)

These two items surfaced during the post-plan ce-doc-review pass and re-open architectural directions that would diverge from origin-accepted decisions. They are NOT blocking: implementation can proceed against the plan as written, with these entries informing first-week decisions.

- **[Affects R10, U3][Architectural — Resolve before Phase A] Multi-process cache redundant-trigger pattern.** Under Lambda concurrent invocation, two processes with cold per-aggregate-per-process caches may both observe `lastSnap=0` and both decide to trigger a snapshot at the same threshold crossing. The DB's `WHERE excluded.version > version` upsert dedupes storage (final state is correct), but each invocation still performs the work — including a potentially expensive `getAggregate({ skipSnapshot: true })` recompute when `prevAggregate` is not supplied. At cold-start scale this is 2-N times the snapshot cost on the synchronous `pushEvent` boundary. **Two paths forward:** (a) Accept the redundant-trigger cost as a documented bound — operational cost of cold cache amortized across container lifetime — and add an explicit acknowledgment to U3 Approach. (b) Add modulo-jitter to the threshold check (`event.version - lastSnap >= everyNEvents AND event.version % everyNEvents === 0`) so only one trigger fires per N-event window across processes, at the cost of weakening the strong-backfill guarantee R10 chose. The plan does not pre-decide; this is a design choice the implementer or reviewer should make before Phase A's `snapshotPolicy` integration in `pushEvent` lands.
- **[Affects U2 read path][Design re-open — implementer should surface to user before changing] Unconditional `getLastSnapshot` on every `getAggregate`.** Origin §6 accepted "snapshot reads are unconditional" as the transparent-default position. Plan deepening reviewer challenged it: a consumer who installs the v2 drizzle adapter but never opts into snapshots inherits a permanent extra round-trip per `getAggregate`. The cache only helps the policy trigger path (which never fires for opted-out consumers), not the read path. **The transparent-default position is preserved in the plan; this entry exists so the implementer knows the trade is contested.** If during implementation a hot-path measurement shows the round-trip dominates `getAggregate` for opted-out consumers, surface it to the user — at that point gating `getLastSnapshot` on `(snapshotPolicy configured) || (verifyOnRead > 0) || enableSnapshotReads === true` is a small, additive change, but it diverges from the origin decision and should be a deliberate, signaled flip rather than a silent design correction.

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

## Output Structure

The plan creates new files in core, in the drizzle adapter, in the in-memory adapter, and in `@castore/lib-test-tools` (the conformance harness home). Existing files are modified at well-bounded surfaces. Tree showing the new artifacts:

    packages/core/src/
      eventStore/
        snapshot/                                 (new dir — extracted helpers)
          snapshot.ts                             (new — Snapshot<STATE> type, GetAggregateOptions extension, EventStore config types)
          snapshotPolicy.ts                       (new — sync policy check + per-aggregate-per-process LRU cache + max-aware cache writes)
          getAggregateWithSnapshot.ts             (new — read path with snapshot integration; inline stateRev resolution)
          verifyOnRead.ts                         (new — divergence detection via node:util isDeepStrictEqual)
          saveSnapshot.ts                         (new — saveSnapshot method body; inline stateRev resolution)
          errors.ts                               (new — SnapshotNotSupportedError + StateRevNotConfiguredError)
          snapshot.type.test.ts                   (new — type-level proofs for Snapshot, GetAggregateOptions, EventStore config)
      eventStorageAdapter.ts                      (modify — add optional getLastSnapshot/putSnapshot)
      eventStore/eventStore.ts                    (modify — wire saveSnapshot, snapshotPolicy, verifyOnRead, getAggregate; saveSnapshot bound as arrow-function instance field)
      eventStore/types.ts                         (modify — extend GetAggregateOptions; add saveSnapshot type)
      eventStore/eventStore.unit.test.ts          (modify — add snapshot scenarios, verifyOnRead validation, stateRev precedence)
      eventStore/eventStore.type.test.ts          (modify — add snapshot type proofs)
      connectedEventStore/connectedEventStore.ts  (modify — forward saveSnapshot via direct field assignment)
      index.ts                                    (modify — export new types/errors; Phase-A internal-only landing, export-flip in Phase B)

    packages/event-storage-adapter-drizzle/src/
      common/
        dialect.ts                                (new — extracted shared `type Dialect = 'pg' | 'mysql' | 'sqlite'`; reused by outbox/fencedUpdate.ts and snapshot/upsertSnapshot.ts)
        snapshot/                                 (new dir — dialect-agnostic helpers)
          types.ts                                (new — SnapshotColumnTable structural type)
          selectColumns.ts                        (new — selectSnapshotColumns projection helper)
          upsertSnapshot.ts                       (new — per-dialect upsert SQL builders; mysql uses row-aliasing, NOT deprecated VALUES())
        outbox/fencedUpdate.ts                    (modify — re-export Dialect from common/dialect.ts to preserve compatibility)
      pg/
        schema.ts                                 (modify — add snapshotColumns/snapshotTable/snapshotTableConstraints)
        contract.ts                               (modify — add PgSnapshotTableContract)
        adapter.ts                                (modify — add snapshot? option, getLastSnapshot, putSnapshot)
        index.ts                                  (modify — export new symbols)
        adapter.unit.test.ts                      (modify — wire snapshot conformance from @castore/lib-test-tools/snapshot-conformance)
        snapshot.schema.type.test.ts              (new — type proofs for the contract)
      mysql/
        ...                                       (mirror pg layout; row-aliasing upsert in adapter.ts)
      sqlite/
        ...                                       (mirror pg layout)

    packages/event-storage-adapter-in-memory/src/
      adapter.ts                                  (modify — add Map-based snapshot store inline; getLastSnapshot/putSnapshot bound)
      adapter.unit.test.ts                        (modify — wire snapshot conformance from @castore/lib-test-tools/snapshot-conformance)
      index.ts                                    (modify — export anything needed by conformance)

    packages/lib-test-tools/src/
      snapshot-conformance/                       (new dir — dedicated sub-entrypoint)
        index.ts                                  (new — re-exports makeSnapshotConformanceSuite and shared fixtures)
        makeSnapshotConformanceSuite.ts           (new — factory; mirrors outboxConformance shape)
        fixtures.ts                               (new — counter event store + counter reducer for length-N stream construction)
        snapshot-conformance.type.test.ts         (new — factory boundary type proofs)
      package.json                                (modify — add ./snapshot-conformance sub-entrypoint to exports map)

    docs/docs/3-reacting-to-events/
      5-snapshots.md                              (rewrite — userland convention → framework feature)

    packages/event-storage-adapter-drizzle/
      README.md                                   (modify — new section pointing at snapshotColumns/snapshotTable per dialect, mirroring outbox section)

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Adapter contract (R1, R2)

```
EventStorageAdapter {
  // existing methods unchanged
  getEvents
  pushEvent
  pushEventGroup
  groupEvent
  listAggregateIds

  // new — optional
  getLastSnapshot?(params: { eventStoreId, aggregateId })
    -> Promise<Snapshot<STATE> | undefined>

  putSnapshot?(params: { eventStoreId, aggregateId, version, stateRev, state })
    -> Promise<void>
}

Snapshot<STATE> = {
  aggregateId: string
  version: number
  stateRev: string
  state: STATE
  createdAt: Date
}
```

### `getAggregate` read path (R6, R7, R8, R9, R19)

```
getAggregate(aggregateId, options?):
  if options.skipSnapshot or adapter has no getLastSnapshot:
    events = adapter.getEvents(aggregateId, { maxVersion: options.maxVersion })
    aggregate = fold(events, undefined)
    return { aggregate, events, lastEvent }

  snapshot = adapter.getLastSnapshot(aggregateId)
  if snapshot is undefined:
    events = adapter.getEvents(aggregateId, { maxVersion: options.maxVersion })
    aggregate = fold(events, undefined)
    return { aggregate, events, lastEvent }

  if snapshot.stateRev != configuredStateRev:
    log warn (first time per (eventStoreId, aggregateId) per process; debug after)
    fall back to full replay
    return { aggregate: ..., events: <full>, lastEvent }

  events = adapter.getEvents(aggregateId, {
    minVersion: snapshot.version + 1,
    maxVersion: options.maxVersion
  })
  aggregate = fold(events, snapshot.state)
  if shouldVerify(verifyOnRead):  // Math.random() < probability
    fullEvents = adapter.getEvents(aggregateId, { maxVersion })
    fullAggregate = fold(fullEvents, undefined)
    if not isDeepStrictEqual(aggregate, fullAggregate):  // node:util, not JSON.stringify
      log warn — verifyOnRead divergence
  return { aggregate, events: <delta>, lastEvent }
```

### Synchronous policy trigger in `pushEvent` (R10, R11)

```
pushEvent(eventDetail, options):
  result = adapter.pushEvent(...)  // event row written, transaction committed
  nextAggregate = reduce(...) if applicable
  onEventPushed?(...)

  if snapshotPolicy is configured:
    lastSnapshotVersion = cache.get(aggregateId) ?? adapter.getLastSnapshot(...)?.version ?? 0
    if event.version - lastSnapshotVersion >= snapshotPolicy.everyNEvents:
      try:
        state = nextAggregate ?? (recompute via getAggregate({ skipSnapshot: true }))
        adapter.putSnapshot({ ..., version: event.version, stateRev, state })
        cache.set(aggregateId, Math.max(cache.get(aggregateId) ?? 0, event.version))
      catch e:
        log warn — putSnapshot failed; do not fail pushEvent
        // do NOT update cache on failure — next pushEvent re-evaluates

  return result
```

### `pushEventGroup` post-commit per-aggregate (R14)

```
EventStore.pushEventGroup(...):
  // existing atomic adapter call
  { eventGroup } = adapter.pushEventGroup(...)
  // per-event JS-side reduce
  for each grouped event:
    compute nextAggregate
    onEventPushed?
  await Promise.all(onEventPushed)

  // post-commit per-aggregate snapshot evaluation
  for each grouped event with eventStore.snapshotPolicy configured:
    same threshold check as in pushEvent
    same try/catch/log around putSnapshot
    same cache update on success only (Math.max)
```

### Per-dialect upsert (R5)

```
pg / sqlite (single statement):
  INSERT INTO snapshots (event_store_id, aggregate_id, version, state_rev, state, created_at)
  VALUES (?, ?, ?, ?, ?, NOW())
  ON CONFLICT (event_store_id, aggregate_id) DO UPDATE SET
    version    = excluded.version,
    state_rev  = excluded.state_rev,
    state      = excluded.state,
    created_at = excluded.created_at
  WHERE excluded.version > snapshots.version

mysql (single statement, modern row-aliasing — MySQL 8.0.20+):
  INSERT INTO snapshots (event_store_id, aggregate_id, version, state_rev, state, created_at)
  VALUES (?, ?, ?, ?, ?, NOW(3))
  AS new
  ON DUPLICATE KEY UPDATE
    version    = IF(new.version > version, new.version,    version),
    state_rev  = IF(new.version > version, new.state_rev,  state_rev),
    state      = IF(new.version > version, new.state,      state),
    created_at = IF(new.version > version, new.created_at, created_at)
```

---

## Implementation Units

> Note: U1 was folded into U2 during the 2026-04-29 deepening pass. The U1 ID is intentionally vacant; subsequent unit IDs are unchanged.

- U2. **Core types, adapter contract, and `getAggregate` read path**

**Goal:** Add the optional `getLastSnapshot`/`putSnapshot` methods to `EventStorageAdapter`, define the `Snapshot<STATE>` type, extend `GetAggregateOptions` with `skipSnapshot`, add the new `EventStore` config fields (`snapshotPolicy`, `stateRev`, `verifyOnRead`), define the new error types, AND modify `getAggregate` to transparently use snapshots when available — including R9 stateRev mismatch handling and `verifyOnRead` divergence detection. Types and read path land together since types-only has no independent runnable delta.

**Requirements:** R1, R2, R6, R7, R8, R9, R10 (config shape only), R12 (signature only), R16 (type + precedence), R19, R24

**Dependencies:** None.

**Files:**
- Create: `packages/core/src/eventStore/snapshot/snapshot.ts` (`Snapshot<STATE>` type, `SnapshotPolicy` type, `GetAggregateOptions` extension)
- Create: `packages/core/src/eventStore/snapshot/getAggregateWithSnapshot.ts` (extracted helper; inline stateRev resolution: `snapshotPolicy?.stateRev ?? eventStoreConfig.stateRev` — throw `StateRevNotConfiguredError` if both absent and snapshot fetch is attempted)
- Create: `packages/core/src/eventStore/snapshot/verifyOnRead.ts` (probability check + divergence comparator using `node:util` `isDeepStrictEqual` + warn-once tracker)
- Create: `packages/core/src/eventStore/snapshot/errors.ts` (`SnapshotNotSupportedError`, `StateRevNotConfiguredError`)
- Create: `packages/core/src/eventStore/snapshot/snapshot.type.test.ts`
- Modify: `packages/core/src/eventStorageAdapter.ts` (add optional methods)
- Modify: `packages/core/src/eventStore/types.ts` (`GetAggregateOptions` add `skipSnapshot`; add `SaveSnapshot<STATE>` type)
- Modify: `packages/core/src/eventStore/eventStore.ts` (rewire `getAggregate` to delegate to the helper; add `mismatchLogTracker: Set<string>` private field + first-mismatch logger)
- Modify: `packages/core/src/eventStore/eventStore.unit.test.ts` (add R6/R8/R9/R19 scenarios + verifyOnRead range validation)
- Modify: `packages/core/src/eventStore/eventStore.type.test.ts` (cover new config options and method signatures via `expectTypeOf`)
- Modify: `packages/core/src/index.ts` (Phase-A internal-only landing — new types/errors stay UNexported until Phase B's first adapter PR)

**Approach:**
- The adapter contract gains two `?:` methods. No capability symbol — `EventStore` runtime-checks `typeof adapter.getLastSnapshot === 'function'`.
- `Snapshot<STATE>` carries `aggregateId`, `version`, `stateRev`, `state`, `createdAt`. STATE binds to the EventStore's `AGGREGATE` type.
- `SnapshotPolicy = { everyNEvents: number; stateRev: string; cacheSize?: number }`. Optional `cacheSize` defaults to `1000` per EventStore.
- `verifyOnRead?: number` on the EventStore constructor options, validated at construction (must be in `[0, 1]`; throw on invalid).
- Top-level `stateRev?: string` on the EventStore constructor options for the standalone-`saveSnapshot`-without-policy case. Resolution precedence: `snapshotPolicy.stateRev` wins when both set; throw `StateRevNotConfiguredError` if neither set when `saveSnapshot` is called.
- `getAggregate` extracts to `getAggregateWithSnapshot.ts`. Path: `skipSnapshot || !adapter.getLastSnapshot` → full replay (today's behavior). Otherwise: fetch snapshot; if missing → full replay; if `stateRev` mismatch → log first-time-per-key warn, full replay; if matched → fold `getEvents({ minVersion: snapshot.version + 1, maxVersion })` over `snapshot.state`. The returned `events` array contains only the delta when a snapshot was used (R6, R24).
- `verifyOnRead`: if probability > 0 and `Math.random() < probability`, also run the no-snapshot path and compare aggregates via `node:util` `isDeepStrictEqual`. On divergence, log a warn with both states' summary. **Cost amplification**: a positive sample pays the FULL no-snapshot replay path on top of the snapshot path — for a 10K-event aggregate at p=0.01, one in 100 reads pays ~10K-event latency. Production callers should use ε-level probabilities; CI tests can run `verifyOnRead: 1.0` because their fixtures are short.
- New errors: `SnapshotNotSupportedError` (thrown by `saveSnapshot` when adapter lacks `putSnapshot` and `allowNoop` is not `true`); `StateRevNotConfiguredError` (thrown when `saveSnapshot` is called and neither `snapshotPolicy.stateRev` nor top-level `stateRev` is set).
- `saveSnapshot` is bound as an arrow-function instance field in the constructor (load-bearing for U5 forwarding). Implementation lands in U3 (this unit defines the type; U3 wires the body).

**Patterns to follow:**
- `packages/core/src/eventStore/errors/aggregateNotFound.ts` for the error class shape.
- `packages/core/src/eventStore/eventStore.ts:177-296` for the arrow-function instance-field pattern (must mirror; class methods break U5 forwarding).
- `packages/event-storage-adapter-drizzle/src/common/walkErrorCauses.ts` for cause-chain inspection.

**Test scenarios:**
- *Happy path:* Snapshot at v100 with matching `stateRev`, stream 1–150 → `getAggregate` returns aggregate folded from snapshot.state + events 101–150; `events.length === 50`; `events[0].version === 101`; `lastEvent.version === 150`. **Disambiguates the origin R6 "delta" wording** — the events array contains the post-snapshot forward events, not a before-snapshot diff.
- *Happy path:* Snapshot at v100 with `lastEvent.version === 100` → `events.length === 0`; `aggregate === snapshot.state`.
- *Edge case:* Adapter has no `getLastSnapshot` → falls back to full replay; `events.length` matches stream length.
- *Edge case:* `getAggregate(id, { skipSnapshot: true })` → snapshot fetch is bypassed entirely; full replay with full events array.
- *Edge case:* `getAggregate(id)` on aggregate that has no snapshot yet → full replay (no extra reads beyond getEvents).
- *Edge case:* Snapshot exists at v50 but `getAggregate(id, { maxVersion: 30 })` → fall back to full replay from v1 with `maxVersion: 30`. Snapshot is unusable when asked for a past state.
- *Edge case:* `EventStore` constructor with `verifyOnRead: 1.5` throws; `verifyOnRead: -0.1` throws.
- *Edge case (stateRev precedence):* both `snapshotPolicy.stateRev: "1"` and top-level `stateRev: "2"` are set → snapshot put uses `"1"`; `saveSnapshot` outside policy uses `"1"` (snapshotPolicy wins); test asserts `state_rev` column on the written row.
- *Error path:* `stateRev` mismatch, first time for this `(eventStoreId, aggregateId)` → warn log fires; snapshot ignored; full replay returns correct aggregate.
- *Error path:* `stateRev` mismatch, second call for same `(eventStoreId, aggregateId)` in same process → debug log fires (no warn).
- *Error path:* `getLastSnapshot` throws → falls back to full replay; warn log; aggregate returned correctly.
- *Integration — verifyOnRead:* `verifyOnRead: 1.0` with consistent reducer → no divergence warn across 100 reads.
- *Integration — verifyOnRead (key-order):* aggregate constructed with reordered keys between paths must NOT trigger divergence (proves `isDeepStrictEqual` is order-insensitive vs the rejected `JSON.stringify` approach).
- *Integration — verifyOnRead:* `verifyOnRead: 1.0` with deliberately broken reducer → divergence warn fires.
- *Integration — verifyOnRead:* `verifyOnRead: 0` → second-path execution never happens (assert via spy on `getEvents`).
- *Type test:* `expectTypeOf(adapter.getLastSnapshot).toEqualTypeOf<((params: { eventStoreId: string; aggregateId: string }) => Promise<Snapshot<unknown> | undefined>) | undefined>()`.
- *Type test:* `Snapshot<MyAggregate>` preserves `MyAggregate` in the `state` field type.
- *Covers AE for §2 success criteria:* Sentinel CI test proves `verifyOnRead` catches a forgotten-`stateRev`-bump (reducer changed; stateRev unchanged; snapshot stale; verifyOnRead surfaces divergence at warn level).

**Verification:**
- All scenarios pass `pnpm test-unit` for the core package.
- `pnpm test-type` passes (`snapshot.type.test.ts` and `eventStore.type.test.ts`).
- `pnpm test-linter` passes; no new max-lines violations introduced.
- `pnpm test-circular` passes (no cycles introduced by the `snapshot/` subdirectory).

---

- U3. **`saveSnapshot` + synchronous policy trigger in `pushEvent`**

**Goal:** Implement `EventStore.saveSnapshot(aggregateId, options?)` with the dual-shape signature (bound as an arrow-function instance field). Wire the synchronous `snapshotPolicy` trigger into `pushEvent` with the per-aggregate-per-process LRU cache. Implement R13 throw-by-default + `allowNoop` opt-in. Implement R16 stateRev resolution + throw-when-not-configured.

**Requirements:** R10, R11, R12, R13, R16

**Dependencies:** U2.

**Files:**
- Create: `packages/core/src/eventStore/snapshot/snapshotPolicy.ts` (policy decision + LRU cache + putSnapshot dispatch; cache stores `Math.max(currentCacheVal, event.version)` on success)
- Create: `packages/core/src/eventStore/snapshot/saveSnapshot.ts` (the `saveSnapshot` method body; inline stateRev resolution)
- Create: `packages/core/src/eventStore/snapshot/saveSnapshot.unit.test.ts` (consolidated — covers both saveSnapshot module and its policy interaction)
- Modify: `packages/core/src/eventStore/eventStore.ts` (declare `saveSnapshot` field as **arrow-function instance field**; bind in constructor; integrate policy check at end of `pushEvent`)
- Modify: `packages/core/src/eventStore/eventStore.unit.test.ts` (add R10/R11/R12/R13/R16 scenarios)

**Approach:**
- `saveSnapshot(id, options?)` resolves `stateRev` inline: `snapshotPolicy?.stateRev ?? eventStoreConfig.stateRev ?? throw StateRevNotConfiguredError`. If options.state and options.version both supplied, write directly. Otherwise call `getAggregate` (with `skipSnapshot: true` to avoid recursion) and write the result.
- Adapter capability check: `typeof adapter.putSnapshot === 'function'`. If false: throw `SnapshotNotSupportedError` unless `options.allowNoop === true`, in which case log a warn (once per process) and return.
- Policy trigger in `pushEvent`: after the existing `onEventPushed` await (line 213-214 in current `eventStore.ts`), check `snapshotPolicy`. Compute `lastSnapshotVersion` from cache or from `getLastSnapshot`. If `event.version - lastSnapshotVersion >= everyNEvents`, attempt `putSnapshot` with `state = nextAggregate ?? (recompute via getAggregate({ skipSnapshot: true }))`. On success, update cache via `Math.max(cache.get(...) ?? 0, event.version)` (never regress; concurrent writers may have landed a higher version, but the local cache always points to a real snapshot). On failure, log warn and do NOT update cache.
- Cache: `Map<string, number>` keyed by `${eventStoreId}:${aggregateId}` with insertion-order eviction at `cacheSize` (default `1000`).
- `pushEvent` semantics: snapshot write happens BEFORE `pushEvent` resolves (origin R10 is explicit). Failure does NOT throw to the caller.
- **`saveSnapshot` is bound as an arrow-function instance field (NOT a class method)** — load-bearing for U5's direct field-assignment forwarding.

**Patterns to follow:**
- `packages/core/src/eventStore/eventStore.ts:187-216` for `pushEvent` shape — extend the post-event-pushed hook section.
- `packages/event-storage-adapter-drizzle/src/common/outbox/backoff.ts` for the warn-once-per-process pattern.

**Test scenarios:**
- *Happy path:* `saveSnapshot(id)` with no policy configured but top-level `stateRev: "1"` → invokes `getAggregate` once with `skipSnapshot: true`, then `putSnapshot({ stateRev: "1", state, version })`.
- *Happy path:* `saveSnapshot(id, { state: aggr, version: 50 })` → does NOT call `getAggregate`; calls `putSnapshot` directly.
- *Happy path:* `pushEvent` crosses `everyNEvents` threshold (e.g., everyNEvents=100, lastSnap=0, eventVersion=100) → `putSnapshot` called once, then `pushEvent` resolves.
- *Happy path:* `pushEvent` does not cross threshold (eventVersion=99) → no `putSnapshot` call.
- *Happy path (cache, max-aware):* Concurrent `putSnapshot(v100)` succeeds; another writer landed `putSnapshot(v200)` first; cache stores `max(0, 100) = 100` (not regressed below 100, but lags behind v200; next pushEvent re-evaluates correctly).
- *Edge case:* Cold cache miss → first `pushEvent` triggers `getLastSnapshot`; subsequent calls hit cache.
- *Edge case:* Cache eviction at insertion-order limit → least-recently-inserted aggregate falls out; next `pushEvent` for it pays a fresh read.
- *Edge case:* `pushEvent` with `prevAggregate` undefined and `event.version > 1` → `nextAggregate` is undefined; policy uses `getAggregate({ skipSnapshot: true })` to compute state; `putSnapshot` succeeds. **Cost note:** this path pays a full replay on every Nth pushEvent when consumers don't supply prevAggregate; documented in §6 cache-miss cost note. Implementer should advise high-throughput consumers to supply `prevAggregate` to `pushEvent` (covered in U12 docs).
- *Error path:* `saveSnapshot` against adapter with no `putSnapshot` and no `allowNoop` → throws `SnapshotNotSupportedError`.
- *Error path:* `saveSnapshot(id, { allowNoop: true })` against adapter with no `putSnapshot` → returns without throw; warn log fires once per process.
- *Error path:* `saveSnapshot` when neither `snapshotPolicy.stateRev` nor top-level `stateRev` is set → throws `StateRevNotConfiguredError`.
- *Error path:* Snapshot policy fires but `putSnapshot` rejects → `pushEvent` resolves successfully; warn log; cache NOT updated.
- *Integration:* `saveSnapshot` from inside an `onEventPushed` hook with `state: nextAggregate, version: event.version` → writes without redundant `getAggregate`; round-trip via `getAggregate` returns the snapshot-folded aggregate.
- *Integration:* Manual `saveSnapshot` call updates the cache via `Math.max`, so the next policy-triggered `pushEvent` sees the new lastSnapshotVersion without an extra read.
- *Integration (this-binding):* `const fn = eventStore.saveSnapshot; await fn(id);` (detached invocation) — does NOT throw on `this` of undefined. Proves the arrow-function-instance-field binding contract.

**Verification:**
- All scenarios pass `pnpm test-unit`.
- `pnpm test-linter` passes (max-lines stays under control because helpers were extracted in U2).

---

- U4. **`pushEventGroup` post-commit per-aggregate snapshot policy**

**Goal:** Extend the static `EventStore.pushEventGroup` method to evaluate `snapshotPolicy` per aggregate after the atomic group commits. Per-aggregate failures follow R11 (log + proceed; never fail the group).

**Requirements:** R14

**Dependencies:** U3.

**Files:**
- Modify: `packages/core/src/eventStore/eventStore.ts` (extend the static `pushEventGroup` body — after the existing `onEventPushed` `Promise.all`, run snapshot evaluation per grouped event)
- Modify: `packages/core/src/eventStore/eventStore.unit.test.ts` (add R14 scenarios)

**Approach:**
- After the existing `await Promise.all(... onEventPushed ...)` block (lines 90-100 in current `eventStore.ts`), add a per-grouped-event loop that:
  1. Reads the grouped event's `eventStore.snapshotPolicy` (if configured),
  2. Reuses the same threshold check from U3's `snapshotPolicy.ts` helper,
  3. Calls `putSnapshot` with the computed state (`nextAggregate` from the per-event reduce already computed in lines 69-88),
  4. Handles failures the same way `pushEvent` does (warn log, no cache update on failure; max-aware update on success).
- The atomic boundary is the adapter's `pushEventGroup` call (line 63-67); snapshot writes happen strictly outside it.
- Mixed policy: some grouped events have policy, others don't — only configured ones snapshot.

**Patterns to follow:**
- `packages/core/src/eventStore/eventStore.ts:42-109` for the existing `pushEventGroup` shape.
- U3's `snapshotPolicy.ts` for the threshold-check helper.

**Test scenarios:**
- *Happy path:* Group with two aggregates (different EventStores), both with `snapshotPolicy: { everyNEvents: 100 }`, both crossing threshold → two `putSnapshot` calls AFTER the atomic group commits.
- *Happy path — atomic boundary:* Group with one aggregate at threshold, group commit succeeds → snapshot write happens after; `adapter.pushEventGroup` is called exactly once with no snapshot row inside the transaction.
- *Edge case:* Group with one aggregate at threshold, the other not → exactly one `putSnapshot` call.
- *Edge case:* Group commit fails (adapter throws) → no snapshot writes happen; group failure propagates as today.
- *Error path:* Group commit succeeds, one per-aggregate `putSnapshot` rejects → group does NOT fail; warn log; the failed aggregate's cache is not updated; the other aggregate's snapshot succeeds.
- *Integration:* Per-aggregate cache keyed by `${eventStoreId}:${aggregateId}` is updated independently for each grouped event.

**Verification:**
- All scenarios pass via `pnpm test-unit`.
- The conformance harness (U11) replicates the `pushEventGroup` scenario across all four adapters as an end-to-end check.

---

- U5. **`ConnectedEventStore` forwarding**

**Goal:** Extend `ConnectedEventStore` to forward `saveSnapshot` to the wrapped `EventStore` via direct method-reference assignment. Confirm `snapshotPolicy` triggers fire identically when wrapped vs unwrapped. Confirm snapshot writes do NOT trigger message-channel publishes.

**Requirements:** R15

**Dependencies:** U3.

**Files:**
- Modify: `packages/core/src/connectedEventStore/connectedEventStore.ts` (declare `saveSnapshot` field; assign in constructor as direct method-reference forwarder; do NOT route through `publishPushedEvent`)
- Modify: `packages/core/src/connectedEventStore/connectedEventStore.unit.test.ts` (add R15 scenarios)

**Approach:**
- Direct method-reference assignment: `this.saveSnapshot = eventStore.saveSnapshot`. **Safe ONLY because U3 binds `saveSnapshot` as an arrow-function instance field** — class-method binding would lose `this` here. Document this dependency in code comments at the assignment site.
- For `pushEvent` snapshot policy: today's `connectedEventStore.pushEvent` rewrite calls `eventStore.pushEvent` and then `publishPushedEvent`. The snapshot write happens INSIDE `eventStore.pushEvent` (per U3), so it's already in the right order: event commit → snapshot put → pushEvent resolves → publish. No additional code in CES.

**Patterns to follow:**
- `packages/core/src/connectedEventStore/connectedEventStore.ts:115-144` for the existing forwarding pattern (direct field assignment for non-message-emitting methods).

**Test scenarios:**
- *Happy path:* `connectedEventStore.saveSnapshot(id)` → forwards to `eventStore.saveSnapshot`; round-trip via `getAggregate` returns the snapshot-folded aggregate.
- *Happy path:* CES wrapping an EventStore with `snapshotPolicy: { everyNEvents: 100 }` → `pushEvent` at threshold → exactly one `putSnapshot` call AND exactly one `publishMessage` call (snapshot does NOT publish).
- *Edge case:* CES `getAggregate` honors `skipSnapshot: true` (forwarded transparently).
- *Edge case:* CES `pushEventGroup` triggers per-aggregate snapshots post-commit (forwarded via the static method) and per-aggregate publishes (existing behavior). Snapshots do NOT add to publish count.
- *Integration:* Mock channel `publishMessage` spy + mock adapter `putSnapshot` spy → assertion that publishMessage call count === pushed-event count, regardless of snapshot writes.
- *Integration:* CES wrapping an EventStore that lacks adapter `putSnapshot` → `connectedEventStore.saveSnapshot` throws (matches U3 R13 behavior).
- *Integration (this-binding):* `const fn = connectedEventStore.saveSnapshot; await fn(id);` (detached invocation) — proves the forwarded reference still works.

**Verification:**
- All scenarios pass via `pnpm test-unit`.
- Type test: `connectedEventStore.saveSnapshot` is typed identically to `eventStore.saveSnapshot`.

---

- U6. **Drizzle common helpers (snapshot column types, projection helper, per-dialect upsert, shared Dialect type)**

**Goal:** Land the dialect-agnostic snapshot helpers under `packages/event-storage-adapter-drizzle/src/common/snapshot/`, and extract the shared `type Dialect = 'pg' | 'mysql' | 'sqlite'` from `common/outbox/fencedUpdate.ts` so both outbox and snapshot helpers reuse it.

**Requirements:** R3, R5 (mechanism), R20 (column shape commonality)

**Dependencies:** U2.

**Files:**
- Create: `packages/event-storage-adapter-drizzle/src/common/dialect.ts` (extracted shared `type Dialect = 'pg' | 'mysql' | 'sqlite'`)
- Modify: `packages/event-storage-adapter-drizzle/src/common/outbox/fencedUpdate.ts` (re-export `Dialect` from `common/dialect.ts` as `OutboxDialect` for backward compatibility, OR migrate call sites to import from `common/dialect.ts` directly — pick one in implementation)
- Create: `packages/event-storage-adapter-drizzle/src/common/snapshot/types.ts` (`SnapshotColumnTable` structural type — every field typed `unknown`, mirrors `OutboxColumnTable` from `common/outbox/selectColumns.ts`)
- Create: `packages/event-storage-adapter-drizzle/src/common/snapshot/selectColumns.ts` (`selectSnapshotColumns<T extends SnapshotColumnTable>(table: T)` returns snake_case projection preserving field types)
- Create: `packages/event-storage-adapter-drizzle/src/common/snapshot/upsertSnapshot.ts` (per-dialect upsert SQL builders dispatched on `dialect: Dialect`; mysql uses row-aliasing form, NOT deprecated `VALUES(...)`)
- Create: `packages/event-storage-adapter-drizzle/src/common/snapshot/upsertSnapshot.unit.test.ts` (per-dialect SQL fragment golden tests; no DB)

**Approach:**
- `Dialect` is a single union type used across outbox and snapshot helpers. Existing `OutboxDialect` becomes a re-export (or call sites migrate; either is acceptable).
- `SnapshotColumnTable` is a structural type with the columns the snapshot adapter reads/writes: `eventStoreId`, `aggregateId`, `version`, `stateRev`, `state`, `createdAt`. Each typed as `unknown` so dialect-specific column types fit.
- `selectSnapshotColumns(table)` returns `{ event_store_id: table.eventStoreId, aggregate_id: table.aggregateId, ... }` with the original field types preserved via `T['eventStoreId']` etc.
- `upsertSnapshot` is a function returning a drizzle SQL fragment + bind values, parametrized on `Dialect`. Dispatched via a small `switch` on `dialect`. Returns the same shape regardless of dialect so the per-dialect adapter just executes it.
- The mysql variant uses single-statement row-aliasing (`INSERT ... AS new ON DUPLICATE KEY UPDATE col = IF(new.version > version, new.col, col)` per non-key column). Two-statement fallback only if drizzle 0.45's `sql` template tag does not handle the row-alias clause.

**Patterns to follow:**
- `packages/event-storage-adapter-drizzle/src/common/outbox/selectColumns.ts:12-25` for the structural type + projection pattern.
- `packages/event-storage-adapter-drizzle/src/common/walkErrorCauses.ts` for any error classification on putSnapshot failures.

**Test scenarios:**
- *Happy path:* `upsertSnapshot({ dialect: 'pg', table, values })` returns SQL containing `ON CONFLICT (event_store_id, aggregate_id) DO UPDATE SET ... WHERE excluded.version > snapshots.version`.
- *Happy path:* `upsertSnapshot({ dialect: 'mysql', table, values })` returns SQL containing `INSERT ... AS new ON DUPLICATE KEY UPDATE ... new.version > version, new.col, col` for each non-key column. **Asserts NOT contains `VALUES(`** — guards against regression to the deprecated form.
- *Happy path:* `upsertSnapshot({ dialect: 'sqlite', table, values })` returns SQL identical-shape to pg.
- *Type test:* `selectSnapshotColumns` preserves field types `T['version']` etc.
- *Type test:* `Dialect` is the same union used by `fencedUpdate.ts` (no duplicate union definition reachable in the package).
- *Edge case:* `SnapshotColumnTable` accepts a table with extra non-required columns (extension OK).

**Verification:**
- `pnpm test-unit` passes for the per-dialect SQL golden tests.
- `pnpm test-type` passes (selectSnapshotColumns type preservation; Dialect is a single source of truth).
- `pnpm test-circular` passes.

---

- U7. **Drizzle pg adapter snapshot integration**

**Goal:** Implement `getLastSnapshot` and `putSnapshot` on the pg adapter. Add `snapshotColumns`, `snapshotTable`, `snapshotTableConstraints`, `PgSnapshotTableContract`, and the `snapshot?:` constructor option.

**Requirements:** R3, R4, R5, R20, R21, R25

**Dependencies:** U2, U6.

**Files:**
- Modify: `packages/event-storage-adapter-drizzle/src/pg/schema.ts`
- Modify: `packages/event-storage-adapter-drizzle/src/pg/contract.ts`
- Modify: `packages/event-storage-adapter-drizzle/src/pg/adapter.ts`
- Modify: `packages/event-storage-adapter-drizzle/src/pg/index.ts`
- Create: `packages/event-storage-adapter-drizzle/src/pg/snapshot.schema.type.test.ts`
- Modify: `packages/event-storage-adapter-drizzle/src/pg/adapter.unit.test.ts` (wire conformance suite from `@castore/lib-test-tools/snapshot-conformance` — this file may compile against the harness even before U11 is committed if U11 is interleaved with U7; planning suggests landing U6+U11 first then U7-U10 against a stable factory)

**Approach:**
- Schema: `snapshotColumns = { eventStoreId: text(...), aggregateId: text(...), version: integer(...), stateRev: text(...), state: jsonb(...).$type<unknown>(), createdAt: timestamp({ precision: 3, withTimezone: true }) }`. PK on `(event_store_id, aggregate_id)` via the constraints helper. Stable PK constraint name `castore_snapshot_pk`.
- `PgSnapshotTableContract` is a phantom-typed structural type identical in shape to `PgEventTableContract`.
- `getLastSnapshot({ eventStoreId, aggregateId })` performs a `SELECT ... FROM snapshotTable WHERE event_store_id = $1 AND aggregate_id = $2`. Maps to `Snapshot<unknown>` shape.
- `putSnapshot` calls `upsertSnapshot({ dialect: 'pg', table, values })` from common/snapshot/upsertSnapshot.ts.
- Constructor: adds `snapshot?: PgSnapshotTableContract` parallel to the existing `outbox?:` option.

**Patterns to follow:**
- `packages/event-storage-adapter-drizzle/src/pg/schema.ts:90-142` (outbox schema as the structural template).
- `packages/event-storage-adapter-drizzle/src/pg/contract.ts` for the contract type pattern with phantom dialect tag.
- `packages/event-storage-adapter-drizzle/src/pg/adapter.ts:51-82` (constructor option wiring).
- `docs/solutions/best-practices/multi-dialect-adapter-package-patterns-2026-04-18.md` for the falsy-aware nullable JSON handling guidance.

**Test scenarios** (in the per-dialect test file; the conformance harness in U11 covers most cross-dialect scenarios):
- *Happy path:* `putSnapshot({ ... version: 100 })`; `getLastSnapshot` returns the snapshot at v100.
- *Happy path:* `putSnapshot(v100)`; `putSnapshot(v200)`; `getLastSnapshot` returns v200.
- *Happy path (highest-version-wins):* `putSnapshot(v200)`; `putSnapshot(v100)`; `getLastSnapshot` returns v200.
- *Happy path (concurrency):* `Promise.all([putSnapshot(v100), putSnapshot(v200)])`; `getLastSnapshot` returns v200.
- *Happy path (state_rev):* `putSnapshot({ stateRev: "1" })`; round-trip via `getLastSnapshot` returns `stateRev: "1"`.
- *Edge case (falsy state):* `putSnapshot({ state: null })`, `state: false`, `state: 0`, `state: ''`, `state: { value: 0, label: '' }` — all preserved on round-trip.
- *Edge case (no row):* `getLastSnapshot` against an aggregate with no snapshot → returns `undefined`.
- *Schema type test:* `PgSnapshotTableContract` accepts a table extension but rejects a table with the wrong type for a required column (verify via `@ts-expect-error`).
- *Performance smoke (origin §2 SC):* 10K-event fixture stream with `snapshotPolicy: { everyNEvents: 100 }` lands one snapshot at v100; subsequent `getAggregate` reads the snapshot and the 9900-event delta — **assert latency drop > 10× vs cold replay** (`withSnapshot < cold/10`). If this is flaky in testcontainer pg, lengthen the fixture stream or switch to a wall-time-budget assertion; do not weaken the threshold.

**Verification:**
- `pnpm test-unit` for the drizzle-adapter package passes (testcontainer pg).
- `pnpm test-type`, `pnpm test-linter` pass.

---

- U8. **Drizzle mysql adapter snapshot integration**

**Goal:** Implement the same shape as U7 for mysql, using the **modern row-aliasing** upsert pattern (NOT deprecated `VALUES(...)`).

**Requirements:** R3, R4, R5, R20, R21, R25

**Dependencies:** U2, U6.

**Files:** mirror U7 structure for `mysql/`.

**Approach:**
- Schema column types: `state: json().$type<unknown>()`, `createdAt: datetime({ fsp: 3, mode: 'string' })`.
- `putSnapshot` calls the mysql variant of `upsertSnapshot`: `INSERT ... AS new ON DUPLICATE KEY UPDATE col = IF(new.version > version, new.col, col)` per non-key column. **Modern row-aliasing form, MySQL 8.0.20+; the deprecated `VALUES(...)` reference is not used.**
- If drizzle 0.45's `sql` template tag does not template `INSERT ... AS new` correctly (verify against testcontainer mysql), fall back to two-statement pattern: `INSERT IGNORE INTO snapshots ...; UPDATE snapshots SET ... WHERE event_store_id = ? AND aggregate_id = ? AND version < ?`. Document the fallback choice in code comments and in a follow-up `/ce-compound` learning. Either single-statement or two-statement is acceptable; deprecated `VALUES(...)` is not.

**Patterns to follow:**
- `packages/event-storage-adapter-drizzle/src/mysql/schema.ts` for outbox schema + dialect-specific defaults.
- `docs/solutions/integration-issues/drizzle-orm-api-gaps-multi-dialect-adapter-2026-04-18.md` for MySQL `RETURNING` workarounds and per-driver error wrapping (with the row-aliasing supersedure noted in the doc).

**Test scenarios:**
- Same scenarios as U7, executed against testcontainer mysql.
- *Edge case (mysql JSON unicode):* `putSnapshot({ state: { unicode: "héllo" } })` round-trip preserves UTF-8 with no `latin1` regression.
- *Performance smoke (§2 SC):* same 10× assertion.

**Verification:**
- `pnpm test-unit` passes.
- If two-statement fallback selected, code comment explains the choice and links the institutional doc.

---

- U9. **Drizzle sqlite adapter snapshot integration**

**Goal:** Implement the same shape as U7 for sqlite, respecting better-sqlite3's sync transaction model.

**Requirements:** R3, R4, R5, R20, R21, R25

**Dependencies:** U2, U6.

**Files:** mirror U7 structure for `sqlite/`.

**Approach:**
- Schema column types: `state: text({ mode: 'json' }).$type<unknown>()`, `createdAt: text` (ISO-8601).
- `putSnapshot` is a single `INSERT ... ON CONFLICT DO UPDATE SET ... WHERE excluded.version > snapshots.version` — no enclosing transaction needed (single statement is atomic).
- Single-writer model: sqlite carve-out for any concurrency tests in conformance is expected.

**Patterns to follow:**
- `packages/event-storage-adapter-drizzle/src/sqlite/schema.ts`.
- `packages/event-storage-adapter-drizzle/src/sqlite/adapter.ts:67-107` for the txQueue serialization pattern (only relevant if multi-statement work is needed).

**Test scenarios:**
- Same scenarios as U7, executed against in-process better-sqlite3.
- *Schema test (sqlite carve-out):* `PRAGMA index_list` does not return constraint names; verify the snapshot table's PK by walking `index_info` and matching column-set, NOT by name.
- *Performance smoke (§2 SC):* same 10× assertion.

**Verification:**
- `pnpm test-unit` passes (in-process better-sqlite3).
- `pnpm test-type`, `pnpm test-linter` pass.

---

- U10. **In-memory adapter snapshot integration**

**Goal:** Implement `getLastSnapshot`/`putSnapshot` on the in-memory adapter via a `Map`-based latest-only store keyed by `(eventStoreId, aggregateId)`.

**Requirements:** R3, R5, R22

**Dependencies:** U2.

**Files:**
- Modify: `packages/event-storage-adapter-in-memory/src/adapter.ts` (add `private snapshotStore: Map<string, Snapshot<unknown>>` field; bind `getLastSnapshot`/`putSnapshot` methods inline — file is already `eslint-disable max-lines` so adding ~30 LOC introduces no new violation)
- Modify: `packages/event-storage-adapter-in-memory/src/adapter.unit.test.ts` (wire conformance suite from `@castore/lib-test-tools/snapshot-conformance`)
- Modify: `packages/event-storage-adapter-in-memory/src/index.ts` (export anything needed by conformance)

**Approach:**
- Inline implementation in `adapter.ts` (no separate `snapshot/` subdirectory). The file is already exempted from max-lines via `/* eslint-disable max-lines */` at line 1, so adding ~30 LOC for the snapshot store + two methods does not introduce a new violation.
- `snapshotStore: Map<string, Snapshot<unknown>>` keyed by `${eventStoreId}:${aggregateId}`.
- `putSnapshot(params)` checks the existing entry's version; only writes if `params.version > existing.version`. Idempotent. Highest-version-wins.
- `getLastSnapshot(params)` returns the entry or `undefined`. No async work but returns `Promise` to match the contract.

**Patterns to follow:**
- `packages/event-storage-adapter-in-memory/src/adapter.ts` for the instance-field method binding pattern.

**Test scenarios:**
- Same shape as U7 happy/edge/error scenarios (mostly covered by U11 conformance harness).
- *Edge case (Map key collision):* two different `(eventStoreId, aggregateId)` pairs do not collide (e.g., eventStoreId='a', aggregateId='b:c' vs eventStoreId='a:b', aggregateId='c'). Add a key-encoding test that survives colon-in-id cases — pick a separator that cannot appear in IDs, OR use `Map<string, Map<string, Snapshot<unknown>>>` for nested keying.
- *Edge case (falsy state):* put({ state: null }), { value: 0, label: '' } → preserved on get.

**Verification:**
- `pnpm test-unit` passes.
- `pnpm test-type`, `pnpm test-linter`, `pnpm test-circular` pass.

---

- U11. **Conformance harness in `@castore/lib-test-tools` + per-adapter wiring**

**Goal:** Build `makeSnapshotConformanceSuite<A, T>(config)` analogous to `makeOutboxConformanceSuite`, hosted in `@castore/lib-test-tools` (NOT in the drizzle adapter's `__tests__/`). Wire it into all four adapter unit tests.

**Requirements:** R23, plus end-to-end coverage of R3, R5, R6, R7, R8, R9, R10, R11, R13, R14, R15, R19

**Dependencies:** U2, U3, U4, U5, U7, U8, U9, U10.

**Files:**
- Create: `packages/lib-test-tools/src/snapshot-conformance/index.ts` (re-exports `makeSnapshotConformanceSuite`, fixtures)
- Create: `packages/lib-test-tools/src/snapshot-conformance/makeSnapshotConformanceSuite.ts` (factory)
- Create: `packages/lib-test-tools/src/snapshot-conformance/fixtures.ts` (counter event store + counter reducer for length-N stream construction)
- Create: `packages/lib-test-tools/src/snapshot-conformance/snapshot-conformance.type.test.ts` (factory boundary type proofs)
- Modify: `packages/lib-test-tools/package.json` (add `./snapshot-conformance` to the `exports` map)
- Modify: `packages/event-storage-adapter-drizzle/src/pg/adapter.unit.test.ts` (invoke conformance suite from the new sub-entrypoint)
- Modify: `packages/event-storage-adapter-drizzle/src/mysql/adapter.unit.test.ts`
- Modify: `packages/event-storage-adapter-drizzle/src/sqlite/adapter.unit.test.ts`
- Modify: `packages/event-storage-adapter-in-memory/src/adapter.unit.test.ts`

**Approach:**
- Factory signature: `makeSnapshotConformanceSuite<A extends EventStorageAdapter, T extends SnapshotColumnTable>(config: { dialectName: 'pg' | 'mysql' | 'sqlite' | 'in-memory'; setup: () => Promise<{ adapter: A; db?: ...; snapshotTable?: T; connectedEventStore: ConnectedEventStore<...>; eventStore: EventStore<...>; reset: () => Promise<void>; deleteSnapshotRow?: (...) => Promise<void>; uniqueConstraintExists?: (...) => Promise<boolean> }>; teardown: () => Promise<void> })`. Mirrors the outbox factory shape.
- Shared fixtures: counter event store + counter reducer (an aggregate that just counts events).
- The factory describes one `describe(\`${dialectName} snapshots — conformance\`, ...)` block; assertions are dialect-agnostic.
- Per-dialect helpers (`backdateCreatedAt`, `deleteSnapshotRow`, etc.) live in the per-dialect `setup()` closure, NOT in the factory.
- Sqlite carve-out for cross-connection concurrency tests: explicit `it.skipIf(dialectName === 'sqlite')` with a docstring rationale.
- Cross-aggregate primitive (origin §2 SC): a scenario that does `putSnapshot` for two different aggregates, then asserts the SQL `SELECT aggregate_id, state, version FROM snapshots WHERE event_store_id = ?` returns both rows in all four backends. (In-memory asserts via `Map.values()` filtered by event_store_id key prefix.)
- **Lib-test-tools sub-entrypoint check:** verify that adding `./snapshot-conformance` to the package's `exports` map does not require updating the `event-storage-adapter-drizzle`-scoped ESLint `CASTORE_INTERNAL_IMPORT_REGEX`. The regex is package-scoped, so it should not. Confirm with a cross-package import probe; delete the probe after verification.

**Patterns to follow:**
- `packages/event-storage-adapter-drizzle/src/__tests__/outboxConformance.ts:71-138` for factory shape, setup contract, and shared fixtures.
- `docs/solutions/best-practices/outbox-conformance-suite-patterns-2026-04-24.md` for the design principles.

**Test scenarios** (the conformance suite enumerates these; this list ensures the factory covers them):
- *Happy path:* round-trip put/get; multiple state shapes (object, primitive, falsy field).
- *Happy path:* highest-version-wins under sequential writes.
- *Happy path:* in-process `Promise.all([putSnapshot(v100), putSnapshot(v200)])` → highest version wins.
- *Happy path:* end-to-end `getAggregate` returns delta-only `events` after a snapshot lands; full-replay path returns full events when `skipSnapshot: true`.
- *Edge case:* `getLastSnapshot` returns `undefined` for an aggregate with no snapshot.
- *Edge case (falsy state):* state with `{ value: 0, flag: false, label: '' }` round-trips byte-equal.
- *Edge case (cross-aggregate primitive):* two aggregates each with one snapshot → `SELECT aggregate_id, state, version FROM snapshots WHERE event_store_id = ?` returns both rows. (Skipped on in-memory; in-memory asserts via Map.values filtered by event_store_id prefix.)
- *Edge case (state_rev mismatch):* put with `stateRev: "1"`; configure EventStore with `stateRev: "2"`; `getAggregate` falls back to full replay; first-mismatch warn log fires; second mismatch logs at debug.
- *Edge case (stateRev precedence):* both `snapshotPolicy.stateRev` and top-level `stateRev` set; assert snapshotPolicy wins on the persisted `state_rev` column.
- *Error path:* `saveSnapshot` against adapter with no `putSnapshot` and no `allowNoop` → throws `SnapshotNotSupportedError`. (Built via a stub adapter.)
- *Error path:* `saveSnapshot(id, { allowNoop: true })` against same stub → no throw; warn log fires once per process.
- *Error path (snapshotPolicy + putSnapshot rejection):* mock the adapter to reject; `pushEvent` succeeds; warn log; cache not updated.
- *Integration (snapshotPolicy):* `pushEvent` crosses `everyNEvents` threshold → `putSnapshot` called once before `pushEvent` resolves.
- *Integration (pushEventGroup):* group with two aggregates each crossing threshold → both `putSnapshot` calls happen post-commit; group commit and adapter `pushEventGroup` happen exactly once.
- *Integration (CES no-publish-on-snapshot):* CES wrapping the adapter with a spy on `channel.publishMessage` → snapshot writes do NOT increment publish count.
- *Integration (verifyOnRead):* `verifyOnRead: 1.0` with consistent reducer → no divergence warn across N reads. With deliberately broken reducer → divergence warn fires. With reordered keys between paths → no divergence (proves `isDeepStrictEqual` is order-insensitive).
- *Performance smoke (origin §2 SC):* 10K-event fixture stream with `snapshotPolicy: { everyNEvents: 100 }`; **assert latency drop > 10×** (`withSnapshot < cold/10`). Per-dialect timeout set to mysql worst-case (~30s).
- *SQLite carve-out:* explicit `skipIf` on cross-connection concurrency tests with docstring rationale.

**Verification:**
- All four adapter `*.unit.test.ts` files invoke the factory with their own setup closure.
- `pnpm test-unit` from each adapter package passes.
- Type-test boundary file (`snapshot-conformance.type.test.ts`) compiles via `pnpm test-type`.
- `pnpm test-circular` passes (no runtime cycle).
- The sqlite carve-out is a single explicit `skipIf` with a docstring.

---

- U12. **Documentation rewrite + migration guidance + drizzle adapter README**

**Goal:** Rewrite `docs/docs/3-reacting-to-events/5-snapshots.md` from "userland convention via bus listener" to "framework feature, configure `snapshotPolicy`". Update the drizzle adapter README with a new section covering snapshot exports per dialect, mirroring the existing outbox section. Add migration guidance for the `getAggregate.events` semantic shift (R24). Add a `stateRev` checklist for reducer changes (R17, R18). Document the `verifyOnRead` cost amplification.

**Requirements:** R17, R18, R24, R26, plus drizzle adapter README parity with the outbox section

**Dependencies:** U2–U11.

**Files:**
- Rewrite: `docs/docs/3-reacting-to-events/5-snapshots.md`
- Modify: `packages/event-storage-adapter-drizzle/README.md` (new section pointing at `snapshotColumns`/`snapshotTable` exports per dialect, mirroring the existing outbox section — **unconditional**, not a follow-up)
- Possibly modify: `docs/sidebar.json` if structure changes

**Approach:**
- Replace existing snapshots page content with:
  - Overview of snapshots as a framework feature.
  - When to use them (long-lived aggregates, command-handler hot paths).
  - How to enable: drizzle migration adds the snapshot table; configure `snapshotPolicy: { everyNEvents, stateRev }`.
  - Configuring `verifyOnRead` for dev/CI — including **cost amplification callout**: "verifyOnRead samples pay the FULL no-snapshot replay path on top of the snapshot path. For long-stream stores, production probability should be ε-level (`0.001` or lower); CI tests can run `1.0` because their fixtures are short."
  - Manual `saveSnapshot` for backfill and operator use, including the `onEventPushed`-hook recommended pattern (`saveSnapshot(id, { state: nextAggregate, version: event.version })`) to avoid redundant `getAggregate` calls.
  - **Recommendation for high-throughput consumers:** supply `prevAggregate` to `pushEvent` so the policy trigger doesn't need a full replay on every Nth event.
  - **stateRev checklist for reducer changes** — explicit step-by-step.
  - **Silent-corruption risk callout** — named risk if you forget to bump `stateRev`; mitigation is `verifyOnRead` in CI catching the divergence.
  - **getAggregate events-array semantic shift** — what changed, who is affected, how to recover full-history shape via `skipSnapshot: true`.
  - **Backfill chunking recommendation** — for long-stream finance aggregates, the backfill `saveSnapshot` loop can be a multi-hour operation; recommend chunking by aggregate-cardinality buckets and rate-limiting concurrent calls to avoid overloading the storage backend.
- Drizzle adapter README addition: a "Snapshots" section with per-dialect schema-export pointers (`snapshotColumns`, `snapshotTable`, `snapshotTableConstraints`), constructor option (`snapshot?:`), and a link to the user-facing concept page.

**Patterns to follow:**
- `docs/docs/3-reacting-to-events/` existing pages for tone and length.
- `packages/event-storage-adapter-drizzle/README.md` existing outbox section.

**Test scenarios:**
- Test expectation: none -- documentation rewrite, no behavioral change.

**Verification:**
- Docusaurus build succeeds.
- All in-doc links resolve (no 404s).
- Code snippets parse.
- Manual review by a maintainer.

---

## System-Wide Impact

- **Interaction graph:** The snapshot policy fires inside `EventStore.pushEvent` and `EventStore.pushEventGroup`. `ConnectedEventStore` forwards `saveSnapshot` and inherits the `pushEvent` snapshot timing (commit → snapshot put → resolve → publish). `onEventPushed` hooks continue to fire after event commit and BEFORE snapshot writes (snapshot is post-hook in the synchronous flow). No new hook surface in v1.
- **Error propagation:** `putSnapshot` failures are isolated — they never propagate up through `pushEvent` or `pushEventGroup`. They are observable via warn-level logs only.
- **State lifecycle risks:** Stale snapshots (rev mismatch) are silent fall-back at read time, with first-time-per-key warn logs. Cache misses during cold start cost one extra read per aggregate. Cache invalidation is keyed off successful `putSnapshot` only — failures leave the cache in its prior state. **Multi-process redundant-trigger pattern** (cold caches in concurrent Lambdas) is acknowledged in §7 as an open implementer-judgment item.
- **API surface parity:** `EventStore`, `ConnectedEventStore`, `EventStorageAdapter` all gain new surface. `EventStore.saveSnapshot` is mirrored on `ConnectedEventStore` via direct method-reference assignment (load-bearing on the arrow-function-instance-field binding).
- **Integration coverage:** The conformance harness in `@castore/lib-test-tools` (U11) is the primary cross-layer coverage. Per-unit unit tests cover the core changes; the harness covers the contract end-to-end across all four adapter implementations.
- **Unchanged invariants:** `pushEvent` semantics (atomic event commit, version-based OCC), `getAggregate` return shape (still `{ aggregate, events, lastEvent }`), `pushEventGroup` atomic boundary, `ConnectedEventStore` message-channel publishing semantics for events. Only the `events` array's *semantic content* changes when a snapshot is used (R6, R24).
- **Phase A→B export-flip:** `@castore/core` ships Phase A's new types/methods as internal-only (not exported from `index.ts`). Public exports flip on with Phase B's first adapter PR. Avoids exposing a publicly-callable API that throws `SnapshotNotSupportedError` against every adapter during the inter-phase window.

---

## Risks & Dependencies

> *Note: the §6 table mixes plan-time risks (introduced by the implementation choices in this plan) with origin-inherited risks (carried from the requirements doc). Plan-time entries are marked `[plan-time]`; the rest are origin-inherited.*

| Risk | Mitigation |
|------|------------|
| `[plan-time]` MySQL row-aliasing pattern doesn't template correctly under drizzle 0.45's `sql` tag | Open Question / Deferred to Implementation flagged; fall back to two-statement `INSERT IGNORE` + conditional `UPDATE` if templating fails. Test against testcontainer mysql before declaring U8 done. **Deprecated `VALUES(...)` is explicitly rejected as a path.** |
| `[plan-time]` `eventStore.ts` already at the 200-line max-lines cap; new snapshot logic compounds the violation | Helpers extracted to `packages/core/src/eventStore/snapshot/` per U2–U4. Inline additions to `eventStore.ts` itself are kept to method bindings + thin delegations. Expected net inline addition ~50–80 LOC (re-estimated post-deepening); file already has `/* eslint-disable max-lines */` so this is a maintainer-aesthetic concern, not a CI gate. |
| `[origin §6]` `ConnectedEventStore.publishPushedEvent` adds publish latency on Nth event when snapshot policy fires synchronously inside `pushEvent` | Origin §6 acknowledges the trade explicitly; documented in U12 docs. Async-after-publish is a v1.1 candidate. |
| `[origin §6]` Sqlite single-writer model breaks any cross-connection concurrency assertion in conformance | Sqlite carve-out is explicit per U11 — `it.skipIf(dialectName === 'sqlite')` with docstring rationale. |
| `[origin §6]` In-process `Promise.all` is insufficient for true cross-connection concurrency on pg/mysql; the conformance suite's "highest-version-wins" assertion may be too lax | Origin §7 flagged this; conformance covers in-process approximation in v1, with explicit comment that cross-connection coverage is deferred. |
| `[plan-time]` Adapter test runtime dominated by mysql testcontainer | Per-test timeouts sized to mysql worst-case (~30s); already the precedent in outbox conformance. |
| `[origin §6]` Forgotten `stateRev` bump silently corrupts state in production | Three-layer mitigation: docs (R17, R18), `verifyOnRead` opt-in (R19), §2 sentinel CI test catching the case. |
| `[plan-time]` Cache eviction under high aggregate cardinality (more than `cacheSize` aggregates active) → repeated cold reads on the hot path | `cacheSize` is configurable per EventStore. Default 1000 is sized for typical command-handler workloads. Documented in U12 docs and the §6 cache-miss cost note. |
| `[plan-time]` Falsy state values silently dropped by a `if (!state)` regression in adapter code | Conformance harness includes explicit falsy-state round-trip tests across all adapters. |
| `[plan-time, deferred]` Multi-process cache redundant-trigger pattern (Lambda concurrent invocations) | §7 "From 2026-04-29 plan review" — implementer/reviewer chooses between documented-bound or modulo-jitter before Phase A's `pushEvent` integration ships. |
| `[plan-time, deferred]` Unconditional `getLastSnapshot` on every `getAggregate` for opt-out consumers | §7 "From 2026-04-29 plan review" — preserved as origin-accepted; implementer surfaces to user if hot-path measurement shows the round-trip dominates. |
| `[plan-time]` `verifyOnRead` cost amplification — positive samples pay full replay path | Documented in §4 Key Decisions, U2 Approach, and U12 docs. Production guidance: ε-level probability (`0.001` or lower) on long-stream stores. CI uses `1.0` on short fixtures. |
| `[plan-time]` Cross-package conformance harness import was unresolved in the original plan | Resolved in deepening: harness lives in `@castore/lib-test-tools/snapshot-conformance` (new sub-entrypoint). All four adapter test files import from there. No internal `__tests__/` cross-package import. |

### Dependencies

- `@castore/core` (peer dependency for adapters) — adapter changes depend on the core contract changes from U2.
- `@castore/lib-test-tools` (devDependency for adapter tests) — gains a new sub-entrypoint (`./snapshot-conformance`); package.json `exports` map updated in U11.
- drizzle-orm 0.45+ (peer dependency for the drizzle adapter) — no version bump required.
- Postgres / MySQL / SQLite testcontainer images — already in use for outbox.
- No new runtime dependencies. No new native dependencies.
- No new sub-entrypoints in the drizzle adapter (snapshots ride inside the existing `pg`, `mysql`, `sqlite` exports). One new sub-entrypoint in `@castore/lib-test-tools` (`./snapshot-conformance`).

---

## Phased Delivery

### Phase A — Core, internal-only (U2, U3, U4, U5)

Land the core contract, the read-path snapshot integration, the synchronous policy trigger + manual `saveSnapshot` API, the `pushEventGroup` semantics, and the `ConnectedEventStore` forwarding. **The new symbols (`saveSnapshot`, `snapshotPolicy`, `verifyOnRead`, `Snapshot`, `SnapshotPolicy`, `SnapshotNotSupportedError`, `StateRevNotConfiguredError`) are NOT exported from `@castore/core`'s public `index.ts` during Phase A.** Internal-only landing means the unit tests exercise the new surface directly via internal imports, but consumers of `@castore/core` cannot call the new methods. This avoids shipping a publicly-callable API that throws `SnapshotNotSupportedError` against every adapter during the inter-phase window. Phase A may land as a single PR or a cluster within one PR train.

Before closing Phase A, the implementer/reviewer resolves the `[deferred]` items in §7 "From 2026-04-29 plan review" (multi-process cache redundant-trigger; unconditional `getLastSnapshot`).

### Phase B — Adapters + public-export flip (U6, U7, U8, U9, U10, U11)

Land the dialect-agnostic helpers in `common/snapshot/`, the three drizzle dialect implementations, the in-memory adapter, and the conformance harness in `@castore/lib-test-tools`. **Phase B's first adapter PR also flips the public exports on in `@castore/core/src/index.ts`** (the export-flip is a one-line change; gating it on the first adapter PR keeps the public API and a working end-to-end implementation in lockstep).

The conformance harness lands alongside the first adapter implementation (U7 or U10) so the factory shape can be designed against a real adapter, then re-applied to the others. Subsequent adapter PRs in Phase B import from the now-stable harness.

### Phase C — Documentation (U12)

Rewrite the user-facing snapshots concept page, update the drizzle adapter README, document the `verifyOnRead` cost amplification and the backfill chunking recommendation. With Phase C merged, the feature is shippable and documented end-to-end.

Each phase can land as one or more PRs depending on review preference. Phase A → Phase B → Phase C is the sequencing constraint; within each phase, units can interleave.

---

## Documentation Plan

- **U12 owns user-facing docs** — `docs/docs/3-reacting-to-events/5-snapshots.md` is fully rewritten.
- **U12 also owns the drizzle adapter README update** — unconditional, not a follow-up PR.
- Migration guide entry — short note in the next minor-release CHANGELOG explaining the `getAggregate.events` semantic shift, the new opt-in `snapshotPolicy` config, and the `stateRev` discipline.
- A `/ce-compound` learning capturing G-02 patterns (highest-version-wins upsert per dialect including the MySQL row-aliasing supersedure of the deprecated `VALUES(...)`, optional-contract typing on `EventStore.saveSnapshot`, conformance scenarios that proved load-bearing) is recommended after Phase C ships.
- `AGENTS.md` and `CLAUDE.md` — no changes required.

---

## Operational / Rollout Notes

- **Schema migration ownership:** Consumers of `@castore/event-storage-adapter-drizzle` own their drizzle migrations and run `drizzle-kit` themselves — same pattern as the outbox table. v1 ships the schema definition; consumers add the table to their migration set.
- **Configuration rollout:** `snapshotPolicy` is opt-in. Existing consumers see no behavior change unless they configure it. Consumers who configure it without a corresponding migration will see warn logs from `putSnapshot` failures (table doesn't exist) but events still commit.
- **Backfill recommendation for existing long aggregates at first deploy:** Document a sample script using `EventStore.saveSnapshot(aggregateId)` in U12, including chunking guidance. The naive backfill (loop over all aggregates, call `saveSnapshot(id)`) can be a multi-hour operation for long-stream finance aggregates because each call replays the full stream once. Recommend chunking by aggregate cardinality bucket and bounding concurrency.
- **Monitoring signals:** Operators should monitor warn-level logs from `putSnapshot` failures (R11) and from `stateRev` first-time mismatches (R9). High mismatch rate indicates a forgotten `stateRev` bump after a reducer change. High `putSnapshot` failure rate indicates table misconfiguration.
- **`verifyOnRead` in CI:** Document the sentinel pattern — a CI test that toggles `verifyOnRead: 1.0` after a deliberate reducer change (without a `stateRev` bump) and asserts the divergence warn fires.
- **`verifyOnRead` in production:** Use ε-level probabilities (`0.001` or lower) on long-stream stores. The cost amplification (positive samples pay full replay) makes higher probabilities a latency hazard.
- **Rollback:** The schema addition is additive; rolling back the code release does not require dropping the snapshot table. Stale snapshots remain in the table; a future deploy can drop them via a one-off operator script.

---

## Sources & References

- **Origin requirements:** [`specs/requirements/2026-04-28-g02-snapshots-drizzle-requirements.md`](../requirements/2026-04-28-g02-snapshots-drizzle-requirements.md)
- **Gap analysis research:** `specs/requirements/2026-04-16-castore-es-gap-analysis-research.md` §G-02 (lines 1161–1245) — design sketch and original alternatives
- **Outbox precedent (structural twin):**
  - `specs/requirements/2026-04-19-g01-transactional-outbox-requirements.md`
  - `specs/plans/2026-04-19-001-feat-g01-transactional-outbox-plan.md`
  - PRs #5 (relay core), #6 (conformance), #7 (docs)
- **Institutional learnings:**
  - `docs/solutions/integration-issues/drizzle-orm-api-gaps-multi-dialect-adapter-2026-04-18.md` — MySQL `RETURNING` gap, better-sqlite3 sync transaction model, per-driver error wrapping (note: `VALUES(...)` reference inside `ON DUPLICATE KEY UPDATE` is deprecated as of MySQL 8.0.20; this plan uses row-aliasing instead — capture in follow-up `/ce-compound`)
  - `docs/solutions/best-practices/multi-dialect-adapter-package-patterns-2026-04-18.md` — four-pattern playbook
  - `docs/solutions/best-practices/outbox-conformance-suite-patterns-2026-04-24.md` — conformance harness shape
  - `docs/solutions/developer-experience/pnpm10-eslint9-native-deps-allow-list-2026-04-18.md`
  - `docs/solutions/workflow-issues/ce-resolve-pr-feedback-parallel-dispatch-file-overlap-2026-04-19.md`
- **Core shape references:**
  - `packages/core/src/eventStore/eventStore.ts` (concrete class, methods bound as arrow-function instance fields)
  - `packages/core/src/connectedEventStore/connectedEventStore.ts` (forwarding pattern)
  - `packages/core/src/eventStorageAdapter.ts` (interface, will gain optional methods)
- **Drizzle adapter shape references:**
  - `packages/event-storage-adapter-drizzle/src/{pg,mysql,sqlite}/{schema,contract,adapter,index}.ts`
  - `packages/event-storage-adapter-drizzle/src/common/{walkErrorCauses,outbox/}.ts`
  - `packages/event-storage-adapter-drizzle/src/__tests__/{outboxConformance,outboxFaultInjection}.ts` (pattern reference; the snapshot harness lives in `@castore/lib-test-tools`, not here)
- **External:** drizzle-orm 0.45 docs for `ON CONFLICT` and `ON DUPLICATE KEY UPDATE` syntax variations across dialects.
