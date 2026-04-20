/**
 * Type-level contract tests for the relay sub-entrypoint's public surface.
 * Runs through `tsc --noEmit`; nothing here is executed by the unit-test
 * runner.
 */
import { expectTypeOf } from 'vitest';

import type {
  AssertOutboxEnabledMode,
  CreateOutboxRelayArgs,
  DeleteRowResult,
  OnDeadHook,
  OnFailHook,
  OutboxRelay,
  OutboxRow,
  RelayHooks,
  RelayOptions,
  RelayRegistryEntry,
  RetryRowOptions,
  RetryRowResult,
  RunOnceResult,
} from './index';

// Happy path: relay factory yields an object with the documented methods.
expectTypeOf<
  OutboxRelay['runOnce']
>().returns.resolves.toEqualTypeOf<RunOnceResult>();
expectTypeOf<OutboxRelay['runContinuously']>().returns.resolves.toBeVoid();
expectTypeOf<OutboxRelay['stop']>().returns.resolves.toBeVoid();
expectTypeOf<OutboxRelay['retryRow']>().parameters.toMatchTypeOf<
  [string, RetryRowOptions?]
>();
expectTypeOf<
  OutboxRelay['retryRow']
>().returns.resolves.toEqualTypeOf<RetryRowResult>();
expectTypeOf<
  OutboxRelay['deleteRow']
>().returns.resolves.toEqualTypeOf<DeleteRowResult>();

// Retry warning shape is stable across versions (parent R20 committed).
expectTypeOf<
  RetryRowResult['warning']
>().toEqualTypeOf<'at-most-once-not-guaranteed'>();
expectTypeOf<RetryRowResult['forced']>().toBeBoolean();

// Registry entry exposes exactly three fields.
expectTypeOf<RelayRegistryEntry>().toHaveProperty('eventStoreId');
expectTypeOf<RelayRegistryEntry>().toHaveProperty('connectedEventStore');
expectTypeOf<RelayRegistryEntry>().toHaveProperty('channel');

// Hook types forward the expected argument bags.
expectTypeOf<OnDeadHook>().parameters.toMatchTypeOf<
  [{ row: OutboxRow; lastError: string }]
>();
expectTypeOf<OnFailHook>().parameters.toMatchTypeOf<
  [
    {
      row: OutboxRow;
      error: unknown;
      attempts: number;
      nextBackoffMs: number;
    },
  ]
>();

// CreateOutboxRelayArgs surface: dialect is required literal union.
expectTypeOf<CreateOutboxRelayArgs['dialect']>().toEqualTypeOf<
  'pg' | 'mysql' | 'sqlite'
>();
expectTypeOf<CreateOutboxRelayArgs['hooks']>().toEqualTypeOf<
  RelayHooks | undefined
>();
expectTypeOf<CreateOutboxRelayArgs['options']>().toEqualTypeOf<
  RelayOptions | undefined
>();

// assertOutboxEnabled mode is a strict literal union.
expectTypeOf<AssertOutboxEnabledMode>().toEqualTypeOf<'warn' | 'throw'>();
