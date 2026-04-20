import { and, eq, sql } from 'drizzle-orm';

/**
 * Dialects the fenced-UPDATE helper knows how to dispatch to. The dialect
 * string drives result-shape normalisation — pg and sqlite support
 * `UPDATE ... RETURNING`, mysql does not and exposes `affectedRows` on the
 * `ResultSetHeader` at position 0 of the driver result.
 */
export type OutboxDialect = 'pg' | 'mysql' | 'sqlite';

/**
 * Column handles the fenced UPDATE needs. Every dialect's outbox table
 * exposes these with identical Drizzle column shapes, so the helper can
 * stay dialect-parametric by accepting them explicitly.
 */
export interface FencedUpdateTable {
  id: unknown;
  claimToken: unknown;
}

export interface FencedUpdateArgs {
  dialect: OutboxDialect;
  // Dialect db handles share no meaningful structural type in Drizzle
  // (pg's `.update()` returns PgUpdateBuilder, mysql's returns MySqlUpdate,
  // sqlite's returns SQLiteUpdateBuilder — each invariant in their table
  // parameter), so the helper treats the handle opaquely and relies on the
  // per-dialect caller for strong typing.
  db: any;
  outboxTable: FencedUpdateTable;
  rowId: string;
  currentClaimToken: string;
  /**
   * Columns to write, keyed by Drizzle column name (not SQL name). Values
   * may be literals or `sql\`...\`` fragments — both pass through Drizzle
   * untouched.
   */
  set: Record<string, unknown>;
}

/**
 * Applies the caller's `set` to the row whose primary key is `rowId` IFF the
 * row's `claim_token` still matches `currentClaimToken`. Returns the number
 * of rows affected — 0 means another worker's TTL reclaim rotated the token
 * between this worker's claim and UPDATE, and the caller MUST treat the
 * result as "work done by someone else" (no retry, no hook dispatch).
 *
 * This is the load-bearing fencing primitive of the outbox relay (parent R14);
 * every post-claim UPDATE the relay issues must go through this helper or
 * the equivalent predicate inline.
 */
export const fencedUpdate = async (args: FencedUpdateArgs): Promise<number> => {
  const { dialect, db, outboxTable, rowId, currentClaimToken, set } = args;

  const where = and(
    eq(outboxTable.id as never, rowId),
    eq(outboxTable.claimToken as never, currentClaimToken),
  );

  const builder = db.update(outboxTable).set(set).where(where);

  if (dialect === 'mysql') {
    const result: unknown = await builder;

    return extractMysqlAffectedRows(result);
  }

  const rows = (await builder.returning({ id: outboxTable.id })) as unknown[];

  return rows.length;
};

/**
 * Narrow the mysql driver result to an `affectedRows` count without a type
 * cast that hides the shape from readers.
 *
 * drizzle-mysql returns `[ResultSetHeader, FieldPacket[]]` on update() — the
 * header at index 0 carries `affectedRows`. Some driver/pooling combinations
 * yield the header directly; this function handles both shapes.
 */
const extractMysqlAffectedRows = (result: unknown): number => {
  if (Array.isArray(result)) {
    const head = result[0] as { affectedRows?: unknown } | undefined;
    if (head !== undefined && typeof head.affectedRows === 'number') {
      return head.affectedRows;
    }
  }

  if (result !== null && typeof result === 'object') {
    const header = result as { affectedRows?: unknown };
    if (typeof header.affectedRows === 'number') {
      return header.affectedRows;
    }
  }

  return 0;
};

/**
 * Dialect-authoritative "now" fragment for the mutation timestamp columns.
 * Worker wall-clock is not trusted across nodes (parent Key Decisions).
 */
export const dialectNow = (dialect: OutboxDialect): ReturnType<typeof sql> => {
  if (dialect === 'pg') {
    return sql`NOW()`;
  }
  if (dialect === 'mysql') {
    return sql`NOW(3)`;
  }

  return sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
};
