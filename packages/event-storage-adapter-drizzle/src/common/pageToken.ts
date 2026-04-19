import type { ListAggregateIdsOptions } from '@castore/core';

/**
 * Shape of the JSON blob `listAggregateIds` serialises into `nextPageToken`.
 *
 * Shared by all three dialect adapters: the token is opaque to callers and
 * identical across dialects, so any of them can decode a token produced by
 * any other (within the same deployment — cross-dialect token round-trip is
 * not a supported use case, but keeping the shape identical means the
 * adapter rewrites its own tokens byte-for-byte).
 */
export type ParsedPageToken = {
  limit?: number;
  initialEventAfter?: string | undefined;
  initialEventBefore?: string | undefined;
  reverse?: boolean | undefined;
  lastEvaluatedKey?:
    | {
        aggregateId: string;
        initialEventTimestamp: string;
      }
    | undefined;
};

/**
 * Decode the opaque `pageToken` JSON blob, falling back to an empty token
 * when the input is absent. Throws on a malformed token; the parse error is
 * logged to stderr and re-wrapped as a plain `Error('Invalid page token')`
 * so callers cannot distinguish accidentally-corrupted tokens from tokens
 * produced by a different adapter version.
 */
const decodePageToken = (pageToken: string | undefined): ParsedPageToken => {
  if (typeof pageToken !== 'string') {
    return {};
  }
  try {
    return JSON.parse(pageToken) as ParsedPageToken;
  } catch (error) {
    console.error(error);
    throw new Error('Invalid page token');
  }
};

/**
 * Resolves `listAggregateIds` inputs by merging the caller-supplied
 * `ListAggregateIdsOptions` with the optional `pageToken` JSON blob. Values
 * from the parsed page token take precedence over `inputOptions` — that's
 * what lets page-3+ calls retain `limit` / `initialEvent*` / `reverse` even
 * when the caller only supplied them on the first call.
 */
export const parsePageToken = (
  inputOptions: ListAggregateIdsOptions | undefined,
): {
  limit?: number;
  initialEventAfter?: string;
  initialEventBefore?: string;
  reverse?: boolean;
  lastEvaluatedKey?: ParsedPageToken['lastEvaluatedKey'];
} => {
  const opts = inputOptions ?? {};
  const parsed = decodePageToken(opts.pageToken);

  return {
    limit: parsed.limit ?? opts.limit,
    initialEventAfter: parsed.initialEventAfter ?? opts.initialEventAfter,
    initialEventBefore: parsed.initialEventBefore ?? opts.initialEventBefore,
    reverse: parsed.reverse ?? opts.reverse,
    lastEvaluatedKey: parsed.lastEvaluatedKey,
  };
};
