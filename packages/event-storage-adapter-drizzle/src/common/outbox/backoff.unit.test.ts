import { computeBackoffMs } from './backoff';

describe('computeBackoffMs', () => {
  const baseMs = 1_000;
  const ceilingMs = 300_000;

  it('returns 0 for attempts < 1', () => {
    expect(
      computeBackoffMs({ baseMs, ceilingMs, attempts: 0, jitterPct: 0 }),
    ).toBe(0);
  });

  it('returns baseMs on first attempt without jitter', () => {
    expect(
      computeBackoffMs({ baseMs, ceilingMs, attempts: 1, jitterPct: 0 }),
    ).toBe(baseMs);
  });

  it('doubles each attempt (no jitter)', () => {
    expect(
      computeBackoffMs({ baseMs, ceilingMs, attempts: 2, jitterPct: 0 }),
    ).toBe(2 * baseMs);
    expect(
      computeBackoffMs({ baseMs, ceilingMs, attempts: 5, jitterPct: 0 }),
    ).toBe(16 * baseMs);
  });

  it('clamps to ceilingMs once uncapped exceeds it', () => {
    expect(
      computeBackoffMs({ baseMs, ceilingMs, attempts: 100, jitterPct: 0 }),
    ).toBe(ceilingMs);
    expect(
      computeBackoffMs({ baseMs, ceilingMs, attempts: 50, jitterPct: 0 }),
    ).toBe(ceilingMs);
  });

  it('does not overflow on pathological attempt counts', () => {
    expect(
      computeBackoffMs({
        baseMs,
        ceilingMs,
        attempts: 1_000_000,
        jitterPct: 0,
      }),
    ).toBe(ceilingMs);
  });

  it('applies jitter within ±jitterPct of the base', () => {
    // Deterministic rng returning max value (1) → +25% jitter
    const high = computeBackoffMs({
      baseMs,
      ceilingMs,
      attempts: 1,
      jitterPct: 0.25,
      rng: () => 1,
    });
    expect(high).toBeCloseTo(baseMs * 1.25);

    // Deterministic rng returning min value (0) → -25% jitter
    const low = computeBackoffMs({
      baseMs,
      ceilingMs,
      attempts: 1,
      jitterPct: 0.25,
      rng: () => 0,
    });
    expect(low).toBeCloseTo(baseMs * 0.75);
  });

  it('never returns a negative value even when jitter is extreme', () => {
    const result = computeBackoffMs({
      baseMs: 1,
      ceilingMs: 1000,
      attempts: 1,
      jitterPct: 10,
      rng: () => 0,
    });
    expect(result).toBeGreaterThanOrEqual(0);
  });
});
