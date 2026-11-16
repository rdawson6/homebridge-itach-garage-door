/**
 * Integration tests for a pulse requested while the IP2CC connection is down.
 *
 * These wire a real CommandClient (over a synthetic socket) to a real
 * PulseActuator, which is the closest reproduction of the production failure:
 *
 *   [16/11/2026, 10:02:29] Relay 1:2 setstate 1 failed: Connection closed; pulse abandoned
 *   [16/11/2026, 10:02:29] Door "Gates" (CLOSED) pulse failed: Connection closed
 *   [16/11/2026, 10:02:30] 192.168.4.235:4998 devices: ...
 *
 * The relays are wired to a real garage door and real gates, so the invariant
 * these tests exist to protect is that `setstate <relay>,1` reaches a socket at
 * most once per actuation request. A second write would be a second press of
 * the opener button.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CommandClient,
  CommunicationError,
  RECONNECT_HOLD_MS,
  type SocketLike,
} from '../src/command-client.js';
import { PulseActuator } from '../src/pulse-actuator.js';
import { ProtocolCodec } from '../src/protocol-codec.js';
import type { Logger } from '../src/logger.js';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

type Listener = (...args: never[]) => void;

class MockSocket implements SocketLike {
  writes: string[] = [];
  destroyed = false;
  private listeners: Record<string, Listener[]> = {};

  connect(): void {
    // Established explicitly by the test via emitConnect().
  }
  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  on(event: string, listener: Listener): this {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }
  removeAllListeners(): this {
    this.listeners = {};
    return this;
  }

  emitConnect(): void {
    (this.listeners['connect'] ?? []).forEach((l) => (l as () => void)());
  }
  emitData(data: string): void {
    (this.listeners['data'] ?? []).forEach((l) => (l as (b: Buffer) => void)(Buffer.from(data, 'utf8')));
  }
  emitClose(): void {
    (this.listeners['close'] ?? []).forEach((l) => (l as () => void)());
  }
}

describe('pulse across an IP2CC reconnect', () => {
  let codec: ProtocolCodec;
  let log: Logger;
  let sockets: MockSocket[];
  let client: CommandClient;
  let actuator: PulseActuator;

  beforeEach(() => {
    vi.useFakeTimers();
    codec = new ProtocolCodec();
    log = makeLogger();
    sockets = [];
    client = new CommandClient('192.168.4.235', 4998, codec, log, () => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    });
    actuator = new PulseActuator(client, codec, log, '1:1', 500);
  });

  afterEach(async () => {
    await client.disconnect();
    vi.useRealTimers();
  });

  const current = () => sockets[sockets.length - 1]!;
  const allWrites = () => sockets.flatMap((s) => s.writes);
  const writeCount = (data: string) => allWrites().filter((w) => w === data).length;

  const DEVICES = 'device,0,0 ETHERNET\rdevice,1,3 RELAY\rendlistdevices\r';

  /** Connect, answer getdevices, then have the device drop the session. */
  function connectThenDrop(): void {
    void client.connect();
    current().emitConnect();
    current().emitData(DEVICES);
    current().emitClose();
  }

  it('completes a pulse requested while the connection is down and recovering', async () => {
    connectThenDrop();
    expect(client.isConnected).toBe(false);

    // The tap that used to be burned.
    const promise = actuator.actuate('OPEN');
    await vi.advanceTimersByTimeAsync(0);

    // The immediate connect attempt is refused.
    current().emitClose();
    expect(writeCount('setstate,1:1,1\r')).toBe(0);

    // The reconnect scheduled 1s after the drop succeeds.
    await vi.advanceTimersByTimeAsync(1000);
    current().emitConnect();
    current().emitData(DEVICES);

    // The engage is written once, and only once.
    expect(writeCount('setstate,1:1,1\r')).toBe(1);
    current().emitData('setstate,1:1,1\r');

    // Hold, then release.
    await vi.advanceTimersByTimeAsync(500);
    expect(writeCount('setstate,1:1,0\r')).toBe(1);
    current().emitData('setstate,1:1,0\r');

    const result = await promise;
    expect(result.target).toBe('OPEN');
    expect(writeCount('setstate,1:1,1\r')).toBe(1);

    // Nothing further is written however long we wait.
    await vi.advanceTimersByTimeAsync(RECONNECT_HOLD_MS + 5000);
    expect(writeCount('setstate,1:1,1\r')).toBe(1);
    expect(writeCount('setstate,1:1,0\r')).toBe(1);
  });

  it('abandons a pulse whose engage was written before the connection closed, with no retry and no release', async () => {
    void client.connect();
    current().emitConnect();
    current().emitData(DEVICES);

    const promise = actuator.actuate('OPEN').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeCount('setstate,1:1,1\r')).toBe(1);

    // The session dies before the device echoes the engage. Whether the relay
    // actually fired is unknowable, so the command is never sent again.
    current().emitClose();

    const err = await promise;
    expect(err).toBeInstanceOf(CommunicationError);
    expect((err as CommunicationError).deliveryUncertain).toBe(true);

    // Reconnect and wait out every timer in the system.
    await vi.advanceTimersByTimeAsync(1000);
    current().emitConnect();
    current().emitData(DEVICES);
    await vi.advanceTimersByTimeAsync(RECONNECT_HOLD_MS + 5000);

    expect(writeCount('setstate,1:1,1\r')).toBe(1);
    // Requirement 5.4: no state-0 command for an abandoned pulse.
    expect(writeCount('setstate,1:1,0\r')).toBe(0);
  });

  it('logs the delivery-uncertain case distinctly from the never-sent case', async () => {
    void client.connect();
    current().emitConnect();
    current().emitData(DEVICES);

    const promise = actuator.actuate('OPEN').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    current().emitClose();
    await promise;

    const errors = (log.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(
      errors.some((m) => m.includes('setstate 1 failed') && m.includes('may already have reached the device')),
    ).toBe(true);
  });

  it('reports a never-sent engage as such and writes nothing', async () => {
    connectThenDrop();

    const promise = actuator.actuate('CLOSED').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    current().emitClose();

    // No connection arrives before the hold expires.
    await vi.advanceTimersByTimeAsync(RECONNECT_HOLD_MS);
    const err = await promise;
    expect(err).toBeInstanceOf(CommunicationError);
    expect((err as CommunicationError).deliveryUncertain).toBe(false);
    expect(writeCount('setstate,1:1,1\r')).toBe(0);
    expect(writeCount('setstate,1:1,0\r')).toBe(0);

    const errors = (log.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(errors.some((m) => m.includes('setstate 1 failed') && m.includes('never sent'))).toBe(true);
  });

  it('does not double-actuate when a drop interrupts the hold before the release', async () => {
    void client.connect();
    current().emitConnect();
    current().emitData(DEVICES);

    const promise = actuator.actuate('OPEN').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    current().emitData('setstate,1:1,1\r');

    // The relay is engaged and the connection dies mid-hold. The release is
    // idempotent and de-energising, so it is held and retried; the engage is
    // not sent again.
    current().emitClose();
    await vi.advanceTimersByTimeAsync(500);
    expect(writeCount('setstate,1:1,1\r')).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    current().emitConnect();
    current().emitData(DEVICES);
    expect(writeCount('setstate,1:1,0\r')).toBe(1);
    current().emitData('setstate,1:1,0\r');

    await promise;
    await vi.advanceTimersByTimeAsync(RECONNECT_HOLD_MS + 5000);
    expect(writeCount('setstate,1:1,1\r')).toBe(1);
  });
});
