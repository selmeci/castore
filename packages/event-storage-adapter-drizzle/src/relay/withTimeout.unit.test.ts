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
    const slow = () => new Promise<never>(() => {}); // never resolves
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
    const slow = () => new Promise<never>(() => {});
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
});
