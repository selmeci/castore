import * as v from 'valibot';

import type { ListAggregateIdsOptions } from '@castore/core';

/**
 * Valibot schema for the JSON blob `listAggregateIds` serialises into
 * `nextPageToken`. Every field is optional — an empty page token is a valid
 * starting state, and the presence of each field is what distinguishes "caller
 * supplied it" from "inherit from prior token or inputOptions".
 *
 * All string fields are validated strictly: a malformed token (e.g. a number
 * where a string is expected, or a `lastEvaluatedKey` missing one of its two
 * string fields) throws rather than silently type-asserting through. The
 * decoded token is untrusted input — a caller can pass anything — so we
 * validate rather than cast.
 */
const pageTokenSchema = v.object({
  limit: v.optional(v.number()),
  initialEventAfter: v.optional(v.string()),
  initialEventBefore: v.optional(v.string()),
  reverse: v.optional(v.boolean()),
  lastEvaluatedKey: v.optional(
    v.object({
      aggregateId: v.string(),
      initialEventTimestamp: v.string(),
    }),
  ),
});

/**
 * Shape of the JSON blob `listAggregateIds` serialises into `nextPageToken`.
 *
 * Shared by all three dialect adapters: the token is opaque to callers and
 * identical across dialects, so any of them can decode a token produced by
 * any other (within the same deployment — cross-dialect token round-trip is
 * not a supported use case, but keeping the shape identical means the
 * adapter rewrites its own tokens byte-for-byte).
 *
 * Derived from `pageTokenSchema` so the runtime validator and the compile-time
 * type cannot drift.
 */
export type ParsedPageToken = v.InferOutput<typeof pageTokenSchema>;

/**
 * Decode the opaque `pageToken` JSON blob, falling back to an empty token
 * when the input is absent. Throws `Error('Invalid page token')` on either
 * a JSON parse failure or a shape-validation failure; the underlying error is
 * logged to stderr but the thrown error is deliberately generic so callers
 * cannot distinguish accidentally-corrupted tokens from tokens produced by a
 * different adapter version.
 */
const decodePageToken = (pageToken: string | undefined): ParsedPageToken => {
  if (typeof pageToken !== 'string') {
    return {};
  }
  try {
    const raw: unknown = JSON.parse(pageToken);

    return v.parse(pageTokenSchema, raw);
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
