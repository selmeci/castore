---
title: "Parallel /ce-resolve-pr-feedback agents silently overwrite each other when a cluster refactor implies edits outside its anchor file"
date: 2026-04-19
category: workflow-issues
module: ce-resolve-pr-feedback
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "Dispatching two or more ce-pr-comment-resolver agents in parallel from /ce-resolve-pr-feedback"
  - "A cluster brief proposes 'extract shared helpers' or any multi-file refactor where the anchor file is only one of several files that will be rewritten"
  - "A standalone thread targets one file that a concurrent cluster's brief also implicates via refactor scope"
tags:
  - ce-resolve-pr-feedback
  - parallel-agents
  - file-overlap
  - conflict-avoidance
  - cluster-dispatch
  - pr-review
  - regression-detection
---

# Parallel /ce-resolve-pr-feedback agents silently overwrite each other when a cluster refactor implies edits outside its anchor file

## Context

The `ce-resolve-pr-feedback` skill dispatches one `ce-pr-comment-resolver` agent per review thread, with a "Conflict avoidance" rule: no two dispatch units that touch the same file should run in parallel. The rule is phrased around the thread's file (path+line where the comment was left). It does not mention that a cluster's brief can implicate additional files that never appear in any individual thread's anchor.

This surfaced concretely during the PR #4 review (selmeci/castore, `feat/event-storage-adapter-drizzle`). 13 CodeRabbit threads were grouped into two clusters and eight individual items:

- **Cluster A** — cursor-pagination bug in `listAggregateIds` across `src/{pg,mysql,sqlite}/adapter.ts`. Anchors: three threads, one per adapter.
- **Cluster B** — package-wide ESLint disables (`max-lines`, `strict-boolean-expressions`) + "split shared adapter logic". Anchors: `eslint.config.js` and `src/pg/adapter.ts`. The brief implicitly required rewriting `src/mysql/adapter.ts` and `src/sqlite/adapter.ts` as well, because the whole point of the fix was to extract common helpers out of all three adapters.
- **Item 13** — SQLite `pushEventGroup` is not safe for overlapping calls. Anchor: `src/sqlite/adapter.ts`. Fix: add a per-adapter promise-chain mutex.

The overlap analysis was done with only anchor files: Cluster A and Item 13 both touched `sqlite/adapter.ts` → serialize. Cluster A and Cluster B both touched `pg/adapter.ts` → serialize. But **Cluster B's implicit sqlite touch was missed**, so Cluster B and Item 13 were dispatched in parallel as "Batch 3". Cluster B finished by rewriting `sqlite/adapter.ts` to use new `src/common/` helpers — and wrote the file without Item 13's mutex, because Cluster B had read the file before Item 13 edited it. Item 13's *tests* survived (they went to `adapter.unit.test.ts`, a different file), but the mutex the tests were covering did not.

Both agents reported `verdict: fixed`. The discrepancy only surfaced when the orchestrator ran `pnpm vitest run` on the whole package after the batch — 2 of 58 tests failed. Cluster B's report even mentioned "two pre-existing failures in `sqlite/adapter.unit.test.ts` concurrent-pushEventGroup tests reproduce on HEAD without my changes… out of scope for this PR review", which was the mutex tests that Item 13 had just added in the parallel run that Cluster B's own git-level read pre-dated.

## Guidance

### 1. Expand each dispatch unit's file list to every file its brief could plausibly modify

Before listing files for the conflict check, read the cluster brief / individual prompt and ask: *if this agent executes what I'm asking, which files get written?* For a cluster that says "extract shared helpers out of three adapters", all three adapter files are in the set — even if only two of them are thread anchors. For a prompt that says "re-enable a repo-wide lint rule and fix all violations inline", every file that currently violates the rule is in the set. For a refactor that moves a type from file X to file Y, both X and Y are in the set.

The thread-anchor file is the *minimum* file list, not the actual one.

### 2. Treat "extract shared helpers"-style clusters as serialization gates

Any cluster whose hypothesis includes refactoring across multiple files should block parallel dispatch of *any other unit* that touches any of those files. The simplest rule: if a cluster rewrites N files, it runs alone in its batch. Everything else that targets those N files runs before or after, never alongside.

This is the narrow, safe default. A faster dispatch can be argued for on a case-by-case basis (e.g., if the cluster only touches a disjoint subset of each file), but that requires reading the current file state and the cluster brief together — and that's the exact step that gets skipped under batch pressure.

### 3. Run the full package test + lint suite after every parallel batch, not just what each agent ran

Individual resolver agents verify within their scope. Cluster B ran unit tests for `pg` and `mysql` but not `sqlite`, because from its self-centered view sqlite was "pre-existing failures". That self-verification is not a substitute for the orchestrator running `pnpm test` (or the equivalent package-wide check) after every batch before proceeding.

The collision is undetectable from either agent's internal state. It's only detectable in the union.

### 4. Be suspicious when an agent's report mentions "pre-existing" failures in adjacent files

An agent describing a failure as "pre-existing, out of scope" is almost always right — except when the failure was introduced by a *concurrent* agent in the same batch. If Batch 3 is running cluster B and Item 13 together, and cluster B reports pre-existing failures in the file Item 13 was editing, the two agents just collided. Verify by running tests on the current working copy.

## Why This Matters

Parallel dispatch is the whole performance value proposition of `ce-resolve-pr-feedback`. Sequential would be safer but much slower for PRs with 10+ threads. The file-overlap rule exists specifically to keep parallelism safe, so the rule has to catch *all* overlaps — including the ones implied by refactor scope, not just the ones where a comment was anchored on a literal line of a file.

The failure mode is the worst kind: both agents report success, the orchestrator commits + pushes, and the only backstop is the post-commit test run. If the test suite had a gap in coverage for the lost change (e.g., a concurrency fix whose tests were also overwritten), the regression would ship.

In this specific case the bug that Item 13 fixed is a silent data-corruption hazard — overlapping `pushEventGroup` calls on the same SQLite handle can enter a wrong transaction or fail the outer `BEGIN`. Shipping a PR that "fixed" this while the mutex was actually missing would be worse than not fixing it, because the PR description and review threads would claim it was done.

## When to Apply

- Any run of `/ce-resolve-pr-feedback` that produces a cluster with a multi-file refactor hypothesis
- Any batch dispatch where two or more units' briefs plausibly touch the same file, even if their anchor files differ
- After every parallel batch completes — run the full package `test` + `test-linter` before the next batch

## Examples

### Bad — overlap check uses only anchor files

```text
Cluster A anchors: pg/adapter.ts, mysql/adapter.ts, sqlite/adapter.ts
Cluster B anchors: eslint.config.js, pg/adapter.ts
Item 13  anchors: sqlite/adapter.ts

Overlap matrix (naive):
  A ↔ B: pg/adapter.ts        → serialize
  A ↔ 13: sqlite/adapter.ts   → serialize
  B ↔ 13: (none)              → parallel OK   ← WRONG

Batch 1: A alone
Batch 2: B + 13 in parallel   ← collision on sqlite/adapter.ts
```

### Good — expand each unit's file list with refactor-implied files

```text
Cluster A effective files:
  pg/adapter.ts, mysql/adapter.ts, sqlite/adapter.ts
Cluster B effective files (brief: "extract common helpers from all three adapters"):
  eslint.config.js, pg/adapter.ts, mysql/adapter.ts, sqlite/adapter.ts, + src/common/*
Item 13 effective files:
  sqlite/adapter.ts, sqlite/adapter.unit.test.ts

Overlap matrix:
  A ↔ B: pg+mysql+sqlite/adapter.ts → serialize
  A ↔ 13: sqlite/adapter.ts         → serialize
  B ↔ 13: sqlite/adapter.ts         → serialize   ← detected

Batch 1: A alone
Batch 2: B alone (it rewrites all three adapters)
Batch 3: 13 alone, after B
```

### Good — orchestrator-side post-batch verification

```bash
# After every parallel batch completes and agents return their summaries:
cd packages/event-storage-adapter-drizzle
pnpm test-type
pnpm test-linter
pnpm vitest run   # full package, not the subset any single agent ran
```

If any of those reveal a regression, re-run the affected agents **sequentially**. The [skill doc](../../../) mentions this as a verification-step fallback; the mistake above was that the orchestrator trusted individual agent verification reports instead of doing its own full-package run.

## Related

- `specs/plans/2026-04-17-002-feat-event-storage-adapter-drizzle-plan.md` — plan for the Drizzle adapter package that triggered this PR review
- `docs/solutions/best-practices/multi-dialect-adapter-package-patterns-2026-04-18.md` — the three-adapter structure that made Cluster B's refactor scope span multiple files
