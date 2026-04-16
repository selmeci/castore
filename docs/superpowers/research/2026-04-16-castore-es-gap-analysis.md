# Castore ES Gap Analysis & Roadmap

- **Date:** 2026-04-16
- **Status:** Draft — Chunk 1 in progress
- **Owner:** Roman Selmeci
- **Spec:** `docs/superpowers/specs/2026-04-16-castore-es-gap-analysis-design.md`

---

## 1. Scope & methodology

### 1.1 Project context

Castore (`@castore/castore`) is a TypeScript event-sourcing framework built on an nx + yarn 4 workspace structure, targeting Node 22, and authored as an ESM-first library. The upstream repository (`castore-dev/castore`) slowed considerably over 2024–2025, with the last meaningful feature commit being `feat: support zod v4` (October 2025); at the time of writing the upstream is effectively dormant. Rather than waiting for upstream activity, the decision taken was to treat castore as an **internal fork for company use only**: no public npm publishing, no backwards-compatibility obligation to the open-source community, and a roadmap driven solely by internal product requirements.

The project is at a **greenfield stage** — nothing is in production yet, which gives the luxury of choosing a healthy baseline before committing to any architecture. This analysis therefore aims to identify what must be added or changed before the fork is trusted for production use, not to assess castore after years of accumulated real-world load.

Eight packages are in scope for this analysis and for all future implementation work: `core`, `event-storage-adapter-postgres`, `event-storage-adapter-in-memory` (tests only), `message-bus-adapter-event-bridge`, `message-bus-adapter-event-bridge-s3`, `event-type-zod`, `command-zod`, and `lib-test-tools`. Ten packages are explicitly out of scope and will be removed during a separate "Fork & Trim" sub-project: `event-storage-adapter-dynamodb`, `event-storage-adapter-http`, `redux` integration, `message-bus-adapter-sqs`, `message-bus-adapter-sqs-s3`, `message-queue-adapter-in-memory`, `message-bus-adapter-in-memory`, `command-json-schema`, `event-type-json-schema`, `lib-dam`, and `lib-react-visualizer`.

The domain profile driving all prioritization is **D1 — Financial / payments**: long-lived account streams, regulatory audit trail, and exact-once semantics. Four non-functional requirements are active constraints throughout:

- **N1** — GDPR / PII delete via crypto-shredding
- **N4** — Zero event loss (transactional outbox / exactly-once publish)
- **N5** — Long aggregate streams (snapshots required for performance)
- **N6** — Schema evolution (event format changes over a 5+ year horizon)

The analysis depth chosen is **option A — Full gap catalogue**: a systematic, 4-way competitor matrix, per-feature audit for all 26 features, and gap entries with design sketches for every meaningful deficit. This depth is justified by the greenfield context: decisions made now are inexpensive to reverse, but post-production architectural changes carry far higher cost.

### 1.2 How castore was evaluated

The following five-step methodology governs every claim made in §4 (Castore current state). Evidence that does not conform to this methodology is flagged explicitly.

1. **Code walkthrough** — every claim has a `file:line` reference. Assertions not backed by a specific source location are marked as "convention" or "inference" and carry lower confidence.
2. **Tests as source of truth** — features not covered by `*.unit.test.ts`, `*.type.test.ts`, or `*.fixtures.test.ts` are marked ⚠️, not ✅. A feature that works in practice but has no automated test coverage cannot be relied upon across refactors; this is especially important in a financial context.
3. **Documentation cross-check** — docusaurus content, package READMEs, and commit messages are compared against code. Any docs-vs-code divergence is flagged in the audit entry.
4. **Upstream signals** — closed PRs and issues in `castore-dev/castore` over the last two years, with particular attention to **rejected** feature requests, which reveal maintainer philosophy and inform whether certain gaps are architectural decisions rather than oversights.
5. **Type-level contracts** — `.type.test.ts` files count as separate evidence from runtime tests, because compiler-enforced guarantees are qualitatively stronger than runtime-enforced ones. Both tiers are noted in each audit entry's "Guarantees" field.

For any feature that is expected to be absent, the **Absence evidence protocol** applies: at least two code-level regex searches, a docs search, and a package-metadata search must all return no results before the status is recorded as ❌. When all searches return zero but the feature is named in canonical ES references, confidence is rated **medium** and the status is downgraded to ⚠️ with a note to confirm during per-gap brainstorming.

### 1.3 How competitors were selected

Four primary competitors were chosen to benchmark castore against the current state of the art:

**Emmett** (`event-driven-io/emmett`) — selected as the direct TypeScript peer: same language, Postgres storage, actively maintained, and reflecting 2024–2025 design thinking. It shows what the TS event-sourcing community currently considers the baseline for a well-designed framework.

**EventStoreDB** (kurrent.io) — selected as the industry gold standard for dedicated event-sourcing servers with a first-class TS/JS client. It defines the feature ceiling: what is possible when event sourcing is the only concern of the storage layer.

**Marten** (martendb.io) — selected as the closest Postgres-native analogue in a different language (.NET). Marten's async daemon, projection runner, and sequence-based ordering patterns are directly relevant to the `event-storage-adapter-postgres` package and may inform design decisions.

**Equinox** (`jet/equinox`) — selected for its production-proven track record at scale (Jet.com / Walmart) and its multi-storage, snapshot-first architecture. Castore aims for multi-store design; Equinox is the closest reference for how that is done at scale.

A **DIY Postgres** control baseline is included as a fifth column in the matrix: a thin `pg` wrapper with `SKIP LOCKED` workers and `LISTEN/NOTIFY`. Its purpose is to reveal at which feature tier a framework begins earning its keep over a weekend-effort DIY implementation.

The following competitors were considered and deliberately excluded:

- **Prooph** (PHP) — abandoned in 2023; no longer a meaningful reference point.
- **@nestjs/cqrs** — implements the CQRS pattern only; it has no storage layer and is not an event-sourcing framework.
- **Axon** (Java) — different language and actor-model philosophy; a direct comparison would mislead rather than inform.
- **Akka Persistence** (Scala) — actor model; the architectural analogy is too different to be actionable.
- **MongoDB event stores** — community plugins only, no cohesive framework; comparison surface is too fragmented.

### 1.4 Reader orientation

This document is written for two audiences with different entry points. **Executives and decision-makers** should begin at §6 (Prioritized roadmap), specifically the section opener which presents the go/no-go recommendation, MoSCoW counts, total Phase 1 effort estimate, and the top risks — the entire analysis distilled to one page. **Engineers and technical leads** should proceed directly to §5 (Gap detail catalogue), which contains per-gap problem statements, design sketches, effort estimates, and dependency relationships that translate directly into implementation planning. §4 (Castore current state) is the primary research layer: each of the 26 features is audited with code references, guarantees, and known limits, and it is the authoritative input to both §5 and §6. §3 (Competitor matrix) provides context for prioritization decisions — understanding where castore sits relative to the field makes it easier to judge whether a gap is a critical deficit or an acceptable trade-off for the internal-fork profile.

## 2. Canonical ES feature catalogue

> TODO: see spec §2 for template.

## 3. Competitor matrix

> TODO: see spec §3 for template.

## 4. Castore current state — per feature

> TODO: see spec §4 for template.

## 5. Gap detail catalogue

> TODO: see spec §5 for template.

## 6. Prioritized roadmap

> TODO: see spec §6 for template.

## 7. Risk register

> TODO: see spec §6 (risk register) for template.

## 8. Appendices

> TODO: see spec §8 for template.
