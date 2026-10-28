/**
 * Protocol codec for the Global Caché iTach IP2CC Unified TCP/IP API.
 *
 * Encodes commands to wire format (without the `\r` terminator — the
 * CommandClient appends that before sending) and parses response strings
 * into typed result values.
 *
 * Protocol quirks handled:
 * - Responses arrive concatenated, delimited by `\r`
 * - `setstate` commands echo the command name back (e.g., `setstate,1:1,1`)
 * - `getdevices` response is a multi-part block ending with `endlistdevices`
 * - Error responses start with `ERR` followed by `_` or space then digits
 */

import type {
  Response,
  StateResponse,
  SetStateEcho,
  ErrorResponse,
  DevicesResponse,
  ParseError,
} from './types.js';

const MAX_RAW_LENGTH = 256;

/**
 * Truncate a raw response string to the maximum allowed length for ParseError results.
 */
function truncateRaw(raw: string): string {
  return raw.length > MAX_RAW_LENGTH ? raw.slice(0, MAX_RAW_LENGTH) : raw;
}

export class ProtocolCodec {
  // ─── Encoding ────────────────────────────────────────────────────────────────

  /**
   * Encode a setstate command. Returns the command string without a `\r` terminator.
   */
  encodeSetState(module: number, connector: number, state: 0 | 1): string {
    return `setstate,${module}:${connector},${state}`;
  }

  /**
   * Encode a getstate command. Returns the command string without a `\r` terminator.
   */
  encodeGetState(module: number, connector: number): string {
    return `getstate,${module}:${connector}`;
  }

  /**
   * Encode a getdevices command. Returns the command string without a `\r` terminator.
   */
  encodeGetDevices(): string {
    return 'getdevices';
  }

  // ─── Parsing ─────────────────────────────────────────────────────────────────

  /**
   * Parse a single response frame (already split on `\r`) into a typed result.
   * Never throws — returns a ParseError for unrecognised formats.
   */
  parseResponse(raw: string): Response {
    try {
      // Strip any trailing \r or \n that might remain from frame splitting
      const trimmed = raw.replace(/[\r\n]+$/, '');

      // State response: state,M:C,V
      const stateMatch = trimmed.match(/^state,(\d{1,3}):(\d{1,3}),([01])$/);
      if (stateMatch) {
        return {
          type: 'state',
          module: parseInt(stateMatch[1]!, 10),
          connector: parseInt(stateMatch[2]!, 10),
          value: parseInt(stateMatch[3]!, 10) as 0 | 1,
          raw,
        } satisfies StateResponse;
      }

      // SetState echo: setstate,M:C,V
      const setStateMatch = trimmed.match(/^setstate,(\d{1,3}):(\d{1,3}),([01])$/);
      if (setStateMatch) {
        return {
          type: 'setstate-echo',
          module: parseInt(setStateMatch[1]!, 10),
          connector: parseInt(setStateMatch[2]!, 10),
          value: parseInt(setStateMatch[3]!, 10) as 0 | 1,
          raw,
        } satisfies SetStateEcho;
      }

      // Error response: ERR followed by _ or space then digit code
      if (trimmed.startsWith('ERR')) {
        // Extract digit sequences from the remainder after ERR
        const remainder = trimmed.slice(3);
        const digitMatch = remainder.match(/(\d+)/);
        if (digitMatch) {
          return {
            type: 'error',
            code: digitMatch[1]!,
            raw,
          } satisfies ErrorResponse;
        }
        // ERR with no digits → ParseError
        return {
          type: 'parse-error',
          raw: truncateRaw(raw),
        } satisfies ParseError;
      }

      // Getdevices response: starts with "device," and we parse module info
      // The full getdevices response is a multi-part block. Individual frames
      // may be "device,M,C <TYPE>" or "endlistdevices". We handle the case
      // where the entire concatenated response is passed as one frame.
      if (trimmed.startsWith('device,') || trimmed === 'endlistdevices') {
        return this.parseDevicesResponse(trimmed, raw);
      }

      // Unknown format
      return {
        type: 'parse-error',
        raw: truncateRaw(raw),
      } satisfies ParseError;
    } catch {
      // Safety net — parseResponse must never throw
      return {
        type: 'parse-error',
        raw: truncateRaw(raw),
      } satisfies ParseError;
    }
  }

  /**
   * Parse a getdevices response. The response may be a single "device,..." line
   * or the full multi-part block (lines separated by \r already stripped into
   * a single string by the caller — but we also handle the case where the full
   * block is passed as-is with embedded separators).
   */
  private parseDevicesResponse(trimmed: string, raw: string): DevicesResponse | ParseError {
    // If it's just "endlistdevices", return empty devices list
    if (trimmed === 'endlistdevices') {
      return {
        type: 'devices',
        modules: [],
        raw,
      } satisfies DevicesResponse;
    }

    // Parse individual device lines. Format observed:
    // "device,<module>,<connectors> <TYPE>"
    // Example: "device,1,3 RELAY"
    const modules: Array<{ module: number; type: string; connectors: number }> = [];

    // The trimmed string might contain multiple device entries separated by
    // some delimiter if the full block was passed. Split on common separators.
    const lines = trimmed.split(/[\r\n]+/).filter(line => line.length > 0);

    for (const line of lines) {
      if (line === 'endlistdevices') {
        continue;
      }

      // Match: device,<module>,<connectors> <TYPE>
      const deviceMatch = line.match(/^device,(\d+),(\d+)\s+(.+)$/);
      if (deviceMatch) {
        modules.push({
          module: parseInt(deviceMatch[1]!, 10),
          type: deviceMatch[3]!.trim(),
          connectors: parseInt(deviceMatch[2]!, 10),
        });
      }
      // Lines that don't match device format but aren't endlistdevices
      // are silently skipped (e.g., the ETHERNET line at the start)
    }

    return {
      type: 'devices',
      modules,
      raw,
    } satisfies DevicesResponse;
  }

  // ─── Stream Splitting ────────────────────────────────────────────────────────

  /**
   * Extract complete frames from an accumulated buffer.
   * Frames are delimited by `\r`. Returns all complete frames and the
   * remaining incomplete data (after the last `\r`).
   */
  extractFrames(buffer: string): { frames: string[]; remainder: string } {
    const lastCR = buffer.lastIndexOf('\r');

    if (lastCR === -1) {
      // No complete frame yet
      return { frames: [], remainder: buffer };
    }

    const complete = buffer.slice(0, lastCR);
    const remainder = buffer.slice(lastCR + 1);

    // Split on \r to get individual frames, filter out empty strings
    const frames = complete.split('\r').filter(frame => frame.length > 0);

    return { frames, remainder };
  }
}
