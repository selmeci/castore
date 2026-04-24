/**
 * Exponential backoff with ±jitter, clamped to a ceiling.
 *
 * `attempts` is 1-based (the FIRST failure passes 1 and yields `baseMs`; the
 * second failure passes 2 and yields `2 * baseMs`, etc.). For attempts large
 * enough that `baseMs * 2^(attempts-1)` would overflow or exceed `ceilingMs`,
 * the result is clamped to `ceilingMs` first and then jittered — this means
 * monotonic non-decrease holds even across clamp transitions.
 *
 * Jitter is applied as a uniform offset in `±jitterPct * backoff`. A
 * `jitterPct` of 0 disables jitter (useful in deterministic tests).
 *
 * The helper is pure — no timers, no randomness source injection; callers
 * needing determinism pass a seeded random via `rng`.
 */
export interface BackoffArgs {
  baseMs: number;
  ceilingMs: number;
  attempts: number;
  jitterPct?: number;
  rng?: () => number;
}

export const computeBackoffMs = ({
  baseMs,
  ceilingMs,
  attempts,
  jitterPct = 0.25,
  rng = Math.random,
}: BackoffArgs): number => {
  if (attempts < 1) {
    return 0;
  }

  const exponent = attempts - 1;
  // Cap the exponent so `2 ** exponent` does not overflow to Infinity on
  // pathological inputs (attempts > 1024). `2**40` * baseMs already dwarfs
  // any realistic ceiling, so clamping here is a safe shortcut.
  const safeExponent = Math.min(exponent, 40);

  const uncapped = baseMs * 2 ** safeExponent;
  const clamped = Math.min(uncapped, ceilingMs);

  if (jitterPct <= 0) {
    return clamped;
  }

  const rand = rng();
  const offset = clamped * jitterPct * (2 * rand - 1);

  return Math.max(0, clamped + offset);
};
