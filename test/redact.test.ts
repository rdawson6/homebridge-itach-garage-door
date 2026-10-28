/**
 * Tests for token redaction in log output (Requirements 13.5, 13.8).
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { redactToken, REDACTION_PLACEHOLDER } from '../src/redact.js';

describe('redactToken', () => {
  const TOKEN = 'super-secret-token-abcdef123456';

  // ─── Basic behaviour ────────────────────────────────────────────────────

  it('replaces the full token with the placeholder', () => {
    const out = redactToken(`auth failed for ${TOKEN}`, TOKEN);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it('replaces every occurrence of the token', () => {
    const out = redactToken(`${TOKEN} and again ${TOKEN}`, TOKEN);
    expect(out).not.toContain(TOKEN);
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it('leaves unrelated text unchanged', () => {
    const out = redactToken('nothing sensitive here', TOKEN);
    expect(out).toBe('nothing sensitive here');
  });

  it('handles an empty token', () => {
    expect(redactToken('some text', '')).toBe('some text');
  });

  it('handles empty text', () => {
    expect(redactToken('', TOKEN)).toBe('');
  });

  // ─── Partial leak redaction ──────────────────────────────────────────────

  it('redacts a 4+ character contiguous substring of the token', () => {
    // A truncated token fragment should still be caught.
    const fragment = TOKEN.slice(0, 12);
    const out = redactToken(`partial leak: ${fragment}`, TOKEN);
    expect(out).not.toContain(fragment);
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it('redacts a substring taken from the middle of the token', () => {
    const fragment = TOKEN.slice(8, 20);
    const out = redactToken(`middle: ${fragment}`, TOKEN);
    expect(out).not.toContain(fragment);
  });

  // ─── Placeholder safety ─────────────────────────────────────────────────

  it('placeholder shares no 4+ character substring with a realistic token', () => {
    expect(sharesSubstring(REDACTION_PLACEHOLDER, TOKEN, 4)).toBe(false);
  });

  it('placeholder is 1 to 16 characters', () => {
    expect(REDACTION_PLACEHOLDER.length).toBeGreaterThanOrEqual(1);
    expect(REDACTION_PLACEHOLDER.length).toBeLessThanOrEqual(16);
  });

  // ─── Property: token never survives redaction ───────────────────────────

  describe('property: no 4+ char token substring survives', () => {
    // Tokens as the config validator accepts them: 20–128 printable ASCII
    // characters with no leading/trailing whitespace. This matches how users
    // actually generate tokens (e.g. `openssl rand -hex 32`).
    const tokenChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~'.split('');
    const tokenArb = fc.stringOf(fc.constantFrom(...tokenChars), {
      minLength: 20,
      maxLength: 128,
    });

    it('output contains no 4+ character contiguous substring of the token', () => {
      fc.assert(
        fc.property(tokenArb, fc.string({ maxLength: 120 }), (token, surrounding) => {
          const text = `${surrounding} ${token} ${surrounding}`;
          const out = redactToken(text, token);
          expect(sharesSubstring(out, token, 4)).toBe(false);
        }),
        { numRuns: 150 },
      );
    });

    it('output never contains the whole token', () => {
      fc.assert(
        fc.property(tokenArb, (token) => {
          const out = redactToken(`token=${token}`, token);
          expect(out).not.toContain(token);
        }),
        { numRuns: 200 },
      );
    });

    it('redacting text that does not contain the token is a no-op', () => {
      fc.assert(
        fc.property(
          fc.stringOf(fc.constantFrom(...'THEQUICKBROWNFX '.split('')), { minLength: 1, maxLength: 60 }),
          (text) => {
            // A token made of characters absent from the text above.
            const token = '0123456789abcdefghij';
            expect(redactToken(text, token)).toBe(text);
          },
        ),
        { numRuns: 150 },
      );
    });
  });
});

/** Whether `text` contains any contiguous substring of `token` of length >= minLen. */
function sharesSubstring(text: string, token: string, minLen: number): boolean {
  for (let len = token.length; len >= minLen; len--) {
    for (let start = 0; start + len <= token.length; start++) {
      if (text.includes(token.slice(start, start + len))) {
        return true;
      }
    }
  }
  return false;
}
