import { OutboxPublishTimeoutError } from './errors';

/**
 * Race `work` against a timeout. On timeout, reject with
 * `OutboxPublishTimeoutError`; otherwise return `work`'s resolution.
 *
 * The timer is cleared on both branches so a fast `work` does not leave a
 * dangling handle. The rejected timeout promise is NOT awaited after
 * `work` resolves — Node's unhandled-rejection tracking only fires if
 * nothing ever catches the promise, and the `Promise.race` chain has
 * already attached a `.then`.
 */
export const withTimeout = async <T>(
  work: () => Promise<T>,
  timeoutMs: number,
  rowId: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
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
