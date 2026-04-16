# Castore ES Gap Analysis & Roadmap

- **Date:** 2026-04-16
- **Status:** Draft — Chunks 1 and 2 complete
- **Owner:** Roman Selmeci
- **Spec:** `docs/superpowers/specs/2026-04-16-castore-es-gap-analysis-design.md`

---

## 1. Scope & methodology

### 1.1 Project context

Castore (`@castore/castore`) is a TypeScript event-sourcing framework built on an nx + yarn 4 workspace structure, targeting Node 22, and authored as an ESM-first library. The upstream repository (`castore-dev/castore`) slowed considerably over 2024–2025, with the last meaningful feature commit being `feat: support zod v4` (October 2025); at the time of writing the upstream is effectively dormant. Rather than waiting for upstream activity, the decision taken was to treat castore as an **internal fork for company use only**: no public npm publishing, no backwards-compatibility obligation to the open-source community, and a roadmap driven solely by internal product requirements.

The project is at a **greenfield stage** — nothing is in production yet, which gives the luxury of choosing a healthy baseline before committing to any architecture. This analysis therefore aims to identify what must be added or changed before the fork is trusted for production use, not to assess castore after years of accumulated real-world load.

Eight packages are in scope for this analysis and for all future implementation work: `core`, `event-storage-adapter-postgres`, `event-storage-adapter-in-memory` (tests only), `message-bus-adapter-event-bridge`, `message-bus-adapter-event-bridge-s3`, `event-type-zod`, `command-zod`, and `lib-test-tools`. Eleven packages are explicitly out of scope and will be removed during a separate "Fork & Trim" sub-project (the spec groups two pairs as bundled items, giving the spec's count of ten): `event-storage-adapter-dynamodb`, `event-storage-adapter-http`, `redux` integration, `message-bus-adapter-sqs`, `message-bus-adapter-sqs-s3`, `message-queue-adapter-in-memory`, `message-bus-adapter-in-memory`, `command-json-schema`, `event-type-json-schema`, `lib-dam`, and `lib-react-visualizer`.

The domain profile driving all prioritization is **D1 — Financial / payments**: long-lived account streams, regulatory audit trail, and exact-once semantics. Four non-functional requirements are active constraints throughout (N2 multi-tenancy and N3 high-throughput are out of profile for this analysis — see spec §0):

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

Executives should begin at §6's opener, which delivers the go/no-go recommendation, MoSCoW counts, total Phase 1 effort estimate, and top risks on one page. Engineers working on MUST gaps should start at §5 (Gap detail catalogue), where per-gap problem statements, design sketches, effort estimates, and dependency relationships translate directly into implementation planning. §4 (Castore current state) is the authoritative research layer — 26 features audited with code references, guarantees, and known limits — and is the direct input to both §5 and §6. §3 (Competitor matrix) provides prioritization context: it shows where castore sits relative to the field so readers can judge whether a gap is a critical deficit or an acceptable trade-off.

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

An idempotent write operation allows the caller to supply a stable client-generated key alongside an event batch; if the same key is seen again — for example because a network timeout caused the client to retry — the store returns the previously stored result rather than creating a duplicate event. This retry-safety property ensures that re-sending a failed request produces no additional side effects. In financial systems, where retried payment commands must not produce double charges, idempotent writes are a first-class safety requirement (Vernon, *Implementing Domain-Driven Design*, ch. 8).

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

Event type retirement is the controlled removal or renaming of an event type after all existing streams using it have been migrated or archived. Controlled deprecation involves marking the type as deprecated, providing an upcaster to a replacement type, and eventually removing the old type once no unprocessed events remain. Without a formal retirement process, old event types accumulate indefinitely and the domain model becomes cluttered with historical artefacts that developers must carefully avoid.

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

Crypto-shredding is the technique of encrypting personally identifiable information (PII) in event payloads with a per-data-subject encryption key, so that deleting the key makes the PII cryptographically inaccessible — satisfying GDPR Article 17 (right to erasure) without physically deleting events from the immutable log. Each data subject has a unique key stored in a key registry; all events carrying that subject's PII are encrypted with their key at write time, and the key is deleted upon erasure request.

**F21 — Event encryption at rest**

Event encryption at rest means that event payloads are encrypted in the database such that access to the raw storage (disk image, database backup, storage-provider admin console) does not expose plaintext event data. This is distinct from crypto-shredding (F20): encryption at rest protects against infrastructure-level data exfiltration, while crypto-shredding protects against application-level re-identification after a deletion request. Transparent database encryption (TDE) handles this at the infrastructure layer; payload-level encryption handled by the framework gives additional protection for sensitive fields even when the database is accessible.

**F22 — Multi-tenancy**

Multi-tenancy allows a single event store deployment to isolate streams belonging to different tenants so that one tenant's events cannot be read or written by another tenant. Isolation can be implemented at the stream-ID level (tenant prefix in the aggregate ID), at the row level (tenant column with row-level security policies), or at the schema/database level (separate store per tenant). A framework with first-class multi-tenancy support provides the isolation boundary as a built-in construct rather than leaving it to userland convention, reducing the risk of accidental cross-tenant data leakage.

**F23 — Causation / correlation metadata**

Causation and correlation IDs are metadata fields on each event that allow auditors to reconstruct the causal chain of events in a distributed system. The correlation ID groups all events that belong to the same originating request or user session; the causation ID identifies the specific command or event that directly caused this event to be emitted. Together they provide an audit trail that answers "why did this event happen and in what context?" (Vernon, IDDD, ch. 7).

**F24 — Replay tooling**

Replay tooling provides a controlled mechanism — typically a CLI script or framework API — for re-processing a range of historical events through a projection, subscriber, or saga, without affecting the live event store or triggering live side effects. Replay is needed for backfilling a new read model, recovering a failed consumer, or testing a new event handler against production history. Correct replay tooling must handle exactly-once semantics, support pausing and resuming, and respect the event ordering guarantees of the underlying store.

**F25 — Observability**

Observability in an event-sourcing framework means that the framework emits structured logs, distributed traces (e.g. OpenTelemetry spans), and metrics (e.g. event commit latency, projection lag, outbox queue depth) that allow operators to understand the system's behavior in production without needing to instrument every individual command handler.

**F26 — Testing utilities**

Testing utilities are framework-provided helpers that make it easy to write fast, deterministic, isolated domain tests without infrastructure dependencies. The canonical form is a given/when/then helper (given these past events, when this command is processed, then these events should be produced) and an in-memory adapter that replaces the real event store in test runs. Framework-level test utilities reduce the barrier to high test coverage, which is especially important for financial domain logic where a subtle invariant violation can cause real monetary harm.

## 3. Competitor matrix

This section profiles four primary competitors and one DIY-Postgres control baseline, then consolidates all findings — including castore's §4 audit results — into a single 26×6 feature matrix.

---

### 3.1 Emmett

**Stack:** TypeScript / Node.js 20+; storage options: PostgreSQL (primary), EventStoreDB, MongoDB, SQLite, in-memory; no published npm license as of inspection date — an [RFC](https://github.com/event-driven-io/emmett/pull/260) is open proposing AGPL v3 / SSPL with an open-core commercial model.

**Maturity signals:** 473 GitHub stars; latest release `0.42.0` (2026-02-10); pre-1.0 versioning; stated production deployments by sponsor companies (productminds, Lightest Night); actively maintained — pushed 2026-04-16.

**Ideology / architectural stance:** Emmett is explicitly opinionated but lightweight: composition over magic, framework-provided patterns rather than framework-imposed wiring. It focuses on making event sourcing accessible via clear patterns and BDD-style testing utilities. Multi-store support (Postgres, ESDB, MongoDB, SQLite) is a first-class goal. The author (Oskar Dudycz) is a recognized voice in the TS event-sourcing community.

**Fit score for D1+N1+N4+N5+N6:** 3/5. Strong on storage fundamentals, testing, and schema evolution patterns. Weak on crypto-shredding (no native KMS integration), transactional outbox (Postgres store has an outbox-friendly design but no out-of-the-box relay worker), and the pre-1.0 license situation is a risk for a production financial system.

**Dealbreakers:**
- **No published open-source license.** The RFC outcome (AGPL v3 / SSPL) means adopting Emmett may restrict how derived works are distributed. For an internal-fork strategy this may be acceptable, but requires legal review.
- **Pre-1.0 API instability.** `0.42.0` signals that breaking API changes are expected; adopting Emmett means tracking upstream changes rather than forking a stable baseline.
- **No native crypto-shredding.** N1 (GDPR/PII delete) is not addressed; the application must build key-management wiring from scratch, the same gap as castore.
- **EventBridge not supported.** The in-scope AWS delivery chain (EventBridge + S3) has no Emmett adapter; teams would need to build and maintain one.

**26-feature coverage:**

| Feature | Emmett |
|---|---|
| F1 — Append-only event log | ✅ |
| F2 — Version-based OCC | ✅ |
| F3 — Multi-aggregate transactional commit | ⚠️ |
| F4 — Idempotent writes | ⚠️ |
| F5 — Snapshots | ✅ |
| F6 — Projection runner with checkpoints | ✅ |
| F7 — Projection rebuild | ✅ |
| F8 — Projection lag monitoring | ⚠️ |
| F9 — Inline (sync) projections | ✅ |
| F10 — External (async) projections | ✅ |
| F11 — Explicit event type versioning | ⚠️ |
| F12 — Upcaster pipeline | ⚠️ |
| F13 — Event type retirement / rename | ❌ |
| F14 — Tolerant deserialization | ⚠️ |
| F15 — Transactional outbox | ⚠️ |
| F16 — At-least-once + dedup | ⚠️ |
| F17 — Message bus abstraction | ✅ |
| F18 — Message queue abstraction | ⚠️ |
| F19 — DLQ / poison-pill handling | ❌ |
| F20 — GDPR crypto-shredding | ❌ |
| F21 — Event encryption at rest | ❌ |
| F22 — Multi-tenancy | ⚠️ |
| F23 — Causation / correlation metadata | ✅ |
| F24 — Replay tooling | ⚠️ |
| F25 — Observability | ⚠️ |
| F26 — Testing utilities | ✅ |

*Notes:* F3 rated ⚠️ — Postgres store uses a single connection / transaction per command; explicit multi-stream atomic commits require manual transaction management. F4 rated ⚠️ — idempotency is a convention via metadata fields, not a first-class store API. F12 rated ⚠️ — schema evolution patterns are documented but the upcaster pipeline is convention/application-layer, not a framework pipeline. F15 rated ⚠️ — the Postgres store is designed with outbox-friendly patterns but no out-of-the-box relay worker. Confidence on F11/F12/F15 is medium — docs inspection only; confirm during per-gap brainstorming.

*Docs inspected: 2026-04-16*

---

### 3.2 EventStoreDB (KurrentDB)

**Stack:** C# / .NET (server); TS/JS client (`@eventstore/db-client`, 175 stars); dedicated server deployment (TCP/gRPC); storage is EventStoreDB-proprietary (append-only log files on disk); license: server is BSL / commercial (Community Edition for dev, Enterprise for production at scale); client is Apache 2.0.

**Maturity signals:** 5 775 GitHub stars (server repo); latest release `v24.10.13` (2026-04-01); actively developed and commercially maintained by KurrentDB (formerly Event Store Ltd); in production at hundreds of enterprises; the original reference implementation for event sourcing.

**Ideology / architectural stance:** EventStoreDB is purpose-built for event sourcing: the storage layer exists solely to manage event streams, and every feature is optimized around that single concern. It provides server-side persistent subscriptions, catch-up subscriptions, projections engine, and a gRPC streaming API. It does not try to be a general-purpose database. The 2024–2025 rebrand to KurrentDB signals continued commercial investment.

**Fit score for D1+N1+N4+N5+N6:** 4/5. Feature-complete for the ES domain. The main penalty is operational burden (dedicated server) and the absence of native crypto-shredding for N1.

**Dealbreakers:**
- **Dedicated server — new ops category.** The D1 stack is Postgres-native; adding EventStoreDB introduces a second database server (patching, backups, HA configuration, monitoring). For a greenfield project with limited DevOps capacity this is a significant cost.
- **Commercial license for production.** Community Edition is limited; production deployments at scale require an Enterprise license. Cost and vendor lock-in are real concerns.
- **No native crypto-shredding.** N1 (GDPR/PII delete) is not solved by the store itself; workarounds require application-layer encryption with external KMS — same gap as all competitors.
- **No EventBridge integration.** The delivery chain uses gRPC persistent subscriptions; bridging to AWS EventBridge requires a custom consumer→publisher relay.

**26-feature coverage:**

| Feature | ESDB |
|---|---|
| F1 — Append-only event log | ✅ |
| F2 — Version-based OCC | ✅ |
| F3 — Multi-aggregate transactional commit | ❌ |
| F4 — Idempotent writes | ✅ |
| F5 — Snapshots | ✅ |
| F6 — Projection runner with checkpoints | ✅ |
| F7 — Projection rebuild | ✅ |
| F8 — Projection lag monitoring | ✅ |
| F9 — Inline (sync) projections | ❌ |
| F10 — External (async) projections | ✅ |
| F11 — Explicit event type versioning | ✅ |
| F12 — Upcaster pipeline | ⚠️ |
| F13 — Event type retirement / rename | ⚠️ |
| F14 — Tolerant deserialization | ⚠️ |
| F15 — Transactional outbox | ❌ |
| F16 — At-least-once + dedup | ✅ |
| F17 — Message bus abstraction | ✅ |
| F18 — Message queue abstraction | ✅ |
| F19 — DLQ / poison-pill handling | ✅ |
| F20 — GDPR crypto-shredding | ❌ |
| F21 — Event encryption at rest | 🔶 |
| F22 — Multi-tenancy | 🔶 |
| F23 — Causation / correlation metadata | ✅ |
| F24 — Replay tooling | ✅ |
| F25 — Observability | ✅ |
| F26 — Testing utilities | ✅ |

*Notes:* F3 rated ❌ — EventStoreDB has no cross-stream atomic transactions; multi-stream writes are not atomic. F9 rated ❌ — ESDB is a separate process; writing to a relational read model in the same transaction as an event write is architecturally impossible. F12/F13 rated ⚠️ — schema evolution is supported via event metadata and naming convention; no native upcaster pipeline. F15 rated ❌ — the dual-write problem is not solved at the store level; requires application-layer outbox to bridge from ESDB to a downstream bus. F20 rated ❌ — no native GDPR key-per-subject shredding; recommended approach is application-layer encryption with external KMS. F21 rated 🔶 — ESDB server supports TLS in transit and disk encryption via OS; payload-level encryption requires application code. Confidence: medium — docs inspection only.

*Docs inspected: 2026-04-16*

---

### 3.3 Marten

**Stack:** C# / .NET 8+; PostgreSQL only (no other storage backends); MIT license; dual-function: document database + event store in the same library. Companion bus library: Wolverine (JasperFx).

**Maturity signals:** 3 361 GitHub stars; latest release `V8.30.1` (2026-04-16 — active releases same day as this inspection); commercially supported by JasperFx Software (paid support plans); widely used in .NET event-sourcing community; production deployments documented in public case studies.

**Ideology / architectural stance:** Marten treats PostgreSQL as a first-class event store by mapping event streams directly to Postgres tables with JSONB payloads and a global sequence column (`seq_id`). Its async daemon (a pull-based catch-up projection runner with durable checkpoints) and inline projections are Postgres-native and deeply integrated with the Postgres transaction model. The library is deliberately .NET-only and does not seek multi-language support.

**Fit score for D1+N1+N4+N5+N6:** 4/5 as a *design reference*; 0/5 for direct adoption (language lock-in). Marten is the closest analogue to the castore+Postgres target architecture. Its patterns — async daemon, projection checkpoints, inline projections within the same `IDocumentSession` transaction, GDPR `mt_soft_delete` pattern — are directly relevant to castore gap designs.

**Dealbreakers:**
- **.NET only — complete language lock-in.** A TypeScript shop cannot adopt Marten directly. This is the hard dealbreaker; Marten is in the set as a *pattern reference*, not an adoption candidate.
- **Postgres-only.** If the architecture requires a non-Postgres backend (e.g. DynamoDB for certain services), Marten has no story there.
- **No native EventBridge integration.** Marten publishes via its own bus abstraction (Wolverine / NServiceBus); bridging to AWS EventBridge is custom work.
- **No native crypto-shredding.** GDPR compliance requires application-layer encryption with external KMS; Marten provides `mt_soft_delete` (logical deletion) but not cryptographic erasure of PII in immutable events.

**26-feature coverage:**

| Feature | Marten |
|---|---|
| F1 — Append-only event log | ✅ |
| F2 — Version-based OCC | ✅ |
| F3 — Multi-aggregate transactional commit | ✅ |
| F4 — Idempotent writes | ✅ |
| F5 — Snapshots | ✅ |
| F6 — Projection runner with checkpoints | ✅ |
| F7 — Projection rebuild | ✅ |
| F8 — Projection lag monitoring | ✅ |
| F9 — Inline (sync) projections | ✅ |
| F10 — External (async) projections | ✅ |
| F11 — Explicit event type versioning | ✅ |
| F12 — Upcaster pipeline | ✅ |
| F13 — Event type retirement / rename | 🔶 |
| F14 — Tolerant deserialization | ✅ |
| F15 — Transactional outbox | ✅ |
| F16 — At-least-once + dedup | ✅ |
| F17 — Message bus abstraction | 🔶 |
| F18 — Message queue abstraction | 🔶 |
| F19 — DLQ / poison-pill handling | 🔶 |
| F20 — GDPR crypto-shredding | ⚠️ |
| F21 — Event encryption at rest | ⚠️ |
| F22 — Multi-tenancy | ✅ |
| F23 — Causation / correlation metadata | ✅ |
| F24 — Replay tooling | ✅ |
| F25 — Observability | ✅ |
| F26 — Testing utilities | ✅ |

*Notes:* F3 rated ✅ — Marten uses `IDocumentSession` transactions that can span multiple streams atomically within a single Postgres transaction. F13 rated 🔶 — event type retirement is handled via the `IEventTransform` / `IEventMapper` convention; controlled but not a first-class built-in. F15 rated ✅ — Marten's async daemon uses a Postgres-native outbox pattern (writing events and daemon progress within the same Postgres transaction). F17/F18/F19 rated 🔶 — Marten integrates with Wolverine (JasperFx message bus) for bus/queue/DLQ; requires a separate Wolverine package. F20 rated ⚠️ — Marten does not provide a key-per-subject encryption API; GDPR erasure is approached via `mt_soft_delete` (marks events deleted but does not cryptographically erase PII). Confidence: medium — docs inspection only; no hands-on verification.

*Docs inspected: 2026-04-16*

---

### 3.4 Equinox

**Stack:** F# / .NET 6+; multi-storage: CosmosDB (primary), DynamoDB, EventStoreDB, MessageDB (Postgres), SqlStreamStore, MemoryStore; projections and subscriptions via companion library Propulsion (`jet/propulsion`); codec abstraction via FsCodec (`jet/FsCodec`); Apache 2.0 license.

**Maturity signals:** 495 GitHub stars; latest release `4.1.0` (2026-02-04); production-proven at Jet.com since 2017 and through Walmart acquisition; small but highly experienced maintainer team; actively maintained.

**Ideology / architectural stance:** Equinox is explicitly a library, not a framework — it provides stream-level event sourcing (append, load, OCC, snapshot/caching) and deliberately omits projections/subscriptions (delegated to Propulsion). Its defining architectural feature is multi-store support with a common decision-flow runner: you write domain logic once and swap the backing store. Snapshot strategies are first-class citizens, with store-specific optimizations (CosmosDB tip-with-unfolds, EventStoreDB rolling snapshots, MessageDB adjacent snapshots). Equinox is the clearest prior art for castore's multi-store vision.

**Fit score for D1+N1+N4+N5+N6:** 2/5 for direct adoption (F# + .NET lock-in is a hard no for a TS shop); 5/5 as a design reference for snapshot-first, multi-store, type-safe event sourcing architecture.

**Dealbreakers:**
- **F# / .NET — complete language lock-in.** Same hard dealbreaker as Marten; cannot be adopted directly by a TypeScript team.
- **Projections are an external library (Propulsion).** The combined Equinox + Propulsion + FsCodec stack is three libraries to learn, configure, and maintain; the surface area is broader than the simple stream-append use case suggests.
- **No native crypto-shredding.** N1 not addressed; FsCodec's codec abstraction could support payload encryption but there is no out-of-the-box KMS integration.
- **No EventBridge adapter.** The AWS delivery chain requires a custom Propulsion consumer-to-EventBridge bridge.

**26-feature coverage:**

| Feature | Equinox |
|---|---|
| F1 — Append-only event log | ✅ |
| F2 — Version-based OCC | ✅ |
| F3 — Multi-aggregate transactional commit | ⚠️ |
| F4 — Idempotent writes | ⚠️ |
| F5 — Snapshots | ✅ |
| F6 — Projection runner with checkpoints | 🔶 |
| F7 — Projection rebuild | 🔶 |
| F8 — Projection lag monitoring | 🔶 |
| F9 — Inline (sync) projections | ⚠️ |
| F10 — External (async) projections | 🔶 |
| F11 — Explicit event type versioning | ✅ |
| F12 — Upcaster pipeline | ✅ |
| F13 — Event type retirement / rename | ⚠️ |
| F14 — Tolerant deserialization | ✅ |
| F15 — Transactional outbox | ❌ |
| F16 — At-least-once + dedup | ⚠️ |
| F17 — Message bus abstraction | ❌ |
| F18 — Message queue abstraction | ❌ |
| F19 — DLQ / poison-pill handling | ❌ |
| F20 — GDPR crypto-shredding | ❌ |
| F21 — Event encryption at rest | ⚠️ |
| F22 — Multi-tenancy | ⚠️ |
| F23 — Causation / correlation metadata | ⚠️ |
| F24 — Replay tooling | 🔶 |
| F25 — Observability | 🔶 |
| F26 — Testing utilities | ✅ |

*Notes:* F3 rated ⚠️ — Equinox operates at per-stream level; multi-stream atomicity is not a core concept (the library is stream-scoped). F6/F7/F8/F10 rated 🔶 — all projection features require Propulsion, a separate companion library. F12 rated ✅ — FsCodec provides explicit `tryDecode` / `encode` functions with union-discriminated versioning, enabling upcaster chains. F15 rated ❌ — no outbox mechanism; the transactional boundary is per-stream; bridging to a bus is Propulsion's job and is not transactionally bound to the event write. F17/F18/F19 rated ❌ — Equinox has no bus/queue/DLQ abstractions; these are out of scope by design. F25 rated 🔶 — Equinox.Core emits Serilog-structured logs and OpenTelemetry is partially implemented (`Equinox.MessageDb`). Confidence: medium on F3/F4/F9/F13/F22/F23 — docs inspection only.

*Docs inspected: 2026-04-16*

---

### 3.5 DIY Postgres baseline

The DIY Postgres baseline represents what a competent senior developer could build in ≤3 working days using only the `pg` npm package, Postgres `SKIP LOCKED` for queue workers, and `LISTEN/NOTIFY` for lightweight pub-sub. Its purpose is to reveal the tier at which a framework begins earning its keep: features rated ✅ here are not strong arguments for adopting any framework, while features rated ⚠️ or ❌ identify where framework abstractions provide genuine leverage.

The baseline explicitly excludes: type-level reducer contracts, schema migration tooling, adapter-swap capabilities, and any abstraction that requires architectural decisions a 3-day sprint cannot resolve. It answers the single question: "could we live without a framework for this feature?" A ✅ DIY rating should deflate a framework's ✅ for that same feature — if anyone can build it in hours, it is not a differentiator.

**26-feature coverage:**

| Feature | DIY Postgres |
|---|---|
| F1 — Append-only event log | ✅ |
| F2 — Version-based OCC | ✅ |
| F3 — Multi-aggregate transactional commit | ✅ |
| F4 — Idempotent writes | ⚠️ |
| F5 — Snapshots | ⚠️ |
| F6 — Projection runner with checkpoints | ⚠️ |
| F7 — Projection rebuild | ⚠️ |
| F8 — Projection lag monitoring | ⚠️ |
| F9 — Inline (sync) projections | ✅ |
| F10 — External (async) projections | ✅ |
| F11 — Explicit event type versioning | ⚠️ |
| F12 — Upcaster pipeline | ❌ |
| F13 — Event type retirement / rename | ❌ |
| F14 — Tolerant deserialization | ⚠️ |
| F15 — Transactional outbox | ⚠️ |
| F16 — At-least-once + dedup | ⚠️ |
| F17 — Message bus abstraction | ✅ |
| F18 — Message queue abstraction | ✅ |
| F19 — DLQ / poison-pill handling | ⚠️ |
| F20 — GDPR crypto-shredding | ❌ |
| F21 — Event encryption at rest | ⚠️ |
| F22 — Multi-tenancy | ⚠️ |
| F23 — Causation / correlation metadata | ⚠️ |
| F24 — Replay tooling | ⚠️ |
| F25 — Observability | ⚠️ |
| F26 — Testing utilities | ❌ |

*Notes:* F1/F2/F3 are straightforward SQL (UNIQUE constraint, BEGIN/COMMIT transaction) — a few hours of work. F9/F10/F17/F18 are similarly achievable with Postgres `LISTEN/NOTIFY` and a simple worker loop. F4–F8 are all ⚠️: achievable but each is a half-day to full-day design decision (idempotency table, snapshot table schema, catch-up loop with checkpoint table, lag query). F12/F13/F20 are ❌: these require framework-level pipeline abstractions or cryptographic infrastructure that cannot be built reliably in 3 days. F26 is ❌ because reusable given/when/then test helpers + an in-memory adapter that faithfully mirrors the real store semantics is a non-trivial framework concern.

---

### 3.6 Consolidated 26×6 feature matrix

**Legend:**

| Symbol | Meaning |
|---|---|
| ✅ | Built-in, first-class |
| 🔶 | First-party extension / official lib |
| ⚠️ | Partial — via convention / manual wiring / with caveats |
| ❌ | Absent — would need to build |

**How to read this matrix:** A ⚠️ cell is a *cost*, not a feature — it means the team must implement, maintain, and test the pattern themselves. A 🔶 cell means installing and learning an additional library (which adds a dependency, a version-management concern, and a possible license consideration). A ✅ in the DIY column means the feature is so simple that any framework claiming it as a differentiator is overstating its value. Read across a row to understand the effort differential; read down a column to understand a product's overall coverage posture.

| Feature | Castore | Emmett | ESDB | Marten | Equinox | DIY |
|---|---|---|---|---|---|---|
| F1 — Append-only event log | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| F2 — Version-based OCC | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| F3 — Multi-aggregate transactional commit | ✅ | ⚠️ | ❌ | ✅ | ⚠️ | ✅ |
| F4 — Idempotent writes | ❌ | ⚠️ | ✅ | ✅ | ⚠️ | ⚠️ |
| F5 — Snapshots | ❌ | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| F6 — Projection runner with checkpoints | ❌ | ✅ | ✅ | ✅ | 🔶 | ⚠️ |
| F7 — Projection rebuild | ❌ | ✅ | ✅ | ✅ | 🔶 | ⚠️ |
| F8 — Projection lag monitoring | ❌ | ⚠️ | ✅ | ✅ | 🔶 | ⚠️ |
| F9 — Inline (sync) projections | ⚠️ | ✅ | ❌ | ✅ | ⚠️ | ✅ |
| F10 — External (async) projections | ✅ | ✅ | ✅ | ✅ | 🔶 | ✅ |
| F11 — Explicit event type versioning | ⚠️ | ⚠️ | ✅ | ✅ | ✅ | ⚠️ |
| F12 — Upcaster pipeline | ❌ | ⚠️ | ⚠️ | ✅ | ✅ | ❌ |
| F13 — Event type retirement / rename | ❌ | ❌ | ⚠️ | 🔶 | ⚠️ | ❌ |
| F14 — Tolerant deserialization | 🔶 | ⚠️ | ⚠️ | ✅ | ✅ | ⚠️ |
| F15 — Transactional outbox | ❌ | ⚠️ | ❌ | ✅ | ❌ | ⚠️ |
| F16 — At-least-once + dedup | ⚠️ | ⚠️ | ✅ | ✅ | ⚠️ | ⚠️ |
| F17 — Message bus abstraction | ✅ | ✅ | ✅ | 🔶 | ❌ | ✅ |
| F18 — Message queue abstraction | ✅ | ⚠️ | ✅ | 🔶 | ❌ | ✅ |
| F19 — DLQ / poison-pill handling | ❌ | ❌ | ✅ | 🔶 | ❌ | ⚠️ |
| F20 — GDPR crypto-shredding | ❌ | ❌ | ❌ | ⚠️ | ❌ | ❌ |
| F21 — Event encryption at rest | ❌ | ❌ | 🔶 | ⚠️ | ⚠️ | ⚠️ |
| F22 — Multi-tenancy | ❌ | ⚠️ | 🔶 | ✅ | ⚠️ | ⚠️ |
| F23 — Causation / correlation metadata | ❌ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
| F24 — Replay tooling | ⚠️ | ⚠️ | ✅ | ✅ | 🔶 | ⚠️ |
| F25 — Observability | ❌ | ⚠️ | ✅ | ✅ | 🔶 | ⚠️ |
| F26 — Testing utilities | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |

---

### 3.7 Competitors deliberately excluded

The following competitors were evaluated during competitor selection and excluded from the primary analysis:

- **Prooph** (PHP) — abandoned 2023; PHP ecosystem mismatch; no longer a meaningful reference.
- **@nestjs/cqrs** — CQRS pattern only; no storage layer; not an event-sourcing framework.
- **Axon** (Java) — different language, actor-model philosophy; comparison would mislead rather than inform.
- **Akka Persistence** (Scala) — actor model; architectural analogy is too different to be actionable.
- **MongoDB event stores** — community plugins only, no cohesive framework; comparison surface is too fragmented.

## 4. Castore current state — per feature

---

### Category A — Storage & consistency

**Category A tally:** castore — 3/5 ✅ · 0/5 🔶 · 0/5 ⚠️ · 2/5 ❌ (F4 idempotent writes absent, F5 snapshots absent)

---

### Feature 1 — Append-only event log

```
Status:            ✅
Layer:             core + postgres-adapter + in-memory-adapter
Evidence:          packages/event-storage-adapter-postgres/src/adapter.ts:115-129 (UNIQUE constraint on aggregate_name+aggregate_id+version);
                   packages/event-storage-adapter-postgres/src/adapter.ts:244-258 (pushEvent raises PostgresEventAlreadyExistsError on PG error 23505);
                   packages/event-storage-adapter-in-memory/src/adapter.ts:148-169 (pushEventSync rejects duplicate version unless force=true);
                   packages/core/src/eventStorageAdapter.ts:39-43 (pushEvent interface — no delete/update operation defined)
How it works:      The EventStorageAdapter interface exposes only getEvents, pushEvent, pushEventGroup, and listAggregateIds — no update or delete operations. The Postgres adapter enforces append-only via a UNIQUE(aggregate_name, aggregate_id, version) constraint defined at table-creation time. The in-memory adapter enforces the same invariant in pushEventSync by checking for an existing event at the same version. Both adapters raise an EventAlreadyExistsError on violation, preventing silent overwrites.
Guarantees:        Test-covered: adapter.unit.test.ts files for both Postgres and in-memory adapters cover the conflict path. The adapter interface contract (packages/core/src/eventStorageAdapter.ts) encodes the absence of mutating operations at the type level.
Known limits:      The force=true option on PushEventOptions (packages/core/src/eventStorageAdapter.ts:13–14) bypasses the append-only guarantee by converting the INSERT into an UPSERT (ON CONFLICT DO UPDATE). This is intentional for replay/backfill scenarios but means append-only is a convention, not an absolute DB-level constraint when force is used. No caller-side guard prevents accidental force=true in production code.
Finance fit note:  The regulatory audit trail requirement (D1) depends directly on this guarantee. The UNIQUE constraint at the Postgres level is the strongest safeguard; the in-memory adapter is test-only and consistent with it. The force=true escape hatch must be access-controlled at the application layer.
```

---

### Feature 2 — Version-based optimistic concurrency (OCC)

```
Status:            ✅
Layer:             core + postgres-adapter + in-memory-adapter
Evidence:          packages/event-storage-adapter-postgres/src/adapter.ts:237-258 (INSERT catches PG error 23505 and re-raises as PostgresEventAlreadyExistsError with aggregateId+version);
                   packages/core/src/eventStore/errors/eventAlreadyExists.ts:1-17 (EventAlreadyExistsError interface with aggregateId and version fields);
                   packages/event-storage-adapter-in-memory/src/adapter.ts:148-164 (version collision check in pushEventSync);
                   packages/core/src/eventStore/eventStore.ts:187-215 (EventStore.pushEvent passes caller-supplied version through to adapter)
How it works:      Each event carries a caller-supplied version number (packages/core/src/event/eventDetail.ts:14). The Postgres adapter relies on the UNIQUE(aggregate_name, aggregate_id, version) constraint to atomically detect concurrent writes: a second writer using the same version receives Postgres error 23505, which the adapter translates into EventAlreadyExistsError. The in-memory adapter performs the same check explicitly. The application layer reads the current version via getAggregate, increments, and passes it to pushEvent; the store rejects it if another writer committed between the read and the push.
Guarantees:        The error type (EventAlreadyExistsError) is a stable, typed contract exported from core. Test coverage in both adapter unit-test files validates the conflict path. Type-level: version is a required number on EventDetail (eventDetail.ts:14).
Known limits:      There is no built-in retry helper in core; callers must implement retry-on-conflict themselves. The expectedVersion convention is implicit (caller must read then write) rather than an explicit API parameter; a caller who never reads the current version can silently overwrite events if the conflict happens not to fire. No test validates the retry path end-to-end.
Finance fit note:  OCC is the primary defence against double-booking in concurrent payment commands. The absence of a built-in retry helper is a userland gap but not a framework deficiency; adding one is low-effort (S) and can be done in application code.
```

---

### Feature 3 — Multi-aggregate transactional commit

```
Status:            ✅
Layer:             core + postgres-adapter
Evidence:          packages/core/src/eventStore/eventStore.ts:42-109 (EventStore.static pushEventGroup implementation);
                   packages/core/src/eventStorageAdapter.ts:43-47 (pushEventGroup in the adapter interface);
                   packages/event-storage-adapter-postgres/src/adapter.ts:306-437 (pushEventGroup wraps all inserts in this._sql.begin(async transaction => {...}));
                   packages/event-storage-adapter-postgres/src/adapter.ts:328-345 (adapter type-guard: all grouped events must use PostgresEventStorageAdapter — throws if not)
How it works:      EventStore.pushEventGroup is a static method that accepts one or more GroupedEvent objects (each carrying its own event detail, event store context, and adapter reference). The Postgres adapter implements pushEventGroup by wrapping all INSERT statements in a single postgres.js transaction (this._sql.begin). If any INSERT fails — including a version conflict — the entire transaction is rolled back. The static method then calls each store's onEventPushed callback after the transaction succeeds, enabling downstream bus publication per stream.
Guarantees:        The transaction boundary is enforced by the Postgres driver (postgres.js begin/rollback). Test-covered: adapter.unit.test.ts exercises the group insert path. The adapter guard (hasABadAdapter check) ensures all events in a group belong to the same Postgres instance, preventing partial commits across heterogeneous adapters.
Known limits:      The single-adapter constraint (line 328–345: all grouped events must share one PostgresEventStorageAdapter instance) means cross-region or cross-database transactional commits are not possible. The in-memory adapter's pushEventGroup uses a manual rollback loop (packages/event-storage-adapter-in-memory/src/adapter.ts:195–226) — not a true atomic transaction; safe only for testing.
Finance fit note:  Critical for double-entry bookkeeping (D1): a debit event on an account stream and a credit event on another must commit atomically. This is one of castore's strongest features for the finance profile.
```

---

### Feature 4 — Idempotent writes

```
Status:            ❌
Layer:             — (absent)
Evidence:          Absence confirmed on 2026-04-16 via:
                   (1) Code grep `idempoten|dedup|correlationToken|idempotencyKey` across packages/**/src/**/*.ts → 0 matches.
                   (2) Docs grep same patterns across docs/docs/**/*.md → 0 matches.
                   (3) Package-metadata grep of description+keywords in all 8 in-scope packages/*/package.json → 0 matches.
                   Confidence: high. Feature is named in Vernon IDDD ch. 8; all three searches returned zero.
How it works:      Not implemented. There is no idempotency-key field on the event envelope (packages/core/src/event/eventDetail.ts:3–22 — fields are aggregateId, version, type, timestamp, payload, metadata only). The EventStorageAdapter interface defines no deduplication semantics. The only form of "you cannot push this twice" is the version-based OCC collision (F2), which prevents two pushes at the same version — a different guarantee from idempotency-by-key.
Guarantees:        None. Retry of a failed pushEvent may produce a duplicate event at the next version number if the original write succeeded at the DB level but the response was lost.
Known limits:      Network-level retries without idempotency keys create duplicate events, which in a financial system means duplicate charges or credits. This is a critical gap (Finance: N4 zero event loss + exact-once semantics). Userland workaround requires a separate idempotency table or using the command ID as the aggregate ID prefix.
Finance fit note:  MUST-have for D1 (financial payments). A retried payment command that pushes event v=3 a second time produces a real monetary duplicate. No framework-level mitigation exists; each command handler team must implement its own dedup.
Upstream signal: see Appendix §8.1 for upstream issue/PR #180.
```

---

### Feature 5 — Snapshots

```
Status:            ❌
Layer:             — (absent)
Evidence:          Absence confirmed on 2026-04-16 via:
                   (1) Code grep `snapshot|Snapshot|getLastVersion|cachedAggregate` across packages/**/src/**/*.ts → 0 matches.
                   (2) Docs grep same patterns across docs/docs/**/*.md → docs/docs/3-reacting-to-events/5-snapshots.md mentions snapshots as a userland pattern only ("One solution is to periodically persist snapshots of your aggregates, e.g. through a message bus listener") — no framework API.
                   (3) Package-metadata grep → 0 matches. Keywords in all 8 packages: ["event","source","store","typescript"] only.
                   Confidence: high. The docs snapshot page describes a convention, not a framework feature.
How it works:      Not implemented. getAggregate (packages/core/src/eventStore/eventStore.ts:242–252) always replays from version 1 via getEvents with no minVersion floor other than an explicit maxVersion option. There is no snapshotStore abstraction, no getLastSnapshot/putSnapshot adapter method, and no reducer checkpoint in core. The docs page (docs/docs/3-reacting-to-events/5-snapshots.md) acknowledges the problem and points users to rolling their own snapshot via a message-bus listener.
Guarantees:        None. Aggregate reconstruction is always O(n events) per call.
Known limits:      For long-lived financial account streams (N5) — an account with 10 000+ events over 5 years — every getAggregate call replays all events. This becomes a latency problem at ~hundreds of events and a correctness risk (timeout) at thousands. The workaround (periodic snapshot via bus listener) is complex, error-prone, and not type-safe.
Finance fit note:  MUST-have for N5 (long aggregate streams). Without snapshots, accounts accumulate unbounded replay cost. This is the second-most critical structural gap after the transactional outbox.
Upstream signal: see Appendix §8.1 for upstream issue/PR #161 and #181.
```

---

### Category B — Projection & read-side

**Category B tally:** castore — 1/5 ✅ · 0/5 🔶 · 1/5 ⚠️ · 3/5 ❌ (F6 projection runner, F7 rebuild, F8 lag monitoring absent)

---

### Feature 6 — Projection runner with checkpoints

```
Status:            ❌
Layer:             — (absent)
Evidence:          Absence confirmed on 2026-04-16 via:
                   (1) Code grep `checkpoint|lastProcessed|resumeFrom|subscription|projectionRunner` across packages/**/src/**/*.ts → 0 matches in in-scope packages.
                   (2) Docs grep same patterns across docs/docs/**/*.md → 0 matches.
                   (3) Package-metadata grep → 0 matches.
                   Confidence: medium.
How it works:      Not implemented. There is no pull-based catch-up loop, no checkpoint table, and no projection runner concept in any in-scope package. The only event-distribution mechanism is push-based: ConnectedEventStore.pushEvent (packages/core/src/connectedEventStore/connectedEventStore.ts:134–140) publishes to a message channel after the event write. A consumer that misses a message has no catch-up mechanism within the framework.
Guarantees:        None.
Known limits:      Any projection or read-model worker must subscribe to the message bus and handle its own missed-event recovery. If the bus delivers at-least-once and the consumer crashes, replaying missed events requires out-of-band tooling (lib-dam, which is out of scope). There is no framework guarantee that all events reach projections.
Finance fit note:  Account balance projections and transaction history views depend on reliable event delivery. The absence of a catch-up subscription means balance queries can be stale with no framework-level detection. Intersects N4 (zero event loss) and N5 (long streams that need efficient catch-up on startup).
Upstream signal: see Appendix §8.1 for upstream issue/PR #49.
```

---

### Feature 7 — Projection rebuild

```
Status:            ❌
Layer:             — (absent)
Evidence:          Absence confirmed on 2026-04-16 via:
                   (1) Code grep `rebuild|fromGenesis|replayAll|dropProjection` across packages/**/src/**/*.ts → 0 matches.
                   (2) docs grep → 0 matches.
                   (3) Package-metadata grep → 0 matches.
                   Confidence: high. Note: out-of-scope lib-dam contains `pourEventStoreEvents` / `pourEventStoreAggregateIds` which pass replay:true to a message channel — this is the closest analogue but is explicitly out of scope.
How it works:      Not implemented in the in-scope package set. A rebuild requires: (a) a way to iterate all events in global order, (b) a checkpoint reset, (c) re-processing each event through the projection. The in-scope adapters provide listAggregateIds and getEvents per aggregate (packages/core/src/eventStorageAdapter.ts:34–51) but no global ordered stream. Rebuilding a projection requires userland scripts that loop over all aggregate IDs, fetch events per aggregate, and replay.
Guarantees:        None at framework level.
Known limits:      Rebuilding a read model for a large event store (millions of events) requires custom tooling per project. With no ordered global sequence in the Postgres table (no single monotonic global_position column), total-order replay is not straightforward. This ties directly to the absence of F6.
Finance fit note:  Required for deployment of schema migrations to read models (N6) and for recovery from read-model corruption. The absence of this feature means every team builds bespoke replay scripts.
```

---

### Feature 8 — Projection lag monitoring

```
Status:            ❌
Layer:             — (absent)
Evidence:          Absence confirmed on 2026-04-16 via:
                   (1) Code grep `projectionLag|lag|headPosition|checkpoint` across packages/**/src/**/*.ts → 0 matches.
                   (2) Docs grep → 0 matches.
                   (3) Package-metadata grep → 0 matches.
                   Confidence: high. This feature depends on F6 (projection runner with checkpoints); since F6 is absent, F8 cannot exist.
How it works:      Not implemented. There is no head-position concept in the event store (no global sequence number), no checkpoint storage, and therefore no lag measurement. Monitoring is entirely a userland concern.
Guarantees:        None.
Known limits:      Without lag metrics, stale balance queries in a financial UI are invisible until a user notices incorrect data. This is an operational risk rather than a correctness risk — the system can still function, but operators have no early warning of projection failures.
Finance fit note:  Relevant for SLA monitoring on account balance queries. Depends on F6 being implemented first; classify as COULD until F6 (SHOULD) is delivered.
```

---

### Feature 9 — Inline (sync) projections

```
Status:            ⚠️
Layer:             userland-convention
Evidence:          packages/core/src/eventStore/eventStore.ts:206–215 (onEventPushed callback called synchronously after pushEvent — user can write to a read model here);
                   packages/core/src/eventStore/types.ts (OnEventPushed type);
                   packages/core/src/eventStore/eventStore.ts:42–109 (pushEventGroup also calls onEventPushed per event after the DB transaction commits)
How it works:      The EventStore constructor accepts an optional onEventPushed callback (packages/core/src/eventStore/eventStore.ts:206–215). This callback is invoked synchronously within the pushEvent flow after the adapter write returns, allowing a caller to update a read model before pushEvent returns to the command handler. However, this callback fires *after* the adapter write (not in the same DB transaction), making it a post-commit hook rather than a true transactional inline projection. A crash between the adapter write and the callback leaves the read model stale.
Guarantees:        Convention-only. There is no test enforcing that onEventPushed is called before pushEvent returns to the user in all code paths. The callback's failure does not roll back the event write (no compensating transaction).
Known limits:      Not truly "in same DB transaction" — the callback fires after the adapter write completes. For a Postgres-backed store, writing to a read model inside onEventPushed requires a separate DB connection or transaction, breaking the atomicity guarantee of a true inline projection. This is the userland pattern the framework supports, not an integrated feature. Classified ⚠️ rather than ❌ because an `onEventPushed` extension point exists as a userland convention; a transactionally-coupled inline projection is not achievable through the current contract.
Finance fit note:  Useful for simple derived state (e.g. updating an account balance table) but risky for financial use cases where the read model must be transactionally consistent with the event log. A crash window exists between event write and read-model update.
```

---

### Feature 10 — External (async) projections

```
Status:            ✅
Layer:             core + eventbridge-adapter
Evidence:          packages/core/src/connectedEventStore/connectedEventStore.ts:134–140 (pushEvent calls publishPushedEvent after adapter write);
                   packages/core/src/connectedEventStore/publishPushedEvent.ts:1–53 (publishes NotificationMessage or StateCarryingMessage to the channel);
                   packages/message-bus-adapter-event-bridge/src/adapter.ts:74–78 (publishMessage sends PutEventsCommand to EventBridge);
                   packages/core/src/messaging/bus/notificationMessageBus.ts + stateCarryingMessageBus.ts (bus abstraction)
How it works:      ConnectedEventStore wraps an EventStore with a MessageChannel. After each pushEvent the framework automatically publishes a notification message (event only) or state-carrying message (event + current aggregate) to the configured channel via publishPushedEvent. EventBridge adapter sends the message via AWS SDK PutEventsCommand. Downstream projection workers subscribe to the bus and process events asynchronously. The replay option (PublishMessageOptions.replay) marks messages as __REPLAYED__ on EventBridge's detail-type, allowing consumers to distinguish live from replayed messages.
Guarantees:        The publish step is covered by unit tests (adapter.unit.test.ts). The type-level message envelope (NotificationMessage/StateCarryingMessage) is exported and stable. The replay flag is tested (message-bus-adapter-event-bridge/src/adapter.unit.test.ts:82–83).
Known limits:      Publish is fire-and-forget after the DB commit (not in the same transaction — see F15). A process crash between DB commit and EventBridge PutEvents loses the message with no retry within the framework. Consumers must handle at-least-once delivery and implement their own dedup. No built-in catch-up if a consumer was offline.
Finance fit note:  The primary mechanism for read-side projections (account balances, transaction feeds). The fire-and-forget publish is the core of the N4 (zero event loss) gap — until a transactional outbox is added, event loss is possible.
```

---

### Category C — Schema evolution

**Category C tally:** castore — 0/4 ✅ · 1/4 🔶 · 1/4 ⚠️ · 2/4 ❌ (F12 upcaster pipeline absent, F13 event type retirement absent)

---

### Feature 11 — Explicit event type versioning

```
Status:            ⚠️
Layer:             userland-convention
Evidence:          packages/core/src/event/eventDetail.ts:3–22 (EventDetail type — fields: aggregateId, version, type, timestamp, payload, metadata; version is aggregate stream position, not event schema version);
                   packages/core/src/event/eventType.ts:4–34 (EventType class — type field is a string literal; no schemaVersion field);
                   packages/event-type-zod/src/eventType.ts:1–46 (ZodEventType extends EventType — adds payloadSchema/metadataSchema; no event schema version field)
How it works:      The event envelope has a `version` field (eventDetail.ts:14) but this is the aggregate stream position (1, 2, 3 ...), not an event schema version. There is no dedicated schema-version field on EventDetail or EventType. The only supported versioning convention is encoding the schema version into the event type string literal (e.g. `ACCOUNT_CREDITED_V2`) — this is naming convention only, not a framework concept. ZodEventType adds payload/metadata Zod schemas but has no notion of schema evolution.
Guarantees:        Convention-only. No test enforces versioned type naming. The type compiler ensures type-string uniqueness within an EventStore's union, but not schema-version semantics.
Known limits:      No framework-level separation of "aggregate version" from "event schema version" means consumers must inspect event type string names to detect schema evolution. Tooling for listing all schema versions of a given event type does not exist. This is the prerequisite for F12 (upcaster pipeline).
Finance fit note:  For a 5+ year event horizon (N6), schema evolution without explicit versioning is fragile. New developers cannot discover the version history of an event type from the framework; they must search commit history or naming conventions.
Upstream signal: see Appendix §8.1 for upstream issue/PR #123.
```

---

### Feature 12 — Upcaster pipeline

```
Status:            ❌
Layer:             — (absent)
Evidence:          Absence confirmed on 2026-04-16 via:
                   (1) Code grep `upcast|upcaster|migrate.*event|transform.*event|schemaVersion` across packages/**/src/**/*.ts → 0 matches.
                   (2) Docs grep same patterns across docs/docs/**/*.md → 0 matches.
                   (3) Package-metadata grep → 0 matches.
                   Confidence: medium.
How it works:      Not implemented. getEvents (packages/core/src/eventStorageAdapter.ts:34–38) returns raw EventDetail objects as stored; there is no read-time transformation layer. A consumer receiving an old-schema event must handle the old shape directly. There is no registered pipeline of (eventType, versionFrom, versionTo) → transform functions anywhere in core or the adapters.
Guarantees:        None.
Known limits:      Without upcasters, any change to event payload structure requires either: (a) keeping all old event handlers in the application forever, or (b) a one-off migration script that rewrites stored events (violating append-only). Both approaches are error-prone over a 5-year horizon. This is a SHOULD-have gap for N6.
Finance fit note:  Regulatory reporting may require re-processing historical events through new schema; without an upcaster pipeline this requires custom migration code per event type change.
```

---

### Feature 13 — Event type retirement / rename

```
Status:            ❌
Layer:             — (absent)
Evidence:          Absence confirmed on 2026-04-16 via:
                   (1) Code grep `deprecat|retire|removeEventType|legacyType` across packages/**/src/**/*.ts → 0 matches.
                   (2) Docs grep `deprecat|retire|remove.*event` across docs/docs/**/*.md → only one match in migration guides referencing a DynamoDB adapter rename (docs/docs/5-migration-guides/1-v1-to-v2.md:102), not an event-type retirement mechanism.
                   (3) Package-metadata grep → 0 matches.
                   Confidence: high.
How it works:      Not implemented. EventType (packages/core/src/event/eventType.ts) has no deprecated flag, no replacement pointer, and no controlled removal mechanism. Old event types remain in the EventStore's EVENT_TYPES union indefinitely; removing one is a breaking type change with no migration path. The reserved event types set (packages/core/src/event/reservedEventTypes.ts) exists only to guard __REPLAYED__ and __AGGREGATE_EXISTS__ from accidental use.
Guarantees:        None.
Known limits:      Accumulation of obsolete event types in the union type makes the domain model increasingly noisy. More critically, there is no way to validate at the store level that a deprecated event type is no longer being pushed, preventing "silent reactivation" bugs.
Finance fit note:  Over a 5-year lifecycle (N6), event types will be renamed and retired. Without a formal retirement mechanism each team maintains its own ad-hoc convention.
```

---

### Feature 14 — Tolerant deserialization

```
Status:            🔶
Layer:             zod-event-type-lib
Evidence:          packages/event-type-zod/src/eventType.ts:1–46 (ZodEventType — payload/metadata schemas are optional; parsing is handled by payloadSchema.parse() when defined);
                   packages/core/src/event/eventType.ts:12–28 (base EventType.parseEventDetail is optional; returns isValid flag);
                   packages/event-type-zod/src/eventType.unit.test.ts (no passthrough/strip test — Zod default is .strip() on objects, i.e. unknown fields are silently dropped)
How it works:      ZodEventType stores a Zod schema for payload and metadata. Zod's default object parsing mode is .strip() — unknown fields are silently removed, which is tolerant in the sense that unknown fields do not cause a parse failure. However, the base EventType class has no parseEventDetail implementation at all (it is optional), and the core adapter layer never calls parseEventDetail — events are returned as raw JSON from the DB without schema validation. Tolerance is therefore: (a) never tested against the actual adapter deserialization path, and (b) only operative if the application explicitly calls parseEventDetail.
Guarantees:        Convention: Zod default strip behaviour means a ZodEventType schema will not fail on unknown fields if the application layer calls parseEventDetail. Not adapter-level enforced.
Known limits:      The adapter (postgres adapter.ts:169–186 toEventDetail) returns a plain EventDetail from raw DB row JSON — no schema validation is applied at the read path. parseEventDetail is entirely optional; a consumer that does not call it gets the raw shape with no tolerance guarantee. There is no framework mechanism to enforce that parseEventDetail is called.
Finance fit note:  Forward compatibility across deployments (N6) requires tolerant reading. The Zod strip default provides this, but only if applications call parseEventDetail — which is convention, not enforcement.
```

---

### Category D — Distributed delivery

**Category D tally:** castore — 2/5 ✅ · 0/5 🔶 · 1/5 ⚠️ · 2/5 ❌ (F15 transactional outbox absent, F19 DLQ absent)

---

### Feature 15 — Transactional outbox

```
Status:            ❌
Layer:             — (absent)
Evidence:          Absence confirmed on 2026-04-16 via:
                   (1) Code grep `outbox|transactionalOutbox|relay|inbox` across packages/**/src/**/*.ts → 0 matches.
                   (2) Docs grep same patterns → 0 matches.
                   (3) Package-metadata grep → 0 matches.
                   Critical architectural observation: packages/core/src/connectedEventStore/connectedEventStore.ts:134–140 shows that pushEvent calls publishPushedEvent AFTER the adapter write returns — two separate operations, no shared transaction.
                   Confidence: high.
How it works:      Not implemented. ConnectedEventStore.pushEvent (line 134–140) calls the underlying event store's pushEvent, waits for it to complete, then calls publishPushedEvent. PublishPushedEvent (packages/core/src/connectedEventStore/publishPushedEvent.ts:26–49) calls messageChannel.publishMessage, which invokes the EventBridge PutEvents API. These are two independent async calls with no transactional binding. A process crash, network failure, or EventBridge throttle error after the DB write but before PutEvents succeeds results in a committed event that is never published to the bus.
Guarantees:        None. The dual-write gap is real and documented in the code structure.
Known limits:      This is the most critical structural gap for the N4 (zero event loss) requirement. Without a transactional outbox (write event + outbox row in same DB tx; relay worker publishes from outbox), there is an inherent window of message loss on every pushEvent call. EventBridge throttling under load widens this window further.
Finance fit note:  MUST-have for N4. A payment-confirmed event that is stored in the DB but never published to the bus means the balance projection is never updated — the user sees an incorrect balance. This is the single highest-priority gap for the D1 finance profile.
```

---

### Feature 16 — At-least-once delivery + idempotent consumer

```
Status:            ⚠️
Layer:             eventbridge-adapter + userland-convention
Evidence:          packages/message-bus-adapter-event-bridge/src/adapter.ts:67–78 (formatMessage sets Detail to JSON.stringify(message), Source to eventStoreId, DetailType to event.type — no stable dedup ID added);
                   packages/core/src/event/eventDetail.ts:3–22 (EventDetail has aggregateId + version — together they form a stable natural key);
                   packages/core/src/messaging/channel/types.ts:1–3 (PublishMessageOptions.replay flag exists)
How it works:      EventBridge delivers messages at-least-once. The framework publishes each event as an EventBridge entry with Source=eventStoreId, DetailType=event.type, and Detail=JSON.stringify(message) — the full event including aggregateId and version. Consumers can derive a stable dedup key from (eventStoreId, aggregateId, version) from the message detail, but the adapter does not set an explicit MessageDeduplicationId or idempotency key field on the EventBridge entry. Dedup is a consumer-side responsibility using the natural key.
Guarantees:        The natural key (aggregateId + version) is always present in the message payload (guaranteed by EventDetail type). The replay flag allows consumers to distinguish live from replayed messages.
Known limits:      No framework helper for consumer-side dedup; each projection/handler must implement its own. EventBridge standard buses do not support dedup natively (only FIFO queues with message group IDs do). Redelivery after a consumer crash can produce double-processing without an idempotency table.
Finance fit note:  Consumer-side dedup is necessary for all financial handlers (payment confirmed, balance updated). The natural key exists but the framework provides no dedup helper, leaving each handler team to re-implement the same pattern.
```

---

### Feature 17 — Message bus abstraction

```
Status:            ✅
Layer:             core
Evidence:          packages/core/src/messaging/bus/notificationMessageBus.ts:1–25 (NotificationMessageBus class);
                   packages/core/src/messaging/bus/stateCarryingMessageBus.ts (StateCarryingMessageBus);
                   packages/core/src/messaging/bus/aggregateExistsMessageBus.ts (AggregateExistsMessageBus);
                   packages/core/src/messaging/channel/messageChannelAdapter.ts:1–13 (MessageChannelAdapter interface: publishMessage + publishMessages)
How it works:      Core defines three bus types (Notification, StateCarrying, AggregateExists) that extend the NotificationMessageChannel/StateCarryingMessageChannel base classes. Each bus holds a list of source event stores and a MessageChannelAdapter. The adapter interface (MessageChannelAdapter) has two methods: publishMessage and publishMessages. Swapping the implementation (in-memory for tests, EventBridge for production) requires only changing the adapter instance — application code is insulated. Fan-out to multiple consumers is handled at the EventBridge rule level, not in castore.
Guarantees:        The MessageChannelAdapter interface is a stable type contract exported from core. Type-level: the message shape (NotificationMessage / StateCarryingMessage) is typed to the specific event store's event union.
Known limits:      No built-in retry, backoff, or circuit breaker in the bus publish path. Fan-out to multiple handlers is EventBridge-native (rules), not framework-managed. There is no in-scope bus adapter other than EventBridge (in-memory bus is out of scope per audit scope).
Finance fit note:  The bus abstraction is well-designed for the D1 profile. The three message types (notification, state-carrying, aggregate-exists) cover the most common financial event patterns.
```

---

### Feature 18 — Message queue abstraction

```
Status:            ✅
Layer:             core
Evidence:          packages/core/src/messaging/queue/notificationMessageQueue.ts:1–25 (NotificationMessageQueue class);
                   packages/core/src/messaging/queue/stateCarryingMessageQueue.ts (StateCarryingMessageQueue);
                   packages/core/src/messaging/queue/aggregateExistsMessageQueue.ts (AggregateExistsMessageQueue);
                   packages/core/src/messaging/channel/messageChannelAdapter.ts:1–13 (same MessageChannelAdapter interface as bus)
How it works:      Core defines three queue types mirroring the bus types. They share the same MessageChannelAdapter interface as the bus, allowing the same adapter implementation to back both a bus and a queue. The distinction (bus = fan-out, queue = single consumer) is expressed at the type level (messageChannelType: 'bus' | 'queue') and enforced at the infrastructure level by the adapter. The in-memory queue adapter (out of scope) and SQS adapter (out of scope) are the reference implementations. The framework provides the abstraction; adapter selection determines the delivery guarantee.
Guarantees:        Type-level: queue message type is correctly narrowed. Unit tests for queue types exist in packages/core/src/messaging/queue/*.fixtures.test.ts and *.type.test.ts.
Known limits:      No in-scope queue adapter in the audit set — only the EventBridge bus adapters are in scope. The queue abstraction exists in core but is only exercised with out-of-scope adapters (SQS). For EventBridge, the queue pattern requires an EventBridge → SQS target configured outside the framework.
Finance fit note:  Worker pattern (single-consumer queue) is needed for idempotent payment processing side effects. The abstraction is present; the in-scope adapter gap is the real constraint.
```

---

### Feature 19 — Dead-letter queue / poison-pill handling

```
Status:            ❌
Layer:             — (absent in-scope; AWS-native only)
Evidence:          Absence confirmed on 2026-04-16 via:
                   (1) Code grep `DLQ|dead.letter|deadLetter|poison|maxReceiveCount|retryPolicy` across packages/**/src/**/*.ts → 0 matches in in-scope packages.
                   (2) Docs grep → 0 matches.
                   (3) Package-metadata grep → 0 matches.
                   Confidence: medium. DLQ support exists at the AWS EventBridge/SQS infrastructure level, but castore has no API surface for it.
How it works:      Not implemented at the framework level. The EventBridge adapter (packages/message-bus-adapter-event-bridge/src/adapter.ts) sends PutEvents with no retry configuration or failure callback. If a consumer Lambda throws, the retry behaviour is controlled entirely by EventBridge rule settings or SQS queue configuration — not by castore. There is no framework API to configure max retries, DLQ target, or failure reason capture.
Guarantees:        None from castore. AWS infrastructure provides DLQ routing but the application must configure it manually via CDK/CloudFormation.
Known limits:      Without framework-level DLQ convention, a poison-pill event (e.g. one that always throws a deserialization error) will retry indefinitely at the AWS level without surfacing to the application. No structured failure reason is captured by castore alongside the original message.
Finance fit note:  Important for operational resilience: a payment event that fails processing due to a bug must be routed to a DLQ with the original message and failure context, not silently dropped. Currently requires 100% infrastructure-layer configuration with no castore involvement.
```

---

### Category E — Operational & governance

**Category E tally:** castore — 1/7 ✅ · 0/7 🔶 · 1/7 ⚠️ · 5/7 ❌ (F20 crypto-shredding, F21 encryption at rest, F22 multi-tenancy, F23 causation/correlation, F25 observability absent; F24 replay partial ⚠️)

---

### Feature 20 — GDPR crypto-shredding

```
Status:            ❌
Layer:             — (absent)
Evidence:          Absence confirmed on 2026-04-16 via:
                   (1) Code grep `crypto.?shred|per.?subject.?key|encryption.?key|\bkms\b|envelope.?encrypt` across packages/**/src/**/*.ts → 0 matches.
                   (2) Docs grep same patterns → 0 matches.
                   (3) Package-metadata grep → 0 matches.
                   Confidence: high.
How it works:      Not implemented. The event payload (packages/core/src/event/eventDetail.ts:15) is stored as plain JSONB (packages/event-storage-adapter-postgres/src/adapter.ts:122: `data JSONB`). There is no per-subject key registry, no payload encryption at push time, and no key-deletion mechanism. PII written to an event payload is stored in plaintext indefinitely.
Guarantees:        None.
Known limits:      Without crypto-shredding, GDPR Article 17 (right to erasure) cannot be satisfied while maintaining the immutable event log. A data erasure request for a customer requires either physically deleting events (violating append-only) or writing tombstone/correction events (which still leaves the PII in historical events). This is a regulatory blocker for a financial product operating in the EU.
Finance fit note:  MUST-have for N1 (GDPR/PII delete). This is the single highest-risk compliance gap. Every event type that contains customer PII (name, IBAN, email, address) is potentially non-compliant without this feature. Requires KMS integration, per-subject key table, and encryption at push/decrypt at read — an L–XL effort.
```

---

### Feature 21 — Event encryption at rest

```
Status:            ❌
Layer:             — (absent; infrastructure-layer concern)
Evidence:          Absence confirmed on 2026-04-16 via:
                   (1) Code grep `encrypt.*event|payload.*encrypt|pgcrypto|encrypt` across packages/**/src/**/*.ts → 0 matches.
                   (2) Docs grep → 0 matches.
                   (3) Package-metadata grep → 0 matches.
                   Confidence: medium. Postgres TDE / AWS RDS encryption at rest is an infrastructure concern outside the framework.
How it works:      Not implemented at the framework level. Events are stored as plaintext JSONB (packages/event-storage-adapter-postgres/src/adapter.ts:122). Encryption at rest is an infrastructure-layer responsibility: AWS RDS supports transparent encryption of storage volumes, which protects against physical media access. The framework provides no payload-level encryption that would protect data from a compromised DB admin or application user.
Guarantees:        None from castore.
Known limits:      Framework-level payload encryption (distinct from TDE) would provide an additional layer of protection for sensitive fields even when the DB is accessible via SQL. The current design relies entirely on infrastructure-layer controls. Note: implementing this correctly typically requires a key-management service and adds complexity to the read path (decrypt on getEvents).
Finance fit note:  Partially addressed by infrastructure (AWS RDS encryption) for the N1 profile, but payload-level encryption is a defence-in-depth measure for financial PII. The absence of framework support means all encryption must be implemented in every command handler individually. This may be classified COULD if TDE is accepted as sufficient.
```

---

### Feature 22 — Multi-tenancy

```
Status:            ❌
Layer:             — (absent; out of profile — see note)
Evidence:          Absence confirmed on 2026-04-16 via:
                   (1) Code grep `tenant|multiTenant|tenantId|rowLevelSecurity` across packages/**/src/**/*.ts → 0 matches.
                   (2) Docs grep → 0 matches.
                   (3) Package-metadata grep → 0 matches.
                   Confidence: high.
How it works:      Not implemented. The event table schema (packages/event-storage-adapter-postgres/src/adapter.ts:115–129) has aggregate_name (eventStoreId) and aggregate_id columns but no tenant column. Row-level security (RLS) policies are not configured by the framework. Tenant isolation, if needed, must be implemented via aggregate ID conventions (e.g. `{tenantId}#{entityId}`) or separate database schemas per tenant — both are userland patterns with no framework support.
Guarantees:        None.
Known limits:      If multi-tenancy is needed in future, retrofitting it onto the existing schema requires a migration (adding a tenant column, updating all queries) and a breaking change to the adapter API. The current design makes single-tenant assumptions throughout.
Finance fit note:  The D1 profile for this analysis is single-tenant; multi-tenancy is explicitly out of profile (spec §0). This feature is classified WON'T for the current roadmap. The audit entry is recorded for completeness per the plan requirement that all 26 features be audited; the gap entry (if any) in §5 will carry WON'T classification.
Upstream signal: see Appendix §8.1 for upstream issue/PR #134.
```

---

### Feature 23 — Causation / correlation metadata

```
Status:            ❌
Layer:             — (absent; partial via open metadata field)
Evidence:          Absence confirmed on 2026-04-16 via:
                   (1) Code grep `causationId|correlationId|causation|correlation` across packages/**/src/**/*.ts → 0 matches.
                   (2) Docs grep → 0 matches.
                   (3) Package-metadata grep → 0 matches.
                   Partial mitigation: packages/core/src/event/eventDetail.ts:15-16 shows a generic `metadata: METADATA` field exists on every event — a caller can store causationId/correlationId there by convention.
                   Confidence: high (named fields absent); medium (generic metadata workaround exists).
How it works:      Not implemented as named fields. The event envelope (eventDetail.ts) has a generic `metadata` field typed to any METADATA generic. There are no framework-enforced causationId or correlationId fields, no validation that they are populated, and no built-in query capability to traverse a causation chain. Application code must use the metadata field by convention. The EventBridge message envelope (message.ts) also has no causal metadata fields beyond eventStoreId.
Guarantees:        Convention-only. The metadata field's type is controlled by the EventType definition; ZodEventType can enforce a metadata schema, but there is no core-level mandate that causation/correlation fields be present.
Known limits:      In a financial audit trail (D1), auditors require the ability to answer "which command triggered this event and as part of which user session?" Without mandatory causation/correlation IDs, individual events cannot be linked to their cause. An optional convention means some handlers will populate the fields and some will not, making the audit trail incomplete.
Finance fit note:  SHOULD-have for D1 audit trail requirements. The metadata field provides a partial workaround, but without mandatory enforcement and query tooling it is insufficient for regulatory compliance. A SHOULD gap entry is warranted.
```

---

### Feature 24 — Replay tooling

```
Status:            ⚠️
Layer:             core (partial: replay flag on PublishMessageOptions)
Evidence:          packages/core/src/messaging/channel/types.ts:1–3 (PublishMessageOptions.replay?: boolean);
                   packages/core/src/messaging/channel/notificationMessageChannel.ts:93–105 (publishMessage accepts replay option and passes to adapter);
                   packages/message-bus-adapter-event-bridge/src/adapter.ts:24–27 (replay=true sets DetailType to __REPLAYED__);
                   packages/core/src/event/reservedEventTypes.ts:1–10 (__REPLAYED__ reserved type);
                   packages/core/src/eventStorageAdapter.ts:13–14 (force?: boolean on PushEventOptions — allows overwriting existing events during a re-import)
How it works:      The framework has two partial replay primitives: (1) a replay flag on publishMessage that sets the EventBridge DetailType to `__REPLAYED__`, allowing downstream consumers to detect and handle replayed messages differently from live events; (2) a force option on pushEvent that performs an ON CONFLICT DO UPDATE in Postgres, enabling re-import of corrected events. However, there is no CLI, script, or API in the in-scope packages that orchestrates a full replay — iterating all aggregates, fetching their events, and re-publishing them to a channel. The out-of-scope lib-dam package contains pourEventStoreEvents with replay:true, which is the closest analogue but is not in scope.
Guarantees:        The replay flag is tested in message-bus-adapter-event-bridge/src/adapter.unit.test.ts:82–83.
Known limits:      No end-to-end replay orchestration in scope. The replay flag alone is insufficient for a controlled backfill: the caller must still iterate aggregates, fetch events, and call publishMessages manually. No progress tracking, no pause/resume, no exactly-once guarantee during replay.
Finance fit note:  Needed for backfilling new read models and recovering from failed projections (N4/N5). The replay flag is a building block; a full replay tool is a SHOULD gap.
```

---

### Feature 25 — Observability

```
Status:            ❌
Layer:             — (absent; userland concern)
Evidence:          Absence confirmed on 2026-04-16 via:
                   (1) Code grep `trace|span|opentelemetry|otel|logger|metric` across packages/**/src/**/*.ts in in-scope packages → 0 matches.
                   (2) Docs grep → 0 matches.
                   (3) Package-metadata grep → 0 matches.
                   Confidence: medium.
How it works:      Not implemented. The event store, adapters, and message bus do not emit any structured logs, OpenTelemetry spans, or metrics. There is no hook point for injecting a tracer or logger into the framework. Observability is entirely a userland concern: application code wraps each pushEvent or getAggregate call with its own spans.
Guarantees:        None.
Known limits:      Without framework-native observability, event commit latency, projection lag, and outbox queue depth are invisible to operators. Each team re-implements the same push/get instrumentation boilerplate. The absence of a hook point (e.g. an optional `onEvent` middleware) makes library-level tracing hard to add without forking core.
Finance fit note:  Important for production operations but not a correctness blocker. COULD classification for the D1 profile — userland wrappers are workable for small teams. Becomes more pressing as the service scales.
```

---

### Feature 26 — Testing utilities

```
Status:            ✅
Layer:             lib-test-tools + in-memory-adapter
Evidence:          packages/lib-test-tools/src/mockEventStore.ts:1–31 (mockEventStore helper — wraps any EventStore with InMemoryEventStorageAdapter + optional initialEvents);
                   packages/lib-test-tools/src/muteEventStore.ts:1–11 (muteEventStore — silently replaces adapter with in-memory for tests);
                   packages/lib-test-tools/src/mockedEventStore.ts (MockedEventStore class);
                   packages/event-storage-adapter-in-memory/src/adapter.ts (full in-memory adapter with no infra deps);
                   packages/core/src/eventStore/eventStore.ts:269–296 (simulateAggregate — dry-run aggregate state without persistence)
How it works:      lib-test-tools provides mockEventStore (sets up a full event store with in-memory adapter and optional seed events) and muteEventStore (replaces an existing store's adapter with in-memory). These helpers enable given/when/then-style domain tests without any infrastructure. The in-memory adapter faithfully mirrors the Postgres adapter semantics (OCC, pushEventGroup rollback) so tests catch real invariant violations. simulateAggregate in EventStore allows testing aggregate state projections without any I/O.
Guarantees:        The testing helpers are themselves tested (mockEventStore.unit.test.ts, muteEventStore.unit.test.ts, type tests). The in-memory adapter has full unit-test coverage.
Known limits:      No explicit given/when/then API — tests must call pushEvent/getAggregate directly. No test helper for message bus scenarios (assertPublished, capturePublishedMessages). Multi-step saga testing requires manual setup.
Finance fit note:  Strong positive for D1. Fast, deterministic, in-memory domain tests lower the cost of thorough invariant coverage — critical for financial logic where edge cases are expensive. This is one of castore's standout strengths (see §4 "What castore does exceptionally well").
```

---

### What castore does exceptionally well (for the finance profile)

The gaps catalogued above are real and must be closed before production use. But five areas stand out where castore's existing design is genuinely strong — in some cases stronger than competing TypeScript frameworks — and where the finance profile is a particularly good fit.

- **`pushEventGroup` with multi-adapter validation delivers first-class double-entry bookkeeping.** The static `EventStore.pushEventGroup` method wraps all inserts for multiple aggregate streams in a single Postgres transaction, and the adapter-homogeneity guard (`hasABadAdapter`, Feature 3 — `packages/event-storage-adapter-postgres/src/adapter.ts:328-345`) ensures a partial cross-adapter commit is impossible. A debit event on one account stream and a credit on another either both land or both roll back — the invariant that financial double-entry requires is enforced at the framework level with no userland coordination needed. See §4 Feature 3 for full evidence.

- **`simulateAggregate` / `simulateSideEffect` enable dry-run pre-trade checks without persistence.** `EventStore.simulateAggregate` (Feature 26 — `packages/core/src/eventStore/eventStore.ts:269-296`) reconstructs aggregate state from a caller-supplied event sequence entirely in memory and returns the projected state, with no adapter call. This is precisely the primitive needed for pre-trade validation — "would this command violate an invariant?" — without side effects, without touching the DB, and without polluting the event log. See §4 Feature 26 for full evidence.

- **Strict type-level reducer contracts make event-type typos a compile error, not a runtime surprise.** The `EventStore` generic ties its reducer directly to the narrowed union of `EventDetail` types declared for that store. A handler for `'ACCOUNT_DEBIITED'` (mis-spelled) is a TypeScript error at the point of declaration, not a silent no-op at runtime. This guarantee is enforced by the type-level contracts in `packages/core/src/event/eventType.ts` and exercised by `.type.test.ts` files (Feature 2 — `packages/core/src/eventStore/eventStore.ts:35`). In a financial context, where a missed event handler means a silently incorrect balance, this compile-time safety net has direct monetary value. See §4 Feature 2 for full evidence.

- **Version-based OCC is baked into the adapter contract, not a userland add-on.** The `EventStorageAdapter` interface makes `pushEvent` raise `EventAlreadyExistsError` on version collision as a first-class typed error, not an undifferentiated exception. The Postgres adapter enforces it via a DB-level `UNIQUE` constraint so that even a direct SQL client bypassing the framework layer is caught. This means concurrent payment commands cannot silently double-book; the second writer receives a typed, retryable conflict signal. See §4 Feature 2 for full evidence.

- **`lib-test-tools` + in-memory adapter provide fast, zero-infrastructure domain-level testing.** `mockEventStore` and `muteEventStore` (Feature 26 — `packages/lib-test-tools/src/mockEventStore.ts:1-31`, `packages/lib-test-tools/src/muteEventStore.ts:1-11`) allow a full given/when/then domain test suite to run without Docker, without a Postgres instance, and without network I/O. The in-memory adapter mirrors Postgres semantics (OCC, `pushEventGroup` rollback) so tests catch real invariant violations. For a financial domain where every edge case in payment logic must be covered, the ability to run thousands of deterministic domain tests in milliseconds is a force multiplier. See §4 Feature 26 for full evidence.

## 5. Gap detail catalogue

> TODO: see spec §5 for template.
> TODO: reuse F-numbers from §2 verbatim.

## 6. Prioritized roadmap

> TODO: see spec §6 for template.

## 7. Risk register

> TODO: see spec §6 (risk register) for template.

## 8. Appendices

> §8.1 filled below; subsections §8.2 (competitor references) and §8.3 (glossary) populated later per plan Task 7.1.

### 8.1 Upstream signals

Scanning the upstream repository's closed PRs and open/closed issues reveals the *maintainer's intended scope* for castore: features that were explicitly declined or stripped out signal architectural choices, not just bandwidth constraints. This matters for the internal fork because it means we should not wait for upstream to fill certain gaps — the upstream has signalled it will not.

Scanned on 2026-04-16 via `gh pr list --repo castore-dev/castore --state closed --limit 60` and `gh issue list --repo castore-dev/castore --state {closed,open} --limit 60`; restricted to the most-recent 60 closed PRs and 60 closed/open issues respectively.

| # | Title | State | Annotation |
|---|-------|-------|------------|
| [#161](https://github.com/castore-dev/castore/pull/161) | fix: remove any mention of snapshots | MERGED (2023-10-06) | Maintainer actively stripped snapshot documentation — snapshots are acknowledged as a userland concern, not a planned framework feature (maps to F5). |
| [#181](https://github.com/castore-dev/castore/issues/181) | Snapshot Discussion | OPEN (since 2024-01-16) | Community-raised snapshot request with no assignee, no milestone, and no upstream activity in over two years — confirms F5 will not be delivered upstream. |
| [#134](https://github.com/castore-dev/castore/issues/134) | Multitenancy | CLOSED **wontfix** (2023-09-29) | Explicitly closed as wontfix with label; maintainer considers multi-tenancy out of scope for the framework layer (maps to F22). |
| [#123](https://github.com/castore-dev/castore/issues/123) | [Suggestion] Specify version in EventType / EventDetails | CLOSED (2023-06-14) | Community request to add a schema-version field to event types — closed without implementation, confirming schema versioning (F11) is convention-only by design. |
| [#180](https://github.com/castore-dev/castore/issues/180) | Auto increment version if event with same version exists | CLOSED (2024-03-20) | Request to silently auto-increment version on conflict — declined; version collision intentionally raises an error (OCC, F2). Adjacent to F4: confirms no idempotency-key mechanism is planned. |
| [#72](https://github.com/castore-dev/castore/issues/72) | Create `withInMemoryCache` high-order function on event storage adapters | CLOSED (2023-06-02) | Caching HOF for read performance — closed; the closest snapshot-adjacent feature the upstream considered, but implemented as a separate opt-in utility rather than a framework-first snapshot store (F5 context). |
| [#49](https://github.com/castore-dev/castore/issues/49) | Query Models | OPEN (since 2023-02-07) | Long-standing open issue requesting a projection/read-model layer — no activity, no milestone; confirms projection runner (F6) and rebuild (F7) are not on the upstream roadmap. |
| [#136](https://github.com/castore-dev/castore/issues/136) | Add validation at pushEvent & commands | OPEN (since 2023-08-04) | Request to add validation hooks in the push path — no activity; indirectly highlights absence of observability hooks (F25) and framework-level validation middleware. |
| [#198](https://github.com/castore-dev/castore/issues/198) | State of this library? | CLOSED (2025-10-12) | Maintainer confirmed the library is "stable but not actively developed"; Zod v4 support was the last planned feature, signalling effective dormancy. |
| [#203](https://github.com/castore-dev/castore/issues/203) | State of this library? | OPEN (since 2026-01-09) | Second community query about dormancy; no maintainer response as of scan date — reinforces the decision to treat castore as an internal fork with no upstream dependency. |
