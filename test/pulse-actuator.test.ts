/**
 * Unit tests for PulseActuator using a mock CommandClient.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PulseActuator,
  RELEASE_RETRIES,
  RELEASE_RETRY_INTERVAL_MS,
  INTER_PULSE_DELAY_MS,
  MAX_ACTUATION_QUEUE,
} from '../src/pulse-actuator.js';
import { ProtocolCodec } from '../src/protocol-codec.js';
import { CommunicationError } from '../src/command-client.js';
import type { CommandClient } from '../src/command-client.js';
import type { Logger } from '../src/logger.js';
import type { Response } from '../src/types.js';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * A scriptable mock CommandClient. Each sendCommand call consults a queue of
 * programmed responses keyed by the encoded command. If none is programmed it
 * resolves with a matching setstate echo.
 */
class MockClient {
  sent: string[] = [];
  /** Responder invoked per command; return a Response or throw to reject. */
  responder: (command: string, callIndex: number) => Response | Promise<Response> = (cmd) => {
    // Default: echo setstate commands as success.
    const m = cmd.match(/^setstate,(\d+):(\d+),([01])$/);
    if (m) {
      return {
        type: 'setstate-echo',
        module: parseInt(m[1]!, 10),
        connector: parseInt(m[2]!, 10),
        value: parseInt(m[3]!, 10) as 0 | 1,
        raw: cmd,
      };
    }
    return { type: 'parse-error', raw: cmd };
  };

  private callCount = 0;

  sendCommand(command: string): Promise<Response> {
    this.sent.push(command);
    const idx = this.callCount++;
    return Promise.resolve().then(() => this.responder(command, idx));
  }
}

function makeActuator(client: MockClient, pulseMs = 500): PulseActuator {
  return new PulseActuator(
    client as unknown as CommandClient,
    new ProtocolCodec(),
    makeLogger(),
    '1:1',
    pulseMs,
  );
}

describe('PulseActuator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Startup reset ──────────────────────────────────────────────────────

  describe('reset', () => {
    it('sends setstate 0 and becomes ready on success', async () => {
      const client = new MockClient();
      const actuator = makeActuator(client);
      const ok = await actuator.reset();
      expect(ok).toBe(true);
      expect(actuator.isReady).toBe(true);
      expect(client.sent[0]).toBe('setstate,1:1,0');
    });

    it('stays not ready when reset returns an error', async () => {
      const client = new MockClient();
      client.responder = () => ({ type: 'error', code: '001', raw: 'ERR_001' });
      const actuator = makeActuator(client);
      const ok = await actuator.reset();
      expect(ok).toBe(false);
      expect(actuator.isReady).toBe(false);
    });
  });

  // ─── Pulse sequence timing ────────────────────────────────────────────────

  describe('pulse sequence', () => {
    it('sends setstate 1, holds for pulseDuration, then setstate 0', async () => {
      const client = new MockClient();
      const actuator = makeActuator(client, 500);

      const promise = actuator.actuate('OPEN');

      // Let the setstate 1 promise resolve
      await vi.advanceTimersByTimeAsync(0);
      expect(client.sent).toEqual(['setstate,1:1,1']);

      // Before the hold elapses, state 0 not yet sent
      await vi.advanceTimersByTimeAsync(499);
      expect(client.sent).toEqual(['setstate,1:1,1']);

      // After the hold, state 0 is sent
      await vi.advanceTimersByTimeAsync(1);
      expect(client.sent).toEqual(['setstate,1:1,1', 'setstate,1:1,0']);

      const result = await promise;
      expect(result.target).toBe('OPEN');
      expect(result.holdMs).toBeGreaterThanOrEqual(500);
    });

    it('measured hold interval is within pulseDuration .. pulseDuration+250ms', async () => {
      const client = new MockClient();
      const actuator = makeActuator(client, 500);
      const promise = actuator.actuate('CLOSED');
      await vi.advanceTimersByTimeAsync(500);
      const result = await promise;
      expect(result.holdMs).toBeGreaterThanOrEqual(500);
      expect(result.holdMs).toBeLessThanOrEqual(750);
    });
  });

  // ─── setstate 1 failure ───────────────────────────────────────────────────

  describe('setstate 1 failure', () => {
    it('abandons pulse without sending state 0 on state-1 error', async () => {
      const client = new MockClient();
      client.responder = (cmd) => {
        if (cmd === 'setstate,1:1,1') {
          return { type: 'error', code: '005', raw: 'ERR_005' };
        }
        return { type: 'setstate-echo', module: 1, connector: 1, value: 0, raw: cmd };
      };
      const actuator = makeActuator(client);
      const promise = actuator.actuate('OPEN');

      await expect(promise).rejects.toBeInstanceOf(CommunicationError);
      await vi.advanceTimersByTimeAsync(1000);
      // Only the state-1 attempt was sent; no state-0.
      expect(client.sent).toEqual(['setstate,1:1,1']);
    });

    it('rejects on state-1 network failure', async () => {
      const client = new MockClient();
      client.responder = (cmd) => {
        if (cmd === 'setstate,1:1,1') {
          throw new CommunicationError('timeout');
        }
        return { type: 'setstate-echo', module: 1, connector: 1, value: 0, raw: cmd };
      };
      const actuator = makeActuator(client);
      await expect(actuator.actuate('OPEN')).rejects.toBeInstanceOf(CommunicationError);
    });
  });

  // ─── Relay release retry ──────────────────────────────────────────────────

  describe('relay release retry', () => {
    it('retries state 0 up to 3 times then succeeds', async () => {
      const client = new MockClient();
      let releaseAttempts = 0;
      client.responder = (cmd) => {
        if (cmd === 'setstate,1:1,0') {
          releaseAttempts++;
          // Fail first 3, succeed on 4th
          if (releaseAttempts <= 3) {
            return { type: 'error', code: '002', raw: 'ERR_002' };
          }
        }
        return { type: 'setstate-echo', module: 1, connector: 1, value: cmd.endsWith(',1') ? 1 : 0, raw: cmd };
      };
      const actuator = makeActuator(client, 500);
      const promise = actuator.actuate('OPEN');

      // Advance through hold + 3 retries
      await vi.advanceTimersByTimeAsync(500); // hold → first release (fails)
      await vi.advanceTimersByTimeAsync(RELEASE_RETRY_INTERVAL_MS); // retry 1 (fails)
      await vi.advanceTimersByTimeAsync(RELEASE_RETRY_INTERVAL_MS); // retry 2 (fails)
      await vi.advanceTimersByTimeAsync(RELEASE_RETRY_INTERVAL_MS); // retry 3 (succeeds)

      const result = await promise;
      expect(result.target).toBe('OPEN');
      expect(releaseAttempts).toBe(4);
      expect(actuator.isLockedOut).toBe(false);
    });

    it('locks out after all retries fail', async () => {
      const client = new MockClient();
      client.responder = (cmd) => {
        if (cmd === 'setstate,1:1,0') {
          return { type: 'error', code: '002', raw: 'ERR_002' };
        }
        return { type: 'setstate-echo', module: 1, connector: 1, value: 1, raw: cmd };
      };
      const actuator = makeActuator(client, 500);
      // Attach the rejection handler up-front to avoid an unhandled rejection
      // while we drive the fake timers.
      let rejection: unknown;
      const promise = actuator.actuate('OPEN').catch((e) => { rejection = e; });

      await vi.advanceTimersByTimeAsync(500); // hold → release attempt 1
      for (let i = 0; i < RELEASE_RETRIES; i++) {
        await vi.advanceTimersByTimeAsync(RELEASE_RETRY_INTERVAL_MS);
      }

      await promise;
      expect(rejection).toBeInstanceOf(CommunicationError);
      expect(actuator.isLockedOut).toBe(true);
    });

    it('rejects further actuation while locked out', async () => {
      const client = new MockClient();
      client.responder = (cmd) => {
        if (cmd === 'setstate,1:1,0') {
          return { type: 'error', code: '002', raw: 'ERR_002' };
        }
        return { type: 'setstate-echo', module: 1, connector: 1, value: 1, raw: cmd };
      };
      const actuator = makeActuator(client, 500);
      const p1 = actuator.actuate('OPEN').catch((e) => e);
      await vi.advanceTimersByTimeAsync(500);
      for (let i = 0; i < RELEASE_RETRIES; i++) {
        await vi.advanceTimersByTimeAsync(RELEASE_RETRY_INTERVAL_MS);
      }
      await p1;
      expect(actuator.isLockedOut).toBe(true);

      // New actuation is rejected immediately
      await expect(actuator.actuate('CLOSED')).rejects.toBeInstanceOf(CommunicationError);
    });
  });

  // ─── Actuation queue ──────────────────────────────────────────────────────

  describe('actuation queue', () => {
    it('holds up to 2 requests while a pulse is in progress', async () => {
      const client = new MockClient();
      const actuator = makeActuator(client, 500);

      const p1 = actuator.actuate('OPEN');
      // While p1 is in progress, queue 2 more
      const p2 = actuator.actuate('CLOSED');
      const p3 = actuator.actuate('OPEN');
      expect(actuator.queueDepth).toBe(2);

      // A 3rd queued request (4th total) is rejected
      await expect(actuator.actuate('CLOSED')).rejects.toBeInstanceOf(CommunicationError);

      // Complete p1
      await vi.advanceTimersByTimeAsync(500);
      await p1;

      // After inter-pulse delay, p2 runs
      await vi.advanceTimersByTimeAsync(INTER_PULSE_DELAY_MS);
      await vi.advanceTimersByTimeAsync(500);
      await p2;

      await vi.advanceTimersByTimeAsync(INTER_PULSE_DELAY_MS);
      await vi.advanceTimersByTimeAsync(500);
      await p3;

      expect(actuator.queueDepth).toBe(0);
    });

    it('waits INTER_PULSE_DELAY_MS between queued pulses', async () => {
      const client = new MockClient();
      const actuator = makeActuator(client, 500);

      const p1 = actuator.actuate('OPEN');
      const p2 = actuator.actuate('CLOSED');

      await vi.advanceTimersByTimeAsync(500); // p1 completes
      await p1;
      const sentAfterP1 = client.sent.length;

      // Before the inter-pulse delay, p2 has not started
      await vi.advanceTimersByTimeAsync(INTER_PULSE_DELAY_MS - 1);
      expect(client.sent.length).toBe(sentAfterP1);

      // After the delay, p2 starts
      await vi.advanceTimersByTimeAsync(1);
      expect(client.sent.length).toBe(sentAfterP1 + 1);

      await vi.advanceTimersByTimeAsync(500);
      await p2;
    });

    it('MAX_ACTUATION_QUEUE constant is 2', () => {
      expect(MAX_ACTUATION_QUEUE).toBe(2);
    });
  });
});
