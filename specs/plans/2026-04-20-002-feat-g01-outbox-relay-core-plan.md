---
title: 'feat: G-01 outbox relay core (drizzle adapter)'
type: feat
status: completed
date: 2026-04-20
origin: specs/plans/2026-04-19-001-feat-g01-transactional-outbox-plan.md
parent_units: [U4, U5, U6, U7, U8]
---

# feat: G-01 outbox relay core (drizzle adapter)

## Relationship to parent plan

This is a **derived sub-plan** carved out of
[2026-04-19-001-feat-g01-transactional-outbox-plan.md](./2026-04-19-001-feat-g01-transactional-outbox-plan.md)
after Phase A + Phase B shipped. All load-bearing decisions from the parent
— Key Technical Decisions, Scope Boundaries, Requirements Trace, Risks,
Output Structure, System-Wide Impact — are **inherited by reference and not
restated here**. Read the parent first; this doc only adds what the
relay-core slice needs on top.

### What is already on the branch (`feat/g01-transactional-outbox`)

| Commit | Unit | Landed |
|---|---|---|
| `2f5cd32` | Parent U1 — core outbox-capability short-circuit | `OUTBOX_ENABLED_SYMBOL`, `OUTBOX_GET_EVENT_SYMBOL`, `isOutboxEnabledAdapter`, `publishPushedEvent` short-circuit |
| `335d30e` | Parent U2 — outbox schema + shared utilities | `outboxColumns` / `outboxTable` / `outboxTableConstraints` + `OutboxTableContract<Dialect>` per dialect; `common/outbox/{backoff,scrubber,types}.ts` |
| `a0008d3` | Parent U3 — adapter `outbox` option + atomic write | Each dialect's adapter accepts `outbox?`, sets capability symbols, and writes event + outbox row atomically; per-dialect `outbox/getEventByKey.ts` |

The relay itself does not exist yet — this plan delivers it.

## Scope of this plan

Deliver the outbox relay as the `@castore/event-storage-adapter-drizzle/relay`
sub-entrypoint. Covers parent units **U4, U5, U6, U7, U8**. No change to
core, no conformance-suite extension (that's the next sub-plan), no docs
(the sub-plan after that).

### Explicitly out of scope (deferred to sibling sub-plans)

- **Conformance suite + fault-injection tests** — deferred to sub-plan
  `…-g01-outbox-conformance-plan.md` (parent units U9, U10).
- **Docs + runtime recipes + README migration note** — deferred to sub-plan
  `…-g01-outbox-docs-plan.md` (parent unit U11).
- **v1.1 candidates** — see parent §7.

Per-unit tests inside this plan are still required (`*.unit.test.ts` files
alongside each module), just not the cross-dialect testcontainer
conformance suite. A relay built without the conformance suite is NOT
shippable — the sub-plan follow-up is load-bearing.

## Inherited decisions (pointers, not restatements)

Don't reopen these while executing this plan. If execution discovers one is
wrong, pause and raise it as an Open Question, don't silently diverge.

- **Fencing-token rule is mandatory** — parent Key Decisions + parent R14.
- **Raw SQL acceptable for dialect-specific locking** — parent Key Decisions.
- **Pointer-shaped outbox rows** — parent Key Decisions; the relay looks up
  the source event via `adapter[OUTBOX_GET_EVENT_SYMBOL]` at publish time.
- **DB-authoritative timestamps** — parent Key Decisions; every UPDATE /
  INSERT that touches a timestamp uses the dialect's server-time function.
- **Per-aggregate FIFO primitives** — parent Key Decisions: pg uses
  `pg_try_advisory_xact_lock`, mysql uses earliest-per-aggregate
  `FOR UPDATE SKIP LOCKED`, sqlite relies on its single-writer model.
- **Probe inside `publishPushedEvent`, per-invocation** — parent Key
  Decisions; already implemented in U1, don't re-architect here.
- **`retryRow` carries a structured warning return** — parent R20 and Key
  Decisions; the shape `{ warning: 'at-most-once-not-guaranteed', rowId, forced }`
  is committed.
- **`assertOutboxEnabled` is an explicit helper, not a constructor side
  effect** — parent Key Decisions.

## Open Questions carried from parent (to resolve during execution)

The parent plan's "Deferred to Implementation" list still applies for the
relay slice. The ones this sub-plan must resolve:

- **pg advisory-lock delimiter / hashtext collision mitigation** — parent
  §Open Questions, Deferred. Decide between `\x00` delimiter, XOR of
  `hashtext(name)` with `hashtext(id)`, or keep `:`-delimited with
  documented aggregate_name constraint. The collision is a throughput
  concern, not a correctness one; pick the cheapest option that avoids
  `:`-in-eventStoreId false serialization.
- **Concrete Drizzle expression for `pg_try_advisory_xact_lock` + MySQL
  composite-key `FOR UPDATE SKIP LOCKED`**. Raw `sql\`…\`` fragments are
  pre-approved; final string shape is a U4 implementation-time choice.
- **Exact claim-eligibility predicate shape** (parent R14) — must be
  cheap on the `(aggregate_name, aggregate_id, version)` index on every
  dialect. Verified by `EXPLAIN` during U4 implementation (no plan-time
  micro-benchmarks required).
- **Numeric defaults** (`baseMs`, `ceilingMs`, `maxAttempts`,
  `claimTimeoutMs`, polling cadence per dialect). Starting points from
  parent R15 / R18. Final values tuned during U6 implementation; the
  conformance-suite sub-plan validates them.
- **Typed capability-extension pattern for future gaps** — parent Open
  Questions. Stays deferred past this sub-plan; do NOT introduce a typed
  `capabilities?` field on `EventStorageAdapter` here.

## Requirements Trace (subset of parent)

Only the R#s this sub-plan closes. Full context for each is in parent §1.

| Parent R# | Concern | Unit |
|---|---|---|
| R1, R4 | `./relay` sub-entrypoint + peerDependencies | U8 |
| R10 | Nil-row dead path | U5 |
| R11 | Registry validation + missing-entry dead path | U5, U7 |
| R12, R13 | Per-dialect claim primitives + TTL + DB-authoritative time | U4 |
| R14 | FIFO exclusion + fencing-token rule | U4, U6 |
| R15 | Exponential backoff + knobs | U6 (consumes the `backoff.ts` from parent U2) |
| R16 | Dead transition + FIFO block + `onDead` | U6 |
| R17 | `last_error` cap + scrub | U6 (consumes the `scrubber.ts` from parent U2) |
| R18 | `runOnce` / `runContinuously` / `stop` | U6 |
| R19 | `onDead`, `onFail` hooks + swallow semantics | U6 |
| R20 | `retryRow` + `deleteRow` + structured warning return | U7 |
| R21 | Caller-side authz (doc-only acknowledgment; no code surface) | U7 |
| R23 | `assertOutboxEnabled(adapter, { mode })` | U7 |
| R25 | Driver allow-list respected (same as adapter) | U4 |

## Implementation Units

Units keep their parent identifiers (U4…U8) so the Requirements Trace stays
stable across the whole G-01 effort. **Goal, Files, Approach, Patterns to
follow, Test scenarios, and Verification for each unit are specified in
full in the parent plan — do NOT restate them in this doc.** This section
only adds slice-specific overrides and sequencing.

- [x] **U4 — Per-dialect claim primitives + FIFO exclusion + fencing-token
  UPDATE helpers.** See parent §Implementation Units. **Execution note:**
  test-first on the fencing-token path (parent says so). Dependencies:
  parent U3 is already landed, so the capability symbols + atomic write
  are available. Shipped (PR #5).

- [x] **U5 — Relay publish path + envelope reconstruction + nil-row dead.**
  See parent §Implementation Units. Dependencies: U4 (this plan) +
  parent U1/U3 (landed). Shipped (PR #5).

- [x] **U6 — Relay lifecycle (runOnce, runContinuously, retry, hooks,
  graceful shutdown).** See parent §Implementation Units. **Consumes**
  `common/outbox/backoff.ts` and `common/outbox/scrubber.ts` (already
  shipped by parent U2 — do NOT re-create them). **Execution note:**
  test-first on (a) backoff math, (b) hook-swallow semantics. Dependencies:
  U4, U5 (this plan). Shipped (PR #5).

- [x] **U7 — Admin API + registry validation + `assertOutboxEnabled` helper.**
  See parent §Implementation Units. Dependencies: U6 (this plan). Shipped (PR #5).

- [x] **U8 — Relay sub-entrypoint wiring (exports map + ESLint allow-list
  + index barrel).** See parent §Implementation Units. **Must update**
  `eslint.config.js` `no-restricted-imports` regex on **both** line
  ~94 and line ~208 (per parent R1 + the
  `docs/solutions/developer-experience/pnpm10-eslint9-native-deps-allow-list-2026-04-18.md`
  learning). Dependencies: U7 (this plan). Shipped (PR #5).

### Dependency DAG (this plan)

```
U4 ──┬─► U5 ──► U6 ──► U7 ──► U8
     └────────────────────────┘
```

U4 has no in-plan dependencies (builds directly on landed parent U3).
U5 depends on U4's fencing helpers + the landed `getEventByKey` lookup.
U6 depends on U4 and U5 for the retry/release-claim UPDATE paths. U7
depends on U6 for the relay state shape. U8 is pure wiring and sequences
last because it exports the public surface the prior units built.

Serial execution is the right shape: per the parent plan's Execution
Strategy table, these units have hard dependencies between them, so a
parallel subagent dispatch would require rework. Serial subagent dispatch
(one per unit) is still acceptable if context-window pressure becomes a
concern.

## Slice-specific Risks (add to parent Risks table)

Risks already captured in the parent §Risks table still apply — the ones
below are specific to executing the relay slice in isolation from the
conformance suite.

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Per-unit tests pass but inter-unit behaviour drifts (fencing token isn't exercised by U5 / U6 / U7 unit tests even though each individually passes) | High | High | Every UPDATE path in U5/U6/U7 uses the same `common/outbox/fencedUpdate.ts` helper from U4; the helper's own unit tests cover the fenced-no-op return. Additional reassurance comes from the conformance sub-plan; do NOT ship this sub-plan to production without it |
| `runContinuously` supervisor swallows a programming error (not just a DB blip) and loops forever | Medium | Medium | U6 logs at `console.error` for every caught exception; document in code comments that the supervisor is ONLY for transient DB failures; programming-error coverage falls on the conformance sub-plan's fault-injection scenarios |
| Tuned numeric defaults (`claimTimeoutMs`, `pollingMs`, `baseMs`, `ceilingMs`) drift from values the conformance suite will eventually exercise | Medium | Low | Pick defaults inside U6 that are conservative (long claim TTL, short polling); the conformance sub-plan is permitted to adjust them within the R15/R18 envelope |
| U8 ESLint regex edit breaks builds elsewhere in the monorepo (the regex appears on TWO lines — forgetting one silently breaks linting in the other scope) | Medium | Medium | Parent Context & Research calls this out explicitly (`eslint.config.js` lines 94 + 208). U8 Verification must `pnpm test-linter` at the repo root, not just in the drizzle package |

## Success Criteria (narrower than parent §2)

A shippable relay-core slice requires:

- All U4 / U5 / U6 / U7 / U8 unit tests green on sqlite (no testcontainer
  dependency at the unit-test layer; containerised pg/mysql coverage lives
  in the conformance sub-plan).
- `pnpm --filter @castore/event-storage-adapter-drizzle test` passes
  (type + unit + circular + linter).
- `pnpm test-linter` at the repo root passes (catches the double-regex
  edit from U8).
- Cross-package probe: a fresh file outside `@castore/event-storage-adapter-drizzle`
  can `import { createOutboxRelay } from '@castore/event-storage-adapter-drizzle/relay'`
  without ESLint or TypeScript errors.
- The fencing-token property holds in unit tests: a mutated `claim_token`
  between claim and `fencedUpdate` yields `affectedRows === 0`.
- Graceful `stop()` resolves cleanly under the unit-test harness within
  `pollingMs + typical publishMessage time` bound.

The parent's "Zero-loss under induced failure" success criterion **is not
closable by this sub-plan alone** — it requires the fault-injection test
(conformance sub-plan U10). That is expected and called out here so the
status of the parent plan stays honest.

## Sources & References

- **Parent plan:** [2026-04-19-001-feat-g01-transactional-outbox-plan.md](./2026-04-19-001-feat-g01-transactional-outbox-plan.md)
- **Parent requirements:** [2026-04-19-g01-transactional-outbox-requirements.md](../requirements/2026-04-19-g01-transactional-outbox-requirements.md)
- **Landed commits (branch `feat/g01-transactional-outbox`):** `2f5cd32`, `335d30e`, `a0008d3`
- **Institutional learnings** that apply to this slice specifically:
  - `docs/solutions/integration-issues/drizzle-orm-api-gaps-multi-dialect-adapter-2026-04-18.md` — MySQL UPDATE lacks `.returning()` (U4 pre-fetches + UPDATE-by-id); better-sqlite3 rejects `db.transaction(async cb)` (U4 sqlite claim path).
  - `docs/solutions/best-practices/multi-dialect-adapter-package-patterns-2026-04-18.md` — Generic index-callback factory pattern for `fencedUpdate` if shared; falsy-JSON rule (`=== null || === undefined`).
  - `docs/solutions/developer-experience/pnpm10-eslint9-native-deps-allow-list-2026-04-18.md` — `no-restricted-imports` regex on lines 94 AND 208 (U8).

## Next Steps

`/ce-work` this plan. Each unit commits with a `feat(drizzle-adapter):`
conventional-commit scope, matching the already-landed U1–U3.
