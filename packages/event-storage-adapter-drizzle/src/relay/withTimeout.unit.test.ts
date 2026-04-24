import { OutboxPublishTimeoutError } from './errors';
import { withTimeout } from './withTimeout';

describe('withTimeout', () => {
  it('returns work result when it resolves before the timeout', async () => {
    const result = await withTimeout(
      () => Promise.resolve('ok'),
      1_000,
      'row-1',
    );
    expect(result).toBe('ok');
  });

  it('rejects with OutboxPublishTimeoutError when work exceeds the cap', async () => {
    const slow = (): Promise<never> => new Promise<never>(() => {}); // never resolves
    await expect(withTimeout(slow, 10, 'row-hang')).rejects.toBeInstanceOf(
      OutboxPublishTimeoutError,
    );
  });

  it('propagates work-side rejections without wrapping', async () => {
    const boom = new Error('bus down');
    await expect(
      withTimeout(() => Promise.reject(boom), 1_000, 'row-1'),
    ).rejects.toBe(boom);
  });

  it('carries rowId and timeoutMs on the thrown timeout error', async () => {
    const slow = (): Promise<never> => new Promise<never>(() => {});
    try {
      await withTimeout(slow, 15, 'row-42');
      throw new Error('should have timed out');
    } catch (err) {
      expect(err).toBeInstanceOf(OutboxPublishTimeoutError);
      const timeoutErr = err as OutboxPublishTimeoutError;
      expect(timeoutErr.rowId).toBe('row-42');
      expect(timeoutErr.timeoutMs).toBe(15);
    }
  });

  it('passes a live (not-yet-aborted) AbortSignal to work', async () => {
    let seenSignal: AbortSignal | undefined;
    await withTimeout(
      signal => {
        seenSignal = signal;

        return Promise.resolve('ok');
      },
      1_000,
      'row-signal',
    );
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);
  });

  it("aborts the work's AbortSignal when the timeout fires", async () => {
    // Resolve the outer withTimeout promise, but keep `work` running so we
    // can observe the signal flip after the timer fires. A `never` promise
    // would never let us read `.aborted` post-timeout.
    const signalCaptured = new Promise<AbortSignal>(resolveSignal => {
      void withTimeout(
        signal => {
          resolveSignal(signal);

          return new Promise<never>(() => {});
        },
        15,
        'row-abort',
      ).catch(() => {
        // Swallow the expected OutboxPublishTimeoutError — we're asserting
        // on the signal state, not on the race's rejection.
      });
    });

    const signal = await signalCaptured;
    // Timer fires after 15ms; give the event loop a slightly longer tick
    // to run the setTimeout callback that calls controller.abort().
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(signal.aborted).toBe(true);
  });
});
