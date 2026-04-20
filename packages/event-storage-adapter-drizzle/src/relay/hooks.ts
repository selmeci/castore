import type { OutboxRow, RelayHooks } from '../common/outbox/types';

/**
 * Dispatch `onDead` with swallow semantics (parent R19): the relay never
 * fails because of a user-provided hook. Exceptions are logged to
 * `console.error` so operators can see what broke; the caller proceeds as
 * if the hook had returned cleanly.
 */
export const dispatchOnDead = async (
  hooks: RelayHooks,
  args: { row: OutboxRow; lastError: string },
): Promise<void> => {
  if (hooks.onDead === undefined) {
    return;
  }
  try {
    await hooks.onDead(args);
  } catch (hookErr) {
    console.error('[outbox relay] onDead hook threw:', hookErr);
  }
};

/**
 * Dispatch `onFail` with swallow semantics (parent R19).
 */
export const dispatchOnFail = async (
  hooks: RelayHooks,
  args: {
    row: OutboxRow;
    error: unknown;
    attempts: number;
    nextBackoffMs: number;
  },
): Promise<void> => {
  if (hooks.onFail === undefined) {
    return;
  }
  try {
    await hooks.onFail(args);
  } catch (hookErr) {
    console.error('[outbox relay] onFail hook threw:', hookErr);
  }
};
