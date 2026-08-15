/**
 * How many Gemini image calls may be in flight at once.
 *
 * `gemini-2.5-flash-image` on Vertex runs on dynamic shared quota: capacity is
 * pooled across projects and handed out on demand, so RESOURCE_EXHAUSTED means
 * "not right now" rather than "you are over your allowance". There is no
 * per-project quota to raise for it — only Provisioned Throughput, or asking for
 * less at once.
 *
 * Measured against the live endpoint, one burst per level:
 *
 *   1, 2, 3 concurrent -> every call 200
 *   6 concurrent       -> 1 of 6 got 429
 *   10 concurrent      -> 7 of 10 got 429
 *
 * Two, not three: the render that first hit this was firing three at a time and
 * every one of them was refused, so three is only comfortable while the pool is
 * quiet. Two leaves headroom and still overlaps — a call takes 6-8s, so the wait
 * is what dominates, not the arithmetic. The retry above this is what actually
 * makes it safe; this only keeps the retries rare.
 */
const MAX_IN_FLIGHT = Math.max(1, Number(process.env.GEMINI_IMAGE_CONCURRENCY || 2));

/** Gap between two starts. Smooths a burst that arrives in the same millisecond. */
const MIN_SPACING_MS = Math.max(0, Number(process.env.GEMINI_IMAGE_SPACING_MS || 250));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Limiter {
  private inFlight = 0;
  private lastStart = 0;
  private readonly waiting: Array<() => void> = [];

  /** Resolves when it is this caller's turn. The returned function releases the slot. */
  private async take(): Promise<() => void> {
    if (this.inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.inFlight++;
    const since = Date.now() - this.lastStart;
    if (since < MIN_SPACING_MS) await sleep(MIN_SPACING_MS - since);
    this.lastStart = Date.now();

    let released = false;
    return () => {
      if (released) return; // a double release would hand out a slot that does not exist
      released = true;
      this.inFlight--;
      this.waiting.shift()?.();
    };
  }

  /** Runs `fn` with a slot held, releasing it however `fn` ends. */
  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.take();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Live counters, for the tests and for anyone wondering what is queued. */
  get stats() {
    return { inFlight: this.inFlight, waiting: this.waiting.length, max: MAX_IN_FLIGHT };
  }
}

export const geminiRateLimiter = new Limiter();
