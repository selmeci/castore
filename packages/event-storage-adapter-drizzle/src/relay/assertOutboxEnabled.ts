import { isOutboxEnabledAdapter } from '@castore/core';
import type { EventStorageAdapter } from '@castore/core';

import { OutboxNotEnabledError } from './errors';

export type AssertOutboxEnabledMode = 'warn' | 'throw';

/**
 * Bootstrap aid for apps that cannot run safely without the outbox
 * (finance / N4-bound profiles — parent R23). Defaults to `'warn'` so
 * non-finance users are informed but not broken; `'throw'` fails fast.
 *
 * Mode semantics:
 *   - `'warn'`: when `process.env.NODE_ENV === 'production'`, log once via
 *     `console.warn`. Silent in dev/test to avoid training adopters to
 *     ignore it. Non-fatal.
 *   - `'throw'`: throw `OutboxNotEnabledError` unconditionally — when the
 *     caller explicitly asks for enforcement, honor it in every env so
 *     tests catch misconfig.
 */
export const assertOutboxEnabled = (
  adapter: EventStorageAdapter | undefined,
  { mode = 'warn' as AssertOutboxEnabledMode } = {},
): void => {
  if (isOutboxEnabledAdapter(adapter)) {
    return;
  }

  if (mode === 'throw') {
    throw new OutboxNotEnabledError(
      'Expected adapter to expose the outbox capability symbols. Construct the adapter with an `outbox` table to enable.',
    );
  }

  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '[castore] assertOutboxEnabled: adapter is missing the outbox capability. This app is NOT safe against dual-write loss under N4. Pass `{ mode: "throw" }` to enforce.',
    );
  }
};
