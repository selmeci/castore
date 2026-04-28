---
title: 'feat: G-01 outbox conformance + fault-injection'
type: feat
status: completed
date: 2026-04-24
origin: specs/plans/2026-04-19-001-feat-g01-transactional-outbox-plan.md
parent_units: [U9, U10]
---

# feat: G-01 outbox conformance + fault-injection

## Relationship to parent plan

This is a **derived sub-plan** carved out of
[2026-04-19-001-feat-g01-transactional-outbox-plan.md](./2026-04-19-001-feat-g01-transactional-outbox-plan.md)
after the relay-core sub-plan shipped (U4–U8). All load-bearing decisions
from the parent — Key Technical Decisions, Scope Boundaries, Requirements
Trace, Risks, Output Structure, System-Wide Impact — are **inherited by
reference and not restated here**. Read the parent first; this doc only
adds what the conformance + fault-injection slice needs on top.

### What is already on the branch (`feat/g01-transactional-outbox`)

| Commit | Unit | Landed |
|---|---|---|
| `2f5cd32` | Parent U1 — core outbox-capability short-circuit | `OUTBOX_ENABLED_SYMBOL`, `OUTBOX_GET_EVENT_SYMBOL`, `isOutboxEnabledAdapter`, `publishPushedEvent` short-circuit |
| `335d30e` | Parent U2 — outbox schema + shared utilities | `outboxColumns` / `outboxTable` / `outboxTableConstraints` + `OutboxTableContract<Dialect>` per dialect; `common/outbox/{backoff,scrubber,types}.ts` |
| `a0008d3` | Parent U3 — adapter `outbox` option + atomic write | Each dialect's adapter accepts `outbox?`, sets capability symbols, and writes event + outbox row atomically; per-dialect `outbox/getEventByKey.ts` |
| `86c6250` | Parent U4 — per-dialect claim primitives + fencing | `pg/outbox/claim.ts` (advisory-lock), `mysql/outbox/claim.ts` (earliest-per-aggregate + FOR UPDATE SKIP LOCKED), `sqlite/outbox/claim.ts`, `common/outbox/fencedUpdate.ts` |
| `f3099ec` | Parent U5 — publish path | `relay/publish.ts`, `relay/envelope.ts`, `relay/errors.ts` |
| `3251c8d` | Parent U6 — lifecycle | `relay/runOnce.ts`, `relay/runContinuously.ts`, `relay/retry.ts`, `relay/hooks.ts` |
| `e1bdfcd` | Parent U7 — factory + admin | `relay/factory.ts`, `relay/admin.ts`, `relay/assertOutboxEnabled.ts` |
| `e3de08d` | Parent U8 — sub-entrypoint wiring | `./relay` added to `package.json` exports + ESLint allow-list on lines 94 and 208; `relay/index.ts` barrel; `relay/relay.type.test.ts` |
| `d115927`, `f314145`, `b387737`, `73b5aac` | Relay-core code review follow-ups | 13 review findings resolved; `OutboxRowNotFoundError`, `UnsupportedChannelTypeError`, `OutboxPublishTimeoutError`, `InvalidPublishTimeoutError`; `withTimeout` helper; `publishTimeoutMs` option with factory-time invariant; supervisor distinguishes programming errors; `deleteRow` default-safe; 181 unit tests green |

The conformance suite and fault-injection helper do not exist yet — this
plan delivers them.

## Scope of this plan

Deliver the cross-dialect conformance suite and the fault-injection
integration test that together close parent success criterion §2
("zero-loss under induced failure"). Covers parent units **U9 and U10**.

- U9 lives at `packages/event-storage-adapter-drizzle/src/__tests__/outboxConformance.ts`
  with a type test in the same directory.
- U10 lives at `packages/event-storage-adapter-drizzle/src/__tests__/outboxFaultInjection.ts`.
- Both suites get wired into the existing per-dialect adapter test files
  (`{pg,mysql,sqlite}/adapter.unit.test.ts`) alongside the already-wired
  `makeAdapterConformanceSuite`.

### Explicitly out of scope (deferred to sibling sub-plans)

- **Docs + runtime recipes + README migration note** — landed alongside U9/U10
  in PR #7 against the same `feat/g01-outbox-conformance` branch (parent unit
  U11). No separate `g01-outbox-docs-plan.md` sub-plan was carved out; the
  earlier deferral note here was written before that decision and is preserved
  for trail. The parent plan tracks U11 as completed.
- **G-03 consumer dedup** — separate brainstorm + plan cycle (parent Scope
  Boundaries).
- **v1.1 candidates** — parent §7.
- **`@castore/lib-test-tools` relocation** — the parent Key Decisions
  explicitly keep the suite in the drizzle adapter package. The origin
  doc's R28 reference to `lib-test-tools` is inaccurate; this plan (and
  the parent) override it.

This sub-plan **is** the shippability gate for G-01's write-side half of
N4. Once landed, the parent's "zero-loss under induced failure" success
criterion is closable and the feature becomes eligible for production
traffic (gated by G-03 per the parent's scope boundary).

## Inherited decisions (pointers, not restatements)

Don't reopen these while executing this plan. If execution discovers one
is wrong, pause and raise it as an Open Question, don't silently diverge.

- **Fencing-token rule is mandatory** — parent Key Decisions + parent R14.
- **DB-authoritative timestamps** — every UPDATE/INSERT uses the dialect's
  server-time function; `vi.useFakeTimers()` does not travel into the DB.
  Manual `UPDATE outbox SET claimed_at = NOW() - INTERVAL …` is the only
  way to simulate TTL advancement in a conformance test.
- **Per-aggregate FIFO primitives** — pg `pg_try_advisory_xact_lock`,
  mysql earliest-per-aggregate `FOR UPDATE SKIP LOCKED`, sqlite
  single-writer. sqlite is **exempt** from cross-aggregate parallelism
  and two-concurrent-relay scenarios per parent §2 success criteria.
- **Pointer-shaped outbox rows** — the relay looks up the source event
  via `adapter[OUTBOX_GET_EVENT_SYMBOL]` at publish time. Nil-row dead
  path is tested by deleting the event row between commit and claim.
- **Container lifecycle owned by the per-dialect file** — the conformance
  factory does NOT own pg/mysql testcontainer start/stop. Matches the
  existing `makeAdapterConformanceSuite` shape (`conformance.ts:12-24`).
- **Conformance suite home** — `packages/event-storage-adapter-drizzle/src/__tests__/`,
  alongside `conformance.ts`. Do not relocate.
- **`publishTimeoutMs < claimTimeoutMs` invariant** — enforced at factory
  construction by `InvalidPublishTimeoutError`. Conformance tests that
  tune these knobs must respect the invariant; any test that wants to
  exercise the "publish exceeds TTL" failure mode has to accept the
  timeout path (bus rejected, retry scheduled) rather than trying to
  construct the unsound state.

## Open Questions carried from parent (resolved)

All three OQs carried from the parent are closed. Resolutions live in
`docs/solutions/best-practices/outbox-conformance-suite-patterns-2026-04-24.md`:

- **OQ1 — Final numeric defaults**: ratified. Empirical 10k-row pg drain
  on default options shows throughput ~176 rows/sec, per-row turnaround
  p50 6.29ms / p95 7.69ms / p99 19.39ms — every percentile sits ~four
  orders of magnitude inside `publishTimeoutMs = 150,000ms`. See
  [`outbox-conformance-suite-patterns-2026-04-24.md` § Empirical drain — OQ1](../../docs/solutions/best-practices/outbox-conformance-suite-patterns-2026-04-24.md#empirical-drain--oq1).
  Procedure committed as `it.skip(...)` at
  `packages/event-storage-adapter-drizzle/src/pg/adapter.unit.test.ts`
  under `describe('drizzle pg outbox relay — numeric defaults drain
  benchmark (OQ1, manual)', …)`.
- **OQ2 — pg advisory-lock collision measurement**: closed as a write-up.
  Lock-id derivation (`hashtext(name||':'||id)`) and the same-aggregate
  vs. hashtext-bucket collision modes are documented; the N=2 correctness
  case is already pinned by `pg/outbox/claim.unit.test.ts:199-233`. An
  empirical N>2 rate harness is itself deferred — adds flake surface
  without raising any §2 bar. See
  [`outbox-conformance-suite-patterns-2026-04-24.md` § pg advisory-lock collision behavior — OQ2](../../docs/solutions/best-practices/outbox-conformance-suite-patterns-2026-04-24.md#pg-advisory-lock-collision-behavior--oq2).
- **OQ3 — Fault-injection determinism on mysql vs pg**: closed as a
  write-up. Top-line finding: zero pass/fail divergence — every U10
  scenario runs byte-identically across pg + mysql + sqlite. Captures
  the implementation-level divergences the relay normalises (claim
  primitive, fencedUpdate result-shape, dialectNow precision, driver
  lock-error surface, `DrizzleQueryError` wrapping) and notes the
  sqlite carve-out + mysql-driven 30s timeout sizing. See
  [`outbox-conformance-suite-patterns-2026-04-24.md` § mysql vs pg fault-injection divergence — OQ3](../../docs/solutions/best-practices/outbox-conformance-suite-patterns-2026-04-24.md#mysql-vs-pg-fault-injection-divergence--oq3).

## Requirements Trace (subset of parent)

Only the R#s this sub-plan closes or verifies end-to-end. Full context
for each is in parent §1.

| Parent R# | Concern | Unit |
|---|---|---|
| R7 | `pushEventGroup` atomicity under outbox mode | U9 |
| R9 | Outbox schema shape (DDL introspection) | U9 |
| R10 | Nil-row dead path | U9 |
| R11 | Registry validation + runtime missing-registry dead | U9 |
| R12 | Per-dialect claim primitives (all three dialects exercised) | U9 |
| R13 | Claim lease TTL recovery | U9 |
| R14 | **Fencing-token correctness under real driver-level race** | U9, U10 |
| R15 | Exponential backoff knobs | U9 |
| R16 | `dead_at` transition + FIFO block + `onDead` | U9 |
| R17 | `last_error` cap + scrubber at real DB column boundary | U9 |
| R18 | `runOnce` / `runContinuously` / `stop` end-to-end | U9 |
| R19 | Hooks swallow semantics | U9 |
| R20 | `retryRow` return shape + `deleteRow` | U9 |
| R22 | Liveness query shapes (age + depth + dead-count per dialect) | U9 |
| R24 | Multi-dialect coverage (pg + mysql + sqlite at v1 parity) | U9, U10 |
| R28 | **Conformance suite + fault-injection** | U9, U10 |
| §2 SC | Success criteria — zero-loss under induced failure | U10 |

Explicitly **not** re-verified here (closed at unit-test layer in U1–U8,
or deferred to U11 docs sub-plan): R1–R6, R8, R21, R23, R25, R26, R27,
R29, R30, R31.

## Implementation Units

Units keep their parent identifiers (U9, U10) so the Requirements Trace
stays stable across the whole G-01 effort. **Goal, Files, Approach,
Patterns to follow, Test scenarios, and Verification for each unit are
specified in full in the parent plan — do NOT restate them in this doc.**
This section only adds slice-specific overrides, post-relay-core updates,
and sequencing.

---

- U9. **Outbox conformance suite + per-dialect wiring.**

See parent §Implementation Units > Unit 9. Dependencies: U1–U8 (all
landed on the branch).

**Slice-specific overrides and additions** (on top of the parent spec):

- Factory signature is fully parametric over the dialect's bound `claim`
  primitive so the same suite runs against all three dialects. Shape:
  `makeOutboxConformanceSuite<A extends EventStorageAdapter & OutboxCapability>({ dialectName, adapterClass, setup, teardown })`
  where `setup` returns `{ adapter, outboxTable, connectedEventStore, channel, claim, reset }`.
  The `claim` closure is dialect-specific (`(args) => claimPg({...})` etc.);
  the per-dialect test file owns binding it to that file's `db` + `outboxTable`.
- **Scenarios added by the relay-core code review** (beyond the parent's
  list — these cover regressions the unit tests couldn't fully prove):
  - `publishTimeoutMs` end-to-end: slow `publishMessage` (> `publishTimeoutMs`)
    rejects with `OutboxPublishTimeoutError`, routes through retry, and
    does NOT escape the `claimTimeoutMs` window (no TTL-reclaim double-publish).
  - `retryRow` TOCTOU under real driver serialization: concurrent
    `claim()` + `retryRow()` on the same row — only one wins, the other
    errors typed (either `RetryRowClaimedError` or `OutboxRowNotFoundError`).
  - `deleteRow` default-safe path: refuses rows with live `claim_token`;
    `{ force: true }` succeeds.
  - Supervisor programming-error abort: inject a `TypeError` into the
    bound `claim` closure; assert `runContinuously` rejects rather than
    loops (new behavior from relay-core review fix).
  - **pg `.returning()` path and mysql `[ResultSetHeader, fields]` path
    for `fencedUpdate`** exercised via real drivers — sqlite-only
    fencing tests from U4 do not prove the dialect-specific normalization.
  - `dialectNow(pg) = NOW()` and `dialectNow(mysql) = NOW(3)` produce
    values consistent with the server clock; unit tests only covered
    the sqlite `strftime` form.
  - **mysql concurrent-claim test** (symmetric to the pg one in U4):
    two concurrent `claim()` calls against the same aggregate return
    disjoint rowsets via `FOR UPDATE SKIP LOCKED` + the earliest-
    per-aggregate subquery.
- **Scenario removed from the parent's list** (no longer applicable after
  relay-core review):
  - Parent's "dead row blocks newer same-aggregate rows; unblocked by
    `retryRow` success or `deleteRow`" still holds, but the relay-core
    fix (d115927) made dead rows release `claim_token`, so the
    unblocking test must assert `retryRow` works **without** `force:true`
    for a dead row. Any leftover assumption that dead rows retain their
    claim_token is stale.
- **Scenarios where the parent's spec needs a precision tightening**:
  - "Graceful `stop()` completes within `pollingMs + in-flight publish time`"
    — post-relay-core, the bound is `pollingMs + min(publishTimeoutMs, in-flight publish time)`
    because `publishTimeoutMs` is the hard cap. The parent spec predates
    that knob.
  - "Liveness queries (age, depth, dead-count) return expected shapes"
    — parent mentions this without naming the three SQL shapes. Execute
    with the three queries from R22 (pg `NOW() - MIN(created_at)` for
    age, `COUNT(*)` for depth, `COUNT(*) WHERE dead_at IS NOT NULL` for
    dead-count) and assert dialect-portable behavior.
- **DDL introspection for schema-contract checks** (parent approach note):
  - pg: `SELECT conname FROM pg_constraint WHERE conname = 'outbox_aggregate_version_uq'`
    to confirm the unique constraint exists after `reset()`.
  - mysql: `SHOW INDEX FROM castore_outbox WHERE Key_name = 'outbox_aggregate_version_uq'`.
  - sqlite: `PRAGMA index_list(castore_outbox)` + `PRAGMA index_info(…)`.
  - No dependency on `drizzle-kit` migrations — raw SQL introspection only.

**Execution note:** Not test-first in the parent sense — this IS the
test. Execution posture: **characterization-first against the landed
relay-core implementation**. Each scenario is written to pin the
observed behavior first, then any discovered bug gets a dedicated fix
commit on top with a failing-test-first pattern.

**Patterns to follow** (beyond the parent's list):
- `packages/event-storage-adapter-drizzle/src/__tests__/conformance.ts` —
  the factory signature, setup/teardown split, container-lifecycle
  ownership contract, and scenario-per-describe layout. Do not
  sub-class; compose.
- Existing per-dialect test files' testcontainer wiring at file scope
  (`pg/adapter.unit.test.ts:37-59`, `mysql/adapter.unit.test.ts:30-55`,
  `sqlite/adapter.unit.test.ts:20-51`). The conformance suite invocation
  is appended after the existing `makeAdapterConformanceSuite` call.
- `docs/solutions/integration-issues/drizzle-orm-api-gaps-multi-dialect-adapter-2026-04-18.md`
  — the "mysql UPDATE lacks `.returning()`" gotcha still applies to the
  conformance suite's UPDATE-based assertions.

**Verification** (beyond the parent's list):
- `pnpm --filter @castore/event-storage-adapter-drizzle test-unit` green
  with the full matrix. Expected minimum: ~20 scenarios × 3 dialects =
  ~60 new tests on top of the existing 181.
- `pnpm --filter @castore/event-storage-adapter-drizzle test` (type +
  unit + linter + circular) green.
- No existing test from U1–U8 is broken. The conformance suite is
  strictly additive.

---

- U10. **Fault-injection integration test.**

See parent §Implementation Units > Unit 10. Dependencies: U9 (this plan).

**Slice-specific overrides and additions**:

- The helper is a factory, not a fixture: `makeOutboxFaultInjectionSuite({ dialectName, setup, teardown })`
  receives the same `setup` shape as U9 and invokes it afresh per
  scenario so the crash-simulation has an isolated relay instance.
- **Crash simulation shape**: rather than kill the Node process, the
  harness drops all references to the current `relay` object (letting
  GC claim it) while leaving the outbox DB rows in place. A fresh
  `createOutboxRelay({...})` call then observes the post-"crash" state.
  `state.stopping` is not used — the goal is to model abrupt
  termination, not graceful shutdown.
- **Scenarios added by the relay-core code review**:
  - Crash during `handleFailure` itself: publish fails, relay gets
    killed mid-`fencedUpdate` (attempts++). Next relay instance
    observes the row with `claim_token` still populated; TTL reclaim
    applies; the eventual publish count is bounded by `maxAttempts + 1`
    per event.
  - Crash after `publishTimeoutMs` fires but before retry runs: timer
    rejection in-flight, relay killed. Next relay observes the row
    with the original `claim_token` (the post-timeout fencedUpdate
    never ran); TTL reclaim picks it up.
- **Scenario tightening** on top of the parent's 100/30% guidance:
  - 100 events × 10 aggregates is the right shape. Kill rates: 30% at
    "post-claim-pre-publish", 30% at "post-publish-pre-mark",
    remaining 40% process normally. Assertion: at the end, every
    committed event has `processed_at IS NOT NULL` OR `dead_at IS NOT NULL`
    — no stuck rows. Per-aggregate bus-delivery order preserved for
    successful deliveries.
  - `maxAttempts = 3` + `failureRate = 100%` scenario: every row lands
    in `dead_at` with the expected scrubbed `last_error`; `onDead`
    fired the expected count; `onFail` fired `(maxAttempts - 1)` times
    per row.
- **sqlite-specific carve-out**: the parent §2 success criteria exempt
  sqlite from cross-aggregate parallelism and two-concurrent-relay
  scenarios. U10 applies the same carve-out: sqlite runs the single-relay
  fault-injection scenarios only. Documented in the suite's jsdoc.

**Execution note:** Test-first on the new scenarios added here. The
parent-spec scenarios are characterization-first against the landed
relay-core (U4–U8) so any pass/fail divergence between dialects becomes
explicit rather than quietly papered over.

**Patterns to follow** (beyond the parent's list):
- The parent's reference to the sqlite `concurrent pushEventGroup` test
  (`sqlite/adapter.unit.test.ts:232-373`) still applies — use
  `Promise.all` with overlapping transactions.
- **Do NOT use `vi.useFakeTimers()` to advance the DB clock**. Fake
  timers only affect Node's event loop; DB-authoritative timestamps
  (`NOW()`, `NOW(3)`, `strftime`) are unaffected. For TTL advancement
  use a manual SQL `UPDATE outbox SET claimed_at = NOW() - INTERVAL '10 minutes'`
  pattern per dialect.
- Deterministic failure injection via `vi.spyOn(channel, 'publishMessage').mockImplementationOnce(…)`
  remains the right primitive for bus-side failures. Claim-side
  failures inject into the bound `claim` closure the harness passes
  to `createOutboxRelay`.

**Verification** (beyond the parent's list):
- `pnpm --filter @castore/event-storage-adapter-drizzle test-unit` green
  on all three dialects' fault-injection suite.
- No stuck rows: every non-dead row has `processed_at IS NOT NULL` in
  the final state of every scenario.
- Per-aggregate FIFO preserved on the bus mock across all successful
  deliveries, for every scenario where the bus actually received
  messages (duplicates permitted; reordering not).
- Resource cleanup: every scenario's `afterEach` confirms there are no
  leaked timers, open DB connections, or unhandled promise rejections
  (Vitest reports these by default; make the failure mode loud if
  the helper ever leaks).

### Dependency DAG (this plan)

```
U9 ──► U10
```

U9 has no in-plan dependencies (builds directly on landed U1–U8 + the
relay-core review fix-commits). U10 depends on U9 because fault-injection
reuses the conformance suite's `setup` shape and testcontainer wiring.

Serial execution is the right shape: these two units share test
scaffolding that's easiest to iterate on when one is stable before the
other builds on it. Serial subagent dispatch is acceptable if context
pressure becomes a concern; parallel dispatch is NOT appropriate because
both units modify the three per-dialect `adapter.unit.test.ts` files.

## Slice-specific Risks (add to parent Risks table)

Risks already captured in the parent §Risks table still apply — the ones
below are specific to the conformance + fault-injection slice.

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Testcontainer flakiness on CI (pg + mysql bring-up timeouts, port conflicts between conformance and fault-injection runs) | Medium | Medium | Existing `pg/adapter.unit.test.ts` and `mysql/adapter.unit.test.ts` already run testcontainers reliably — reuse their `beforeAll` / `afterAll` lifecycle verbatim. Do NOT spin a second container per suite; the file-level container is reused for both `makeAdapterConformanceSuite`, `makeOutboxConformanceSuite`, and `makeOutboxFaultInjectionSuite`. |
| Fault-injection scenarios produce different pass/fail between dialects for the same logical scenario (driver-specific error wrapping, timing tolerance drift) | Medium | Medium | U10 test assertions use the post-relay-core error class surface (`OutboxPublishTimeoutError`, etc.) rather than message-string matching. Where a scenario is genuinely dialect-specific (e.g. mysql `ER_LOCK_WAIT_TIMEOUT` vs pg `40001` serialization failure), fork the scenario explicitly rather than paper over. |
| Suite execution time balloons (3 dialects × 20+ scenarios × testcontainer overhead) and slows `pnpm test` below the fast-feedback threshold | Medium | Low | Use `vitest`'s concurrent scheduling within a describe block where the scenarios don't share DB state. Keep conformance scenarios independent (each does its own `reset()` in `beforeEach`). Fault-injection scenarios are deliberately sequential because they share relay-instance lifecycle. |
| Non-deterministic TTL tests (`claimedAt` arithmetic vs server clock drift) flake under load | Medium | Medium | TTL-reclaim scenarios use a manual `UPDATE` to backdate `claimed_at` rather than real time + `vi.useFakeTimers()`. The parent plan's "DB-authoritative timestamps" decision forces this. |
| The `publishTimeoutMs < claimTimeoutMs` invariant test produces a false sense of security because it only asserts factory-time rejection, not the at-runtime guarantee the invariant is designed to uphold | Medium | Medium | U9 includes an at-runtime scenario: `publishTimeoutMs = claimTimeoutMs - 10ms`, publish takes `claimTimeoutMs - 5ms`. Timeout fires first; no TTL-reclaim race. A future refactor that bypasses the factory would be caught by this runtime test, not just the constructor guard. |
| Conformance suite becomes a snapshot of current behavior rather than a contract: passes today but does not catch a subtle future regression | Low | Medium | Every scenario asserts a specific mechanism (fencing-token affected-row count, `last_error` shape, `onDead` invocation count) rather than end-state shape alone. Prefer "publish spy called N times with matching payload" over "bus received 3 messages". |
| Fault-injection helper's "drop relay reference + GC" crash simulation is approximate — Node's GC is non-deterministic, and some in-flight promises may resolve after the reference drops, mutating DB state that the "next relay" was supposed to find stale | Medium | High | The helper awaits all pending promises from the "dying" relay's operations before declaring the crash complete, but does NOT call `stop()` (that would defeat the purpose). Uses an internal `AbortController` to signal the dying relay's in-flight work. Where a scenario genuinely requires `await` all pending work, it's a graceful-shutdown scenario, not a crash scenario — move it to U9. |

## Success Criteria (narrower than parent §2)

A shippable conformance + fault-injection slice requires:

- All U9 + U10 scenarios pass on pg + mysql + sqlite, respecting the
  sqlite carve-outs the parent §2 already documents.
- `pnpm --filter @castore/event-storage-adapter-drizzle test` green
  (type + unit + circular + linter).
- No regression to the 181 passing unit tests from U1–U8.
- **Fencing-token correctness under real driver-level race** proved on
  every dialect — not just sqlite with fake timers.
- **Zero-loss under induced failure** proved on pg + mysql under the
  U10 fault-injection scenarios. This closes the parent's §2 success
  criterion that the relay-core sub-plan could not close alone.
- Final numeric defaults (claim/publish TTLs, backoff knobs, polling
  cadence) either ratified or adjusted, with the final values captured
  in a `docs/solutions/` learning under `best-practices/`.
- Cross-dialect assertions respect driver-specific behavior without
  paper-over: where mysql and pg genuinely differ (error wrapping,
  TTL precision, RETURNING availability), the test file says so.

This slice is still **not alone** sufficient for production traffic —
G-03 consumer dedup remains mandatory per the parent's Scope Boundaries.
But after this slice plus U11 (docs), G-01 is feature-complete for the
write-side half of N4.

## Sources & References

- **Parent plan:** [2026-04-19-001-feat-g01-transactional-outbox-plan.md](./2026-04-19-001-feat-g01-transactional-outbox-plan.md)
- **Relay-core sub-plan (prerequisite, shipped):** [2026-04-20-002-feat-g01-outbox-relay-core-plan.md](./2026-04-20-002-feat-g01-outbox-relay-core-plan.md)
- **Parent requirements:** [2026-04-19-g01-transactional-outbox-requirements.md](../requirements/2026-04-19-g01-transactional-outbox-requirements.md)
- **Open PR (relay-core):** https://github.com/selmeci/castore/pull/5
- **Existing conformance factory to mirror:** `packages/event-storage-adapter-drizzle/src/__tests__/conformance.ts`
- **Existing testcontainer wiring to reuse:**
  - `packages/event-storage-adapter-drizzle/src/pg/adapter.unit.test.ts` (lines 37-59)
  - `packages/event-storage-adapter-drizzle/src/mysql/adapter.unit.test.ts` (lines 30-55)
  - `packages/event-storage-adapter-drizzle/src/sqlite/adapter.unit.test.ts` (lines 20-51)
- **Institutional learnings that apply to this slice specifically:**
  - `docs/solutions/integration-issues/drizzle-orm-api-gaps-multi-dialect-adapter-2026-04-18.md` — MySQL `.returning()` gap still shapes which UPDATEs the conformance suite can directly observe.
  - `docs/solutions/best-practices/multi-dialect-adapter-package-patterns-2026-04-18.md` — shared conformance factory pattern; container lifecycle owned by per-dialect file.
- **Relay-core code-review artifacts** (drove several new scenarios in U9/U10):
  - `.context/compound-engineering/ce-code-review/2026-04-24-selfreview/` — per-reviewer JSON with evidence

## Next Steps

Shipped. U9 + U10 conformance + fault-injection landed across pg + mysql
+ sqlite on branch `feat/g01-outbox-conformance` via
[selmeci/castore PR #6](https://github.com/selmeci/castore/pull/6); the
three OQs above were closed in five follow-up commits on the same branch
(skipped pg drain benchmark + OQ1/OQ2/OQ3 doc write-ups + this status
flip). Parent §2 success criterion ("zero-loss under induced failure")
is closed for the write-side half of N4. Production-traffic gating
remains G-03 consumer dedup per the parent's Scope Boundaries.
