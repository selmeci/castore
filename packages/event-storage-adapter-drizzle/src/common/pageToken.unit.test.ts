import { describe, expect, it } from 'vitest';

import { parsePageToken } from './pageToken';

const mkToken = (body: unknown): string => JSON.stringify(body);

describe('parsePageToken', () => {
  describe('absent or undefined input', () => {
    it('returns an empty token when inputOptions is undefined', () => {
      expect(parsePageToken(undefined)).toEqual({
        limit: undefined,
        initialEventAfter: undefined,
        initialEventBefore: undefined,
        reverse: undefined,
        lastEvaluatedKey: undefined,
      });
    });

    it('returns inputOptions values when pageToken is missing', () => {
      expect(
        parsePageToken({
          limit: 10,
          initialEventAfter: '2026-04-19T00:00:00.000Z',
          reverse: true,
        }),
      ).toEqual({
        limit: 10,
        initialEventAfter: '2026-04-19T00:00:00.000Z',
        initialEventBefore: undefined,
        reverse: true,
        lastEvaluatedKey: undefined,
      });
    });
  });

  describe('valid tokens', () => {
    it('accepts a fully populated token', () => {
      const token = mkToken({
        limit: 25,
        initialEventAfter: '2026-04-19T00:00:00.000Z',
        initialEventBefore: '2026-04-20T00:00:00.000Z',
        reverse: false,
        lastEvaluatedKey: {
          aggregateId: 'agg-123',
          initialEventTimestamp: '2026-04-19T12:00:00.000Z',
        },
      });

      expect(parsePageToken({ pageToken: token })).toEqual({
        limit: 25,
        initialEventAfter: '2026-04-19T00:00:00.000Z',
        initialEventBefore: '2026-04-20T00:00:00.000Z',
        reverse: false,
        lastEvaluatedKey: {
          aggregateId: 'agg-123',
          initialEventTimestamp: '2026-04-19T12:00:00.000Z',
        },
      });
    });

    it('lets page-token values override inputOptions', () => {
      const token = mkToken({ limit: 50, reverse: true });

      expect(
        parsePageToken({
          pageToken: token,
          limit: 10,
          reverse: false,
        }),
      ).toEqual({
        limit: 50,
        initialEventAfter: undefined,
        initialEventBefore: undefined,
        reverse: true,
        lastEvaluatedKey: undefined,
      });
    });

    it('accepts an empty-object token', () => {
      expect(parsePageToken({ pageToken: mkToken({}) })).toEqual({
        limit: undefined,
        initialEventAfter: undefined,
        initialEventBefore: undefined,
        reverse: undefined,
        lastEvaluatedKey: undefined,
      });
    });
  });

  describe('invalid tokens', () => {
    it('rejects malformed JSON', () => {
      expect(() =>
        parsePageToken({ pageToken: '{not valid json' }),
      ).toThrowError('Invalid page token');
    });

    it('rejects a non-object JSON payload', () => {
      expect(() => parsePageToken({ pageToken: '42' })).toThrowError(
        'Invalid page token',
      );
      expect(() => parsePageToken({ pageToken: '"string"' })).toThrowError(
        'Invalid page token',
      );
      expect(() => parsePageToken({ pageToken: 'null' })).toThrowError(
        'Invalid page token',
      );
    });

    it('rejects a field of the wrong primitive type', () => {
      expect(() =>
        parsePageToken({ pageToken: mkToken({ limit: '10' }) }),
      ).toThrowError('Invalid page token');
      expect(() =>
        parsePageToken({ pageToken: mkToken({ reverse: 'true' }) }),
      ).toThrowError('Invalid page token');
    });

    it('rejects a lastEvaluatedKey that is not an object', () => {
      expect(() =>
        parsePageToken({ pageToken: mkToken({ lastEvaluatedKey: 'agg-123' }) }),
      ).toThrowError('Invalid page token');
    });

    it('rejects a lastEvaluatedKey missing a required field', () => {
      expect(() =>
        parsePageToken({
          pageToken: mkToken({
            lastEvaluatedKey: { aggregateId: 'agg-123' },
          }),
        }),
      ).toThrowError('Invalid page token');
      expect(() =>
        parsePageToken({
          pageToken: mkToken({
            lastEvaluatedKey: {
              initialEventTimestamp: '2026-04-19T12:00:00.000Z',
            },
          }),
        }),
      ).toThrowError('Invalid page token');
    });

    it('rejects a lastEvaluatedKey with a non-string field', () => {
      expect(() =>
        parsePageToken({
          pageToken: mkToken({
            lastEvaluatedKey: {
              aggregateId: 42,
              initialEventTimestamp: '2026-04-19T12:00:00.000Z',
            },
          }),
        }),
      ).toThrowError('Invalid page token');
    });
  });
});
