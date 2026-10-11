import { type Clock } from "@invisible-dots/shared";

/** A token bucket per key: `capacity` messages at once, refilled at `refillPerSecond`. */
export class RateLimiter {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly clock: Clock,
  ) {}

  /** Take one token for `key`: false when the bucket is empty. */
  take(key: string): boolean {
    const now = this.clock.now().getTime();
    const bucket = this.#buckets.get(key) ?? { tokens: this.capacity, at: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + ((now - bucket.at) / 1000) * this.refillPerSecond);
    bucket.at = now;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.#buckets.set(key, bucket);
    return allowed;
  }
}
