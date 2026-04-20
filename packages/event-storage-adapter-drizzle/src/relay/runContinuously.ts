import { computeBackoffMs } from '../common/outbox/backoff';
import { runOnce, type RelayState } from './runOnce';

/**
 * Supervised `runOnce` loop. A single transient DB failure in the
 * claim phase (connection dropped, advisory-lock timeout, deadlock
 * retry) must not kill the relay process: wrap every iteration in
 * try/catch, log, apply the same backoff used by the publish retry
 * path, and continue. Only `state.stopping = true` ends the loop.
 *
 * The in-memory consecutive-failure counter is reset on any successful
 * iteration, so a transient blip does not permanently slow the relay.
 */
export const runContinuously = async (state: RelayState): Promise<void> => {
  let consecutiveClaimFailures = 0;

  while (!state.stopping) {
    try {
      const result = await runOnce(state);
      consecutiveClaimFailures = 0;

      if (result.claimed === 0) {
        await sleep(state.options.pollingMs, state);
      }
    } catch (err) {
      consecutiveClaimFailures += 1;
      console.error(
        `[outbox relay] runOnce failed (attempt ${consecutiveClaimFailures}):`,
        err,
      );
      const backoffMs = computeBackoffMs({
        baseMs: state.options.baseMs,
        ceilingMs: state.options.ceilingMs,
        attempts: consecutiveClaimFailures,
      });
      await sleep(backoffMs, state);
    }
  }
};

/**
 * Sleep that wakes early when `state.stopping` flips to true — so a
 * pending `stop()` resolves within at most one `pollingMs` + whatever
 * was already in-flight.
 */
const sleep = (ms: number, state: RelayState): Promise<void> => {
  const start = Date.now();
  const tick = 25; // coarse polling on state.stopping keeps the loop tight.

  return new Promise(resolve => {
    const check = (): void => {
      if (state.stopping || Date.now() - start >= ms) {
        resolve();

        return;
      }
      setTimeout(check, Math.min(tick, ms - (Date.now() - start)));
    };
    check();
  });
};

export interface StopControl {
  /** Flip the stopping flag and wait for the current runContinuously to unwind. */
  stop: () => Promise<void>;
}

/**
 * Build a `stop()` closure bound to a `runContinuously` promise. The caller
 * (factory) owns the returned handle and exposes it as the relay's public
 * `stop()` method.
 *
 * Contract (parent §Unit 6 shutdown): `stop()` resolves cleanly even if
 * the in-flight publish and its subsequent fenced UPDATE both reject (e.g.,
 * DB connection dropped during SIGTERM). The affected rows keep their
 * claim_token and are TTL-reclaimed by a fresh relay instance.
 */
export const makeStop = (
  state: RelayState,
  loop: Promise<void>,
): StopControl => ({
  stop: async () => {
    state.stopping = true;
    try {
      await loop;
    } catch (err) {
      console.error(
        '[outbox relay] runContinuously loop rejected during stop():',
        err,
      );
    }
  },
});
