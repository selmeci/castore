/**
 * Snake_case column-projection map for the outbox table, used by every
 * dialect's claim primitive and by the admin API. Keeps the `RETURNING` /
 * `SELECT` shape aligned with `OutboxRow` so relay code consumes
 * `row.claim_token` (not Drizzle's camelCase) across all three dialects.
 *
 * Generic over the dialect-specific table type so Drizzle's strict
 * `SelectedFields` contract is preserved at each call site — callers get
 * their own `PgColumn` / `MySqlColumn` / `SQLiteColumn` back, not a
 * type-laundered `unknown`.
 */
export interface OutboxColumnTable {
  id: unknown;
  aggregateName: unknown;
  aggregateId: unknown;
  version: unknown;
  createdAt: unknown;
  claimToken: unknown;
  claimedAt: unknown;
  processedAt: unknown;
  attempts: unknown;
  lastError: unknown;
  lastAttemptAt: unknown;
  deadAt: unknown;
}

export const selectOutboxColumns = <T extends OutboxColumnTable>(
  outbox: T,
): {
  id: T['id'];
  aggregate_name: T['aggregateName'];
  aggregate_id: T['aggregateId'];
  version: T['version'];
  created_at: T['createdAt'];
  claim_token: T['claimToken'];
  claimed_at: T['claimedAt'];
  processed_at: T['processedAt'];
  attempts: T['attempts'];
  last_error: T['lastError'];
  last_attempt_at: T['lastAttemptAt'];
  dead_at: T['deadAt'];
} => ({
  id: outbox.id,
  aggregate_name: outbox.aggregateName,
  aggregate_id: outbox.aggregateId,
  version: outbox.version,
  created_at: outbox.createdAt,
  claim_token: outbox.claimToken,
  claimed_at: outbox.claimedAt,
  processed_at: outbox.processedAt,
  attempts: outbox.attempts,
  last_error: outbox.lastError,
  last_attempt_at: outbox.lastAttemptAt,
  dead_at: outbox.deadAt,
});
