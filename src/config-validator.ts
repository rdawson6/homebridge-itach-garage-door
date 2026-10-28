/**
 * Configuration validator for the iTach Garage Door plugin.
 *
 * Validates and normalises the raw platform configuration into a list of
 * `ValidatedDoorEntry` values plus a list of human-readable validation errors
 * for logging. Invalid required fields cause a door to be skipped; invalid
 * optional fields fall back to defaults while preserving the rest of the entry.
 *
 * This module is pure (no I/O, no logging) so it can be property-tested in
 * isolation. The caller (platform) is responsible for emitting the returned
 * errors at error level.
 */

import { createHash } from 'crypto';
import type { MidTravelBehaviour, ValidatedDoorEntry } from './types.js';

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_PULSE_DURATION = 500;
export const DEFAULT_OPENING_TIME = 15;
export const DEFAULT_CLOSING_TIME = 15;
export const DEFAULT_PORT = 4998;
export const DEFAULT_MID_TRAVEL: MidTravelBehaviour = 'stop';
export const DEFAULT_WEBHOOK_BIND_ADDRESS = '0.0.0.0';

// ─── Ranges ──────────────────────────────────────────────────────────────────

const PULSE_MIN = 100;
const PULSE_MAX = 2000;
const TRAVEL_MIN = 1;
const TRAVEL_MAX = 120;
const PORT_MIN = 1;
const PORT_MAX = 65535;
const NAME_MAX = 64;
const DOOR_ID_MAX = 64;
const WEBHOOK_PORT_MIN = 1024;
const WEBHOOK_PORT_MAX = 65535;
const WEBHOOK_TOKEN_MIN = 20;
const WEBHOOK_TOKEN_MAX = 128;

const VALID_RELAYS: ReadonlySet<string> = new Set(['1:1', '1:2', '1:3']);
const DOOR_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// ─── Result Types ──────────────────────────────────────────────────────────

/** A validation error message for logging. */
export interface ValidationError {
  /** The array index of the offending Door_Entry, or undefined for webhook errors. */
  readonly index?: number;
  /** The offending field name. */
  readonly field: string;
  /** Human-readable description. */
  readonly message: string;
}

/** Validated webhook configuration. */
export interface ValidatedWebhookConfig {
  readonly port: number;
  readonly token: string;
  readonly bindAddress: string;
}

/** Full validation result. */
export interface ValidationResult {
  readonly doors: ValidatedDoorEntry[];
  readonly webhook: ValidatedWebhookConfig | null;
  readonly errors: ValidationError[];
}

// ─── Raw Config Shapes ───────────────────────────────────────────────────────

/** Raw (unvalidated) door entry as received from Homebridge config. */
export interface RawDoorEntry {
  name?: unknown;
  ipAddress?: unknown;
  relay?: unknown;
  port?: unknown;
  doorId?: unknown;
  pulseDuration?: unknown;
  openingTime?: unknown;
  closingTime?: unknown;
  midTravelBehaviour?: unknown;
}

/** Raw (unvalidated) webhook config. */
export interface RawWebhookConfig {
  port?: unknown;
  token?: unknown;
  bindAddress?: unknown;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Validate the full plugin configuration.
 *
 * @param rawDoors - The raw `doors` array from config (or undefined/empty).
 * @param rawWebhook - The raw `webhook` object from config (or undefined).
 */
export function validateConfig(
  rawDoors: readonly RawDoorEntry[] | undefined,
  rawWebhook?: RawWebhookConfig | undefined,
): ValidationResult {
  const errors: ValidationError[] = [];
  const doors: ValidatedDoorEntry[] = [];

  const entries = Array.isArray(rawDoors) ? rawDoors : [];

  // First pass: validate each entry independently.
  const candidates: Array<{ index: number; entry: ValidatedDoorEntry } | null> = entries.map(
    (raw, index) => validateDoorEntry(raw, index, errors),
  );

  // Second pass: detect duplicate doorId (first wins).
  const seenDoorIds = new Map<string, number>();
  // Third pass tracking: duplicate ip+relay (first wins).
  const seenRelayKeys = new Map<string, number>();

  for (const candidate of candidates) {
    if (candidate === null) {
      continue;
    }
    const { index, entry } = candidate;

    // Duplicate doorId check
    const firstDoorIdIndex = seenDoorIds.get(entry.doorId);
    if (firstDoorIdIndex !== undefined) {
      errors.push({
        index,
        field: 'doorId',
        message: `Door_Entry at index ${index} resolves to duplicate doorId "${entry.doorId}" (first defined at index ${firstDoorIdIndex}); this entry is skipped.`,
      });
      continue;
    }

    // Duplicate ip+relay check
    const relayKey = `${entry.ipAddress}:${entry.relay}`;
    const firstRelayIndex = seenRelayKeys.get(relayKey);
    if (firstRelayIndex !== undefined) {
      errors.push({
        index,
        field: 'relay',
        message: `Door_Entry at index ${index} duplicates ipAddress+relay "${relayKey}" (first defined at index ${firstRelayIndex}); this entry is skipped.`,
      });
      continue;
    }

    seenDoorIds.set(entry.doorId, index);
    seenRelayKeys.set(relayKey, index);
    doors.push(entry);
  }

  const webhook = rawWebhook !== undefined ? validateWebhookConfig(rawWebhook, errors) : null;

  return { doors, webhook, errors };
}

/**
 * Derive a deterministic seed string for a door's accessory UUID.
 * Depends only on ipAddress and relay, per Requirement 1.6.
 */
export function uuidSeed(ipAddress: string, relay: string): string {
  return `${ipAddress}:${relay}`;
}

/**
 * Derive a deterministic UUID from the seed. Produces an RFC-4122-shaped
 * v5-style UUID string (name-based SHA-1). This is used for testing and as a
 * fallback; in production the platform uses Homebridge's `api.hap.uuid`
 * against the same seed, which is also deterministic.
 */
export function deriveUuid(ipAddress: string, relay: string): string {
  const seed = uuidSeed(ipAddress, relay);
  const hash = createHash('sha1').update(seed).digest('hex');
  // Format the first 32 hex chars as a UUID (8-4-4-4-12).
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

// ─── Per-Entry Validation ────────────────────────────────────────────────────

function validateDoorEntry(
  raw: RawDoorEntry,
  index: number,
  errors: ValidationError[],
): { index: number; entry: ValidatedDoorEntry } | null {
  // --- Required: name ---
  const name = validateName(raw.name, index, errors);
  if (name === null) {
    return null;
  }

  // --- Required: ipAddress ---
  const ipAddress = validateIpAddress(raw.ipAddress, index, errors);
  if (ipAddress === null) {
    return null;
  }

  // --- Required: relay ---
  const relay = validateRelay(raw.relay, index, errors);
  if (relay === null) {
    return null;
  }

  // --- Required (with default index): doorId ---
  const doorId = validateDoorId(raw.doorId, index, errors);
  if (doorId === null) {
    return null;
  }

  // --- Optional numeric fields (fall back to default on invalid) ---
  const pulseDuration = validateIntRange(
    raw.pulseDuration,
    PULSE_MIN,
    PULSE_MAX,
    DEFAULT_PULSE_DURATION,
    'pulseDuration',
    index,
    errors,
  );

  const openingTime = validateIntRange(
    raw.openingTime,
    TRAVEL_MIN,
    TRAVEL_MAX,
    DEFAULT_OPENING_TIME,
    'openingTime',
    index,
    errors,
  );

  const closingTime = validateIntRange(
    raw.closingTime,
    TRAVEL_MIN,
    TRAVEL_MAX,
    DEFAULT_CLOSING_TIME,
    'closingTime',
    index,
    errors,
  );

  const port = validateIntRange(
    raw.port,
    PORT_MIN,
    PORT_MAX,
    DEFAULT_PORT,
    'port',
    index,
    errors,
  );

  const midTravelBehaviour = validateMidTravel(raw.midTravelBehaviour, index, errors);

  const entry: ValidatedDoorEntry = {
    name,
    ipAddress,
    relay,
    port,
    doorId,
    pulseDuration,
    openingTime,
    closingTime,
    midTravelBehaviour,
  };

  return { index, entry };
}

function validateName(value: unknown, index: number, errors: ValidationError[]): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push({
      index,
      field: 'name',
      message: `Door_Entry at index ${index} has a missing, empty, or whitespace-only name; accessory skipped.`,
    });
    return null;
  }
  // Truncate to 64 chars (Requirement 1.8)
  return value.length > NAME_MAX ? value.slice(0, NAME_MAX) : value;
}

function validateIpAddress(value: unknown, index: number, errors: ValidationError[]): string | null {
  if (typeof value !== 'string' || value.trim().length === 0 || !isValidIpv4(value)) {
    errors.push({
      index,
      field: 'ipAddress',
      message: `Door_Entry at index ${index} has a missing or malformed IPv4 ipAddress; accessory skipped.`,
    });
    return null;
  }
  return value;
}

function validateRelay(value: unknown, index: number, errors: ValidationError[]): string | null {
  if (typeof value !== 'string' || !VALID_RELAYS.has(value)) {
    errors.push({
      index,
      field: 'relay',
      message: `Door_Entry at index ${index} has relay "${String(value)}" outside the permitted set {1:1, 1:2, 1:3}; accessory skipped.`,
    });
    return null;
  }
  return value;
}

function validateDoorId(value: unknown, index: number, errors: ValidationError[]): string | null {
  // Absent → default to the array index expressed in decimal
  if (value === undefined || value === null) {
    return String(index);
  }

  if (typeof value !== 'string' || !DOOR_ID_PATTERN.test(value) || value.length > DOOR_ID_MAX) {
    errors.push({
      index,
      field: 'doorId',
      message: `Door_Entry at index ${index} has an invalid doorId (must be 1–64 chars of [a-z0-9-]); accessory skipped.`,
    });
    return null;
  }
  return value;
}

function validateIntRange(
  value: unknown,
  min: number,
  max: number,
  defaultValue: number,
  field: string,
  index: number,
  errors: ValidationError[],
): number {
  // Absent → use default silently
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    errors.push({
      index,
      field,
      message: `Door_Entry at index ${index} has ${field}=${String(value)} outside the range ${min}–${max}; using default ${defaultValue}.`,
    });
    return defaultValue;
  }
  return value;
}

function validateMidTravel(value: unknown, index: number, errors: ValidationError[]): MidTravelBehaviour {
  if (value === undefined || value === null) {
    return DEFAULT_MID_TRAVEL;
  }
  if (value === 'stop' || value === 'reverse') {
    return value;
  }
  errors.push({
    index,
    field: 'midTravelBehaviour',
    message: `Door_Entry at index ${index} has midTravelBehaviour="${String(value)}" outside {stop, reverse}; using default "${DEFAULT_MID_TRAVEL}".`,
  });
  return DEFAULT_MID_TRAVEL;
}

// ─── Webhook Validation ──────────────────────────────────────────────────────

function validateWebhookConfig(
  raw: RawWebhookConfig,
  errors: ValidationError[],
): ValidatedWebhookConfig | null {
  // If no port is configured, the webhook is simply disabled (not an error).
  if (raw.port === undefined || raw.port === null) {
    return null;
  }

  let valid = true;

  // Port: integer 1024–65535
  const port = raw.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < WEBHOOK_PORT_MIN || port > WEBHOOK_PORT_MAX) {
    errors.push({
      field: 'webhook.port',
      message: `Webhook port "${String(port)}" must be an integer in the range ${WEBHOOK_PORT_MIN}–${WEBHOOK_PORT_MAX}; webhook disabled.`,
    });
    valid = false;
  }

  // Token: 20–128 printable chars, no leading/trailing whitespace
  const token = raw.token;
  if (
    typeof token !== 'string' ||
    token.length < WEBHOOK_TOKEN_MIN ||
    token.length > WEBHOOK_TOKEN_MAX ||
    token !== token.trim() ||
    !isPrintableAscii(token)
  ) {
    errors.push({
      field: 'webhook.token',
      message: `Webhook token must be ${WEBHOOK_TOKEN_MIN}–${WEBHOOK_TOKEN_MAX} printable characters with no leading/trailing whitespace; webhook disabled.`,
    });
    valid = false;
  }

  // Bind address: dotted-quad IPv4, default 0.0.0.0
  let bindAddress = DEFAULT_WEBHOOK_BIND_ADDRESS;
  if (raw.bindAddress !== undefined && raw.bindAddress !== null) {
    if (typeof raw.bindAddress !== 'string' || !isValidIpv4(raw.bindAddress)) {
      errors.push({
        field: 'webhook.bindAddress',
        message: `Webhook bindAddress "${String(raw.bindAddress)}" is not a valid dotted-quad IPv4 address; webhook disabled.`,
      });
      valid = false;
    } else {
      bindAddress = raw.bindAddress;
    }
  }

  if (!valid) {
    return null;
  }

  return {
    port: port as number,
    token: token as string,
    bindAddress,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Validate a dotted-quad IPv4 address: four octets, each 0–255. */
export function isValidIpv4(value: string): boolean {
  const match = IPV4_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  for (let i = 1; i <= 4; i++) {
    const octetStr = match[i]!;
    // Reject leading zeros beyond a single "0" (e.g., "01") to be strict? The
    // requirement only specifies four decimal octets each 0–255. Accept any
    // decimal digits that fall in range.
    const octet = parseInt(octetStr, 10);
    if (octet < 0 || octet > 255) {
      return false;
    }
  }
  return true;
}

/** Check whether every character is printable ASCII (0x20–0x7e). */
function isPrintableAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}
