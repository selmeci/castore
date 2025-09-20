import { throttledQueue } from 'throttled-queue';

export const getThrottle = (
  rateLimit = Infinity,
): (<RESPONSE>(throttledFn: () => Promise<RESPONSE>) => Promise<RESPONSE>) =>
  rateLimit === Infinity
    ? throttledFn => throttledFn()
    : throttledQueue({
        maxPerInterval: rateLimit,
        interval: 1000,
        evenlySpaced: true,
      });
