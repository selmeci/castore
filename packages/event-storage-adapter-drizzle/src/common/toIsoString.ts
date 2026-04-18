/**
 * Normalises a timestamp value returned by any supported Drizzle driver to
 * an ISO-8601 string.
 *
 * Drivers may hand back either a `Date` instance (node-postgres for
 * `timestamptz`) or an already-formatted string (postgres-js for the same
 * column type, mysql2 with `mode: 'string'`, better-sqlite3 for text-stored
 * timestamps). Both paths round-trip through `new Date(...).toISOString()` so
 * downstream code can always assume a fixed-width ISO-8601 string.
 *
 * Fixed-width ISO-8601 is also what `listAggregateIds`' page-token cursor
 * relies on — lexicographic comparison of `toISOString()` output matches
 * chronological order.
 */
export const toIsoString = (value: unknown): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    const asDate = new Date(value);
    if (!Number.isNaN(asDate.getTime())) {
      return asDate.toISOString();
    }
    // Throw rather than return the unparsed string: a malformed timestamp
    // would silently corrupt listAggregateIds page-token ordering (which
    // relies on lexicographic = chronological comparison of ISO strings).
    // Surfacing the bad value here makes integration failures loud.
    throw new Error(`Unparseable timestamp string: ${value}`);
  }
  throw new Error(`Unexpected timestamp value: ${String(value)}`);
};
