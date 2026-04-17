# Castore ES Gap-Analysis — Research Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the gap-analysis & roadmap deliverable at `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` that satisfies every success criterion in `docs/superpowers/specs/2026-04-16-castore-es-gap-analysis-design.md` §7.

**Architecture:** A research deliverable — not code. The plan executes the spec's methodology in 7 chunks: (1) skeleton & methodology, (2) castore code audit for 26 features, (3) competitor harvest + matrix, (4) gap catalogue + DAG, (5) risk register verification, (6) prioritized roadmap, (7) finalization. Work is mostly read + grep + write + commit. "Tests" are validation grep-checks against the deliverable itself.

**Tech Stack:** Markdown (GitHub-flavored), Mermaid for DAG, `grep` / `rg` / `Glob` / `Read` for audit, `gh api` / `gh pr list` / `gh issue list` for upstream signals, `WebFetch` / `context7` MCP for competitor docs.

**Spec contract:** everything in this plan defers to the spec. When in doubt, read the spec and obey it; do not innovate.

**Anti-scope reminder (from spec §5 and §6):**
- Do **not** write implementation plans for individual MUST/SHOULD gaps — each gap becomes its own brainstorming → writing-plans cycle **after** this deliverable is signed off.
- Do **not** run competitor hands-on POCs unless the spec §9 OQ-4 decision changes to "hands-on". Default is documentation-only.
- Do **not** begin the Fork & Trim or Health Audit sub-projects — separate brainstorming cycles.

**Abbreviations used below:** "the spec" = `docs/superpowers/specs/2026-04-16-castore-es-gap-analysis-design.md`; "the deliverable" = `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md`.

**Commit cadence:** one commit per completed task unless otherwise stated. All commits use `--no-verify` until `.husky/commit-msg` is fixed (separate ticket). Commit messages prefix with `docs(gap-analysis):`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` | **The deliverable.** Single markdown file with 8 sections per spec §1. |
| `docs/superpowers/specs/2026-04-16-castore-es-gap-analysis-design.md` | Read-only reference. Do not edit. If the spec is wrong, surface and pause — do not silently deviate. |
| `docs/superpowers/plans/2026-04-16-castore-es-gap-analysis.md` | This plan. Update checkboxes as work progresses. |

No other files are created or modified by this plan. If you find yourself wanting to change `packages/core/src/**`, stop — that is implementation work, not research.

---

## Chunk 1: Skeleton & methodology

**Outcome:** A deliverable file that compiles (renders as valid markdown), contains all 8 section headers from spec §1, a filled §0 summary, a filled §1 scope & methodology, and placeholder content that tells the executor what goes where.

### Task 1.1: Scaffold the deliverable file

**Files:**
- Create: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md`

- [ ] **Step 1: Read the spec end-to-end to ground yourself.**
  - Read: `docs/superpowers/specs/2026-04-16-castore-es-gap-analysis-design.md`
  - Focus on §1 (TOC), §7 (success criteria), §9 (open questions).

- [ ] **Step 2: Create the deliverable file with 8 top-level section headers mirroring spec §1 verbatim.**
  - Headers must be: `# Castore ES Gap Analysis & Roadmap`, then `## 1. Scope & methodology`, `## 2. Canonical ES feature catalogue`, `## 3. Competitor matrix`, `## 4. Castore current state — per feature`, `## 5. Gap detail catalogue`, `## 6. Prioritized roadmap`, `## 7. Risk register`, `## 8. Appendices`.
  - Under each section header, add a stub: `> TODO: see spec §N for template.` These stubs will be replaced chunk-by-chunk.

- [ ] **Step 3: Validate the file renders.**
  - Run: `grep -c "^## " docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md`
  - Expected: `8`

- [ ] **Step 4: Commit.**
  - `git add docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md`
  - `git commit --no-verify -m "docs(gap-analysis): scaffold deliverable with 8 section headers"`

### Task 1.2: Write §1 Scope & methodology

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§1)

- [ ] **Step 1: Copy the context block from spec §0 "Context established during brainstorming" into §1 of the deliverable, reformatted as prose, not bullet-list.**
  - Must cover: internal-fork relationship, greenfield stage, 8 in-scope packages, 10 out-of-scope packages (name them), D1 + N1+N4+N5+N6 profile, option A analysis depth.

- [ ] **Step 2: Copy the audit methodology from spec §4 "Audit methodology" (5 numbered items) into §1 as the "How castore was evaluated" subsection.**
  - Verbatim is fine — this is the binding contract for the researcher.

- [ ] **Step 3: Copy the competitor selection criteria from spec §3 into §1 as the "How competitors were selected" subsection.**
  - Include the excluded-competitors list with one-line rationales.

- [ ] **Step 4: Write a "Reader orientation" paragraph at the end of §1.**
  - 3–4 sentences directing the reader to the two highest-value entry points: §6 opener (go/no-go) for executives, §5 gap catalogue for engineers.

- [ ] **Step 5: Validate.**
  - Run: `grep -c "^### " docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md`
  - Expected: `>= 3` (one subsection per methodology/selection/orientation).

- [ ] **Step 6: Commit.**
  - `git commit --no-verify -m "docs(gap-analysis): fill §1 scope & methodology"`

### Task 1.3: Write §2 Canonical ES feature catalogue

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§2)

- [ ] **Step 1: Copy the 26-feature list from spec §2 verbatim into §2 of the deliverable.**
  - Preserve the 5 category headers (A–E) and feature numbering 1–26.

- [ ] **Step 2: Expand each feature from its 1-line summary into a 2–3 sentence definition.**
  - Use neutral, framework-agnostic wording — do **not** describe castore specifics here (that belongs in §4).
  - Source material: Evans (DDD), Young (CQRS), Dudycz (event-driven.io), Vernon (IDDD). Cite ≥1 canonical reference in the category intro.

- [ ] **Step 3: Validate.**
  - Run: `grep -c "^\*\*F[0-9]\+" docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (assuming `**F1 — ...**` style).
  - Expected: `26`.

- [ ] **Step 4: Commit.**
  - `git commit --no-verify -m "docs(gap-analysis): fill §2 canonical feature catalogue (26 features)"`

---

## Chunk 2: Castore code audit (§4 + "strengths")

**Outcome:** §4 of the deliverable contains 26 per-feature audit entries plus the "What castore does exceptionally well" subsection. Every entry has at least one `file:line` reference or a documented reason the feature is absent. Category tallies are present. Upstream GitHub signals harvested.

### Convention: "Absence evidence protocol" (referenced by Tasks 2.1–2.5)

When a feature is expected to be ❌ or ⚠️ in castore, the bar for "confirmed absent" is:

1. **Code grep** across `packages/**/src/**` using ≥2 related regexes (e.g. `snapshot|Snapshot` **and** `getLastVersion|aggregateState`).
2. **Docs grep** across `docs/docs/**/*.md` and all `README*.md` in the repo.
3. **Package-metadata grep** of the `description` field and `keywords` array in every in-scope `packages/*/package.json`.
4. **Negative-evidence note** in the audit entry: `"Absence confirmed on <YYYY-MM-DD> via: <list of grep patterns and locations searched>. Confidence: high | medium | low."`
5. **Confidence calibration:** if all three searches return zero and the feature is named in canonical ES references (Young/Dudycz/Vernon), confidence = **medium**, not high. Negative grep is weak evidence. Downgrade ❌ to ⚠️ if any doubt remains; flag as "confirm in per-gap brainstorming".

Tasks 2.1–2.5 reference this protocol by name. Do not improvise grep patterns when this protocol applies.

### Task 2.1: Audit Category A — Storage & consistency (F1–F5)

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§4 Category A)
- Read-only: `packages/core/src/**`, `packages/event-storage-adapter-postgres/src/**`, `packages/event-storage-adapter-in-memory/src/**`

- [ ] **Step 1: For F1 "Append-only event log per aggregate" — locate the push semantics.**
  - Grep: `Grep pattern "pushEvent" in packages/core/src/ output_mode content -n`
  - Read: `packages/core/src/eventStorageAdapter.ts` (full file).
  - Read: `packages/event-storage-adapter-postgres/src/**/pushEvent*.ts`.

- [ ] **Step 2: Check the test that proves append-only behavior.**
  - Grep: `Grep pattern "EventAlreadyExists|version.*already|unique.*version" in packages/`

- [ ] **Step 3: Write the F1 audit entry using spec §4 template.** Required fields: Status, Layer, Evidence (≥1 `file:line`), How it works, Guarantees, Known limits, Finance fit note.

- [ ] **Step 4: Repeat steps 1–3 for F2 (OCC), F3 (multi-aggregate transactional commit via `pushEventGroup`), F4 (idempotent writes), F5 (snapshots).**
  - F3 evidence is in `eventStore.ts` `static pushEventGroup` — already partially discovered during brainstorming.
  - F4: apply the **Absence evidence protocol** with regexes `idempoten|dedup|correlationToken` across code/docs/package metadata.
  - F5: apply the **Absence evidence protocol** with regexes `snapshot|Snapshot|getLastVersion|cachedAggregate`.

- [ ] **Step 5: Write the category tally line at the top of Category A.**
  - Example: `**Category A tally:** castore — 3/5 ✅ · 1/5 ⚠️ · 1/5 ❌ (F4 idempotency, F5 snapshots absent)`

- [ ] **Step 6: Validate.**
  - Grep: every F1–F5 subsection has at least one `.ts:` reference OR an explicit "absence confirmed by grep on <date>" note.

- [ ] **Step 7: Commit.**
  - `git commit --no-verify -m "docs(gap-analysis): audit Category A — storage & consistency (F1–F5)"`

### Task 2.2: Audit Category B — Projection & read-side (F6–F10)

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§4 Category B)
- Read-only: `packages/core/src/messaging/**`, `packages/core/src/connectedEventStore/**`

- [ ] **Step 1: For F6 "Projection runner with checkpoints" — inspect the messaging + connectedEventStore abstractions.**
  - Read: `packages/core/src/messaging/bus/**`, `packages/core/src/messaging/queue/**`, `packages/core/src/connectedEventStore/connectedEventStore.ts`.
  - Grep: `Grep pattern "checkpoint|lastProcessed|resumeFrom|subscription" in packages/`

- [ ] **Step 2: If castore has no runner (push-only via bus), status is ❌. Document in Known limits: "distribution via message bus exists; no pull-based catch-up subscription with persisted checkpoints".**

- [ ] **Step 3: Repeat for F7 (rebuild), F8 (lag monitoring), F9 (inline/sync projections), F10 (async projections via bus — likely ✅ or 🔶).**

- [ ] **Step 4: Category tally line + commit.**
  - `git commit --no-verify -m "docs(gap-analysis): audit Category B — projection & read-side (F6–F10)"`

### Task 2.3: Audit Category C — Schema evolution (F11–F14)

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§4 Category C)
- Read-only: `packages/core/src/event/**`, `packages/event-type-zod/src/**`

- [ ] **Step 1: F11 "Explicit event versioning" — read `packages/core/src/event/eventDetail.ts` and `eventType.ts`. Does the event envelope include a `version` field distinct from aggregate version?**

- [ ] **Step 2: F12 "Upcaster pipeline" — apply the Absence evidence protocol with regexes `upcast|upcaster|migrate.*event|transform.*event|schemaVersion`.**

- [ ] **Step 3: F13 "Event type retirement" — search docs for deprecation guidance: `Grep pattern "deprecat|retire|remove.*event" in docs/`**

- [ ] **Step 4: F14 "Tolerant deserialization" — check how `event-type-zod` parses: strict vs. `.passthrough()`. Read `packages/event-type-zod/src/eventType.ts`.**

- [ ] **Step 5: Category tally line + commit.**

### Task 2.4: Audit Category D — Distributed delivery (F15–F19)

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§4 Category D)
- Read-only: `packages/message-bus-adapter-event-bridge/src/**`, `packages/message-bus-adapter-event-bridge-s3/src/**`

- [ ] **Step 1: F15 "Transactional outbox" — critical. Read `connectedEventStore.ts` `publishPushedEvent.ts`. Determine: is the bus publish in the same DB transaction as the event write?**
  - Expected finding: it is **not** — publish is fire-and-forget post-commit. Status ❌. Write a 2-sentence Finance fit note about zero-event-loss impact (N4).

- [ ] **Step 2: F16 "At-least-once + dedup" — inspect bus adapter. Does it set a stable message ID that consumers can use for dedup?**
  - Read: `packages/message-bus-adapter-event-bridge/src/**`

- [ ] **Step 3: F17 "Message bus abstraction" (pub-sub) — ✅ likely, castore has bus abstraction in core messaging.**

- [ ] **Step 4: F18 "Message queue abstraction" (worker) — ✅ likely, queue abstraction present.**

- [ ] **Step 5: F19 "DLQ / poison pill" — inspect adapters. DLQ is AWS-managed at EventBridge/SQS level — but is castore-aware? Does castore have retry policy per handler?**

- [ ] **Step 6: Category tally + commit.**

### Task 2.5: Audit Category E — Operational & governance (F20–F26)

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§4 Category E)

- [ ] **Step 1: F20 "Crypto-shredding" — apply the Absence evidence protocol with regexes `crypto.?shred|per.?subject.?key|encryption.?key|\bkms\b|envelope.?encrypt`.**

- [ ] **Step 2: F21 "Event encryption at rest" — apply the Absence evidence protocol with regexes `encrypt.*event|payload.*encrypt|pgcrypto`. TDE at Postgres level is out of framework scope; note as "infrastructure-layer concern".**

- [ ] **Step 3: F22 "Multi-tenancy" — still write a full §4 audit entry (Status likely ❌, evidence via regex `tenant|multiTenant|tenantId`). The WON'T classification happens later in §5, not in §4. The audit must cover all 26 features without exception.**

- [ ] **Step 4: F23 "Causation / correlation metadata" — read `eventDetail.ts`. Look for `causationId`, `correlationId`, or a generic `metadata` field.**

- [ ] **Step 5: F24 "Replay tooling" — search for CLI / scripts in `scripts/` and `packages/*/src/`. Grep `replay|backfill`. Note: `force` option on pushEvent exists (found during brainstorming) — document as partial ⚠️.**

- [ ] **Step 6: F25 "Observability" — grep: `Grep pattern "trace|span|opentelemetry|otel|logger" in packages/`. Likely ❌ framework-native; userland can wire it.**

- [ ] **Step 7: F26 "Testing utilities" — read `packages/lib-test-tools/src/**`. Document what's there. ✅ likely.**

- [ ] **Step 8: Category tally + commit.**

### Task 2.6: Harvest upstream signals

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§8 Appendix — upstream notes)

- [ ] **Step 0: Verify `gh` is authenticated.**
  - Run: `gh auth status`
  - Expected: `Logged in to github.com`. If not: run `gh auth login` (requires user interaction) OR fall back to browser-based GitHub search — open `https://github.com/castore-dev/castore/pulls?q=is%3Apr+is%3Aclosed` and `https://github.com/castore-dev/castore/issues?q=is%3Aissue` and copy titles manually. Note the fallback used in the deliverable's §8.1 so reproducibility is transparent.

- [ ] **Step 1: Pull closed PRs from upstream.**
  - Run: `gh pr list --repo castore-dev/castore --state closed --limit 60 --json number,title,state,labels,url,closedAt`

- [ ] **Step 2: Pull closed issues (especially `wontfix` / `won't merge` / feature requests).**
  - Run: `gh issue list --repo castore-dev/castore --state closed --limit 60 --json number,title,labels,url,closedAt`
  - Run: `gh issue list --repo castore-dev/castore --state open --limit 60 --json number,title,labels,url,createdAt`

- [ ] **Step 3: Scan titles for any of: snapshot, projection, outbox, upcaster, versioning, saga, idempoten, crypto, tenant, observ.**

- [ ] **Step 4: In §8 Appendix "Upstream signals" subsection, list ≤10 noteworthy items with one-line annotations. Focus on rejected feature requests — they reveal maintainer philosophy.**

- [ ] **Step 5: Back-reference from relevant §4 entries.** E.g. "F5 Snapshots — upstream issue #NNN (closed as won't-fix 2024-MM-DD) — see Appendix."

- [ ] **Step 6: Commit.**

### Task 2.7: Write "What castore does exceptionally well"

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§4 trailing subsection)

- [ ] **Step 1: Based on audit evidence collected in 2.1–2.5, write ≤1-page subsection titled "What castore does exceptionally well (for the finance profile)".**
  - Must include the 5 bullets from spec §4 (pushEventGroup for double-entry, simulate APIs, type-level reducer contracts, version-based OCC, lib-test-tools + in-memory adapter).
  - Back each bullet with a `file:line` reference from §4.

- [ ] **Step 2: Commit.**

### Task 2.8: Validate Chunk 2 acceptance

- [ ] **Step 1: Acceptance check — every feature has evidence.**
  - Run: `grep -E "^### Feature [0-9]+" docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md | wc -l`
  - Expected: `26`

- [ ] **Step 2: Every entry has a Layer + Status field.**
  - Run: `grep -c "^Status:" docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md`
  - Expected: `>= 26`

- [ ] **Step 3: Every ❌/⚠️ feature has either a `file:line` ref for the "workaround" or an explicit "absence confirmed by grep on <date>" note.**
  - Manual review — eyeball all ❌/⚠️ entries.

- [ ] **Step 4: Category tally lines present.**
  - Run: `grep -c "Category [A-E] tally" docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md`
  - Expected: `5`

- [ ] **Step 5: If all pass, final chunk commit: `docs(gap-analysis): complete §4 castore audit`. Else, return to failing task.**

---

## Chunk 3: Competitor harvest + matrix (§3)

**Outcome:** §3 contains 4 competitor profiles (1 page each), a 26×5 matrix with ✅/🔶/⚠️/❌ values per cell, dealbreakers per competitor, and the DIY Postgres baseline column.

### Task 3.1: Emmett profile

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§3 Emmett subsection)

- [ ] **Step 1: Fetch Emmett docs via context7 MCP.**
  - Run context7: resolve library ID `event-driven-io/emmett`; get documentation for topics "event store", "projections", "snapshots", "outbox", "schema evolution".

- [ ] **Step 2: Supplementary: `WebFetch` `https://event-driven-io.github.io/emmett/` for a landing overview.**

- [ ] **Step 3: Read the Emmett README on GitHub.**
  - Run: `gh api repos/event-driven-io/emmett/readme --jq .content | base64 -d`

- [ ] **Step 4: Fill the profile template (spec §3 "Per-competitor profile") — Stack, Maturity signals (stars via `gh api repos/event-driven-io/emmett`, last release), Ideology, Fit score 1–5, Dealbreakers.**
  - Dealbreakers are the most important — be concrete. Example candidate dealbreakers to investigate: maturity (pre-1.0?), adapter coverage (does it support EventBridge?), TypeScript ergonomics.

- [ ] **Step 5: For every feature F1–F26, assess Emmett's coverage and record a value per spec §3 legend. Use a table at the bottom of the profile.**

- [ ] **Step 6: Commit.**

### Task 3.2: EventStoreDB profile

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§3 EventStoreDB subsection)

- [ ] **Step 1: Fetch docs via context7: library ID `eventstore` or `kurrent` (try both).**

- [ ] **Step 2: `WebFetch` `https://developers.eventstore.com/` or `https://docs.kurrent.io/` for current landing.**

- [ ] **Step 3: Focus on TS/JS client surface — `https://github.com/EventStore/EventStore-Client-NodeJS`.**

- [ ] **Step 4: Fill profile + 26-feature coverage table.**
  - Note: EventStoreDB is a dedicated server — "Postgres-native" is a cost dealbreaker (adds new ops burden).

- [ ] **Step 5: Commit.**

### Task 3.3: Marten profile

- [ ] **Step 1: context7 for `martendb`; `WebFetch` https://martendb.io/events/.**
- [ ] **Step 2: Focus on event store + async daemon + projections — that's why Marten is in the set.**
- [ ] **Step 3: Fill profile + 26-feature coverage table.**
  - Dealbreaker: .NET. For a TS shop, this is a hard no for adoption — but relevant as a pattern reference for castore-postgres.
- [ ] **Step 4: Commit.**

### Task 3.4: Equinox profile

- [ ] **Step 1: `gh api repos/jet/equinox/readme` + `WebFetch` https://github.com/jet/equinox/blob/master/DOCUMENTATION.md if accessible.**
- [ ] **Step 2: Fill profile + 26-feature coverage.** Note the multi-store architecture as the key architectural lesson.
- [ ] **Step 3: Commit.**

### Task 3.5: DIY Postgres baseline column

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§3 DIY baseline subsection)

- [ ] **Step 1: For each of the 26 features, answer one question: "Is this achievable with `pg` + `SKIP LOCKED` + `LISTEN/NOTIFY` in ≤3 days of engineering?"**
  - ✅ = yes, straightforward (append-only, OCC)
  - ⚠️ = yes, but significant design work (outbox, projection runner)
  - ❌ = no, requires a framework-level abstraction (type-level reducer contracts, upcaster pipeline)

- [ ] **Step 2: Record as one column added to the matrix (task 3.6), not as a full profile.**
- [ ] **Step 3: Commit.**

### Task 3.6: Build the 26×5 matrix

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§3 matrix subsection)

- [ ] **Step 1: Consolidate the 4 competitor tables + DIY column + castore column (from §4) into one matrix: 26 rows × 6 columns (Feature, Castore, Emmett, ESDB, Marten, Equinox, DIY).**
  - Wait — that's 7 columns if Feature is a column. Use: Feature | Castore | Emmett | ESDB | Marten | Equinox | DIY.

- [ ] **Step 2: Add legend block above matrix (spec §3 legend).**

- [ ] **Step 3: Add a 1-paragraph "How to read this matrix" — explicitly state that "⚠️ via convention" is a cost not a feature, and that "🔶 first-party extension" means install an extra lib.**

- [ ] **Step 4: Validate.**
  - Run: `grep -c "^| F[0-9]\+" docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (assuming matrix rows begin `| F1 | ...`).
  - Expected: `26`

- [ ] **Step 5: Commit.**

### Task 3.7: Exclusions rationale

- [ ] **Step 1: Copy the "Competitors deliberately excluded" block from spec §3 into §3 of the deliverable, under a subsection heading.** One line per exclusion — no elaboration.
- [ ] **Step 2: Commit.**

---

## Chunk 4: Gap catalogue + DAG (§5)

**Outcome:** §5 contains 10–15 gap entries conforming to the spec §5 template, a MoSCoW priority per entry, effort estimate, and a Mermaid DAG at the end.

### Task 4.1: Identify gap candidates

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§5 preamble)

- [ ] **Step 1: From §4, list every feature with status ❌ or ⚠️. This is your gap candidate set.**

- [ ] **Step 2: For every ❌/⚠️ feature, decide: gap entry OR `WON'T` line-item?**
  - Gap entry if: in-profile (aligns with D1/N1/N4/N5/N6), or affects MUST/SHOULD path.
  - `WON'T` line-item if: explicitly out of profile (e.g. multi-tenancy F22) or ecosystem-solved (e.g. F25 observability via userland OpenTelemetry wiring).

- [ ] **Step 3: Write a §5 preamble listing the candidate set and the decision per candidate. This is the table of contents for §5.**

- [ ] **Step 4: Commit.**

### Task 4.2: MUST gap entries

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§5 body)

- [ ] **Step 0: Reconcile the pre-assigned gap IDs below against actual §4 audit findings BEFORE writing any entries.**
  - The IDs/priorities below (G-01 outbox MUST, G-02 snapshots MUST, etc.) are brainstorming hypotheses, not audit outcomes. Spec §6 risk-register protocol applies here too: hypotheses must be re-verified.
  - If §4 revealed that a feature is *partially* present (e.g. snapshots have a one-off helper in `lib-dam`, or causation metadata is already on the envelope), renumber or re-prioritize that gap and log the change in the §5 preamble under "Priority revisions from audit".
  - If a whole gap dissolves (feature turns out to be ✅), drop it and renumber downstream G-IDs contiguously.
  - Only after this reconciliation step proceed to writing the entries.

- [ ] **Step 1: Write G-01 "Transactional outbox" (expected MUST, N4 — verify assumption survives Step 0).**
  - Use spec §5 template verbatim. Design sketch: Postgres `outbox` table in same tx; relay worker with advisory lock; optional pointer-in-outbox for S3-offloaded large payloads (spec §6 R-04).
  - Alternatives considered: Debezium CDC, logical replication, userland convention. List pros/cons.
  - Effort: L. Justify.

- [ ] **Step 2: Write G-02 "Snapshots" (expected MUST, N5).**
  - Design sketch: snapshot store as separate Postgres table keyed by `(event_store_id, aggregate_id)`; reducer extension point in core; adapter contract extended with `getLastSnapshot` / `putSnapshot`.
  - Effort: L.

- [ ] **Step 3: Write G-03 "Idempotent writes" (MUST for finance).**
  - Design sketch: optional `idempotencyKey` on pushEvent; unique index in adapter; returns existing result if key conflict. Does **not** use aggregate version (which is OCC, not idempotency).
  - Effort: M.

- [ ] **Step 4: Write G-04 "GDPR crypto-shredding" (MUST, N1).**
  - Design sketch: per-subject encryption key registry (DB table); event payload encryption at push time; key deletion invalidates all PII-bearing events for that subject. Requires event-type metadata ("is this event PII-bearing, for which subject?"). Requires external KMS integration story.
  - Effort: L–XL. Justify: this is the single highest-risk gap.

- [ ] **Step 5: Commit per entry or batch — your call, but no batches >300 lines.**

### Task 4.3: SHOULD gap entries

- [ ] **Step 1: G-05 "Upcaster pipeline" (SHOULD, N6).**
  - Design sketch: registered `(eventType, versionFrom, versionTo) → transform` functions; applied during `getEvents` after raw fetch. Type-level: output becomes union of current versions only.
  - Effort: L.

- [ ] **Step 2: G-06 "Causation / correlation metadata" (SHOULD, audit).**
  - Design sketch: mandatory `causationId` + `correlationId` on event envelope; populated from command context; enforced via adapter contract.
  - Effort: S–M.

- [ ] **Step 3: G-07 "Projection runner with checkpoints" (SHOULD, B).**
  - Design sketch: pull-based subscription over adapter's `getEvents({ from: checkpoint, limit })`; checkpoint table; worker loop with backoff. Separate `projections` package.
  - Effort: XL. Justify.

- [ ] **Step 4: Commit per entry.**

### Task 4.4: COULD gap entries

- [ ] **Step 1: G-08 "Projection rebuild tooling" (COULD) — depends on G-07.**
- [ ] **Step 2: G-09 "Observability (OpenTelemetry)" (COULD) — userland workaround exists.**
- [ ] **Step 3: G-10 "DLQ convention" (COULD) — AWS-native, framework convention only.**
- [ ] **Step 4: Commit per entry.**

### Task 4.5: WON'T line-items

- [ ] **Step 1: In §5, a short subsection "Explicit non-goals".**
  - List: F22 multi-tenancy (not in profile), F8 projection lag monitoring (depends on G-07, defer), F14 tolerant deserialization (zod handles per-schema policy), any others surfaced during audit.
  - One line per item with the rejection reason.
- [ ] **Step 2: Commit.**

### Task 4.6: Dependency DAG

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§5 trailing subsection)

- [ ] **Step 1: Apply spec §5 DAG edge criterion: `G-A → G-B` only if A cannot be designed/shipped until B's API/data model is decided.**

- [ ] **Step 2: Enumerate edges on paper first. Expected edges include: G-08 → G-07 (rebuild needs runner), G-04 → (potentially) G-05 (shredding tombstones may need to be visible through upcasting), G-10 → G-07 (DLQ is useful only with an async consumer).**

- [ ] **Step 3: Render as Mermaid in the deliverable.** The snippet below is a **stylistic example**, not the finished DAG. Do not paste it literally — build the real DAG from the edges you enumerated in Step 2.
  ```mermaid
  graph TD
    G07[G-07 Projection runner] --> G08[G-08 Rebuild tooling]
    %% ... add one edge per dependency from Step 2 ...
  ```

- [ ] **Step 4: Sanity-check: no cycles. Walk the DAG mentally; if any node has a path back to itself, fix.**

- [ ] **Step 5: Commit.**

### Task 4.7: Validate Chunk 4 acceptance

- [ ] **Step 1: Count gap entries.**
  - Run: `grep -c "^### G-" docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md`
  - Expected: between 10 and 15.

- [ ] **Step 2: Every gap entry has Priority, Effort, Depends on, Design sketch, Alternatives considered, Why this priority?**
  - Run: `grep -c "^Priority:" docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` — expected ≥10.

- [ ] **Step 3: WON'T section present; DAG renders (no `graph TD` typos).**

- [ ] **Step 4: If pass, chunk commit.**

---

## Chunk 5: Risk register verification (§7)

**Outcome:** §7 contains the risk register table (spec §6 columns) with R-01..R-12 verified against current code. Invalidated risks are dropped with a one-line note.

### Task 5.1: Verify R-01 — EventStore class extensibility

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§7)
- Read-only: `packages/core/src/eventStore/eventStore.ts`

- [ ] **Step 1: Read `eventStore.ts` end-to-end.**
  - Determine: is `EventStore` `class` or `interface`? Are internals `private`? Can a consumer extend it with new methods (e.g. `getAggregateWithSnapshot`) without monkey-patching?

- [ ] **Step 2: Write verdict: R-01 **confirmed** / **partially confirmed** / **invalidated**. One sentence.**

- [ ] **Step 3: If confirmed/partial: write Likelihood, Impact, Mitigation columns. If invalidated: drop R-01 and append a note at the end of §7 "Risks dropped during verification: R-01 — <reason>".**

- [ ] **Step 4: Commit.**

### Task 5.2: Verify R-02..R-04 (technical/architectural)

- [ ] **Step 1: R-02 contravariance — open 2–3 `.type.test.ts` files, note whether they pin generics tightly.** Confirm/invalidate.
- [ ] **Step 2: R-03 pushEventGroup static + single adapter — read `static pushEventGroup` signature; verify the single-adapter constraint.**
- [ ] **Step 3: R-04 EventBridge 256KB limit + s3 mitigation — read `eventbridge-s3` adapter, confirm pointer-in-event pattern.**
- [ ] **Step 4: Append verified risks to register; commit.**

### Task 5.3: Verify R-05..R-07 (dependency/upstream)

- [ ] **Step 1: R-05 upstream reactivation — confirm via `gh api repos/castore-dev/castore --jq .pushed_at` — no recent activity → likelihood Low, impact Medium.**
- [ ] **Step 2: R-06 pg driver lock-in — read postgres adapter package.json `dependencies` → note pinned pg major.**
- [ ] **Step 3: R-07 aws-sdk v2 vs. v3 — grep `Grep pattern "aws-sdk|@aws-sdk" in packages/*/package.json`.**
- [ ] **Step 4: Commit.**

### Task 5.4: Verify R-08..R-10 (governance/security)

- [ ] **Step 1: R-08 crypto-shredding key lifecycle — confirm framework provides no KMS integration (cross-ref to F20 audit).**
- [ ] **Step 2: R-09 outbox relay SPOF — DROP from §7 risk register.** R-09 is a design risk of a *hypothetical future* G-01 implementation, not a current property of the castore codebase. Relocate its substance to the G-01 gap entry in §5 under "Design considerations / open risks". In §7 add a one-line note in "Dropped during verification": `R-09 — reclassified as a G-01 design risk; see §5 G-01.`
- [ ] **Step 3: R-10 causation/correlation not mandatory — cross-ref to F23 audit.**
- [ ] **Step 4: Commit.**

### Task 5.5: Verify R-11..R-12 (organizational)

- [ ] **Step 1: Keep as-is — organizational risks can't be code-verified.**
- [ ] **Step 2: Commit.**

### Task 5.6: Write the register table + "dropped risks" appendix-note

- [ ] **Step 1: Render §7 as a single table with fixed columns: ID | Category | Description | Likelihood | Impact | Mitigation | Owner.** Owner column filled with `TBD` until OQ-1 resolves.

- [ ] **Step 2: Below the table, a "Dropped during verification" subsection listing any risk invalidated by audit evidence, with a 1-line reason each.**

- [ ] **Step 3: Validate: `grep -c "^| R-" docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` ≥ 8 (allowing up to 4 to be dropped).**

- [ ] **Step 4: Chunk commit.**

---

## Chunk 6: Prioritized roadmap (§6)

**Outcome:** §6 contains the at-the-top opener, 4 phases (0/1/2/3), per-phase tables, conditional calendar estimates, and the checkpoint decision gate.

### Task 6.1: Assign MoSCoW priority per gap (if not already)

- [ ] **Step 1: Walk §5. Confirm every gap has a Priority. If any is missing/wrong based on the D1/N1/N4/N5/N6 profile, fix it in §5 and note the change in a "Priority revision" line.**
- [ ] **Step 2: Count: `X MUST / Y SHOULD / Z COULD / W WON'T`.**
- [ ] **Step 3: Commit (if changes).**

### Task 6.2: Phase content

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§6)

- [ ] **Step 1: Write Phase 0 (Fork cleanup & health audit) description per spec §6. Note this phase is **deferred** to separate brainstorming sub-projects — §6 merely lists what it contains.**

- [ ] **Step 2: Phase 1 (MUST-haves) — list all MUST gaps with Effort + Depends on; critical-path analysis (which gaps can parallelize).**

- [ ] **Step 3: Phase 2 (SHOULD-haves) — same.**

- [ ] **Step 4: Phase 3 (COULD-haves, demand-driven) — same.**

- [ ] **Step 5: Commit.**

### Task 6.3: Per-phase tables

- [ ] **Step 1: For each phase, render a table: `Gap ID | Effort | Priority | Depends on | Owner | ETA`. Owner + ETA = `TBD` until OQ-1/OQ-2 resolved.**
- [ ] **Step 2: Commit.**

### Task 6.4: Conditional calendar table

- [ ] **Step 0: Check OQ-1 resolution.**
  - If OQ-1 (FTE capacity) has been resolved by the user since spec sign-off: **replace** the conditional 1/1.5/2 table with a single projection using the actual FTE number, and drop the "conditional" framing from the section prose. Keep the parallelization caveat paragraph either way.
  - If OQ-1 is still open: proceed with Steps 1–4 as written.

- [ ] **Step 1: Sum Phase 1 effort in person-days (from Effort rubric: S=2, M=6, L=16, XL=30 — use midpoints).**
- [ ] **Step 2: Divide by 1 FTE, 1.5 FTE, 2 FTE capacity, assuming 4 effective days/week (accounting for meetings, context-switch, code review of self by cross-checking).**
- [ ] **Step 3: Render as a 3-row table:**
  ```
  | FTE | Phase 1 calendar | Phase 1+2 calendar |
  | --- | --- | --- |
  | 1   | ~X weeks | ~Y weeks |
  | 1.5 | ~X weeks | ~Y weeks |
  | 2   | ~X weeks | ~Y weeks |
  ```
- [ ] **Step 4: Add caveat paragraph: parallelization only works where the DAG permits (ref §5 DAG); serial gaps cap the 2-FTE speedup.**
- [ ] **Step 5: Commit.**

### Task 6.5: Checkpoint decision gate

- [ ] **Step 1: Write a paragraph describing the post-Phase-1 stop-the-line review (spec §6 "Checkpoint decision gate"). State the explicit decision question: "does the castore hypothesis still hold?"**
- [ ] **Step 2: List the checkpoint inputs: Phase 1 completion evidence, any architectural surprises, any new risks surfaced during Phase 1.**
- [ ] **Step 3: Commit.**

### Task 6.6: Section opener (replaces exec summary)

- [ ] **Step 1: Write the §6 opener (one page max):**
  - Go / no-go recommendation with one-sentence rationale — the **whole document** synthesized.
  - MoSCoW counts from 6.1.
  - Total Phase 1 effort in person-days.
  - Top 2–3 risks (from §7).

- [ ] **Step 2: This is the single most-read paragraph of the deliverable. Draft, sleep on it if time permits, revise.**

- [ ] **Step 3: Commit.**

---

## Chunk 7: Finalization (§8 appendices + success-criteria validation)

**Outcome:** The deliverable passes every success criterion in spec §7. Appendices complete. Final commit.

### Task 7.1: Appendices

**Files:**
- Modify: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md` (§8)

- [ ] **Step 1: §8.1 "Upstream notes" — already populated in 2.6. Cross-reference.**

- [ ] **Step 2: §8.2 "Competitor references" — for each of the 4 competitors, list: repo URL, docs URL, last-inspected date, version/commit SHA at inspection time.** This is the reproducibility contract.

- [ ] **Step 3: §8.3 "Glossary" — every ES acronym used in the doc. Source: walk the doc, `grep -oE '\b[A-Z]{2,}\b' | sort -u`. Write a 1-sentence definition per term. Required at minimum: ES, OCC, DLQ, PII, KMS, CDC, FTE, DDD, CQRS, NFR, OCC, DAG, KPI, TDE, SPOF.**

- [ ] **Step 4: Commit.**

### Task 7.2: Validate success criteria (spec §7 checklist)

- [ ] **Step 1: Criterion 1 — All 26 features have per-feature entry with ≥1 code/test/docs ref.** Run the grep from Task 2.8.

- [ ] **Step 2: Criterion 2 — 4 competitor profiles + matrix row complete with dealbreakers.** Visual walk through §3.

- [ ] **Step 3: Criterion 3 — every ❌/⚠️ in castore column has a gap entry or WON'T line-item.** Cross-reference §4 → §5. Count matches.

- [ ] **Step 4: Criterion 4 — every gap entry has design sketch, effort, priority, dependencies, rollout note.** Grep per-field counts.

- [ ] **Step 5: Criterion 5 — DAG has no cycles, rendered Mermaid.** Already checked in 4.6 step 4.

- [ ] **Step 6: Criterion 6 — risk register populated with Likelihood/Impact/Mitigation for every kept risk.** Grep.

- [ ] **Step 7: Criterion 7 — §6 opener has go/no-go with 1-sentence rationale.** Visual.

- [ ] **Step 8: Criterion 8 (the measurable version from spec §7 #8 post-polish) — glossary covers every acronym; every code ref has `file:line`; every forward reference has a back-link.**
  - Acronym coverage: `grep -oE '\b[A-Z]{2,}\b' deliverable.md | sort -u` → cross-check against §8.3 glossary.
  - File:line coverage: `grep -oE "\.ts:[0-9]+" deliverable.md | wc -l` → should be substantial (say ≥20).
  - Forward refs: `grep -oE "§[0-9]+" deliverable.md` — spot-check 5 random picks, confirm each target exists.

- [ ] **Step 9: If all 8 criteria pass, commit. If any fail, return to the responsible chunk, fix, re-run this task.**

### Task 7.3: Final read-through & polish

- [ ] **Step 1: Read the entire deliverable top-to-bottom in one sitting.**
  - Note: stilted prose, unclear transitions, contradictions between §4 and §5, unfinished thoughts.

- [ ] **Step 2: Fix all findings from Step 1 in a single pass.**

- [ ] **Step 3: Verify the deliverable compiles as markdown by rendering (preview in VS Code or similar, or run through `docusaurus build` if fast enough — but not required; valid markdown is enough).**

- [ ] **Step 4: Final commit: `docs(gap-analysis): final polish; deliverable complete`.**

### Task 7.4: Post-delivery handoff

- [ ] **Step 1: Surface the deliverable to the user by path: `docs/superpowers/research/2026-04-16-castore-es-gap-analysis.md`.**
- [ ] **Step 2: Highlight: §6 opener (go/no-go), §5 gap catalogue (entry points for next brainstorming cycles), §7 risk register (what needs ongoing management).**
- [ ] **Step 3: Remind user that this deliverable is a **decision input**, not a green light. Next step = user decides: proceed with fork (triggers per-MUST-gap brainstorming cycles) or pivot.**
- [ ] **Step 4: Ask for an explicit go/no-go decision — do not close the session without one.**
  - Present 3 options to the user verbatim: **(a)** Go — proceed with castore fork; open first brainstorming cycle for the top-priority MUST gap (per §5 priority order). **(b)** No-go — pivot to an alternative (likely Emmett or DIY Postgres based on §3); close the castore worktree. **(c)** Defer — specific questions returned to (e.g. "re-open OQ-5 spike", "escalate to stakeholders X/Y"), session paused until resolved.
  - Wait for an explicit choice. Log it in the deliverable itself as a final line: `**Decision (<date>):** <a|b|c> — <one-line rationale from user>`. This line is the deliverable's terminal state and the bridge to whatever comes next.

---

## Anti-scope (re-stated, final reminder)

- Do not start the Fork & Trim sub-project. Not this plan.
- Do not start the Health Audit sub-project. Not this plan.
- Do not write implementation plans for any MUST gap (outbox, snapshots, crypto-shredding, idempotency). Each is a separate brainstorming → writing-plans cycle **after** this deliverable is accepted.
- Do not run hands-on competitor POCs unless OQ-4 flips. Documentation-only review is the default.
- Do not edit `packages/**`. Read-only throughout.

## Risk during execution

- **Research-sprawl risk:** this plan has 7 chunks × ~40 steps ≈ 100 tasks. Keep momentum by resisting the temptation to dig deeper than the spec requires. If a feature audit entry takes >30 min, you're over-researching — write what you know with confidence markers and move on.
- **Context-drift risk:** the spec is the contract. Re-read spec §7 success criteria at the start of each chunk.
- **Competitor-docs freshness risk:** note inspection date per competitor (Task 7.1 step 2). If docs change before delivery, matrix may drift.
- **Over-confidence risk on "absence confirmed":** negative grep results are weak evidence. If confidence is low for a particular ❌, downgrade to ⚠️ with a note: "likely absent; no negative grep is conclusive — confirm in per-gap brainstorming".
