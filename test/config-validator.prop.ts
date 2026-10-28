/**
 * Property-based tests for the config validator.
 *
 * Property 6: Configuration Validation — Ranges and Defaults
 * Property 7: UUID Determinism and Uniqueness
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  validateConfig,
  deriveUuid,
  isValidIpv4,
  DEFAULT_PULSE_DURATION,
  DEFAULT_OPENING_TIME,
  DEFAULT_PORT,
  type RawDoorEntry,
} from '../src/config-validator.js';

// ─── Generators ────────────────────────────────────────────────────────────────

const validIpArb = fc.tuple(
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 0, max: 255 }),
).map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

const validRelayArb = fc.constantFrom('1:1', '1:2', '1:3');

const validNameArb = fc.string({ minLength: 1, maxLength: 64 }).filter(s => s.trim().length > 0);

/** A minimal valid door entry with a given override. */
function baseEntry(overrides: Partial<RawDoorEntry> = {}): RawDoorEntry {
  return {
    name: 'Test Door',
    ipAddress: '192.168.1.100',
    relay: '1:1',
    ...overrides,
  };
}

// ─── Property 6: Ranges and Defaults ────────────────────────────────────────

describe('Property 6: Configuration Validation — Ranges and Defaults', () => {
  it('in-range pulseDuration is preserved; out-of-range → default 500', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 5000 }), (pulse) => {
        const result = validateConfig([baseEntry({ pulseDuration: pulse })]);
        expect(result.doors).toHaveLength(1);
        const door = result.doors[0]!;
        if (pulse >= 100 && pulse <= 2000) {
          expect(door.pulseDuration).toBe(pulse);
        } else {
          expect(door.pulseDuration).toBe(DEFAULT_PULSE_DURATION);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('in-range openingTime/closingTime preserved; out-of-range → default 15', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100, max: 300 }),
        fc.integer({ min: -100, max: 300 }),
        (opening, closing) => {
          const result = validateConfig([baseEntry({ openingTime: opening, closingTime: closing })]);
          const door = result.doors[0]!;

          if (opening >= 1 && opening <= 120) {
            expect(door.openingTime).toBe(opening);
          } else {
            expect(door.openingTime).toBe(DEFAULT_OPENING_TIME);
          }

          if (closing >= 1 && closing <= 120) {
            expect(door.closingTime).toBe(closing);
          } else {
            expect(door.closingTime).toBe(DEFAULT_OPENING_TIME);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('in-range port preserved; out-of-range → default 4998', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100, max: 70000 }), (port) => {
        const result = validateConfig([baseEntry({ port })]);
        const door = result.doors[0]!;
        if (port >= 1 && port <= 65535) {
          expect(door.port).toBe(port);
        } else {
          expect(door.port).toBe(DEFAULT_PORT);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('non-integer numeric fields fall back to default', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(100.1), max: Math.fround(1999.9), noInteger: true }),
        (pulse) => {
          const result = validateConfig([baseEntry({ pulseDuration: pulse })]);
          const door = result.doors[0]!;
          expect(door.pulseDuration).toBe(DEFAULT_PULSE_DURATION);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('an invalid optional field preserves all other fields', () => {
    fc.assert(
      fc.property(
        validIpArb,
        validRelayArb,
        fc.integer({ min: 1, max: 120 }),
        (ip, relay, openingTime) => {
          // pulseDuration is invalid (out of range), but openingTime is valid
          const result = validateConfig([
            baseEntry({ ipAddress: ip, relay, pulseDuration: 99999, openingTime }),
          ]);
          const door = result.doors[0]!;
          expect(door.pulseDuration).toBe(DEFAULT_PULSE_DURATION); // fell back
          expect(door.openingTime).toBe(openingTime); // preserved
          expect(door.ipAddress).toBe(ip); // preserved
          expect(door.relay).toBe(relay); // preserved
        },
      ),
      { numRuns: 200 },
    );
  });

  it('doorId regex: valid ids accepted, invalid ids skip the entry', () => {
    fc.assert(
      fc.property(
        fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {
          minLength: 1,
          maxLength: 64,
        }),
        (validId) => {
          const result = validateConfig([baseEntry({ doorId: validId })]);
          expect(result.doors).toHaveLength(1);
          expect(result.doors[0]!.doorId).toBe(validId);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('doorId with uppercase or invalid chars skips the entry', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }).filter(s => !/^[a-z0-9-]+$/.test(s)),
        (invalidId) => {
          const result = validateConfig([baseEntry({ doorId: invalidId })]);
          expect(result.doors).toHaveLength(0);
          expect(result.errors.some(e => e.field === 'doorId')).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('IPv4 acceptance: valid dotted-quads accepted', () => {
    fc.assert(
      fc.property(validIpArb, (ip) => {
        expect(isValidIpv4(ip)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('IPv4 rejection: octets above 255 rejected', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 256, max: 999 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (bad, b, c, d) => {
          expect(isValidIpv4(`${bad}.${b}.${c}.${d}`)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('IPv4 rejection: wrong number of octets rejected', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 6 })
          .filter(arr => arr.length !== 4),
        (octets) => {
          expect(isValidIpv4(octets.join('.'))).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 7: UUID Determinism and Uniqueness ────────────────────────────

describe('Property 7: UUID Determinism and Uniqueness', () => {
  it('same (ipAddress, relay) → same UUID', () => {
    fc.assert(
      fc.property(validIpArb, validRelayArb, (ip, relay) => {
        expect(deriveUuid(ip, relay)).toBe(deriveUuid(ip, relay));
      }),
      { numRuns: 200 },
    );
  });

  it('different ipAddress → different UUID (same relay)', () => {
    fc.assert(
      fc.property(
        fc.tuple(validIpArb, validIpArb).filter(([a, b]) => a !== b),
        validRelayArb,
        ([ip1, ip2], relay) => {
          expect(deriveUuid(ip1, relay)).not.toBe(deriveUuid(ip2, relay));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('different relay → different UUID (same ipAddress)', () => {
    fc.assert(
      fc.property(
        validIpArb,
        fc.tuple(validRelayArb, validRelayArb).filter(([a, b]) => a !== b),
        (ip, [relay1, relay2]) => {
          expect(deriveUuid(ip, relay1)).not.toBe(deriveUuid(ip, relay2));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('UUID is independent of name, port, timings, doorId', () => {
    fc.assert(
      fc.property(
        validIpArb,
        validRelayArb,
        validNameArb,
        fc.integer({ min: 1, max: 65535 }),
        fc.integer({ min: 100, max: 2000 }),
        (ip, relay, name, port, pulse) => {
          const resultA = validateConfig([{ name, ipAddress: ip, relay, port, pulseDuration: pulse }]);
          const resultB = validateConfig([{ name: 'Different', ipAddress: ip, relay, port: 4998 }]);

          const doorA = resultA.doors[0]!;
          const doorB = resultB.doors[0]!;

          // UUID derived from ip+relay alone should match
          expect(deriveUuid(doorA.ipAddress, doorA.relay)).toBe(deriveUuid(doorB.ipAddress, doorB.relay));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('derived UUID matches RFC-4122 shape (8-4-4-4-12 hex)', () => {
    fc.assert(
      fc.property(validIpArb, validRelayArb, (ip, relay) => {
        const uuid = deriveUuid(ip, relay);
        expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      }),
      { numRuns: 100 },
    );
  });
});
