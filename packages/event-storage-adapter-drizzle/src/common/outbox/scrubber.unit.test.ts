import { scrubLastError } from './scrubber';

describe('scrubLastError', () => {
  it('returns the raw message when no JSON fragment is present', () => {
    expect(scrubLastError('connection reset by peer')).toBe(
      'connection reset by peer',
    );
  });

  it('redacts a simple JSON object payload', () => {
    const out = scrubLastError(
      'failed with payload: {"accountNumber":"1234-5678"}',
    );
    expect(out).not.toContain('1234-5678');
    expect(out).toContain('accountNumber');
    expect(out).toContain('<redacted>');
  });

  it('redacts nested JSON payloads (the main spec hazard)', () => {
    const out = scrubLastError(
      'boom: {"event":{"aggregateId":"acc-1","payload":{"amount":100,"customer":{"ssn":"123-45-6789"}}}}',
    );
    expect(out).not.toContain('acc-1');
    expect(out).not.toContain('100');
    expect(out).not.toContain('123-45-6789');
    // Shape keys preserved for triage
    expect(out).toContain('aggregateId');
    expect(out).toContain('customer');
  });

  it('collapses malformed bracket fragments to a literal redacted marker', () => {
    const out = scrubLastError('trailing comma: {"a": 1,}');
    expect(out).toContain('{<redacted>}');
    expect(out).not.toContain('1');
  });

  it('redacts array fragments', () => {
    const out = scrubLastError('got: [{"id":"secret"},{"id":"other"}]');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('other');
    expect(out).toContain('id');
  });

  it('truncates to maxLen', () => {
    const long = 'x'.repeat(5000);
    const out = scrubLastError(long, 100);
    expect(out).toHaveLength(100);
  });

  it('stringifies Error instances via .message', () => {
    const err = new Error('something broke: {"userId":"u-1"}');
    const out = scrubLastError(err);
    expect(out).not.toContain('u-1');
    expect(out).toContain('something broke');
  });

  it('handles unserializable values gracefully', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    // Should not throw; exact output is best-effort.
    expect(() => scrubLastError(circular)).not.toThrow();
  });

  it('limits depth of the redacted shape', () => {
    // Nested >3 levels — past depth 3 the whole branch collapses to <redacted>.
    const out = scrubLastError('{"a":{"b":{"c":{"d":{"e":"leaked"}}}}}');
    expect(out).not.toContain('leaked');
  });
});
