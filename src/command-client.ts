/**
 * TCP command client for a single IP2CC address:port pair.
 *
 * Responsibilities:
 * - Own one TCP connection to the IP2CC.
 * - Serialise commands, terminating each with a single `\r` (no `\n`).
 * - Maintain a 16-deep FIFO command queue, one command in flight at a time.
 * - Enforce a 3000ms per-command timeout and a 5000ms connection timeout.
 * - Reconnect with exponential backoff (1s → 2s → … → 60s cap).
 * - Send `getdevices` on each new connection before processing the queue.
 * - Track connection-lost time for the 30s grace period.
 *
 * The `net` module is injected via a socket factory so the client can be
 * tested against a mock TCP server or a fully synthetic socket.
 */

import * as net from 'net';
import { ProtocolCodec } from './protocol-codec.js';
import type { Response } from './types.js';
import type { Logger } from './logger.js';

// ─── Constants ─────────────────────────────────────────────────────────────

/** Maximum commands held in the FIFO queue (excluding the in-flight command). */
export const MAX_QUEUE_DEPTH = 16;

/** Per-command response timeout in milliseconds. */
export const COMMAND_TIMEOUT_MS = 3000;

/** TCP connection establishment timeout in milliseconds. */
export const CONNECT_TIMEOUT_MS = 5000;

/** Initial reconnect backoff in milliseconds. */
export const INITIAL_BACKOFF_MS = 1000;

/** Maximum reconnect backoff in milliseconds. */
export const MAX_BACKOFF_MS = 60_000;

/** Connection grace period in milliseconds — last-known values returned during this window. */
export const GRACE_PERIOD_MS = 30_000;

/**
 * How long an unsent command is held while the client reconnects.
 *
 * Budget: Requirement 3.6 mandates a 1000ms wait before the first reconnect
 * attempt, and connect plus the getdevices round trip costs roughly another
 * 100ms on the LAN (the live log shows the IP2CC back in about a second). That
 * leaves ~900ms of margin while keeping the whole HomeKit write inside
 * hap-nodejs's 9000ms write budget even at the maximum 2000ms pulse duration.
 * Deliberately *not* the 30s grace period: a relay that fires 25 seconds after
 * the user was told the write failed would move a door nobody is watching.
 */
export const RECONNECT_HOLD_MS = 2000;

/** The getdevices command string, used to detect multi-frame replies. */
const GET_DEVICES_COMMAND = 'getdevices';

/** Final frame of a getdevices reply block. */
const DEVICES_TERMINATOR = 'endlistdevices';

// ─── Socket abstraction (for testability) ───────────────────────────────────

/** The subset of net.Socket the client relies upon. */
export interface SocketLike {
  connect(port: number, host: string, connectListener?: () => void): void;
  write(data: string): boolean;
  destroy(error?: Error): void;
  on(event: 'connect', listener: () => void): this;
  on(event: 'data', listener: (data: Buffer) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  removeAllListeners(): this;
}

/** Factory that produces a fresh socket for each connection attempt. */
export type SocketFactory = () => SocketLike;

const defaultSocketFactory: SocketFactory = () => new net.Socket();

// ─── Queue Entry ─────────────────────────────────────────────────────────────

interface QueueEntry {
  command: string;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  /**
   * True once this command has been written to a socket. Set immediately before
   * the write and never cleared, so an entry is written at most once in its
   * lifetime. This is the whole double-actuation guard: a `setstate <relay>,1`
   * that reached a socket is never written again, because TCP cannot tell us
   * whether the IP2CC acted on it.
   */
  written: boolean;
  /** Timer that fails this entry if no connection arrives in time. */
  holdTimer: ReturnType<typeof setTimeout> | null;
}

/** How a CommunicationError came about, so callers can react proportionately. */
export interface CommunicationErrorInfo {
  /**
   * The failure was in the connection rather than in the device's answer: no
   * usable connection carried the command, the connection closed before a
   * response arrived, or no response arrived at all. An `ERR_nnn` reply from
   * the IP2CC is *not* connection-level.
   */
  connectionLevel?: boolean;
  /**
   * The command had already been written to a socket when it failed, so whether
   * the IP2CC received and acted on it cannot be determined.
   */
  deliveryUncertain?: boolean;
  /**
   * The connection had been lost for less than the grace period at the moment
   * this failure was reported, judged then rather than re-derived later.
   */
  withinGracePeriod?: boolean;
}

/** Error thrown/rejected when a command cannot be completed. */
export class CommunicationError extends Error {
  readonly connectionLevel: boolean;
  readonly deliveryUncertain: boolean;
  readonly withinGracePeriod: boolean;

  constructor(message: string, info: CommunicationErrorInfo = {}) {
    super(message);
    this.name = 'CommunicationError';
    this.connectionLevel = info.connectionLevel ?? false;
    this.deliveryUncertain = info.deliveryUncertain ?? false;
    this.withinGracePeriod = info.withinGracePeriod ?? false;
  }
}

/**
 * Whether a failure is a connection drop the client is expected to recover from
 * shortly, as opposed to a device fault or an IP2CC that is simply not there.
 *
 * The grace period (30s) is the dividing line, and it is the same boundary
 * Requirement 3.8 already uses to decide when a lost connection stops being
 * tolerated. A client that has never connected has no loss timestamp, so it is
 * never transient.
 */
export function isTransientConnectionFailure(err: unknown): boolean {
  return err instanceof CommunicationError && err.connectionLevel && err.withinGracePeriod;
}

// ─── CommandClient ───────────────────────────────────────────────────────────

export class CommandClient {
  private readonly host: string;
  private readonly port: number;
  private readonly codec: ProtocolCodec;
  private readonly log: Logger;
  private readonly socketFactory: SocketFactory;

  private socket: SocketLike | null = null;
  private _isConnected = false;
  private _connectionLostAt: number | null = null;

  /** Pending commands waiting for a free slot. */
  private readonly queue: QueueEntry[] = [];
  /** The command currently awaiting a response. */
  private inFlight: QueueEntry | null = null;
  private commandTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private buffer = '';
  /** Accumulated frames of an in-progress getdevices reply block. */
  private deviceFrames: string[] = [];
  private backoffMs = INITIAL_BACKOFF_MS;
  private shuttingDown = false;
  private connecting = false;

  /** Callback invoked when the connection is (re)established. */
  onReconnect: (() => void) | null = null;

  constructor(
    host: string,
    port: number,
    codec: ProtocolCodec,
    log: Logger,
    socketFactory: SocketFactory = defaultSocketFactory,
  ) {
    this.host = host;
    this.port = port;
    this.codec = codec;
    this.log = log;
    this.socketFactory = socketFactory;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  get connectionLostAt(): number | null {
    return this._connectionLostAt;
  }

  /** Whether the client is within the 30s grace period after a connection loss. */
  get isWithinGracePeriod(): boolean {
    if (this._connectionLostAt === null) {
      return false;
    }
    return Date.now() - this._connectionLostAt < GRACE_PERIOD_MS;
  }

  // ─── Connection Lifecycle ──────────────────────────────────────────────────

  /**
   * Open a connection to the IP2CC. Resolves once the socket is established
   * (before getdevices completes). Rejects on connection timeout.
   */
  connect(): Promise<void> {
    if (this._isConnected || this.connecting) {
      return Promise.resolve();
    }
    this.shuttingDown = false;
    this.connecting = true;

    return new Promise<void>((resolve, reject) => {
      const socket = this.socketFactory();
      this.socket = socket;

      this.connectTimer = setTimeout(() => {
        this.log.error(`Connection to ${this.host}:${this.port} timed out after ${CONNECT_TIMEOUT_MS}ms`);
        this.connecting = false;
        this.teardownSocket();
        // Requirement 3.11 requires the queue to be discarded here; the hold
        // across a reconnect deliberately does not extend to this path.
        this.flushQueue(this.connectionError('Connection attempt timed out'));
        this.scheduleReconnect();
        reject(this.connectionError('Connection attempt timed out'));
      }, CONNECT_TIMEOUT_MS);
      if (this.connectTimer.unref) {
        this.connectTimer.unref();
      }

      socket.on('connect', () => {
        this.clearConnectTimer();
        this.connecting = false;
        this._isConnected = true;
        this._connectionLostAt = null;
        this.backoffMs = INITIAL_BACKOFF_MS;
        this.log.debug(`Connected to ${this.host}:${this.port}`);

        // Send getdevices before processing the queue.
        this.sendGetDevices();

        if (this.onReconnect) {
          this.onReconnect();
        }
        resolve();
      });

      socket.on('data', (data: Buffer) => {
        this.handleData(data);
      });

      socket.on('error', (err: Error) => {
        this.log.debug(`Socket error for ${this.host}:${this.port}: ${err.message}`);
        // 'close' will follow; handle teardown there.
      });

      socket.on('close', () => {
        this.handleClose();
      });

      socket.connect(this.port, this.host);
    });
  }

  /**
   * Gracefully close the connection and stop reconnecting.
   */
  disconnect(): Promise<void> {
    this.shuttingDown = true;
    this.clearReconnectTimer();
    this.clearConnectTimer();
    this.clearCommandTimer();
    this.teardownSocket();
    this._isConnected = false;
    this.connecting = false;

    // Reject the in-flight command, if any. It was written, so whether the
    // IP2CC acted on it is unknown — say so rather than implying it was lost.
    if (this.inFlight !== null) {
      const entry = this.inFlight;
      this.inFlight = null;
      this.clearHold(entry);
      entry.reject(new CommunicationError('Client disconnected', { deliveryUncertain: entry.written }));
    }

    this.flushQueue(new CommunicationError('Client disconnected'));
    return Promise.resolve();
  }

  // ─── Command Submission ────────────────────────────────────────────────────

  /**
   * Submit a command for transmission. Resolves with the parsed response, or
   * rejects with a CommunicationError on timeout, queue overflow, or failure.
   *
   * @param command - The wire command string (without `\r` terminator).
   */
  sendCommand(command: string): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      if (this.queue.length >= MAX_QUEUE_DEPTH) {
        this.log.error(`Command queue for ${this.host}:${this.port} is full (${MAX_QUEUE_DEPTH}); rejecting command`);
        reject(new CommunicationError('Command queue full'));
        return;
      }

      const entry: QueueEntry = { command, resolve, reject, written: false, holdTimer: null };
      this.queue.push(entry);

      // Nothing can carry this command yet, so hold it rather than failing it:
      // the IP2CC drops sessions periodically and is back in about a second.
      if (!this._isConnected) {
        this.armHold(entry);
      }

      // Kick off a connection if needed; otherwise try to dispatch.
      if (!this._isConnected && !this.connecting) {
        void this.connect().catch(() => {
          // connect() already flushed the queue on failure.
        });
      } else if (this._isConnected) {
        this.dispatchNext();
      }
    });
  }

  /**
   * Start (but never extend) the hold timer for a command that has no
   * connection to travel on. On expiry the command is failed as a connection
   * error without ever having been written, so the caller knows the device was
   * not touched.
   */
  private armHold(entry: QueueEntry): void {
    if (entry.holdTimer !== null) {
      return;
    }
    entry.holdTimer = setTimeout(() => {
      entry.holdTimer = null;
      const index = this.queue.indexOf(entry);
      if (index === -1) {
        return;
      }
      this.queue.splice(index, 1);
      this.log.error(
        `Command "${truncate(entry.command, 256)}" to ${this.host}:${this.port} was never sent: ` +
        `no connection became available within ${RECONNECT_HOLD_MS}ms`,
      );
      entry.reject(this.connectionError('Connection unavailable; command never sent'));
    }, RECONNECT_HOLD_MS);
    if (entry.holdTimer.unref) {
      entry.holdTimer.unref();
    }
  }

  private clearHold(entry: QueueEntry): void {
    if (entry.holdTimer !== null) {
      clearTimeout(entry.holdTimer);
      entry.holdTimer = null;
    }
  }

  /**
   * Build a connection-level error, reading the grace-period verdict now rather
   * than leaving the caller to re-derive it from a clock that has moved on.
   */
  private connectionError(message: string, deliveryUncertain = false): CommunicationError {
    return new CommunicationError(message, {
      connectionLevel: true,
      deliveryUncertain,
      withinGracePeriod: this.isWithinGracePeriod,
    });
  }

  // ─── Internal: Dispatch & Data Handling ──────────────────────────────────

  private sendGetDevices(): void {
    const cmd = this.codec.encodeGetDevices();
    // getdevices is sent directly ahead of the queue with its own handling.
    const entry: QueueEntry = {
      command: cmd,
      resolve: (response) => {
        if (response.type === 'devices') {
          const summary = response.modules
            .map(m => `module ${m.module} (${m.type}, ${m.connectors} connectors)`)
            .join(', ');
          this.log.info(`${this.host}:${this.port} devices: ${summary || 'none reported'}`);
        } else if (response.type === 'error') {
          this.log.warn(`${this.host}:${this.port} getdevices returned error code ${response.code}`);
        }
        // Continue with the queue regardless.
        this.dispatchNext();
      },
      reject: () => {
        // getdevices failure is non-fatal; the connection handling will retry.
        this.dispatchNext();
      },
      written: false,
      holdTimer: null,
    };
    this.transmit(entry);
  }

  private dispatchNext(): void {
    if (this.inFlight !== null || !this._isConnected) {
      return;
    }
    const next = this.queue.shift();
    if (next === undefined) {
      return;
    }
    this.transmit(next);
  }

  private transmit(entry: QueueEntry): void {
    // A command that has already reached a socket is never written again. For a
    // relay engage that would be a second physical press of the opener button.
    if (entry.written) {
      this.log.error(
        `Refusing to re-send command "${truncate(entry.command, 256)}" to ${this.host}:${this.port}: ` +
        'it has already been written to a socket and may have reached the device',
      );
      entry.reject(this.connectionError('Command already sent; not re-sent', true));
      return;
    }

    this.clearHold(entry);

    if (this.socket === null || !this._isConnected) {
      entry.reject(this.connectionError('Not connected'));
      return;
    }

    this.inFlight = entry;
    this.commandTimer = setTimeout(() => {
      this.log.error(`Command "${entry.command}" to ${this.host}:${this.port} timed out after ${COMMAND_TIMEOUT_MS}ms`);
      const failed = this.inFlight;
      this.inFlight = null;
      this.clearCommandTimer();
      // Close the connection and flush.
      this.teardownSocket();
      this._isConnected = false;
      this._connectionLostAt = Date.now();
      if (failed) {
        // Written, then silence: delivery cannot be determined.
        failed.reject(this.connectionError('Command timed out', failed.written));
      }
      // Requirement 3.5 requires the queue to be discarded after a command
      // timeout, so these are not held.
      this.flushQueue(this.connectionError('Communication failure after timeout'));
      this.scheduleReconnect();
    }, COMMAND_TIMEOUT_MS);
    if (this.commandTimer.unref) {
      this.commandTimer.unref();
    }

    this.log.debug(`→ ${this.host}:${this.port}: ${truncate(entry.command, 256)}`);
    // Mark before the write, not after: if write() throws, the bytes may still
    // have gone out, and the entry must never be eligible for a second send.
    entry.written = true;
    this.socket.write(entry.command + '\r');
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString('utf8');
    const { frames, remainder } = this.codec.extractFrames(this.buffer);
    this.buffer = remainder;

    for (const frame of frames) {
      this.log.debug(`← ${this.host}:${this.port}: ${truncate(frame, 256)}`);
      this.handleFrame(frame);
    }
  }

  /**
   * Route a single response frame to the in-flight command.
   *
   * `getdevices` is special: the device answers with a multi-frame block, one
   * `\r`-delimited frame per module, terminated by `endlistdevices`. Those
   * frames must be accumulated and parsed together, otherwise only the first
   * module would ever be reported.
   */
  private handleFrame(frame: string): void {
    const isGetDevices = this.inFlight !== null && this.inFlight.command === GET_DEVICES_COMMAND;

    if (isGetDevices) {
      const parsed = this.codec.parseResponse(frame);

      // An error reply terminates the block immediately — there will be no
      // `endlistdevices` to wait for.
      if (parsed.type === 'error') {
        this.deviceFrames = [];
        this.resolveInFlight(parsed);
        return;
      }

      this.deviceFrames.push(frame);

      if (frame.trim() === DEVICES_TERMINATOR) {
        const block = this.deviceFrames.join('\r');
        this.deviceFrames = [];
        this.resolveInFlight(this.codec.parseResponse(block));
      }
      // Otherwise keep accumulating until the terminator arrives.
      return;
    }

    this.resolveInFlight(this.codec.parseResponse(frame));
  }

  private resolveInFlight(response: Response): void {
    if (this.inFlight === null) {
      // Unsolicited data — ignore.
      return;
    }
    const entry = this.inFlight;
    this.inFlight = null;
    this.clearCommandTimer();
    entry.resolve(response);
    // Dispatch the next queued command.
    this.dispatchNext();
  }

  // ─── Internal: Connection teardown & reconnect ─────────────────────────────

  private handleClose(): void {
    this.clearConnectTimer();
    this.clearCommandTimer();

    const wasConnected = this._isConnected;
    this._isConnected = false;
    this.connecting = false;

    if (wasConnected && this._connectionLostAt === null) {
      this._connectionLostAt = Date.now();
    }

    // Fail the in-flight command. It had been written, so there is no way to
    // know whether the IP2CC received and acted on it before the close. It is
    // never re-sent; the two cases are logged distinctly so the next occurrence
    // in production can be told apart from a command that never left.
    if (this.inFlight !== null) {
      const entry = this.inFlight;
      this.inFlight = null;
      this.clearHold(entry);
      if (entry.written) {
        this.log.error(
          `Command "${truncate(entry.command, 256)}" to ${this.host}:${this.port} was sent but the ` +
          'connection closed before a reply; delivery to the device is unknown, so it will not be re-sent',
        );
      }
      entry.reject(this.connectionError('Connection closed', entry.written));
    }

    if (this.shuttingDown) {
      return;
    }

    // Commands still in the queue were never written to any socket, so sending
    // one after the reconnect is its first and only send, not a retry. Hold
    // them for the reconnect instead of burning the user's request.
    if (this.queue.length > 0) {
      this.log.warn(
        `Connection to ${this.host}:${this.port} closed with ${this.queue.length} command(s) not yet ` +
        `sent; holding them across the reconnect for up to ${RECONNECT_HOLD_MS}ms`,
      );
      for (const entry of this.queue) {
        this.armHold(entry);
      }
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer !== null) {
      return;
    }
    const wait = this.backoffMs;
    this.log.debug(`Scheduling reconnect to ${this.host}:${this.port} in ${wait}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Double the backoff for next time, capped.
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      void this.connect().catch(() => {
        // connect() schedules its own retry on failure.
      });
    }, wait);
    if (this.reconnectTimer.unref) {
      this.reconnectTimer.unref();
    }
  }

  private flushQueue(error: Error): void {
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.clearHold(entry);
      entry.reject(error);
    }
  }

  private teardownSocket(): void {
    if (this.socket !== null) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.buffer = '';
    this.deviceFrames = [];
  }

  private clearCommandTimer(): void {
    if (this.commandTimer !== null) {
      clearTimeout(this.commandTimer);
      this.commandTimer = null;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
