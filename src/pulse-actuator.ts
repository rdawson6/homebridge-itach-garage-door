/**
 * Pulse actuation logic for a single garage door relay.
 *
 * Encapsulates the momentary-contact pulse (setstate 1 → hold → setstate 0),
 * the state-0 release retry policy, the small FIFO actuation queue, and the
 * lockout that follows a failed relay release. This is deliberately free of any
 * Homebridge dependency so it can be unit-tested against a mock CommandClient.
 *
 * Requirements: 5.1–5.10.
 */

import type { CommandClient } from './command-client.js';
import { CommunicationError } from './command-client.js';
import { ProtocolCodec } from './protocol-codec.js';
import type { Logger } from './logger.js';

/** Maximum actuation requests held while a pulse is in progress. */
export const MAX_ACTUATION_QUEUE = 2;

/** Delay between a completed pulse and starting the next queued actuation. */
export const INTER_PULSE_DELAY_MS = 1000;

/** Number of retries for a failed state-0 (relay release) command. */
export const RELEASE_RETRIES = 3;

/** Interval between relay-release retries. */
export const RELEASE_RETRY_INTERVAL_MS = 500;

/** The target a pulse is intended to achieve. */
export type PulseTarget = 'OPEN' | 'CLOSED';

/** Outcome of a pulse. */
export interface PulseResult {
  target: PulseTarget;
  /** Measured hold interval in milliseconds (state-1 response → state-0 send). */
  holdMs: number;
}

interface QueuedActuation {
  target: PulseTarget;
  resolve: (result: PulseResult) => void;
  reject: (err: Error) => void;
}

/**
 * Drives relay pulses for one door. The caller supplies a callback that is
 * invoked whenever a pulse completes successfully, so the state machine can be
 * advanced (`pulseCompleted`).
 */
export class PulseActuator {
  private readonly client: CommandClient;
  private readonly codec: ProtocolCodec;
  private readonly log: Logger;
  private readonly module: number;
  private readonly connector: number;
  private readonly pulseDurationMs: number;
  private readonly relayLabel: string;
  private readonly setTimer: typeof setTimeout;

  private inProgress = false;
  private readonly queue: QueuedActuation[] = [];

  /**
   * True when a relay release has failed all retries. While locked out, no
   * further actuation is accepted until a successful state-0 clears it.
   */
  private lockedOut = false;

  /** True once the startup relay reset (setstate 0) has succeeded. */
  private ready = false;

  constructor(
    client: CommandClient,
    codec: ProtocolCodec,
    log: Logger,
    relay: string,
    pulseDurationMs: number,
    setTimer: typeof setTimeout = setTimeout,
  ) {
    this.client = client;
    this.codec = codec;
    this.log = log;
    this.pulseDurationMs = pulseDurationMs;
    this.relayLabel = relay;
    this.setTimer = setTimer;

    const [moduleStr, connectorStr] = relay.split(':');
    this.module = parseInt(moduleStr ?? '1', 10);
    this.connector = parseInt(connectorStr ?? '1', 10);
  }

  get isReady(): boolean {
    return this.ready;
  }

  get isLockedOut(): boolean {
    return this.lockedOut;
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  /**
   * Perform the startup relay reset: send setstate 0 before accepting any
   * actuation. On success the actuator becomes ready. On failure it stays
   * not-ready (the platform may retry on reconnect).
   */
  async reset(): Promise<boolean> {
    try {
      const response = await this.client.sendCommand(this.codec.encodeSetState(this.module, this.connector, 0));
      if (response.type === 'error') {
        this.log.warn(`Startup relay reset for ${this.relayLabel} returned error code ${response.code}`);
        return false;
      }
      this.ready = true;
      this.lockedOut = false;
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`Startup relay reset for ${this.relayLabel} failed: ${message}`);
      return false;
    }
  }

  /**
   * Request a pulse toward the given target. Returns a promise that resolves
   * when the pulse completes (state-0 confirmed) or rejects on communication
   * failure, queue overflow, or lockout.
   */
  actuate(target: PulseTarget): Promise<PulseResult> {
    return new Promise<PulseResult>((resolve, reject) => {
      if (this.lockedOut) {
        reject(new CommunicationError('Door is locked out after a failed relay release'));
        return;
      }

      if (this.inProgress) {
        if (this.queue.length >= MAX_ACTUATION_QUEUE) {
          reject(new CommunicationError('Actuation queue full'));
          return;
        }
        this.queue.push({ target, resolve, reject });
        return;
      }

      this.runPulse({ target, resolve, reject });
    });
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private runPulse(entry: QueuedActuation): void {
    this.inProgress = true;

    // Step 1: setstate 1
    void this.client
      .sendCommand(this.codec.encodeSetState(this.module, this.connector, 1))
      .then((response) => {
        if (response.type === 'error') {
          // State-1 error: abandon pulse, no state-0 sent, state unchanged.
          this.log.error(`Relay ${this.relayLabel} setstate 1 returned error code ${response.code}; pulse abandoned`);
          this.finishPulseFailure(entry, new CommunicationError('Relay engage failed'));
          return;
        }

        const engagedAt = Date.now();

        // Step 2: hold for the pulse duration, then send state-0.
        this.setTimer(() => {
          const holdMs = Date.now() - engagedAt;
          this.releaseRelay(entry, holdMs, 0);
        }, this.pulseDurationMs);
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new CommunicationError(String(err));
        this.log.error(`Relay ${this.relayLabel} setstate 1 failed: ${error.message}; pulse abandoned`);
        this.finishPulseFailure(entry, error);
      });
  }

  private releaseRelay(entry: QueuedActuation, holdMs: number, attempt: number): void {
    void this.client
      .sendCommand(this.codec.encodeSetState(this.module, this.connector, 0))
      .then((response) => {
        if (response.type === 'error') {
          this.handleReleaseFailure(entry, holdMs, attempt, `error code ${response.code}`);
          return;
        }
        // Success — pulse complete.
        this.ready = true;
        this.lockedOut = false;
        this.log.debug(`Relay ${this.relayLabel} pulse complete; hold interval ${holdMs}ms`);
        this.finishPulseSuccess(entry, { target: entry.target, holdMs });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.handleReleaseFailure(entry, holdMs, attempt, message);
      });
  }

  private handleReleaseFailure(entry: QueuedActuation, holdMs: number, attempt: number, reason: string): void {
    if (attempt < RELEASE_RETRIES) {
      const nextAttempt = attempt + 1;
      this.log.warn(`Relay ${this.relayLabel} release failed (${reason}); retry ${nextAttempt}/${RELEASE_RETRIES}`);
      this.setTimer(() => {
        this.releaseRelay(entry, holdMs, nextAttempt);
      }, RELEASE_RETRY_INTERVAL_MS);
      return;
    }

    // All retries exhausted → lockout.
    this.log.error(
      `Relay ${this.relayLabel} release failed after ${RELEASE_RETRIES} retries (${reason}); door locked out`,
    );
    this.lockedOut = true;
    this.finishPulseFailure(entry, new CommunicationError('Relay release failed; door locked out'), true);
  }

  private finishPulseSuccess(entry: QueuedActuation, result: PulseResult): void {
    entry.resolve(result);
    this.scheduleNext();
  }

  private finishPulseFailure(entry: QueuedActuation, err: Error, flushQueue = false): void {
    entry.reject(err);
    if (flushQueue) {
      // Discard every queued actuation for this door (Requirement 5.6).
      while (this.queue.length > 0) {
        const queued = this.queue.shift()!;
        queued.reject(new CommunicationError('Door locked out; queued actuation discarded'));
      }
      this.inProgress = false;
      return;
    }
    this.scheduleNext();
  }

  private scheduleNext(): void {
    const next = this.queue.shift();
    if (next === undefined) {
      this.inProgress = false;
      return;
    }
    // Keep inProgress true across the inter-pulse delay so new requests queue.
    this.setTimer(() => {
      this.runPulse(next);
    }, INTER_PULSE_DELAY_MS);
  }
}
