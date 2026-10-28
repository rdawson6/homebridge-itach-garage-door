/**
 * Unit tests for the config validator — edge cases.
 */

import { describe, it, expect } from 'vitest';
import { validateConfig, type RawDoorEntry } from '../src/config-validator.js';

function baseEntry(overrides: Partial<RawDoorEntry> = {}): RawDoorEntry {
  return { name: 'Test Door', ipAddress: '192.168.1.100', relay: '1:1', ...overrides };
}

describe('validateConfig', () => {
  // ─── Empty / valid config ─────────────────────────────────────────────────

  describe('empty config', () => {
    it('accepts an empty array (0 doors, no errors)', () => {
      const result = validateConfig([]);
      expect(result.doors).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts undefined doors as empty', () => {
      const result = validateConfig(undefined);
      expect(result.doors).toHaveLength(0);
    });
  });

  describe('valid single door with defaults', () => {
    it('applies all defaults for a minimal entry', () => {
      const result = validateConfig([baseEntry()]);
      expect(result.doors).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
      const door = result.doors[0]!;
      expect(door.pulseDuration).toBe(500);
      expect(door.openingTime).toBe(15);
      expect(door.closingTime).toBe(15);
      expect(door.port).toBe(4998);
      expect(door.midTravelBehaviour).toBe('stop');
      expect(door.doorId).toBe('0'); // array index
    });

    it('preserves all provided values', () => {
      const result = validateConfig([
        baseEntry({
          pulseDuration: 800,
          openingTime: 20,
          closingTime: 25,
          port: 4999,
          midTravelBehaviour: 'reverse',
          doorId: 'main-door',
        }),
      ]);
      const door = result.doors[0]!;
      expect(door.pulseDuration).toBe(800);
      expect(door.openingTime).toBe(20);
      expect(door.closingTime).toBe(25);
      expect(door.port).toBe(4999);
      expect(door.midTravelBehaviour).toBe('reverse');
      expect(door.doorId).toBe('main-door');
    });
  });

  // ─── Missing required fields ──────────────────────────────────────────────

  describe('missing required fields', () => {
    it('skips entry with missing name', () => {
      const result = validateConfig([{ ipAddress: '192.168.1.1', relay: '1:1' }]);
      expect(result.doors).toHaveLength(0);
      expect(result.errors.some(e => e.field === 'name')).toBe(true);
    });

    it('skips entry with whitespace-only name', () => {
      const result = validateConfig([baseEntry({ name: '   ' })]);
      expect(result.doors).toHaveLength(0);
      expect(result.errors.some(e => e.field === 'name')).toBe(true);
    });

    it('skips entry with missing ipAddress', () => {
      const result = validateConfig([{ name: 'Door', relay: '1:1' }]);
      expect(result.doors).toHaveLength(0);
      expect(result.errors.some(e => e.field === 'ipAddress')).toBe(true);
    });

    it('skips entry with missing relay', () => {
      const result = validateConfig([{ name: 'Door', ipAddress: '192.168.1.1' }]);
      expect(result.doors).toHaveLength(0);
      expect(result.errors.some(e => e.field === 'relay')).toBe(true);
    });
  });

  // ─── Malformed IPv4 ───────────────────────────────────────────────────────

  describe('malformed IPv4', () => {
    it.each(['999.1.1.1', '1.2.3', 'abc', '1.2.3.4.5', '256.256.256.256', ''])(
      'skips entry with invalid ipAddress %s',
      (ip) => {
        const result = validateConfig([baseEntry({ ipAddress: ip })]);
        expect(result.doors).toHaveLength(0);
        expect(result.errors.some(e => e.field === 'ipAddress')).toBe(true);
      },
    );

    it('accepts valid edge-case IPs', () => {
      for (const ip of ['0.0.0.0', '255.255.255.255', '192.168.4.235']) {
        const result = validateConfig([baseEntry({ ipAddress: ip })]);
        expect(result.doors).toHaveLength(1);
      }
    });
  });

  // ─── Invalid relay ────────────────────────────────────────────────────────

  describe('invalid relay', () => {
    it.each(['1:4', '2:1', '0:0', 'foo', '1:1:1'])(
      'skips entry with relay %s outside permitted set',
      (relay) => {
        const result = validateConfig([baseEntry({ relay })]);
        expect(result.doors).toHaveLength(0);
        expect(result.errors.some(e => e.field === 'relay')).toBe(true);
      },
    );
  });

  // ─── Duplicate doorId ─────────────────────────────────────────────────────

  describe('duplicate doorId', () => {
    it('first wins, second skipped with error', () => {
      const result = validateConfig([
        baseEntry({ ipAddress: '192.168.1.1', relay: '1:1', doorId: 'dup' }),
        baseEntry({ ipAddress: '192.168.1.2', relay: '1:1', doorId: 'dup' }),
      ]);
      expect(result.doors).toHaveLength(1);
      expect(result.doors[0]!.ipAddress).toBe('192.168.1.1');
      expect(result.errors.some(e => e.field === 'doorId')).toBe(true);
    });

    it('default doorIds (array index) do not collide', () => {
      const result = validateConfig([
        baseEntry({ ipAddress: '192.168.1.1', relay: '1:1' }),
        baseEntry({ ipAddress: '192.168.1.2', relay: '1:1' }),
      ]);
      expect(result.doors).toHaveLength(2);
      expect(result.doors[0]!.doorId).toBe('0');
      expect(result.doors[1]!.doorId).toBe('1');
    });
  });

  // ─── Duplicate ip+relay ───────────────────────────────────────────────────

  describe('duplicate ipAddress+relay', () => {
    it('first wins, second skipped with error', () => {
      const result = validateConfig([
        baseEntry({ ipAddress: '192.168.1.1', relay: '1:1', doorId: 'a' }),
        baseEntry({ ipAddress: '192.168.1.1', relay: '1:1', doorId: 'b' }),
      ]);
      expect(result.doors).toHaveLength(1);
      expect(result.doors[0]!.doorId).toBe('a');
      expect(result.errors.some(e => e.field === 'relay')).toBe(true);
    });

    it('same IP different relay is allowed', () => {
      const result = validateConfig([
        baseEntry({ ipAddress: '192.168.1.1', relay: '1:1', doorId: 'a' }),
        baseEntry({ ipAddress: '192.168.1.1', relay: '1:2', doorId: 'b' }),
      ]);
      expect(result.doors).toHaveLength(2);
    });
  });

  // ─── Name truncation ──────────────────────────────────────────────────────

  describe('name truncation', () => {
    it('truncates names longer than 64 chars', () => {
      const longName = 'x'.repeat(100);
      const result = validateConfig([baseEntry({ name: longName })]);
      expect(result.doors[0]!.name).toHaveLength(64);
    });
  });

  // ─── Invalid optional numeric fields ──────────────────────────────────────

  describe('invalid optional numeric fields fall back to defaults', () => {
    it('out-of-range pulseDuration → 500 with error, other fields preserved', () => {
      const result = validateConfig([baseEntry({ pulseDuration: 50, openingTime: 30 })]);
      const door = result.doors[0]!;
      expect(door.pulseDuration).toBe(500);
      expect(door.openingTime).toBe(30);
      expect(result.errors.some(e => e.field === 'pulseDuration')).toBe(true);
    });

    it('out-of-range port → 4998 with error', () => {
      const result = validateConfig([baseEntry({ port: 99999 })]);
      expect(result.doors[0]!.port).toBe(4998);
      expect(result.errors.some(e => e.field === 'port')).toBe(true);
    });

    it('invalid midTravelBehaviour → stop with error', () => {
      const result = validateConfig([baseEntry({ midTravelBehaviour: 'bounce' })]);
      expect(result.doors[0]!.midTravelBehaviour).toBe('stop');
      expect(result.errors.some(e => e.field === 'midTravelBehaviour')).toBe(true);
    });
  });

  // ─── Max 8 doors (just verify large arrays validate independently) ─────────

  describe('multiple doors', () => {
    it('validates up to 8 doors independently', () => {
      const entries: RawDoorEntry[] = [];
      for (let i = 0; i < 8; i++) {
        entries.push(baseEntry({ ipAddress: `192.168.1.${i + 1}`, relay: '1:1', doorId: `door-${i}` }));
      }
      const result = validateConfig(entries);
      expect(result.doors).toHaveLength(8);
    });

    it('one invalid door does not affect the others', () => {
      const result = validateConfig([
        baseEntry({ ipAddress: '192.168.1.1', relay: '1:1', doorId: 'good1' }),
        baseEntry({ ipAddress: 'bad-ip', relay: '1:1', doorId: 'bad' }),
        baseEntry({ ipAddress: '192.168.1.3', relay: '1:1', doorId: 'good2' }),
      ]);
      expect(result.doors).toHaveLength(2);
      expect(result.doors.map(d => d.doorId)).toEqual(['good1', 'good2']);
    });
  });

  // ─── Webhook config validation ────────────────────────────────────────────

  describe('webhook config', () => {
    const validToken = 'a'.repeat(32);

    it('returns null webhook when no port configured', () => {
      const result = validateConfig([baseEntry()], {});
      expect(result.webhook).toBeNull();
    });

    it('accepts valid webhook config with defaults', () => {
      const result = validateConfig([baseEntry()], { port: 8080, token: validToken });
      expect(result.webhook).not.toBeNull();
      expect(result.webhook!.port).toBe(8080);
      expect(result.webhook!.bindAddress).toBe('0.0.0.0');
    });

    it('accepts custom bindAddress', () => {
      const result = validateConfig([baseEntry()], {
        port: 8080,
        token: validToken,
        bindAddress: '192.168.1.5',
      });
      expect(result.webhook!.bindAddress).toBe('192.168.1.5');
    });

    it('disables webhook when token too short', () => {
      const result = validateConfig([baseEntry()], { port: 8080, token: 'short' });
      expect(result.webhook).toBeNull();
      expect(result.errors.some(e => e.field === 'webhook.token')).toBe(true);
    });

    it('disables webhook when token too long', () => {
      const result = validateConfig([baseEntry()], { port: 8080, token: 'a'.repeat(129) });
      expect(result.webhook).toBeNull();
      expect(result.errors.some(e => e.field === 'webhook.token')).toBe(true);
    });

    it('disables webhook when token has leading/trailing whitespace', () => {
      const result = validateConfig([baseEntry()], { port: 8080, token: `  ${validToken}  ` });
      expect(result.webhook).toBeNull();
    });

    it('disables webhook when port out of range', () => {
      const result = validateConfig([baseEntry()], { port: 80, token: validToken });
      expect(result.webhook).toBeNull();
      expect(result.errors.some(e => e.field === 'webhook.port')).toBe(true);
    });

    it('disables webhook when bindAddress invalid', () => {
      const result = validateConfig([baseEntry()], {
        port: 8080,
        token: validToken,
        bindAddress: 'not-an-ip',
      });
      expect(result.webhook).toBeNull();
      expect(result.errors.some(e => e.field === 'webhook.bindAddress')).toBe(true);
    });

    it('doors still validate when webhook is invalid', () => {
      const result = validateConfig([baseEntry()], { port: 80, token: 'short' });
      expect(result.doors).toHaveLength(1);
      expect(result.webhook).toBeNull();
    });
  });
});
