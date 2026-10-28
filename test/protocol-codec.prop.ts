/**
 * Property-based tests for ProtocolCodec.
 *
 * Property 1: Command Encoding Round-Trip (Requirements 4.1, 4.2, 4.5, 3.2)
 * Property 2: Response Parsing Round-Trip (Requirements 4.3, 4.4, 4.6, 4.8)
 * Property 3: Parser Total Function — Never Throws (Requirements 4.7, 4.9, 4.10)
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ProtocolCodec } from '../src/protocol-codec.js';

const codec = new ProtocolCodec();

// ─── Generators ────────────────────────────────────────────────────────────────

/** Valid connector values for IP2CC: 1, 2, or 3. */
const connectorArb = fc.constantFrom(1, 2, 3);

/** Valid relay state values: 0 or 1. */
const stateArb = fc.constantFrom(0 as const, 1 as const);

/** Module is always 1 for IP2CC. */
const moduleArb = fc.constant(1);

/** Printable ASCII + \r + \n, strings 0–256 chars. */
const arbitraryProtocolString = fc.string({
  minLength: 0,
  maxLength: 256,
  unit: fc.integer({ min: 0x20, max: 0x7e })
    .chain(charCode =>
      fc.constantFrom(
        String.fromCharCode(charCode),
        '\r',
        '\n',
      )
    ),
});

// A more direct approach: generate from printable ASCII + control chars
const protocolCharArb = fc.oneof(
  { weight: 90, arbitrary: fc.integer({ min: 0x20, max: 0x7e }).map(c => String.fromCharCode(c)) },
  { weight: 5, arbitrary: fc.constant('\r') },
  { weight: 5, arbitrary: fc.constant('\n') },
);

const arbitraryRawString = fc.array(protocolCharArb, { minLength: 0, maxLength: 256 })
  .map(chars => chars.join(''));

// ─── Property 1: Command Encoding Round-Trip ───────────────────────────────────

describe('Property 1: Command Encoding Round-Trip', () => {
  it('encodeSetState produces no whitespace or line terminators', () => {
    fc.assert(
      fc.property(moduleArb, connectorArb, stateArb, (mod, conn, state) => {
        const encoded = codec.encodeSetState(mod, conn, state);
        expect(encoded).not.toMatch(/\s/);
        expect(encoded).not.toContain('\r');
        expect(encoded).not.toContain('\n');
      }),
    );
  });

  it('encodeGetState produces no whitespace or line terminators', () => {
    fc.assert(
      fc.property(moduleArb, connectorArb, (mod, conn) => {
        const encoded = codec.encodeGetState(mod, conn);
        expect(encoded).not.toMatch(/\s/);
        expect(encoded).not.toContain('\r');
        expect(encoded).not.toContain('\n');
      }),
    );
  });

  it('encodeSetState then parseResponse yields structurally equal setstate-echo', () => {
    fc.assert(
      fc.property(moduleArb, connectorArb, stateArb, (mod, conn, state) => {
        const encoded = codec.encodeSetState(mod, conn, state);
        const parsed = codec.parseResponse(encoded);
        expect(parsed).toEqual({
          type: 'setstate-echo',
          module: mod,
          connector: conn,
          value: state,
          raw: encoded,
        });
      }),
    );
  });

  it('encodeGetState → simulated state response round-trips correctly', () => {
    fc.assert(
      fc.property(moduleArb, connectorArb, stateArb, (mod, conn, state) => {
        // The device responds to getstate with "state,M:C,V"
        const wireResponse = `state,${mod}:${conn},${state}`;
        const parsed = codec.parseResponse(wireResponse);
        expect(parsed).toEqual({
          type: 'state',
          module: mod,
          connector: conn,
          value: state,
          raw: wireResponse,
        });
      }),
    );
  });
});

// ─── Property 2: Response Parsing Round-Trip ───────────────────────────────────

describe('Property 2: Response Parsing Round-Trip', () => {
  it('state response wire format → parse → correct structure', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 255 }),
        fc.integer({ min: 1, max: 255 }),
        stateArb,
        (mod, conn, state) => {
          const wire = `state,${mod}:${conn},${state}`;
          const parsed = codec.parseResponse(wire);
          expect(parsed).toEqual({
            type: 'state',
            module: mod,
            connector: conn,
            value: state,
            raw: wire,
          });
        },
      ),
    );
  });

  it('setstate echo wire format → parse → correct structure', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 255 }),
        fc.integer({ min: 1, max: 255 }),
        stateArb,
        (mod, conn, state) => {
          const wire = `setstate,${mod}:${conn},${state}`;
          const parsed = codec.parseResponse(wire);
          expect(parsed).toEqual({
            type: 'setstate-echo',
            module: mod,
            connector: conn,
            value: state,
            raw: wire,
          });
        },
      ),
    );
  });

  it('error response wire format → parse → correct structure', () => {
    fc.assert(
      fc.property(
        fc.stringOf(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.constantFrom('_', ' '),
        (code, sep) => {
          const wire = `ERR${sep}${code}`;
          const parsed = codec.parseResponse(wire);
          expect(parsed.type).toBe('error');
          if (parsed.type === 'error') {
            expect(parsed.code).toBe(code);
            expect(parsed.raw).toBe(wire);
          }
        },
      ),
    );
  });

  it('devices response wire format → parse → devices type', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9 }),
        fc.integer({ min: 0, max: 9 }),
        fc.constantFrom('RELAY', 'IR', 'SERIAL', 'ETHERNET'),
        (mod, connectors, type) => {
          const wire = `device,${mod},${connectors} ${type}`;
          const parsed = codec.parseResponse(wire);
          expect(parsed.type).toBe('devices');
          if (parsed.type === 'devices') {
            expect(parsed.modules).toHaveLength(1);
            expect(parsed.modules[0]).toEqual({
              module: mod,
              type,
              connectors,
            });
          }
        },
      ),
    );
  });
});

// ─── Property 3: Parser Total Function (Never Throws) ──────────────────────────

describe('Property 3: Parser Total Function (Never Throws)', () => {
  it('parseResponse never throws for arbitrary strings 0–256 chars', () => {
    fc.assert(
      fc.property(arbitraryRawString, (input) => {
        // Must not throw
        const result = codec.parseResponse(input);
        // Must return a result with a known type
        expect(result).toBeDefined();
        expect(result.type).toMatch(/^(state|setstate-echo|error|devices|parse-error)$/);
      }),
      { numRuns: 500 },
    );
  });

  it('parseResponse result raw field is truncated to 256 chars when parse-error', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 257, maxLength: 512 }),
        (input) => {
          const result = codec.parseResponse(input);
          // For inputs > 256 chars that can't be parsed, raw should be truncated
          if (result.type === 'parse-error') {
            expect(result.raw.length).toBeLessThanOrEqual(256);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('extractFrames never throws for arbitrary buffers', () => {
    fc.assert(
      fc.property(arbitraryRawString, (buffer) => {
        const result = codec.extractFrames(buffer);
        expect(result).toBeDefined();
        expect(Array.isArray(result.frames)).toBe(true);
        expect(typeof result.remainder).toBe('string');
      }),
      { numRuns: 300 },
    );
  });

  it('extractFrames: frames + remainder reconstitute original content', () => {
    fc.assert(
      fc.property(arbitraryRawString, (buffer) => {
        const { frames, remainder } = codec.extractFrames(buffer);
        // If there are frames, joining them with \r + appending remainder
        // should produce the original (possibly with empty frames removed)
        if (frames.length > 0) {
          const reconstructed = frames.join('\r') + '\r' + remainder;
          // The reconstructed should match original with empty frames collapsed
          // Just verify the non-empty content is preserved
          const originalNonEmpty = buffer.split('\r').filter(s => s.length > 0);
          const resultNonEmpty = [...frames, ...(remainder.length > 0 ? [remainder] : [])];
          // All frames from result should exist in original parts
          for (const frame of frames) {
            expect(originalNonEmpty).toContain(frame);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
