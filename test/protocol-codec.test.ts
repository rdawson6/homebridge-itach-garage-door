import { describe, it, expect } from 'vitest';
import { ProtocolCodec } from '../src/protocol-codec.js';

describe('ProtocolCodec', () => {
  const codec = new ProtocolCodec();

  // ─── Encoding ──────────────────────────────────────────────────────────────

  describe('encodeSetState', () => {
    it('produces correct format for state 1', () => {
      expect(codec.encodeSetState(1, 1, 1)).toBe('setstate,1:1,1');
    });

    it('produces correct format for state 0', () => {
      expect(codec.encodeSetState(1, 2, 0)).toBe('setstate,1:2,0');
    });

    it('produces correct format for connector 3', () => {
      expect(codec.encodeSetState(1, 3, 1)).toBe('setstate,1:3,1');
    });

    it('contains no whitespace or line terminators', () => {
      const cmd = codec.encodeSetState(1, 1, 1);
      expect(cmd).not.toMatch(/\s/);
      expect(cmd).not.toContain('\r');
      expect(cmd).not.toContain('\n');
    });
  });

  describe('encodeGetState', () => {
    it('produces correct format', () => {
      expect(codec.encodeGetState(1, 1)).toBe('getstate,1:1');
    });

    it('handles different connectors', () => {
      expect(codec.encodeGetState(1, 2)).toBe('getstate,1:2');
      expect(codec.encodeGetState(1, 3)).toBe('getstate,1:3');
    });

    it('contains no whitespace or line terminators', () => {
      const cmd = codec.encodeGetState(1, 1);
      expect(cmd).not.toMatch(/\s/);
      expect(cmd).not.toContain('\r');
      expect(cmd).not.toContain('\n');
    });
  });

  describe('encodeGetDevices', () => {
    it('produces "getdevices"', () => {
      expect(codec.encodeGetDevices()).toBe('getdevices');
    });

    it('contains no whitespace or line terminators', () => {
      const cmd = codec.encodeGetDevices();
      expect(cmd).not.toMatch(/\s/);
      expect(cmd).not.toContain('\r');
      expect(cmd).not.toContain('\n');
    });
  });

  // ─── parseResponse ─────────────────────────────────────────────────────────

  describe('parseResponse — state responses', () => {
    it('parses state,1:1,0', () => {
      const result = codec.parseResponse('state,1:1,0');
      expect(result).toEqual({
        type: 'state',
        module: 1,
        connector: 1,
        value: 0,
        raw: 'state,1:1,0',
      });
    });

    it('parses state,1:2,1', () => {
      const result = codec.parseResponse('state,1:2,1');
      expect(result).toEqual({
        type: 'state',
        module: 1,
        connector: 2,
        value: 1,
        raw: 'state,1:2,1',
      });
    });

    it('parses state with trailing \\r', () => {
      const result = codec.parseResponse('state,1:3,1\r');
      expect(result).toEqual({
        type: 'state',
        module: 1,
        connector: 3,
        value: 1,
        raw: 'state,1:3,1\r',
      });
    });
  });

  describe('parseResponse — setstate echo', () => {
    it('parses setstate echo as setstate-echo type', () => {
      const result = codec.parseResponse('setstate,1:1,1');
      expect(result).toEqual({
        type: 'setstate-echo',
        module: 1,
        connector: 1,
        value: 1,
        raw: 'setstate,1:1,1',
      });
    });

    it('parses setstate echo for state 0', () => {
      const result = codec.parseResponse('setstate,1:2,0');
      expect(result).toEqual({
        type: 'setstate-echo',
        module: 1,
        connector: 2,
        value: 0,
        raw: 'setstate,1:2,0',
      });
    });
  });

  describe('parseResponse — error responses', () => {
    it('parses ERR_001', () => {
      const result = codec.parseResponse('ERR_001');
      expect(result).toEqual({
        type: 'error',
        code: '001',
        raw: 'ERR_001',
      });
    });

    it('parses ERR 001', () => {
      const result = codec.parseResponse('ERR 001');
      expect(result).toEqual({
        type: 'error',
        code: '001',
        raw: 'ERR 001',
      });
    });

    it('parses ERR_12345678 (8-digit code)', () => {
      const result = codec.parseResponse('ERR_12345678');
      expect(result).toEqual({
        type: 'error',
        code: '12345678',
        raw: 'ERR_12345678',
      });
    });

    it('returns ParseError for ERR with no digits', () => {
      const result = codec.parseResponse('ERR_abc');
      expect(result).toEqual({
        type: 'parse-error',
        raw: 'ERR_abc',
      });
    });

    it('returns ParseError for bare ERR', () => {
      const result = codec.parseResponse('ERR');
      expect(result).toEqual({
        type: 'parse-error',
        raw: 'ERR',
      });
    });
  });

  describe('parseResponse — getdevices responses', () => {
    it('parses a single device line', () => {
      const result = codec.parseResponse('device,1,3 RELAY');
      expect(result).toEqual({
        type: 'devices',
        modules: [{ module: 1, type: 'RELAY', connectors: 3 }],
        raw: 'device,1,3 RELAY',
      });
    });

    it('parses endlistdevices as empty devices', () => {
      const result = codec.parseResponse('endlistdevices');
      expect(result).toEqual({
        type: 'devices',
        modules: [],
        raw: 'endlistdevices',
      });
    });

    it('parses device with ETHERNET type', () => {
      const result = codec.parseResponse('device,0,0 ETHERNET');
      expect(result).toEqual({
        type: 'devices',
        modules: [{ module: 0, type: 'ETHERNET', connectors: 0 }],
        raw: 'device,0,0 ETHERNET',
      });
    });
  });

  describe('parseResponse — ParseError', () => {
    it('returns ParseError for empty string', () => {
      const result = codec.parseResponse('');
      expect(result).toEqual({
        type: 'parse-error',
        raw: '',
      });
    });

    it('returns ParseError for unknown format', () => {
      const result = codec.parseResponse('hello world');
      expect(result).toEqual({
        type: 'parse-error',
        raw: 'hello world',
      });
    });

    it('truncates raw to 256 chars in ParseError', () => {
      const longString = 'x'.repeat(300);
      const result = codec.parseResponse(longString);
      expect(result.type).toBe('parse-error');
      if (result.type === 'parse-error') {
        expect(result.raw.length).toBe(256);
      }
    });

    it('does not truncate raw when exactly 256 chars', () => {
      const str = 'y'.repeat(256);
      const result = codec.parseResponse(str);
      expect(result.type).toBe('parse-error');
      if (result.type === 'parse-error') {
        expect(result.raw.length).toBe(256);
        expect(result.raw).toBe(str);
      }
    });

    it('never throws for any input', () => {
      const inputs = ['', '\r', '\n', '\r\n', 'state,', 'setstate,', 'ERR', 'device,'];
      for (const input of inputs) {
        expect(() => codec.parseResponse(input)).not.toThrow();
      }
    });
  });

  // ─── extractFrames ─────────────────────────────────────────────────────────

  describe('extractFrames', () => {
    it('returns empty frames when no \\r present', () => {
      const result = codec.extractFrames('partial data');
      expect(result).toEqual({ frames: [], remainder: 'partial data' });
    });

    it('extracts a single complete frame', () => {
      const result = codec.extractFrames('state,1:1,0\r');
      expect(result).toEqual({ frames: ['state,1:1,0'], remainder: '' });
    });

    it('extracts multiple frames', () => {
      const result = codec.extractFrames('state,1:1,0\rstate,1:2,1\r');
      expect(result).toEqual({
        frames: ['state,1:1,0', 'state,1:2,1'],
        remainder: '',
      });
    });

    it('preserves remainder after last complete frame', () => {
      const result = codec.extractFrames('state,1:1,0\rpartial');
      expect(result).toEqual({
        frames: ['state,1:1,0'],
        remainder: 'partial',
      });
    });

    it('handles multiple frames with remainder', () => {
      const result = codec.extractFrames('frame1\rframe2\rincomplete');
      expect(result).toEqual({
        frames: ['frame1', 'frame2'],
        remainder: 'incomplete',
      });
    });

    it('handles empty buffer', () => {
      const result = codec.extractFrames('');
      expect(result).toEqual({ frames: [], remainder: '' });
    });

    it('filters out empty frames from consecutive \\r', () => {
      const result = codec.extractFrames('frame1\r\rframe2\r');
      expect(result).toEqual({
        frames: ['frame1', 'frame2'],
        remainder: '',
      });
    });
  });

  // ─── Round-trip: encode then parse ─────────────────────────────────────────

  describe('round-trip encoding then parsing', () => {
    it('encodeSetState → parseResponse yields setstate-echo', () => {
      const encoded = codec.encodeSetState(1, 1, 1);
      const parsed = codec.parseResponse(encoded);
      expect(parsed).toEqual({
        type: 'setstate-echo',
        module: 1,
        connector: 1,
        value: 1,
        raw: encoded,
      });
    });

    it('encodeGetState → simulated state response parses correctly', () => {
      // getstate produces a "state,M:C,V" response from the device
      const response = 'state,1:2,0';
      const parsed = codec.parseResponse(response);
      expect(parsed).toEqual({
        type: 'state',
        module: 1,
        connector: 2,
        value: 0,
        raw: response,
      });
    });
  });
});
