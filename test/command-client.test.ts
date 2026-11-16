/**
 * Unit tests for CommandClient using a synthetic (mock) socket.
 *
 * The MockSocket lets tests drive connect/data/close/error events
 * deterministically and capture what was written to the wire.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CommandClient,
  CommunicationError,
  GRACE_PERIOD_MS,
  isTransientConnectionFailure,
  MAX_QUEUE_DEPTH,
  RECONNECT_HOLD_MS,
  type SocketLike,
} from '../src/command-client.js';
import { ProtocolCodec } from '../src/protocol-codec.js';
import type { Logger } from '../src/logger.js';

// ─── Test doubles ────────────────────────────────────────────────────────────

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

type Listener = (...args: any[]) => void;

class MockSocket implements SocketLike {
  writes: string[] = [];
  destroyed = false;
  private listeners: Record<string, Listener[]> = {};
  connectCalled = false;

  connect(_port: number, _host: string, _cb?: () => void): void {
    this.connectCalled = true;
    // Connection is established explicitly by the test via emitConnect().
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

  // ─── Test drivers ────────────────────────────────────────────
  emitConnect(): void {
    (this.listeners['connect'] ?? []).forEach(l => l());
  }

  emitData(data: string): void {
    (this.listeners['data'] ?? []).forEach(l => l(Buffer.from(data, 'utf8')));
  }

  emitError(err: Error): void {
    (this.listeners['error'] ?? []).forEach(l => l(err));
  }

  emitClose(): void {
    (this.listeners['close'] ?? []).forEach(l => l());
  }
}

// ─── Test harness ────────────────────────────────────────────────────────────

describe('CommandClient', () => {
  let codec: ProtocolCodec;
  let log: Logger;
  let sockets: MockSocket[];
  let factory: () => SocketLike;

  beforeEach(() => {
    vi.useFakeTimers();
    codec = new ProtocolCodec();
    log = makeLogger();
    sockets = [];
    factory = () => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function currentSocket(): MockSocket {
    return sockets[sockets.length - 1]!;
  }

  // ─── Successful cycle ──────────────────────────────────────────────────

  describe('successful command cycle', () => {
    it('sends getdevices on connect, then the queued command', async () => {
      const client = new CommandClient('192.168.1.1', 4998, codec, log, factory);
      const promise = client.sendCommand('setstate,1:1,1');

      // Connection establishes
      currentSocket().emitConnect();

      // getdevices should be the first write
      expect(currentSocket().writes[0]).toBe('getdevices\r');

      // Respond to getdevices. The real device sends one frame per module
      // followed by an endlistdevices terminator.
      currentSocket().emitData('device,1,3 RELAY\rendlistdevices\r');

      // Now the queued command should be sent
      expect(currentSocket().writes[1]).toBe('setstate,1:1,1\r');

      // Respond to setstate
      currentSocket().emitData('setstate,1:1,1\r');

      const response = await promise;
      expect(response.type).toBe('setstate-echo');
      expect(client.isConnected).toBe(true);
    });

    it('terminates commands with \\r and no \\n', async () => {
      const client = new CommandClient('192.168.1.1', 4998, codec, log, factory);
      const promise = client.sendCommand('getstate,1:1');
      currentSocket().emitConnect();
      currentSocket().emitData('endlistdevices\r');
      currentSocket().emitData('state,1:1,0\r');
      await promise;

      for (const write of currentSocket().writes) {
        expect(write.endsWith('\r')).toBe(true);
        expect(write).not.toContain('\n');
      }
    });

    it('processes multiple commands FIFO', async () => {
      const client = new CommandClient('192.168.1.1', 4998, codec, log, factory);
      const p1 = client.sendCommand('setstate,1:1,1');
      const p2 = client.sendCommand('setstate,1:1,0');

      currentSocket().emitConnect();
      currentSocket().emitData('endlistdevices\r');

      // First command sent
      expect(currentSocket().writes[1]).toBe('setstate,1:1,1\r');
      currentSocket().emitData('setstate,1:1,1\r');

      // Second command sent after first response
      expect(currentSocket().writes[2]).toBe('setstate,1:1,0\r');
      currentSocket().emitData('setstate,1:1,0\r');

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.type).toBe('setstate-echo');
      expect(r2.type).toBe('setstate-echo');
    });
  });

  // ─── Command timeout ───────────────────────────────────────────────────

  describe('command timeout', () => {
    it('rejects with CommunicationError after 3000ms and closes connection', async () => {
      const client = new CommandClient('192.168.1.1', 4998, codec, log, factory);
      const promise = client.sendCommand('setstate,1:1,1');
      currentSocket().emitConnect();
      currentSocket().emitData('endlistdevices\r');

      // Command sent, no response — advance past timeout
      vi.advanceTimersByTime(3000);

      await expect(promise).rejects.toBeInstanceOf(CommunicationError);
      expect(currentSocket().destroyed).toBe(true);
      expect(client.isConnected).toBe(false);
    });

    it('flushes queued commands with communication failure on timeout', async () => {
      const client = new CommandClient('192.168.1.1', 4998, codec, log, factory);
      const p1 = client.sendCommand('setstate,1:1,1');
      const p2 = client.sendCommand('setstate,1:1,0');
      currentSocket().emitConnect();
      currentSocket().emitData('endlistdevices\r');

      // p1 is in flight, p2 queued. Timeout.
      vi.advanceTimersByTime(3000);

      await expect(p1).rejects.toBeInstanceOf(CommunicationError);
      await expect(p2).rejects.toBeInstanceOf(CommunicationError);
    });
  });

  // ─── Queue overflow ────────────────────────────────────────────────────

  describe('queue overflow', () => {
    it('rejects the 17th command when 16 are queued', async () => {
      const client = new CommandClient('192.168.1.1', 4998, codec, log, factory);

      // Fill the queue without connecting (commands stay queued)
      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < MAX_QUEUE_DEPTH; i++) {
        promises.push(client.sendCommand(`getstate,1:1`).catch(() => 'rejected'));
      }

      // The 17th should reject immediately
      await expect(client.sendCommand('getstate,1:1')).rejects.toBeInstanceOf(CommunicationError);

      // Clean up: connect, drop, and let the hold on the 16 held commands
      // expire so they settle rather than waiting forever.
      currentSocket().emitConnect();
      currentSocket().emitClose();
      await vi.advanceTimersByTimeAsync(RECONNECT_HOLD_MS);
      await Promise.allSettled(promises);
    });
  });

  // ─── Connection timeout ────────────────────────────────────────────────

  describe('connection timeout', () => {
    it('abandons connection after 5000ms and schedules reconnect', async () => {
      const client = new CommandClient('192.168.1.1', 4998, codec, log, factory);
      const promise = client.sendCommand('getstate,1:1').catch((e) => e);

      // Never emit connect — advance past connect timeout
      vi.advanceTimersByTime(5000);

      const result = await promise;
      expect(result).toBeInstanceOf(CommunicationError);
      expect(currentSocket().destroyed).toBe(true);
    });
  });

  // ─── Exponential backoff reconnect ─────────────────────────────────────

  describe('exponential backoff reconnection', () => {
    it('reconnects with 1s, 2s, 4s backoff after connection loss', async () => {
      const client = new CommandClient('192.168.1.1', 4998, codec, log, factory);
      // initial connect
      void client.connect();
      currentSocket().emitConnect();
      expect(client.isConnected).toBe(true);
      const socketCountAfterConnect = sockets.length;

      // Lose connection
      currentSocket().emitClose();
      expect(client.isConnected).toBe(false);

      // First reconnect after 1s
      vi.advanceTimersByTime(1000);
      expect(sockets.length).toBe(socketCountAfterConnect + 1);

      // That attempt fails (close without connect)
      currentSocket().emitClose();

      // Second reconnect after 2s
      vi.advanceTimersByTime(1999);
      expect(sockets.length).toBe(socketCountAfterConnect + 1);
      vi.advanceTimersByTime(1);
      expect(sockets.length).toBe(socketCountAfterConnect + 2);

      // Fails again
      currentSocket().emitClose();

      // Third reconnect after 4s
      vi.advanceTimersByTime(3999);
      expect(sockets.length).toBe(socketCountAfterConnect + 2);
      vi.advanceTimersByTime(1);
      expect(sockets.length).toBe(socketCountAfterConnect + 3);

      await client.disconnect();
    });

    it('resets backoff to 1s after a successful reconnect', async () => {
      const client = new CommandClient('192.168.1.1', 4998, codec, log, factory);
      void client.connect();
      currentSocket().emitConnect();
      const baseCount = sockets.length;

      // Lose and fail a couple times to grow backoff
      currentSocket().emitClose();
      vi.advanceTimersByTime(1000); // reconnect #1
      currentSocket().emitClose();
      vi.advanceTimersByTime(2000); // reconnect #2
      // This one succeeds
      currentSocket().emitConnect();
      expect(client.isConnected).toBe(true);

      // Lose again — backoff should be reset to 1s
      currentSocket().emitClose();
      const countBeforeReset = sockets.length;
      vi.advanceTimersByTime(999);
      expect(sockets.length).toBe(countBeforeReset);
      vi.advanceTimersByTime(1);
      expect(sockets.length).toBe(countBeforeReset + 1);

      await client.disconnect();
      expect(baseCount).toBeGreaterThan(0);
    });
  });

  // ─── Grace period ──────────────────────────────────────────────────────

  describe('grace period', () => {
    it('reports within grace period immediately after loss', () => {
      const client = new CommandClient('192.168.1.1', 4998, codec, log, factory);
      void client.connect();
      currentSocket().emitConnect();
      currentSocket().emitClose();

      expect(client.connectionLostAt).not.toBeNull();
      expect(client.isWithinGracePeriod).toBe(true);
    });

    it('leaves grace period after 30s', () => {
      const client = new CommandClient('192.168.1.1', 4998, codec, log, factory);
      void client.connect();
      currentSocket().emitConnect();
      currentSocket().emitClose();

      vi.advanceTimersByTime(30_000);
      expect(client.isWithinGracePeriod).toBe(false);
    });
  });

  // ─── getdevices error handling ─────────────────────────────────────────

  describe('getdevices ERR handling', () => {
    it('logs a warning but continues processing the queue', async () => {
      const client = new CommandClient('192.168.1.1', 4998, codec, log, factory);
      const promise = client.sendCommand('setstate,1:1,1');
      currentSocket().emitConnect();

      // getdevices returns an error
      currentSocket().emitData('ERR_001\r');
      expect(log.warn).toHaveBeenCalled();

      // Queue still processed
      expect(currentSocket().writes[1]).toBe('setstate,1:1,1\r');
      currentSocket().emitData('setstate,1:1,1\r');

      const response = await promise;
      expect(response.type).toBe('setstate-echo');
    });

    it('logs devices at info level on successful getdevices', () => {
      const client = new CommandClient('192.168.1.1', 4998, codec, log, factory);
      void client.connect();
      currentSocket().emitConnect();
      currentSocket().emitData('device,1,3 RELAY\rendlistdevices\r');
      expect(log.info).toHaveBeenCalled();
    });
  });

  // ─── Fragmented frames ─────────────────────────────────────────────────

  describe('stream buffering', () => {
    it('handles responses split across multiple data events', async () => {
      const client = new CommandClient('192.168.1.1', 4998, codec, log, factory);
      const promise = client.sendCommand('getstate,1:1');
      currentSocket().emitConnect();
      currentSocket().emitData('endlistdevices\r');

      // Send response in fragments
      currentSocket().emitData('state,1');
      currentSocket().emitData(':1,0');
      currentSocket().emitData('\r');

      const response = await promise;
      expect(response).toMatchObject({ type: 'state', module: 1, connector: 1, value: 0 });
    });

    it('handles multiple concatenated frames in one data event', async () => {
      const client = new CommandClient('192.168.1.1', 4998, codec, log, factory);
      const p1 = client.sendCommand('getstate,1:1');
      currentSocket().emitConnect();
      // getdevices response + first command response arrive together
      currentSocket().emitData('endlistdevices\rstate,1:1,0\r');

      const r1 = await p1;
      expect(r1).toMatchObject({ type: 'state', value: 0 });
    });
  });

  // ─── Disconnect ────────────────────────────────────────────────────────

  describe('disconnect', () => {
    it('stops reconnection and rejects queued commands', async () => {
      const client = new CommandClient('192.168.1.1', 4998, codec, log, factory);
      const promise = client.sendCommand('getstate,1:1').catch((e) => e);
      currentSocket().emitConnect();
      currentSocket().emitData('endlistdevices\r');

      await client.disconnect();
      const result = await promise;
      expect(result).toBeInstanceOf(CommunicationError);

      // No reconnect should be scheduled
      const countAfterDisconnect = sockets.length;
      vi.advanceTimersByTime(60_000);
      expect(sockets.length).toBe(countAfterDisconnect);
    });
  });

  // ─── Held commands across a reconnect ──────────────────────────────────

  /**
   * The IP2CC at 192.168.4.235 drops its TCP session periodically and the
   * client is back in about a second. A command submitted inside that window
   * used to be failed outright, which burned the user's tap. These tests cover
   * the hold, and — more importantly — the rule that no command is ever written
   * to a socket twice, because a second `setstate <relay>,1` is a second
   * physical press of a wired garage door or gate opener.
   */
  describe('held commands across a reconnect', () => {
    /** Everything written to every socket this client ever created. */
    function allWrites(): string[] {
      return sockets.flatMap((s) => s.writes);
    }

    function writeCount(data: string): number {
      return allWrites().filter((w) => w === data).length;
    }

    /** Connect, answer getdevices, then have the device drop the session. */
    function connectThenDrop(client: CommandClient): void {
      void client.connect();
      currentSocket().emitConnect();
      currentSocket().emitData('device,1,3 RELAY\rendlistdevices\r');
      currentSocket().emitClose();
    }

    it('holds an unsent command across a reconnect and writes it exactly once', async () => {
      const client = new CommandClient('192.168.4.235', 4998, codec, log, factory);
      connectThenDrop(client);
      expect(client.isConnected).toBe(false);

      // A tap lands inside the reconnect window.
      const promise = client.sendCommand('setstate,1:1,1');

      // The immediate connect attempt is refused, as it plausibly was in
      // production: the device had only just dropped a session.
      currentSocket().emitClose();
      expect(writeCount('setstate,1:1,1\r')).toBe(0);

      // The reconnect scheduled 1s after the drop succeeds.
      await vi.advanceTimersByTimeAsync(1000);
      currentSocket().emitConnect();
      currentSocket().emitData('device,1,3 RELAY\rendlistdevices\r');

      expect(writeCount('setstate,1:1,1\r')).toBe(1);
      currentSocket().emitData('setstate,1:1,1\r');
      const response = await promise;
      expect(response.type).toBe('setstate-echo');

      // And it stays at one write, however long we wait.
      await vi.advanceTimersByTimeAsync(RECONNECT_HOLD_MS);
      expect(writeCount('setstate,1:1,1\r')).toBe(1);
      await client.disconnect();
    });

    it('sends getdevices before a held command on the new connection', async () => {
      const client = new CommandClient('192.168.4.235', 4998, codec, log, factory);
      connectThenDrop(client);
      const promise = client.sendCommand('setstate,1:1,1').catch((e) => e);

      await vi.advanceTimersByTimeAsync(1000);
      const reconnected = currentSocket();
      reconnected.emitConnect();
      expect(reconnected.writes[0]).toBe('getdevices\r');
      reconnected.emitData('device,1,3 RELAY\rendlistdevices\r');
      expect(reconnected.writes[1]).toBe('setstate,1:1,1\r');

      await client.disconnect();
      await promise;
    });

    it('fails a held command that no connection arrives for, without ever writing it', async () => {
      const client = new CommandClient('192.168.4.235', 4998, codec, log, factory);
      connectThenDrop(client);

      const promise = client.sendCommand('setstate,1:1,1').catch((e) => e);
      currentSocket().emitClose();

      // Every reconnect attempt stays unanswered until the hold expires.
      await vi.advanceTimersByTimeAsync(RECONNECT_HOLD_MS);

      const err = await promise;
      expect(err).toBeInstanceOf(CommunicationError);
      expect((err as CommunicationError).connectionLevel).toBe(true);
      expect((err as CommunicationError).deliveryUncertain).toBe(false);
      expect(writeCount('setstate,1:1,1\r')).toBe(0);
      await client.disconnect();
    });

    it('does not extend the hold when a later close re-examines the queue', async () => {
      const client = new CommandClient('192.168.4.235', 4998, codec, log, factory);
      connectThenDrop(client);
      const promise = client.sendCommand('setstate,1:1,1').catch((e) => e);

      // A second failed attempt part-way through the hold must not restart it.
      await vi.advanceTimersByTimeAsync(RECONNECT_HOLD_MS - 500);
      currentSocket().emitClose();
      await vi.advanceTimersByTimeAsync(500);

      expect(await promise).toBeInstanceOf(CommunicationError);
      await client.disconnect();
    });

    it('reports a written command whose connection closed as delivery-uncertain, and never re-sends it', async () => {
      const client = new CommandClient('192.168.4.235', 4998, codec, log, factory);
      const promise = client.sendCommand('setstate,1:1,1').catch((e) => e);
      currentSocket().emitConnect();
      currentSocket().emitData('device,1,3 RELAY\rendlistdevices\r');
      expect(writeCount('setstate,1:1,1\r')).toBe(1);

      // The session dies before the device echoes the command.
      currentSocket().emitClose();

      const err = await promise;
      expect(err).toBeInstanceOf(CommunicationError);
      expect((err as CommunicationError).connectionLevel).toBe(true);
      expect((err as CommunicationError).deliveryUncertain).toBe(true);

      // Reconnect and wait out any hold: still exactly one write.
      await vi.advanceTimersByTimeAsync(1000);
      currentSocket().emitConnect();
      currentSocket().emitData('device,1,3 RELAY\rendlistdevices\r');
      await vi.advanceTimersByTimeAsync(RECONNECT_HOLD_MS);
      expect(writeCount('setstate,1:1,1\r')).toBe(1);
      await client.disconnect();
    });

    it('logs the written and the unsent cases distinctly', async () => {
      const client = new CommandClient('192.168.4.235', 4998, codec, log, factory);
      const inFlight = client.sendCommand('setstate,1:1,1').catch((e) => e);
      currentSocket().emitConnect();
      currentSocket().emitData('device,1,3 RELAY\rendlistdevices\r');
      const queued = client.sendCommand('setstate,1:2,1').catch((e) => e);

      currentSocket().emitClose();
      await inFlight;

      const errors = (log.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(errors.some((m) => m.includes('delivery to the device is unknown'))).toBe(true);
      const warns = (log.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(warns.some((m) => m.includes('1 command(s) not yet sent'))).toBe(true);

      await client.disconnect();
      await queued;
    });

    it('marks a fresh drop as transient and a client that never connected as persistent', async () => {
      const dropped = new CommandClient('192.168.4.235', 4998, codec, log, factory);
      connectThenDrop(dropped);
      const transient = dropped.sendCommand('setstate,1:1,1').catch((e) => e);
      currentSocket().emitClose();
      await vi.advanceTimersByTimeAsync(RECONNECT_HOLD_MS);
      expect(isTransientConnectionFailure(await transient)).toBe(true);
      await dropped.disconnect();

      // An IP2CC that has never answered is not a transient fault.
      const absent = new CommandClient('10.0.0.9', 4998, codec, log, factory);
      const persistent = absent.sendCommand('setstate,1:1,1').catch((e) => e);
      currentSocket().emitClose();
      await vi.advanceTimersByTimeAsync(RECONNECT_HOLD_MS);
      const err = await persistent;
      expect((err as CommunicationError).connectionLevel).toBe(true);
      expect(isTransientConnectionFailure(err)).toBe(false);
      await absent.disconnect();
    });

    it('marks a failure past the grace period as persistent', async () => {
      const client = new CommandClient('192.168.4.235', 4998, codec, log, factory);
      connectThenDrop(client);

      // The outage outlasts the 30s grace period.
      await vi.advanceTimersByTimeAsync(GRACE_PERIOD_MS);
      expect(client.isWithinGracePeriod).toBe(false);

      const promise = client.sendCommand('setstate,1:1,1').catch((e) => e);
      await vi.advanceTimersByTimeAsync(RECONNECT_HOLD_MS);
      const err = await promise;
      expect((err as CommunicationError).connectionLevel).toBe(true);
      expect((err as CommunicationError).withinGracePeriod).toBe(false);
      expect(isTransientConnectionFailure(err)).toBe(false);
      await client.disconnect();
    });

    it('does not treat a device error response as a connection failure', () => {
      const deviceError = new CommunicationError('Relay engage failed');
      expect(deviceError.connectionLevel).toBe(false);
      expect(isTransientConnectionFailure(deviceError)).toBe(false);
      expect(isTransientConnectionFailure(new Error('boom'))).toBe(false);
      expect(isTransientConnectionFailure(undefined)).toBe(false);
    });

    it('marks a command timed out after being written as delivery-uncertain', async () => {
      const client = new CommandClient('192.168.4.235', 4998, codec, log, factory);
      const promise = client.sendCommand('setstate,1:1,1').catch((e) => e);
      currentSocket().emitConnect();
      currentSocket().emitData('device,1,3 RELAY\rendlistdevices\r');

      vi.advanceTimersByTime(3000);
      const err = await promise;
      expect((err as CommunicationError).connectionLevel).toBe(true);
      expect((err as CommunicationError).deliveryUncertain).toBe(true);
      expect(writeCount('setstate,1:1,1\r')).toBe(1);
      await client.disconnect();
    });

    it('leaves no hold timer behind after disconnect', async () => {
      const client = new CommandClient('192.168.4.235', 4998, codec, log, factory);
      const promise = client.sendCommand('setstate,1:1,1').catch((e) => e);

      await client.disconnect();
      expect(await promise).toBeInstanceOf(CommunicationError);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

// ─── Multi-frame getdevices (regression) ─────────────────────────────────────

describe('CommandClient — multi-frame getdevices', () => {
  let codec: ProtocolCodec;
  let log: Logger;
  let sockets: MockSocket[];
  let factory: () => SocketLike;

  beforeEach(() => {
    vi.useFakeTimers();
    codec = new ProtocolCodec();
    log = makeLogger();
    sockets = [];
    factory = () => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const current = () => sockets[sockets.length - 1]!;

  /**
   * A real iTach IP2CC answers getdevices with one \r-delimited frame per
   * module, terminated by `endlistdevices`. Observed on hardware at
   * 192.168.4.235:
   *   device,0,0 ETHERNET
   *   device,1,3 RELAY
   *   endlistdevices
   * Earlier the client resolved on the first frame alone, so the RELAY module
   * was silently dropped.
   */
  it('aggregates every frame of the reply before resolving', async () => {
    const client = new CommandClient('192.168.4.235', 4998, codec, log, factory);
    void client.connect();
    current().emitConnect();

    // The automatic getdevices sent on connect is in flight. Deliver the
    // device's reply as three separate frames, exactly as the hardware does.
    const explicit = client.sendCommand(codec.encodeGetDevices());
    current().emitData('device,0,0 ETHERNET\r');
    current().emitData('device,1,3 RELAY\r');
    current().emitData('endlistdevices\r');

    // That satisfied the automatic getdevices; answer the explicit one too.
    current().emitData('device,0,0 ETHERNET\rdevice,1,3 RELAY\rendlistdevices\r');

    const response = await explicit;
    expect(response.type).toBe('devices');
    if (response.type === 'devices') {
      const types = response.modules.map((m) => m.type);
      expect(types).toContain('ETHERNET');
      expect(types).toContain('RELAY');
      const relay = response.modules.find((m) => m.type === 'RELAY');
      expect(relay).toMatchObject({ module: 1, connectors: 3 });
    }
    await client.disconnect();
  });

  it('does not resolve until the endlistdevices terminator arrives', async () => {
    const client = new CommandClient('192.168.4.235', 4998, codec, log, factory);
    void client.connect();
    current().emitConnect();

    let settled = false;
    const pending = client.sendCommand(codec.encodeGetDevices()).then((r) => {
      settled = true;
      return r;
    });

    // Satisfy the automatic getdevices from connect.
    current().emitData('device,1,3 RELAY\rendlistdevices\r');
    await Promise.resolve();

    // Now partially answer the explicit command — no terminator yet.
    current().emitData('device,0,0 ETHERNET\r');
    await Promise.resolve();
    expect(settled).toBe(false);

    current().emitData('endlistdevices\r');
    const response = await pending;
    expect(response.type).toBe('devices');
    await client.disconnect();
  });

  it('resolves immediately when getdevices returns an error instead of a block', async () => {
    const client = new CommandClient('192.168.4.235', 4998, codec, log, factory);
    void client.connect();
    current().emitConnect();

    // The automatic getdevices errors — no endlistdevices will follow.
    current().emitData('ERR_001\r');

    // A subsequent command must still be dispatched, proving we did not hang
    // waiting for a terminator.
    const promise = client.sendCommand(codec.encodeGetState(1, 1));
    current().emitData('state,1:1,0\r');
    const response = await promise;
    expect(response.type).toBe('state');
    await client.disconnect();
  });

  it('logs both modules reported by the device', async () => {
    const client = new CommandClient('192.168.4.235', 4998, codec, log, factory);
    void client.connect();
    current().emitConnect();

    current().emitData('device,0,0 ETHERNET\r');
    current().emitData('device,1,3 RELAY\r');
    current().emitData('endlistdevices\r');

    const logged = (log.info as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join(' | ');
    expect(logged).toContain('RELAY');
    expect(logged).toContain('ETHERNET');
    await client.disconnect();
  });
});
