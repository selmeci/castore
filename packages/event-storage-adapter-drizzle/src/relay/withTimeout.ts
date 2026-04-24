import { OutboxPublishTimeoutError } from './errors';

/**
 * Race `work` against a timeout. On timeout, abort the controller passed
 * to `work` (so AbortSignal-aware awaits in the work body can unwind) and
 * reject with `OutboxPublishTimeoutError`; otherwise return `work`'s
 * resolution.
 *
 * `work` receives an `AbortSignal` so it can thread cancellation into any
 * awaits that support it. Note: today's Castore core channel
 * (`publishMessage`) and `connectedEventStore.getAggregate` do NOT take an
 * `AbortSignal` — the signature is forward-compatible, so when core grows
 * signal-aware overloads later, `publishInner` can wire them without
 * another round-trip through this helper. The timeout + retry contract
 * (timeout fires → outer `handleFailure` → fenced-token guard blocks
 * double-publish) is correct even without in-flight cancellation; the
 * AbortController is a resource-cleanup improvement on top of that.
 *
 * The timer is cleared on both branches so a fast `work` does not leave a
 * dangling handle. The rejected timeout promise is NOT awaited after
 * `work` resolves — Node's unhandled-rejection tracking only fires if
 * nothing ever catches the promise, and the `Promise.race` chain has
 * already attached a `.then`.
 */
export const withTimeout = async <T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  rowId: string,
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new OutboxPublishTimeoutError(rowId, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};
