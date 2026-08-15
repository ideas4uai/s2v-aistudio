import { describe, it, expect } from 'vitest';
import { geminiRateLimiter } from '../src/utils/rateLimiter.js';

/**
 * The limiter exists because a burst of image requests gets refused wholesale —
 * measured 1 of 6 and 7 of 10 rejected with RESOURCE_EXHAUSTED. What it has to
 * guarantee is a ceiling on how many are in flight, and that the ceiling survives
 * a call that throws.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('geminiRateLimiter', () => {
  it('never lets more than the cap run at once, and runs everything', async () => {
    const max = geminiRateLimiter.stats.max;
    let live = 0;
    let peak = 0;
    const order: number[] = [];

    await Promise.all(Array.from({ length: max * 4 }, (_, i) => geminiRateLimiter.schedule(async () => {
      live++;
      peak = Math.max(peak, live);
      await sleep(15);
      order.push(i);
      live--;
    })));

    expect(peak).toBe(max);
    expect(order).toHaveLength(max * 4);
    expect(geminiRateLimiter.stats).toEqual({ inFlight: 0, waiting: 0, max });
  });

  it('releases the slot when the call throws, instead of leaking it', async () => {
    const max = geminiRateLimiter.stats.max;
    // A leak here is the worst failure mode available: every later image would
    // queue behind a slot nobody holds, and the render would hang rather than fail.
    for (let i = 0; i < max + 2; i++) {
      await expect(geminiRateLimiter.schedule(async () => { throw new Error('429'); })).rejects.toThrow('429');
    }
    expect(geminiRateLimiter.stats.inFlight).toBe(0);

    // Still usable afterwards.
    await expect(geminiRateLimiter.schedule(async () => 'ok')).resolves.toBe('ok');
  });

  it('spaces starts apart so a same-tick burst does not arrive as one', async () => {
    const starts: number[] = [];
    await Promise.all(Array.from({ length: 3 }, () => geminiRateLimiter.schedule(async () => { starts.push(Date.now()); })));
    starts.sort((a, b) => a - b);
    // Not asserting the exact gap — the point is that two calls issued in the same
    // millisecond do not both start in it.
    expect(starts[starts.length - 1] - starts[0]).toBeGreaterThan(0);
  });
});
