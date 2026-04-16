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

This catalogue defines the 26 features that every framework in this analysis — including castore — is evaluated against. All definitions are framework-agnostic; castore-specific findings belong in §4. The feature numbering is fixed: the same F-numbers appear in the competitor matrix (§3), the per-feature audit (§4), and the gap catalogue (§5). The five category letters (A–E) are also used in gap entries to indicate which domain a gap belongs to.

---

### Category A — Storage & consistency

> Primary reference: Greg Young, "CQRS Documents" (2010); Eric Evans, *Domain-Driven Design* (2003) ch. 6 (Aggregates & Repositories). The storage tier is the foundation of any event-sourcing system: it must provide append-only semantics, ordering guarantees, and conflict detection before any higher-level feature can be reliably built on top of it.

**F1 — Append-only event log per aggregate**

An event store must guarantee that events for a given aggregate are stored in an immutable, ordered sequence and that no event may be deleted or modified after the fact. Each event carries a monotonically increasing per-stream version number that both identifies its position in history and enables conflict detection. The append-only constraint is the foundational invariant of event sourcing: without it, replaying an aggregate's history will not reproduce the state that was observed at the time the event was written.

**F2 — Version-based optimistic concurrency (OCC)**

Before appending new events, the caller supplies an `expectedVersion` representing the stream version it last read. If the actual stream version at commit time differs — because a concurrent writer appended events in the meantime — the store raises a concurrency conflict error rather than silently overwriting history. This optimistic approach avoids pessimistic locking and scales well under read-heavy workloads, at the cost of requiring the application to retry on conflict, which is typically cheap because conflicts are rare in well-modelled aggregates (Young, "CQRS Documents", §3).

**F3 — Multi-aggregate transactional commit**

Some business operations must atomically update two or more aggregate streams — the canonical example in financial systems is a double-entry bookkeeping journal entry, where a debit on one account and a credit on another must either both succeed or both fail. A framework that supports multi-aggregate transactional commit allows events for multiple streams to be written in a single, all-or-nothing transaction, preventing partial state that would violate business invariants. Without this capability, saga-based compensation patterns must be used instead, which are significantly more complex to implement correctly.

**F4 — Idempotent writes**

An idempotent write operation allows the caller to supply a stable client-generated key alongside an event batch; if the same key is seen again — for example because a network timeout caused the client to retry — the store returns the previously stored result rather than creating a duplicate event. Idempotency is distinct from optimistic concurrency: OCC prevents races between independent writers, while idempotency prevents duplicates from retries by the *same* writer. In financial systems, where retried payment commands must not produce double charges, idempotent writes are a first-class safety requirement (Vernon, *Implementing Domain-Driven Design*, ch. 8).

**F5 — Snapshots**

A snapshot is a serialized aggregate state captured at a specific stream version; subsequent event replay can start from the snapshot rather than from the beginning of the stream. Snapshots exist purely as a performance optimization: as aggregate streams grow over months or years, replaying thousands of events on every command becomes unacceptably slow, and snapshots cap the replay cost at the distance between the most recent snapshot version and the current stream head. A correct snapshot implementation must not alter event semantics — the same state must be reachable with or without the snapshot, just faster.

---

### Category B — Projection & read-side

> Primary reference: Martin Fowler, "Event Sourcing" (2005, martinfowler.com); Oskar Dudycz, "Projections explained" (event-driven.io, 2022). Projections transform the event log into queryable read models. The distinction between *pull-based catch-up* (checkpointed subscription) and *push-based async delivery* (message bus) has deep operational consequences: catch-up subscriptions can be rebuilt deterministically, while bus-based delivery depends on infrastructure-level replay capabilities.

**F6 — Projection runner with checkpoints**

A projection runner is a long-lived process that reads events from the store in a pull-based catch-up loop and applies them to a read model. It persists a `lastProcessedPosition` (checkpoint) so that on restart it resumes exactly where it left off, rather than replaying from the beginning. Durable checkpoints are critical: without them, a restarted runner either misses events or replays from genesis on every restart, both of which break read-model consistency.

**F7 — Projection rebuild**

Projection rebuild is the ability to drop an existing read model and deterministically replay its entire event history from genesis (or from a saved snapshot) to reconstruct the model from scratch. This is necessary whenever the projection logic changes — for example, when a new field is added to a view or a query pattern changes — and is also the recovery mechanism when read-model storage is corrupted or accidentally deleted. A rebuild must produce a read model byte-for-byte equivalent to what would have been produced by processing the events in real-time.

**F8 — Projection lag monitoring**

Projection lag is the difference between the global event store head position and the checkpoint of a given projection runner. Monitoring lag provides an operational signal that a projection is falling behind — due to slow processing, infrastructure issues, or an event spike — before it becomes visible as stale data in the application. In financial systems, projection lag directly translates to query latency for account balances and transaction histories; a framework or adapter that exposes lag as a metric enables SLA monitoring.

**F9 — Inline (sync) projections**

An inline projection is applied within the same database transaction as the event write, guaranteeing that the read model is always consistent with the event log at commit time. Inline projections trade write throughput (two writes per commit) for strong read-model consistency, which is valuable for use cases where the application must immediately query the updated state after a command. The trade-off versus external projections is explicit: inline projections are synchronous and coupled to the event store transaction, while external projections are asynchronous and decoupled.

**F10 — External (async) projections**

An external projection is delivered via a message bus after the event is committed, providing eventual consistency. The event is first written to the store, then published to subscribers (projection workers, notification services, search indexers) asynchronously. Eventual consistency is acceptable for most read-side queries but requires explicit handling of the lag window, deduplication on the consumer side (because at-least-once delivery can produce duplicates), and a rebuild path for consumers that miss messages.

---

### Category C — Schema evolution

> Primary reference: Vaughn Vernon, *Implementing Domain-Driven Design* (2013) ch. 11; Oskar Dudycz, "Schema evolution in Event-Driven systems" (event-driven.io, 2023). Events are immutable once written; schema evolution is the discipline of changing event formats over time without invalidating historical data. In long-lived systems — particularly financial ones where event streams span years — schema evolution is not optional: business concepts change, regulations change, and the ability to rename, extend, or retire event types without breaking the replay chain is a fundamental correctness requirement.

**F11 — Explicit event type versioning**

Each event type carries a version identifier — either a numeric `version` field on the event envelope or a naming convention like `AccountCredited@v2` — that allows the event store and application code to distinguish old and new shapes of the same logical event. Without explicit versioning, schema evolution must be handled implicitly by inspecting field presence, which is fragile and error-prone. Explicit versioning is the prerequisite for the upcaster pipeline (F12): you cannot transform from "the old shape" to "the new shape" without a reliable way to identify which shape you are reading.

**F12 — Upcaster pipeline**

An upcaster is a function that transforms an event from version N to version N+1; an upcaster pipeline chains such functions so that a v1 event read from an old stream is transparently upgraded through v2 and v3 before it reaches application code. The pipeline must be applied at read time (during event deserialization), not at write time, so that existing events are never mutated. A correct upcaster pipeline allows the application to deal exclusively with the current event schema even when the stored events are many versions behind, which is the key to maintaining a clean domain model over a multi-year lifecycle (Vernon, IDDD, ch. 11).

**F13 — Event type retirement / rename**

Event type retirement is the controlled removal or renaming of an event type after all existing streams using it have been migrated or archived. In practice this involves: (1) marking the type as deprecated so new writes are rejected, (2) providing an upcaster that maps old events to a replacement type, and (3) eventually removing the old type from the schema registry once no unprocessed events of that type remain. Without a formal retirement process, old event types accumulate indefinitely and the domain model becomes cluttered with historical artefacts that developers must carefully avoid.

**F14 — Tolerant deserialization**

Tolerant deserialization means that the parser does not fail when it encounters an unknown field in an event payload — it simply ignores it, allowing the reader to proceed. This is the "tolerant reader" pattern (Fowler, 2011) and is the basis of forward compatibility: a newer event schema can add fields without breaking older consumers that have not yet been deployed. Strict deserialization — where an unknown field causes a parse error — is safe for preventing field typos during development but must be relaxed at the consumer boundary for any system that deploys producers and consumers independently.

---

### Category D — Distributed delivery

> Primary reference: Gregor Hohpe & Bobby Woolf, *Enterprise Integration Patterns* (2003) ch. 3–4; Oskar Dudycz, "Outbox, Inbox patterns and delivery guarantees explained" (event-driven.io, 2022). Distributed delivery features govern how events leave the event store and reach downstream consumers. The central concern is the gap between "event committed to the store" and "event delivered to subscribers": anything that can fail in that gap — network partitions, process crashes, bus throttling — must be accounted for by the framework or left to userland to solve.

**F15 — Transactional outbox**

The transactional outbox pattern solves the dual-write problem: rather than writing an event to the store and then publishing it to a message bus in two separate operations (where a crash between the two creates a lost-event scenario), the event and its outbox row are written in the same database transaction, and a relay worker reads the outbox and publishes to the bus. Once the relay confirms the message is delivered, the outbox row is marked processed. This pattern is the standard mechanism for achieving zero event loss (N4) without requiring distributed transactions across the database and the message bus.

**F16 — At-least-once delivery + idempotent consumer**

At-least-once delivery means that a message may be delivered more than once — for example after a relay crash and restart — and the consumer must be designed to handle duplicate deliveries without producing incorrect results. The standard mechanism is a stable, deterministic message ID (derived from the event's stream ID and version) that the consumer stores and checks before processing; if the ID is seen again, the message is a duplicate and is discarded. Without stable message IDs and consumer-side dedup, at-least-once delivery degrades to "at-most-once" in practice, because operators become reluctant to retry deliveries for fear of double-processing.

**F17 — Message bus abstraction**

A message bus abstraction provides a pub-sub interface that allows event producers to publish messages without knowing which consumers are subscribed, and allows new consumers to be added without modifying the producer. Fan-out — one published event reaching multiple independent subscribers — is the defining characteristic of a bus, and it enables decoupled, independently deployable services. A framework-level abstraction over the bus allows the bus implementation to be swapped (e.g. from in-memory for testing to EventBridge for production) without changing application code.

**F18 — Message queue abstraction**

A message queue abstraction provides a worker pattern where each message is consumed by exactly one worker instance; in contrast to the bus (fan-out), the queue is used for work distribution. Queues are typically used for event-triggered side effects that must be processed exactly once by a single processor — for example, sending a payment notification or updating a downstream system. A framework-level queue abstraction decouples the application from the specific queue implementation (SQS, RabbitMQ, in-memory) and enables testing without infrastructure.

**F19 — Dead-letter queue / poison-pill handling**

A dead-letter queue (DLQ) is a separate queue to which messages that have failed processing more than N times are moved, preventing a single "poison pill" message from blocking the entire queue indefinitely. Effective DLQ handling requires the framework or adapter to capture the failure reason alongside the message so that operators can diagnose and replay the failed message once the root cause is resolved. Without DLQ support, a deserialization error or unhandled exception in a consumer can silently halt event processing, which is operationally catastrophic in financial systems.

---

### Category E — Operational & governance

> Primary reference: Vaughn Vernon, *Implementing Domain-Driven Design* (2013) ch. 7 (Domain Events — identity & metadata); GDPR Regulation (EU) 2016/679 Article 17 (right to erasure). Operational and governance features are the invisible infrastructure of a production event-sourcing system: they ensure the system can be run, audited, debugged, and kept compliant over a multi-year lifespan. In a financial context, several of these features — crypto-shredding, causation/correlation metadata, and testing utilities — are not optional niceties but hard requirements.

**F20 — GDPR crypto-shredding**

Crypto-shredding is the technique of encrypting personally identifiable information (PII) in event payloads with a per-data-subject encryption key, so that deleting the key makes the PII cryptographically inaccessible — satisfying GDPR Article 17 (right to erasure) without physically deleting events from the immutable log. Each data subject has a unique key stored in a key registry; all events carrying that subject's PII are encrypted with their key at write time, and the key is deleted upon erasure request. The framework must provide integration points for key lookup, encryption at push, and decryption at read, along with a story for key lifecycle management via an external KMS.

**F21 — Event encryption at rest**

Event encryption at rest means that event payloads are encrypted in the database such that access to the raw storage (disk image, database backup, storage-provider admin console) does not expose plaintext event data. This is distinct from crypto-shredding (F20): encryption at rest protects against infrastructure-level data exfiltration, while crypto-shredding protects against application-level re-identification after a deletion request. Transparent database encryption (TDE) handles this at the infrastructure layer; payload-level encryption handled by the framework gives additional protection for sensitive fields even when the database is accessible.

**F22 — Multi-tenancy**

Multi-tenancy allows a single event store deployment to isolate streams belonging to different tenants so that one tenant's events cannot be read or written by another tenant. Isolation can be implemented at the stream-ID level (tenant prefix in the aggregate ID), at the row level (tenant column with row-level security policies), or at the schema/database level (separate store per tenant). A framework with first-class multi-tenancy support provides the isolation boundary as a built-in construct rather than leaving it to userland convention, reducing the risk of accidental cross-tenant data leakage.

**F23 — Causation / correlation metadata**

Causation and correlation IDs are metadata fields on each event that allow auditors to reconstruct the causal chain of events in a distributed system. The correlation ID groups all events that belong to the same originating request or user session; the causation ID identifies the specific command or event that directly caused this event to be emitted. Together they provide an audit trail that answers "why did this event happen and in what context?" — a requirement for financial regulatory compliance, incident investigation, and debugging production issues in distributed systems (Vernon, IDDD, ch. 7).

**F24 — Replay tooling**

Replay tooling provides a controlled mechanism — typically a CLI script or framework API — for re-processing a range of historical events through a projection, subscriber, or saga, without affecting the live event store or triggering live side effects. Replay is needed for backfilling a new read model, recovering a failed consumer, or testing a new event handler against production history. Correct replay tooling must handle exactly-once semantics, support pausing and resuming, and respect the event ordering guarantees of the underlying store.

**F25 — Observability**

Observability in an event-sourcing framework means that the framework emits structured logs, distributed traces (e.g. OpenTelemetry spans), and metrics (e.g. event commit latency, projection lag, outbox queue depth) that allow operators to understand the system's behavior in production without needing to instrument every individual command handler. Framework-level observability is preferable to userland instrumentation because it captures infrastructure-level timing and error information that application code cannot easily access, and it ensures that all operations — including internal retry loops and outbox relay workers — are visible.

**F26 — Testing utilities**

Testing utilities are framework-provided helpers that make it easy to write fast, deterministic, isolated domain tests without infrastructure dependencies. The canonical form is a given/when/then helper (given these past events, when this command is processed, then these events should be produced) and an in-memory adapter that replaces the real event store in test runs. Framework-level test utilities reduce the barrier to high test coverage, which is especially important for financial domain logic where a subtle invariant violation can cause real monetary harm.

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
