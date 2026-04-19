/**
 * Walks an error and its chain of wrapped causes, calling `predicate` on each
 * node. Returns `true` as soon as any predicate call returns `true`.
 *
 * The walk follows three conventional properties drivers use to carry the
 * original error:
 *   - `.cause`        — standard Node / ECMAScript `Error.cause`
 *   - `.sourceError`  — postgres-js
 *   - `.originalError`— some Drizzle wrappers
 *
 * A `Set` guards against accidental cycles in the cause chain.
 *
 * The dialect-specific part (e.g. `code === '23505'` for pg, `errno === 1062`
 * for mysql, `code === 'SQLITE_CONSTRAINT_UNIQUE'` for sqlite) stays in the
 * caller's predicate — only the walk logic lives here.
 */
export const walkErrorCauses = (
  err: unknown,
  predicate: (node: unknown) => boolean,
): boolean => {
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (
    current !== null &&
    current !== undefined &&
    typeof current === 'object' &&
    !seen.has(current)
  ) {
    seen.add(current);
    if (predicate(current)) {
      return true;
    }
    current =
      (current as { cause?: unknown }).cause ??
      (current as { sourceError?: unknown }).sourceError ??
      (current as { originalError?: unknown }).originalError;
  }

  return false;
};
