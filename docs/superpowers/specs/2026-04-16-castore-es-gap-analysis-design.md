# Design — Castore Event-Sourcing Gap Analysis & Roadmap

- **Date:** 2026-04-16
- **Status:** Draft — brainstorming output, pending spec review
- **Owner:** Roman Selmeci
- **Document kind:** Spec for a research/analysis deliverable (no code output from this spec)

---

## 0. Summary of this spec

This document defines **how** we will produce the castore gap-analysis and roadmap
document — its structure, methodology, competitor set, per-feature audit template,
gap-entry template, prioritization framework and risk register format.

The spec is the contract for the eventual deliverable
`docs/superpowers/plans/<date>-castore-es-gap-analysis.md` (written later during the
`writing-plans` phase).

### Context established during brainstorming

- **Project:** `@castore/castore` — TypeScript event-sourcing framework, nx + yarn 4 workspaces, Node 22, ESM-first.
- **Upstream state:** last meaningful feature commit `feat: support zod v4` (Oct 2025); repo has slowed over 2024–2025; effectively a dormant upstream at the time of writing.
- **Relationship type chosen:** **internal fork for company use** — no public npm publishing, no backwards-compatibility obligation, roadmap driven solely by internal product needs.
- **In-scope packages (8):** `core`, `event-storage-adapter-postgres`, `event-storage-adapter-in-memory` (tests only), `message-bus-adapter-event-bridge`, `message-bus-adapter-event-bridge-s3`, `event-type-zod`, `command-zod`, `lib-test-tools`.
- **Out-of-scope packages (10):** dynamodb, http, redux, sqs, sqs-s3, in-memory message bus/queue, json-schema command & event-type, lib-dam, lib-react-visualizer. These will be removed during a separate "Fork & Trim" sub-project.
- **Current stage of product:** **Greenfield** — nothing in production yet; we have the luxury of choosing a healthy baseline before committing.
- **Domain profile:** **D1 — Financial / payments** — regulatory audit trail, long-lived account streams, exact-once semantics.
- **Critical non-functional requirements:**
  - **N1** GDPR / PII delete via crypto-shredding
  - **N4** Zero event loss (transactional outbox / exactly-once publish)
  - **N5** Long aggregate streams (snapshots required for performance)
  - **N6** Schema evolution (event format changes over 5+ year horizon)
- **Analysis depth chosen:** **Full gap catalogue** (option A) — systematic, with a 4-way competitor matrix, per-feature audit, gap details with design sketches.

### What this spec is NOT

- Not a plan for *implementing* any castore feature. Implementation plans for individual gaps come later via `writing-plans`, **only** for gaps the roadmap promotes to MUST/SHOULD.
- Not a plan for the "Fork & Trim" or "Health Audit & Upgrade" sub-projects — those are separate brainstorming cycles.
- Not a code change to castore itself. The deliverable is a Markdown document.

---

## 1. Deliverable outline (table of contents)

The analysis document will have **8 top-level sections**, in this order:

1. **Scope & methodology** — audience, domain & NFR profile, competitor selection criteria, audit method.
2. **Canonical ES feature catalogue** — 26 features in 5 categories with 2–3 sentence definitions.
3. **Competitor matrix** — castore vs. Emmett vs. EventStoreDB vs. Marten vs. Equinox, plus a "DIY Postgres" control column.
4. **Castore current state — per feature** — 26 per-feature entries + a "what castore does exceptionally well" section.
5. **Gap detail catalogue** — ~10–15 gap entries with design sketches, effort, priority, and a dependency DAG.
6. **Prioritized roadmap** — phased plan (0/1/2/3), with a short at-the-top summary replacing the conventional executive summary.
7. **Risk register** — technical, dependency, governance, organizational risks.
8. **Appendices** — upstream notes, competitor references, ES glossary.

**Explicitly omitted:** a standalone Executive Summary; the roadmap section begins with its own brief summary instead.

---

## 2. Canonical ES feature catalogue (26 features, 5 categories)

Each feature in the deliverable will get a 2–3 sentence definition. The list below is fixed during the audit so that castore and all competitors are evaluated against the same checklist.

### A. Storage & consistency

1. Append-only event log per aggregate — immutable events, monotonic per-stream version.
2. Version-based optimistic concurrency — `expectedVersion` on push, conflict raises error.
3. Multi-aggregate transactional commit — atomic commit of events into 2+ streams (double-entry bookkeeping).
4. Idempotent writes — client-provided idempotency key prevents duplicate writes on retry.
5. Snapshots — stored aggregate state at version N; replay resumes from snapshot forward.

### B. Projection & read-side

6. Projection runner with checkpoints — pull-based catch-up subscription with persistent `lastProcessedPosition`.
7. Projection rebuild — drop and replay from genesis (or from snapshot).
8. Projection lag monitoring — metrics of current checkpoint vs. global head position.
9. Inline (sync) projections — written in same DB tx as events (strong consistency).
10. External (async) projections — delivered via bus (eventual consistency).

### C. Schema evolution

11. Explicit event type versioning — `event.version` and/or `type@v2` naming.
12. Upcaster pipeline — `v1 → v2 → v3` transformation on read.
13. Event type retirement / rename — controlled deprecation without breaking existing streams.
14. Tolerant deserialization — unknown fields do not crash parse (forward compat).

### D. Distributed delivery

15. Transactional outbox — publish committed in same tx as event; worker relays.
16. At-least-once + dedup (idempotent consumer) — stable message IDs for consumer-side dedup.
17. Message bus abstraction — pub-sub, fan-out.
18. Message queue abstraction — worker pattern, single consumer per message.
19. Dead-letter queue / poison-pill handling — after N retries move to DLQ with clear root cause.

### E. Operational & governance

20. GDPR crypto-shredding — per-subject encryption key; delete key ⇒ PII unreadable.
21. Event encryption at rest — payload encrypted in DB; key rotation.
22. Multi-tenancy — tenant isolation at stream or row level.
23. Causation / correlation metadata — audit trail: who caused which event in which session.
24. Replay tooling — CLI/script for controlled backfill of projections/subscribers.
25. Observability — structured logs, OpenTelemetry traces, metrics (commit latency, projection lag).
26. Testing utilities — given/when/then helper, fixtures, in-memory adapter.

---

## 3. Competitor selection (4 benchmarks + 1 control)

### Primary competitors

**1. Emmett** — `event-driven-io/emmett`
- *Why:* direct peer; TypeScript, Postgres storage, actively maintained, modern (2024/25 design).
- *Shows us:* what the TS ES community considers the current baseline.

**2. EventStoreDB** — kurrent.io
- *Why:* industry gold standard; dedicated ES server with TS/JS client.
- *Shows us:* feature ceiling when ES is a first-class citizen.

**3. Marten** — martendb.io
- *Why:* Postgres-native ES in .NET — directly analogous to `event-storage-adapter-postgres`.
- *Shows us:* Postgres-specific patterns worth porting (sequence + `NOTIFY`, async daemon, projection runner).

**4. Equinox** — jet/equinox
- *Why:* production-proven at scale (Jet.com/Walmart); multi-storage, snapshot-first architecture.
- *Shows us:* how a framework dedicated to multi-store design is built — castore aims for the same.

### Control baseline

**5. "DIY Postgres"** — thin `pg` wrapper + `SKIP LOCKED` worker + `LISTEN/NOTIFY`
- Not a full matrix entry; one column with "viable alternative?" rating per category.
- Purpose: reveal where a framework starts earning its keep vs. weekend-effort DIY.

### Competitors deliberately excluded (documented in appendix)

- **Prooph** (PHP) — abandoned 2023.
- **@nestjs/cqrs** — CQRS pattern only; no storage; not an ES framework.
- **Axon** (Java) — different language + philosophy; comparison would mislead.
- **Akka Persistence** (Scala) — actor model; unfair analogy.
- **MongoDB event stores** — community plugins only; no cohesive framework.

### Per-competitor profile (1 page each)

Fixed fields:

- **Stack:** language, runtime, storage options, license.
- **Maturity signals:** stars, last release, stated production deployments.
- **Ideology / architectural stance.**
- **Fit score 1–5 for our D1+N1+N4+N5+N6 profile.**
- **Dealbreakers for us** — explicitly stated; weighted higher than "pros".

### Matrix scoring legend

| Symbol | Meaning |
|---|---|
| ✅ | Built-in, first-class |
| 🔶 | First-party extension / official lib |
| ⚠️ | Partial — via convention / manual wiring / with caveats |
| ❌ | Absent — would need to build |

---

## 4. Castore current state — per-feature audit

Each of the 26 features gets its own sub-section. At the top of each category (A–E) a one-line tally: `castore: 3/5 ✅ | 1/5 🔶 | 1/5 ❌`.

### Per-feature entry template

```
### Feature N — <name>

Status:            ✅ | 🔶 | ⚠️ | ❌
Layer:             core | postgres-adapter | eventbridge-adapter | zod-*-lib | userland-convention
Evidence:          <file:line refs>, test:<path>, docs:<url>
How it works:      <2–4 sentences — what castore actually does>
Guarantees:        <formally test-covered vs. convention-only>
Known limits:      <edges, anti-patterns, open upstream issues>
Finance fit note:  <how this intersects D1+N1+N4+N5+N6>
```

### Audit methodology

1. **Code walkthrough** — every claim has a `file:line` reference.
2. **Tests as source of truth** — features not covered by `*.unit.test.ts`, `*.type.test.ts`, or `*.fixtures.test.ts` are marked ⚠️, not ✅.
3. **Documentation cross-check** — docusaurus content + README + commit messages; docs-vs-code divergence is flagged.
4. **Upstream signals** — closed PRs/issues in `castore-dev/castore` over the last 2 years, especially **rejected** feature requests (reveals maintainer philosophy).
5. **Type-level contracts** — `.type.test.ts` files count as separate evidence: compiler-enforced vs. runtime-enforced guarantees.

### Layer classification rationale

Explicit labeling (`core`, `postgres-adapter`, `eventbridge-adapter`, `zod-*-lib`, `userland-convention`) matters because "done in userland" means every command handler has to rebuild the same logic — and mistakes in that layer are the kind that cause double payments in a financial system.

### "What castore does exceptionally well" — standalone sub-section

After the 26 per-feature entries, a one-page section covering strengths for the finance profile:

- `pushEventGroup` with multi-adapter validation — first-class double-entry bookkeeping.
- `simulateAggregate` / `simulateSideEffect` — dry-run for pre-trade checks without persistence.
- Strict type-level reducer contracts (typo-safe at the event-type level).
- Version-based OCC baked into the adapter contract.
- `lib-test-tools` + in-memory adapter — fast domain-level testing.

---

## 5. Gap detail catalogue — the heart of the document

Expected **10–15 gap entries**. Not every ⚠️/❌ feature becomes a gap entry — some out-of-profile features (e.g. multi-tenancy for our single-tenant use case) are recorded as `WON'T` with a one-line rationale instead of a full entry.

### Gap-entry template

```
### G-NN — <gap name>

Category:          A | B | C | D | E   (from §2)
Maps to feature:   #<N>  ·  <feature-name>
Current state:     (link to §4 per-feature audit)
Priority:          MUST | SHOULD | COULD | WON'T   (for D1+N1+N4+N5+N6)
Effort:            S | M | L | XL     (rubric below)
Depends on:        [G-XX, G-YY] or none
Blocks:            [G-ZZ] or none
Breaking change:   yes / no
Impact surface:    packages affected (e.g. core, postgres-adapter)

#### Problem statement
<3–6 sentences — a concrete finance-domain scenario where absence bites us.>

#### Target state
<2–3 sentences — desired behaviour from the consumer's perspective.>

#### Design sketch
- API sketch (TypeScript signatures, not implementation)
- Data model sketch (Postgres DDL diff / bus envelope shape)
- ASCII sequence diagram if non-trivial
- ~40 lines max. NOT an implementation plan.

#### Alternatives considered
1. Build in core — pros, cons
2. Separate adapter / lib — pros, cons
3. Userland convention + helper — pros, cons
4. External lib / service — pros, cons (e.g. Debezium for outbox CDC)

#### Why this priority?
<Why MUST/SHOULD/COULD/WON'T for this profile specifically.>

#### Migration / rollout notes
<Breaking change migration path, or "N/A — greenfield".>
```

### Effort rubric (calibrated to 1 FTE senior TS dev)

| Size | Person-days | Character |
|---|---|---|
| **S**  | 1–3   | One helper/type change, one package, no schema change. |
| **M**  | 3–10  | Feature across multiple modules; possibly minor schema change. |
| **L**  | 10–25 | Cross-cutting change; new module in core or new adapter contract; manageable breaking change. |
| **XL** | 25+   | Architectural addition (e.g. projection runner subsystem with worker model). |

Estimates are **deliberately pessimistic** — they include tests, docs, review, integration, edge cases, and first-time ramp-up on unfamiliar subsystems.

### MoSCoW prioritization (for this D1+N1+N4+N5+N6 profile)

| Priority | Definition |
|---|---|
| **MUST**   | Blocks the use case. Without it the project either doesn't ship or carries unacceptable risk. |
| **SHOULD** | Significant friction / duplicated userland code. Workable, but cost-of-delay is real. |
| **COULD**  | Nice-to-have. Community convention; likely felt after 6–12 months in production. |
| **WON'T**  | Out of profile. Listed so it's clear we considered and rejected, not forgot. |

### Dependency DAG

At the end of §5 a single Mermaid graph shows gap-to-gap dependencies. Example edges: "Projection rebuild" depends on "Projection runner with checkpoints"; "Crypto-shredding" depends on "Event encryption at rest"; "Replay tooling CLI" depends on "Projection runner" + "Snapshots". This DAG is the direct input to §6 (roadmap = topological sort × priority).

### Anti-scope for gap entries (explicit)

- Detailed implementation plan (steps, files, diffs) — deferred to `writing-plans` for selected gaps.
- In-depth test strategy — only high-level testability signalling.
- Commit-level sequence.
- Final TypeScript API polish — only rough sketch.

---

## 6. Prioritized roadmap & risk register

### Roadmap — section opener (replaces executive summary)

A one-page opener inside §6:

- Go / no-go recommendation (one-sentence rationale).
- MoSCoW counts (e.g. `6× MUST / 4× SHOULD / 3× COULD / 2× WON'T`).
- Total effort for the MUST-have phase in person-days.
- Top 2–3 risks.

### Phases

```
Phase 0 — Fork cleanup & health audit
  Inputs:       sub-projects 1 + 2 (deferred, not this document's scope)
  Contents:     fork under internal scope, trim 10/18 out-of-scope packages,
                dep upgrade, CI reset, green tests, Node 22 verified
  Exit:         build & tests green in CI, no critical CVEs
  Calendar:     conditional on FTE (see below)

Phase 1 — MUST-haves
  Inputs:       all MUST gaps
  Likely:       outbox (N4), snapshots (N5), idempotency, crypto-shredding (N1)
  Exit:         each MUST gap has acceptance criteria met;
                end-to-end integration test (Postgres + EventBridge) green;
                production-readiness sign-off

Phase 2 — SHOULD-haves
  Inputs:       SHOULD gaps — typically schema evolution / upcaster / causation metadata
  Exit:         documented migration playbook for event-schema evolution

Phase 3 — COULD-haves (optional, demand-driven)
  Inputs:       COULD gaps
  Rule:         implement only if production shows real need
```

### Per-phase table

| Gap ID | Effort | Priority | Depends on | Owner | ETA |
|---|---|---|---|---|---|

### Dependency DAG

The same Mermaid graph from §5 appears here annotated with phase boundaries — visualizes critical path vs. parallelizable work.

### Checkpoint decision gate (post-Phase-1)

An explicit re-evaluation after Phase 1: does the castore hypothesis still hold, or has implementation surfaced architectural blockers we didn't see in the catalogue? This is a mandated stop-the-line moment before investing in Phase 2+.

### Conditional calendar estimates

Because FTE capacity and deadline are not yet decided, the roadmap expresses calendar time **conditionally**:

> *"At 1 FTE the MUST-have phase is ~X weeks; at 2 FTE parallelized across independent gaps in the DAG, ~Y weeks."*

The document will include:

- A table of `person-days → calendar weeks` for 1 / 1.5 / 2 FTE.
- A note on which gaps in the DAG can parallelize (independent subtrees) vs. which serialize (critical path).
- A reminder that the checkpoint gate after Phase 1 is the right place to revisit capacity and deadline assumptions.

### Risk register — fixed columns

| ID | Category | Description | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|---|

### Risks to be captured (preview — final wording set during writing)

**Technical / architectural**

- **R-01** — `EventStore` is a concrete class, not an interface; extensibility is by composition, not inheritance — may constrain snapshot-aware `getAggregate` (wrapper needed).
- **R-02** — heavy contravariance in the type system (`$Contravariant` everywhere); any core generic change risks type-test breakage.
- **R-03** — `pushEventGroup` is a static method bound to a single storage adapter per group — limits multi-region / multi-store transactions.
- **R-04** — EventBridge 256 KB payload limit; the `eventbridge-s3` adapter mitigates, but complicates outbox design (pointer in outbox row, not the whole event).

**Dependency / upstream**

- **R-05** — upstream `castore-dev/castore` may reactivate; divergent internal fork implies merge hell.
- **R-06** — Postgres adapter coupled to a specific `pg` major version.
- **R-07** — aws-sdk v2 → v3 migration still pending (v2 visible in `package.json`).

**Governance / security**

- **R-08** — crypto-shredding key lifecycle is outside the framework; losing a master key = GDPR fine; requires external KMS with clear ownership.
- **R-09** — outbox relay worker is a single point of failure if advisory lock held by a dead process.
- **R-10** — audit trail completeness: causation / correlation metadata must be mandatory, not optional, or PII leak paths become unauditable.

**Organizational**

- **R-11** — single-maintainer risk: one person holds both ES knowledge and castore internals; their departure = re-abandonment.
- **R-12** — custom framework for a greenfield project: ~2 weeks ramp-up for new hires; reduced portability.

### Out of scope for this document (re-stated)

- Detailed implementation plan per MUST gap — that's the `writing-plans` phase after roadmap sign-off.
- In-depth test strategy — only testability signalling.
- Performance benchmarks — castore-vs-competitors benchmark is a separate project.

---

## 7. Success criteria for the deliverable

The gap-analysis document is complete when:

1. All 26 features have a per-feature audit entry with ≥1 code / test / docs reference.
2. All 4 primary competitors have a completed matrix row and a 1-page profile, including dealbreakers.
3. Every `❌` and every `⚠️` in the castore column has either a gap entry or an explicit `WON'T` line-item.
4. Every gap entry has: design sketch, effort estimate, priority, dependency list, and rollout note.
5. The dependency DAG has no cycles and is rendered as Mermaid.
6. The risk register has all R-01…R-12 (or updated set) populated with Likelihood/Impact/Mitigation.
7. The opener of §6 contains a clear go/no-go recommendation with one-sentence rationale.
8. The document is self-contained — a reader with no prior castore knowledge can follow it end-to-end.

---

## 8. Workflow after this spec

1. Spec review loop (`spec-document-reviewer` subagent). Up to 5 iterations, then escalate.
2. User review of this spec.
3. `writing-plans` skill produces the implementation plan for **this analysis document** (i.e. how we execute the research: which code to read in what order, which competitor docs to harvest, which gap entries to write first).
4. Execution → deliverable `docs/superpowers/specs/2026-04-16-castore-es-gap-analysis.md` (or `…plans/`, per skill convention).
5. After the analysis is delivered: decision point — fork and proceed (new brainstorming cycles per MUST gap), or pivot.

---

## 9. Open questions to resolve before execution

- **OQ-1** FTE capacity for the analysis work itself (1 person full-time? part-time?) — affects research depth and calendar estimate for the analysis, not the eventual implementation.
- **OQ-2** Hard deadline for the go/no-go decision, if any.
- **OQ-3** Are there additional stakeholders (CTO, compliance, SRE) who should be named as reviewers of the final deliverable?
- **OQ-4** Should competitor evaluation include hands-on POC (e.g. 1-day spike per competitor) or is documentation review sufficient?
- **OQ-5** Do we want a spike/POC phase ("Phase −1") for the highest-risk gap (likely crypto-shredding) before investing in the fork & upgrade?
