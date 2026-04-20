/**
 * Scrub the message of an error before persisting it to `last_error`.
 *
 * Goals (origin R17):
 *  - Never persist event-payload leaf values (PII risk, GDPR erasure scope).
 *  - Cap the persisted string at `maxLen` chars — longer strings are
 *    truncated, never rejected (so a pathological error never kills the
 *    relay via write failures).
 *
 * Strategy:
 *  1. Stringify the error.
 *  2. Walk the string for balanced `{...}` or `[...]` fragments and parse
 *     each one as JSON. If the parse succeeds, recursively replace leaf
 *     values with `'<redacted>'` (keys preserved for shape debugging).
 *  3. For fragments that FAIL to parse cleanly but still contain nested
 *     brackets (malformed JSON or mixed text), collapse the outer balanced
 *     pair into `{<redacted>}` / `[<redacted>]`. This is the fallback the
 *     spec explicitly calls out — a single-level regex like `\{[^{}]*\}`
 *     misses the nested case `{"customer":{"ssn":"..."}}`.
 *  4. Truncate to `maxLen`.
 *
 * Pure function; no I/O, no global state.
 */

const DEFAULT_MAX_LEN = 2048;
const DEFAULT_MAX_DEPTH = 3;
const REDACTED = '<redacted>';

type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [k: string]: JsonValue }
  | JsonValue[];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const redactValue = (value: unknown, depth: number): JsonValue => {
  if (depth >= DEFAULT_MAX_DEPTH) {
    return REDACTED;
  }

  if (Array.isArray(value)) {
    return value.map(item => redactValue(item, depth + 1)) as JsonValue[];
  }

  if (isPlainObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactValue(v, depth + 1);
    }

    return out;
  }

  // Primitive leaf — always redacted. Keys in the enclosing object preserved.
  if (value === null) {
    return null;
  }

  return REDACTED;
};

interface ScanState {
  depth: number;
  inString: boolean;
  escape: boolean;
}

const advanceScan = (
  ch: string,
  opener: string,
  closer: string,
  state: ScanState,
): void => {
  if (state.escape) {
    state.escape = false;

    return;
  }

  if (state.inString) {
    if (ch === '\\') {
      state.escape = true;
    } else if (ch === '"') {
      state.inString = false;
    }

    return;
  }

  if (ch === '"') {
    state.inString = true;

    return;
  }

  if (ch === opener) {
    state.depth++;
  } else if (ch === closer) {
    state.depth--;
  }
};

const findBalancedFragment = (
  input: string,
  start: number,
): { end: number } | null => {
  const opener = input[start];
  if (opener !== '{' && opener !== '[') {
    return null;
  }

  const closer = opener === '{' ? '}' : ']';
  const state: ScanState = { depth: 0, inString: false, escape: false };

  for (let i = start; i < input.length; i++) {
    advanceScan(input[i] as string, opener, closer, state);
    if (state.depth === 0 && !state.inString && i > start) {
      return { end: i + 1 };
    }
  }

  return null;
};

const replaceFragments = (input: string): string => {
  let output = '';
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    if (ch !== '{' && ch !== '[') {
      output += ch;
      i++;
      continue;
    }

    const fragment = findBalancedFragment(input, i);
    if (fragment === null) {
      output += ch;
      i++;
      continue;
    }

    const raw = input.slice(i, fragment.end);
    let replacement: string;
    try {
      const parsed = JSON.parse(raw) as unknown;
      replacement = JSON.stringify(redactValue(parsed, 0));
    } catch {
      replacement = ch === '{' ? '{<redacted>}' : '[<redacted>]';
    }

    output += replacement;
    i = fragment.end;
  }

  return output;
};

const stringifyError = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

export const scrubLastError = (
  err: unknown,
  maxLen: number = DEFAULT_MAX_LEN,
): string => {
  const message = stringifyError(err);
  const scrubbed = replaceFragments(message);

  return scrubbed.length > maxLen ? scrubbed.slice(0, maxLen) : scrubbed;
};
