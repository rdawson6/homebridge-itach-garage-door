/**
 * Per-IP sliding window rate limiter.
 *
 * Allows up to 10 requests per 1000ms window per source IP address.
 * Tracks up to 256 distinct IPs with LRU (least recently active) eviction.
 * Timestamps are assumed to be monotonically non-decreasing (millisecond precision).
 */

/** Maximum number of requests allowed within one window. */
const MAX_REQUESTS_PER_WINDOW = 10;

/** Window duration in milliseconds. */
const WINDOW_DURATION_MS = 1000;

/** Maximum number of distinct IPs tracked concurrently. */
const MAX_TRACKED_IPS = 256;

/** State tracked per source IP. */
interface IpWindow {
  /** Timestamps of requests within the current window. */
  timestamps: number[];
}

/**
 * A sliding window rate limiter that tracks per-IP request rates.
 *
 * The window starts on the first request from an IP and lasts 1000ms.
 * Within that window, up to 10 requests are allowed. Requests beyond the
 * 10th are rejected until the window expires. After expiry the next request
 * starts a fresh window.
 *
 * When 256 IPs are tracked and a request arrives from an untracked IP, the
 * least recently active IP is evicted to make room.
 */
export class RateLimiter {
  /**
   * Map from source IP to its window state.
   * Insertion/access order is maintained by deleting and re-inserting on access
   * so that the first entry is always the least recently used.
   */
  private readonly windows: Map<string, IpWindow> = new Map();

  /**
   * Determine whether a request from the given source IP at the given
   * timestamp should be allowed.
   *
   * @param timestamp - Current time in milliseconds (monotonically non-decreasing).
   * @param sourceIp - The source IPv4 address string.
   * @returns `true` if the request is allowed, `false` if it should be rejected (429).
   */
  allow(timestamp: number, sourceIp: string): boolean {
    const existing = this.windows.get(sourceIp);

    if (existing !== undefined) {
      // Promote to most-recently-used by re-inserting.
      this.windows.delete(sourceIp);

      // Expire timestamps outside the current window.
      const windowStart = timestamp - WINDOW_DURATION_MS;
      const timestamps = existing.timestamps;

      // Since timestamps are monotonically non-decreasing, all expired entries
      // are at the front of the array. Find the first entry still within the window.
      let firstValid = 0;
      while (firstValid < timestamps.length && timestamps[firstValid]! <= windowStart) {
        firstValid++;
      }

      if (firstValid > 0) {
        timestamps.splice(0, firstValid);
      }

      // Check if within budget.
      if (timestamps.length >= MAX_REQUESTS_PER_WINDOW) {
        // Rejected — still re-insert to maintain LRU (IP is active).
        this.windows.set(sourceIp, existing);
        return false;
      }

      // Allowed — record this request.
      timestamps.push(timestamp);
      this.windows.set(sourceIp, existing);
      return true;
    }

    // New IP — evict LRU if at capacity.
    if (this.windows.size >= MAX_TRACKED_IPS) {
      // The first key in the Map is the least recently used.
      const lruKey = this.windows.keys().next().value as string;
      this.windows.delete(lruKey);
    }

    // Start a fresh window for this IP.
    this.windows.set(sourceIp, { timestamps: [timestamp] });
    return true;
  }
}
