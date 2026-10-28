import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../src/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  describe('basic allow/reject', () => {
    it('allows the first request from an IP', () => {
      expect(limiter.allow(1000, '192.168.1.1')).toBe(true);
    });

    it('allows up to 10 requests within a 1000ms window', () => {
      for (let i = 0; i < 10; i++) {
        expect(limiter.allow(1000 + i, '192.168.1.1')).toBe(true);
      }
    });

    it('rejects the 11th request within the same window', () => {
      for (let i = 0; i < 10; i++) {
        limiter.allow(1000, '192.168.1.1');
      }
      expect(limiter.allow(1000, '192.168.1.1')).toBe(false);
    });

    it('rejects all requests beyond 10 within the window', () => {
      for (let i = 0; i < 10; i++) {
        limiter.allow(1000, '192.168.1.1');
      }
      expect(limiter.allow(1500, '192.168.1.1')).toBe(false);
      expect(limiter.allow(1999, '192.168.1.1')).toBe(false);
    });
  });

  describe('window expiry', () => {
    it('allows requests after the window expires', () => {
      for (let i = 0; i < 10; i++) {
        limiter.allow(1000, '192.168.1.1');
      }
      // Window started at t=1000, so t>2000 is past the window
      expect(limiter.allow(2001, '192.168.1.1')).toBe(true);
    });

    it('starts a new window after expiry with full budget', () => {
      for (let i = 0; i < 10; i++) {
        limiter.allow(1000, '192.168.1.1');
      }
      // After window expires, should allow 10 more
      for (let i = 0; i < 10; i++) {
        expect(limiter.allow(2001 + i, '192.168.1.1')).toBe(true);
      }
      // 11th in new window rejected
      expect(limiter.allow(2011, '192.168.1.1')).toBe(false);
    });

    it('sliding window: early requests expire as time progresses', () => {
      // Send 10 requests at t=1000
      for (let i = 0; i < 10; i++) {
        limiter.allow(1000, '192.168.1.1');
      }
      // At t=2001, those 10 requests at t=1000 have expired (1000 is <= 2001-1000=1001)
      expect(limiter.allow(2001, '192.168.1.1')).toBe(true);
    });

    it('partially expired window allows proportional requests', () => {
      // 5 requests at t=1000
      for (let i = 0; i < 5; i++) {
        limiter.allow(1000, '192.168.1.1');
      }
      // 5 requests at t=1500
      for (let i = 0; i < 5; i++) {
        limiter.allow(1500, '192.168.1.1');
      }
      // At t=2001, the 5 at t=1000 have expired, 5 at t=1500 remain
      // Should allow 5 more
      for (let i = 0; i < 5; i++) {
        expect(limiter.allow(2001 + i, '192.168.1.1')).toBe(true);
      }
      // 11th in window rejected (5 from t=1500 + 5 new + 1 = over)
      expect(limiter.allow(2006, '192.168.1.1')).toBe(false);
    });
  });

  describe('multiple IPs', () => {
    it('tracks IPs independently', () => {
      for (let i = 0; i < 10; i++) {
        limiter.allow(1000, '192.168.1.1');
      }
      // IP 1 is exhausted
      expect(limiter.allow(1000, '192.168.1.1')).toBe(false);
      // IP 2 still has full budget
      expect(limiter.allow(1000, '192.168.1.2')).toBe(true);
    });
  });

  describe('LRU eviction at 256 IPs', () => {
    it('evicts the least recently active IP when 257th arrives', () => {
      // Fill up 256 IPs
      for (let i = 0; i < 256; i++) {
        limiter.allow(1000, `10.0.${Math.floor(i / 256)}.${i % 256}`);
      }

      // The first IP added (10.0.0.0) is LRU
      // Add a 257th IP — should succeed (evicts 10.0.0.0)
      expect(limiter.allow(1000, '172.16.0.1')).toBe(true);

      // The evicted IP now behaves as a fresh IP (its history is gone)
      // It should be allowed since it starts a new window
      expect(limiter.allow(1000, '10.0.0.0')).toBe(true);
    });

    it('LRU eviction targets the IP that was active least recently', () => {
      // Add 256 IPs at t=1000
      for (let i = 0; i < 256; i++) {
        limiter.allow(1000, `10.0.${Math.floor(i / 256)}.${i % 256}`);
      }

      // Access the first IP again at t=2000 — it becomes most recently used
      limiter.allow(2000, '10.0.0.0');

      // Now the LRU is 10.0.0.1 (second IP added, never accessed since)
      // Add 257th IP — evicts 10.0.0.1
      expect(limiter.allow(2000, '172.16.0.1')).toBe(true);

      // 10.0.0.0 should still have its history (it was promoted)
      // It had 1 request at t=1000 (expired by t=2000) and 1 at t=2000
      // So it has 1 request in window — 9 more allowed
      for (let i = 0; i < 9; i++) {
        expect(limiter.allow(2000, '10.0.0.0')).toBe(true);
      }
      expect(limiter.allow(2000, '10.0.0.0')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles timestamp at exact window boundary (exclusive start)', () => {
      // Requests at t=1000
      for (let i = 0; i < 10; i++) {
        limiter.allow(1000, '192.168.1.1');
      }
      // At t=2000 exactly: windowStart = 2000 - 1000 = 1000
      // Requests at t=1000 expire when timestamp <= windowStart (1000 <= 1000)
      expect(limiter.allow(2000, '192.168.1.1')).toBe(true);
    });

    it('rejected requests do not consume window budget', () => {
      for (let i = 0; i < 10; i++) {
        limiter.allow(1000, '192.168.1.1');
      }
      // Rejected requests
      limiter.allow(1500, '192.168.1.1');
      limiter.allow(1600, '192.168.1.1');

      // After window expires, should get full 10 again
      for (let i = 0; i < 10; i++) {
        expect(limiter.allow(2001 + i, '192.168.1.1')).toBe(true);
      }
    });

    it('works with zero timestamp', () => {
      expect(limiter.allow(0, '192.168.1.1')).toBe(true);
    });

    it('works with very large timestamps', () => {
      expect(limiter.allow(Number.MAX_SAFE_INTEGER - 1000, '192.168.1.1')).toBe(true);
    });
  });
});
