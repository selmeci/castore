import type { EventAlreadyExistsError } from '@castore/core';
import { eventAlreadyExistsErrorCode } from '@castore/core';

export class DrizzleEventAlreadyExistsError
  extends Error
  implements EventAlreadyExistsError
{
  code: typeof eventAlreadyExistsErrorCode;
  eventStoreId?: string;
  aggregateId: string;
  version: number;

  constructor({
    eventStoreId = '',
    aggregateId,
    version,
    cause,
  }: {
    eventStoreId?: string;
    aggregateId: string;
    version: number;
    cause?: unknown;
  }) {
    // Forward the original driver error as `cause` so production triage
    // retains the full DrizzleQueryError + underlying driver stack. The
    // public contract is the `code` / `eventStoreId` / `aggregateId` /
    // `version` fields; callers should treat `cause` as opaque debug data.
    super(
      `Event already exists for ${eventStoreId} aggregate ${aggregateId} and version ${version}`,
      cause !== undefined ? { cause } : undefined,
    );

    this.code = eventAlreadyExistsErrorCode;
    if (eventStoreId) {
      this.eventStoreId = eventStoreId;
    }
    this.aggregateId = aggregateId;
    this.version = version;
  }
}
