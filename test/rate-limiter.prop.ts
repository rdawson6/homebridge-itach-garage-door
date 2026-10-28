/**
 * Property-based tests for RateLimiter.
 *
 * Property 8: Rate Limiter Correctness (Requirement 9.7)
 * - First 10 requests in window allowed, 11th+ rejected
 * - After window expires, new window starts
 * - 257th distinct IP evicts LRU
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { RateLimiter } from '../src/rate-limiter.js';

// ─── Generators ────────────────────────────────────────────────────────────────

/** Generate a valid IPv4 address string. */
const ipArb = fc.tuple(
  fc.integer({ min: 1, max: 254 }),
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 1, max: 254 }),
).map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

/** Generate a monotonically non-decreasing sequence of timestamps. */
const timestampsArb = (length: number) =>
  fc.array(fc.integer({ min: 0, max: 100 }), { minLength: length, maxLength: length })
    .map(deltas => {
      const timestamps: number[] = [];
      let current = 1000;
      for (const delta of deltas) {
        current += delta;
        timestamps.push(current);
      }
      return timestamps;
    });

// ─── Property 8: Rate Limiter Correctness ──────────────────────────────────────

describe('Property 8: Rate Limiter Correctness', () => {
  it('first 10 requests from any IP within a window are always allowed', () => {
    fc.assert(
      fc.property(ipArb, fc.integer({ min: 0, max: 100000 }), (ip, baseTime) => {
        const limiter = new RateLimiter();
        // All 10 requests at the same timestamp (within window)
        for (let i = 0; i < 10; i++) {
          expect(limiter.allow(baseTime, ip)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('11th request from same IP within same window is always rejected', () => {
    fc.assert(
      fc.property(ipArb, fc.integer({ min: 0, max: 100000 }), (ip, baseTime) => {
        const limiter = new RateLimiter();
        for (let i = 0; i < 10; i++) {
          limiter.allow(baseTime, ip);
        }
        expect(limiter.allow(baseTime, ip)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('requests beyond 10 within window are rejected, regardless of timing within window', () => {
    fc.assert(
      fc.property(
        ipArb,
        fc.integer({ min: 1000, max: 50000 }),
        fc.integer({ min: 11, max: 20 }),
        (ip, baseTime, totalRequests) => {
          const limiter = new RateLimiter();
          let allowed = 0;
          let rejected = 0;

          for (let i = 0; i < totalRequests; i++) {
            // All within the same window (same timestamp)
            if (limiter.allow(baseTime, ip)) {
              allowed++;
            } else {
              rejected++;
            }
          }

          expect(allowed).toBe(10);
          expect(rejected).toBe(totalRequests - 10);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('after window expiry, a new full window of 10 is available', () => {
    fc.assert(
      fc.property(
        ipArb,
        fc.integer({ min: 1000, max: 50000 }),
        fc.integer({ min: 1001, max: 5000 }),
        (ip, baseTime, gap) => {
          const limiter = new RateLimiter();

          // Exhaust first window
          for (let i = 0; i < 10; i++) {
            limiter.allow(baseTime, ip);
          }
          expect(limiter.allow(baseTime, ip)).toBe(false);

          // After window expires (gap > 1000ms ensures full expiry)
          const newTime = baseTime + gap;
          for (let i = 0; i < 10; i++) {
            expect(limiter.allow(newTime + i, ip)).toBe(true);
          }
          // 11th in new window rejected
          expect(limiter.allow(newTime + 10, ip)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('different IPs have independent rate limits', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(ipArb, { minLength: 2, maxLength: 5 }),
        fc.integer({ min: 1000, max: 50000 }),
        (ips, baseTime) => {
          const limiter = new RateLimiter();

          // Exhaust first IP
          for (let i = 0; i < 10; i++) {
            limiter.allow(baseTime, ips[0]!);
          }
          expect(limiter.allow(baseTime, ips[0]!)).toBe(false);

          // Other IPs should still have full budget
          for (let idx = 1; idx < ips.length; idx++) {
            expect(limiter.allow(baseTime, ips[idx]!)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('257th distinct IP evicts LRU and new IP gets fresh window', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 50000 }),
        (baseTime) => {
          const limiter = new RateLimiter();

          // Fill 256 distinct IPs
          for (let i = 0; i < 256; i++) {
            const ip = `10.${Math.floor(i / 256) % 256}.${Math.floor(i / 1) % 256}.${(i % 254) + 1}`;
            limiter.allow(baseTime, ip);
          }

          // 257th IP should be allowed (evicts LRU)
          expect(limiter.allow(baseTime, '172.16.99.99')).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('evicted IP loses its history and behaves as fresh', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1000, max: 50000 }), (baseTime) => {
        const limiter = new RateLimiter();

        // Use up 9 requests from the first IP
        const targetIp = '10.0.0.1';
        for (let i = 0; i < 9; i++) {
          limiter.allow(baseTime, targetIp);
        }

        // Fill remaining 255 IPs to push targetIp to LRU
        for (let i = 2; i <= 256; i++) {
          limiter.allow(baseTime, `10.0.${Math.floor(i / 256)}.${i % 256}`);
        }

        // Add one more IP to trigger eviction of targetIp
        limiter.allow(baseTime, '172.16.0.1');

        // targetIp's history is gone — it should be allowed fresh (10 requests)
        for (let i = 0; i < 10; i++) {
          expect(limiter.allow(baseTime, targetIp)).toBe(true);
        }
        expect(limiter.allow(baseTime, targetIp)).toBe(false);
      }),
      { numRuns: 20 },
    );
  });

  it('rejected requests do not consume window budget', () => {
    fc.assert(
      fc.property(
        ipArb,
        fc.integer({ min: 1000, max: 50000 }),
        fc.integer({ min: 1, max: 10 }),
        (ip, baseTime, extraAttempts) => {
          const limiter = new RateLimiter();

          // Use all 10 slots
          for (let i = 0; i < 10; i++) {
            limiter.allow(baseTime, ip);
          }

          // Make extra rejected attempts
          for (let i = 0; i < extraAttempts; i++) {
            limiter.allow(baseTime + i + 1, ip);
          }

          // After full window expiry, should get exactly 10 again
          const freshTime = baseTime + 1001;
          let count = 0;
          for (let i = 0; i < 15; i++) {
            if (limiter.allow(freshTime, ip)) {
              count++;
            }
          }
          expect(count).toBe(10);
        },
      ),
      { numRuns: 100 },
    );
  });
});
