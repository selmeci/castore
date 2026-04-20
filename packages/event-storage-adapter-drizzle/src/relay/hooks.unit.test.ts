import { randomUUID } from 'crypto';
import { vi } from 'vitest';

import type { OutboxRow } from '../common/outbox/types';
import { dispatchOnDead, dispatchOnFail } from './hooks';

const makeRow = (): OutboxRow => ({
  id: randomUUID(),
  aggregate_name: 'store',
  aggregate_id: 'a',
  version: 1,
  created_at: new Date().toISOString(),
  claim_token: 't',
  claimed_at: new Date().toISOString(),
  processed_at: null,
  attempts: 0,
  last_error: null,
  last_attempt_at: null,
  dead_at: null,
});

describe('dispatchOnDead / dispatchOnFail (swallow semantics, parent R19)', () => {
  it('is a no-op when the hook is undefined', async () => {
    await expect(
      dispatchOnDead({}, { row: makeRow(), lastError: 'x' }),
    ).resolves.toBeUndefined();
    await expect(
      dispatchOnFail(
        {},
        { row: makeRow(), error: new Error(), attempts: 1, nextBackoffMs: 1 },
      ),
    ).resolves.toBeUndefined();
  });

  it('awaits the hook and returns', async () => {
    const onDead = vi.fn().mockResolvedValue(undefined);
    const row = makeRow();
    await dispatchOnDead({ onDead }, { row, lastError: 'boom' });
    expect(onDead).toHaveBeenCalledWith({ row, lastError: 'boom' });
  });

  it('swallows a hook that throws synchronously', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onDead = vi.fn().mockImplementation(() => {
      throw new Error('sync boom');
    });

    await expect(
      dispatchOnDead({ onDead }, { row: makeRow(), lastError: 'x' }),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('swallows a hook that rejects asynchronously', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onFail = vi.fn().mockRejectedValue(new Error('async boom'));

    await expect(
      dispatchOnFail(
        { onFail },
        {
          row: makeRow(),
          error: new Error('underlying'),
          attempts: 2,
          nextBackoffMs: 100,
        },
      ),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
