import { vi } from 'vitest';

import { OUTBOX_ENABLED_SYMBOL, OUTBOX_GET_EVENT_SYMBOL } from '@castore/core';
import type { EventStorageAdapter } from '@castore/core';

import {
  __resetWarnedForTests,
  assertOutboxEnabled,
} from './assertOutboxEnabled';
import { OutboxNotEnabledError } from './errors';

const outboxAdapter = {
  [OUTBOX_ENABLED_SYMBOL]: true,
  [OUTBOX_GET_EVENT_SYMBOL]: async () => undefined,
} as unknown as EventStorageAdapter;

const legacyAdapter = {} as EventStorageAdapter;

describe('assertOutboxEnabled', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    __resetWarnedForTests();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('is a no-op for outbox-enabled adapter under default (warn) mode', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => assertOutboxEnabled(outboxAdapter)).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('warns in production when adapter is missing the capability (default warn)', () => {
    process.env.NODE_ENV = 'production';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => assertOutboxEnabled(legacyAdapter)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledOnce();

    warnSpy.mockRestore();
  });

  it('logs only once across repeated invocations in production (warn mode)', () => {
    process.env.NODE_ENV = 'production';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => assertOutboxEnabled(legacyAdapter)).not.toThrow();
    expect(() => assertOutboxEnabled(legacyAdapter)).not.toThrow();
    expect(() => assertOutboxEnabled(legacyAdapter)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledOnce();

    warnSpy.mockRestore();
  });

  it('is silent in dev/test under warn mode', () => {
    process.env.NODE_ENV = 'test';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => assertOutboxEnabled(legacyAdapter)).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('throws in any env when mode: "throw"', () => {
    process.env.NODE_ENV = 'test';
    expect(() => assertOutboxEnabled(legacyAdapter, { mode: 'throw' })).toThrow(
      OutboxNotEnabledError,
    );

    process.env.NODE_ENV = 'production';
    expect(() => assertOutboxEnabled(legacyAdapter, { mode: 'throw' })).toThrow(
      OutboxNotEnabledError,
    );
  });

  it('does not throw in throw mode when adapter IS outbox-enabled', () => {
    expect(() =>
      assertOutboxEnabled(outboxAdapter, { mode: 'throw' }),
    ).not.toThrow();
  });

  it('throws in throw mode when adapter is undefined', () => {
    expect(() => assertOutboxEnabled(undefined, { mode: 'throw' })).toThrow(
      OutboxNotEnabledError,
    );
  });
});
