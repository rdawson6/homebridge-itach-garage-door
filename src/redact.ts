/**
 * Token redaction for log output.
 *
 * Requirement 13.5: every occurrence of the configured webhook token in a log
 * entry must be replaced with a fixed placeholder that shares no substring of
 * 4 or more consecutive characters with the token.
 *
 * We also redact any 4+ character contiguous substring of the token so that
 * partial leaks (a truncated token inside an error message, for example) are
 * caught too.
 *
 * Implementation note: a naive approach enumerates every token substring, which
 * is O(tokenLength^2) patterns and far too slow for long tokens. Instead we scan
 * the text once, and at each position find the longest run that also appears
 * contiguously in the token. Runs of 4+ characters are replaced; shorter runs
 * are emitted unchanged.
 */

export const REDACTION_PLACEHOLDER = '[REDACTED]';

/** Minimum contiguous token substring length to redact. */
const MIN_SUBSTRING = 4;

/**
 * Replace the token, and any 4+ character contiguous substring of it, with the
 * placeholder.
 *
 * @param text - The log text to sanitise.
 * @param token - The secret webhook token.
 */
export function redactToken(text: string, token: string): string {
  if (token.length === 0 || text.length === 0) {
    return text;
  }

  // Tokens shorter than the substring threshold can only be redacted in full.
  if (token.length < MIN_SUBSTRING) {
    return text.split(token).join(REDACTION_PLACEHOLDER);
  }

  // Replacing a run with the placeholder can, in rare cases, fuse placeholder
  // characters with neighbouring text into a new token fragment. Re-run the
  // scan until the result is free of fragments (bounded, converges quickly).
  let result = text;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    if (!mightContainTokenFragment(result, token)) {
      break;
    }
    const next = redactOnce(result, token);
    if (next === result) {
      break;
    }
    result = next;
  }

  return result;
}

/** Maximum redaction passes; guards against pathological inputs. */
const MAX_PASSES = 5;

/** One left-to-right greedy redaction pass. */
function redactOnce(text: string, token: string): string {
  let out = '';
  let i = 0;

  while (i < text.length) {
    const runLength = longestTokenRunAt(text, i, token);

    if (runLength >= MIN_SUBSTRING) {
      out += REDACTION_PLACEHOLDER;
      i += runLength;
    } else {
      out += text[i];
      i += 1;
    }
  }

  return out;
}

/**
 * Length of the longest substring starting at `text[start]` that also occurs
 * contiguously somewhere in `token`. Capped at the remaining text length.
 */
function longestTokenRunAt(text: string, start: number, token: string): number {
  let best = 0;
  const maxPossible = Math.min(token.length, text.length - start);

  // Grow the candidate while it still occurs in the token. Growth is monotone:
  // if a window of length n is absent, every longer window is absent too.
  for (let len = 1; len <= maxPossible; len++) {
    const candidate = text.slice(start, start + len);
    if (token.includes(candidate)) {
      best = len;
    } else {
      break;
    }
  }

  return best;
}

/** Cheap pre-check: does any MIN_SUBSTRING window of the text occur in the token? */
function mightContainTokenFragment(text: string, token: string): boolean {
  if (token.length < MIN_SUBSTRING) {
    // Short tokens can only be redacted in full.
    return text.includes(token);
  }
  for (let i = 0; i + MIN_SUBSTRING <= text.length; i++) {
    if (token.includes(text.slice(i, i + MIN_SUBSTRING))) {
      return true;
    }
  }
  return false;
}
