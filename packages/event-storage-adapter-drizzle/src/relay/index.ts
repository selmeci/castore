/**
 * Public surface of the outbox relay.
 *
 * Users import the factory + dialect-specific claim primitive from this
 * sub-entrypoint:
 *
 * ```ts
 * import {
 *   createOutboxRelay,
 *   claimSqlite,
 * } from '@castore/event-storage-adapter-drizzle/relay';
 * ```
 *
 * The relay never transacts directly against the adapter's event table —
 * it only reads via `adapter[OUTBOX_GET_EVENT_SYMBOL]` and writes to the
 * outbox table via the fenced-update helper. The adapter owns all
 * event-side state.
 */

export { assertOutboxEnabled } from './assertOutboxEnabled';
export type { AssertOutboxEnabledMode } from './assertOutboxEnabled';

export { createOutboxRelay, DEFAULT_RELAY_OPTIONS } from './factory';
export type { CreateOutboxRelayArgs, OutboxRelay } from './factory';

export {
  DuplicateEventStoreIdError,
  OutboxNotEnabledError,
  RegistryEntryMismatchError,
  RetryRowClaimedError,
} from './errors';

export type { RetryRowOptions } from './admin';
export type { BoundClaim, RelayState, RunOnceResult } from './runOnce';
export type { RelayPublishContext, PublishOutcome } from './publish';

// Shared outbox types live in `common/` so the dialect adapters can also
// consume them, but they ARE part of the relay's public surface — re-export
// from here so users only need one import path.
export type {
  DeleteRowResult,
  OutboxRow,
  RelayChannel,
  RelayHooks,
  RelayOptions,
  RelayRegistryEntry,
  OnDeadHook,
  OnFailHook,
  RetryRowResult,
} from '../common/outbox/types';

// Dialect-specific claim primitives. Tree-shaking drops the unused two for
// users who only consume one dialect (the package declares `sideEffects:
// false`).
export { claimPg } from '../pg/outbox/claim';
export type { PgClaimArgs } from '../pg/outbox/claim';
export { claimMysql } from '../mysql/outbox/claim';
export type { MysqlClaimArgs } from '../mysql/outbox/claim';
export { claimSqlite } from '../sqlite/outbox/claim';
export type { SqliteClaimArgs } from '../sqlite/outbox/claim';

export type { OutboxDialect } from '../common/outbox/fencedUpdate';
