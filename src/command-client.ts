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
}

/** Error thrown/rejected when a command cannot be completed. */
export class CommunicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommunicationError';
  }
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
        this.flushQueue(new CommunicationError('Connection attempt timed out'));
        this.scheduleReconnect();
        reject(new CommunicationError('Connection attempt timed out'));
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

    // Reject the in-flight command, if any.
    if (this.inFlight !== null) {
      const entry = this.inFlight;
      this.inFlight = null;
      entry.reject(new CommunicationError('Client disconnected'));
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

      const entry: QueueEntry = { command, resolve, reject };
      this.queue.push(entry);

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
    if (this.socket === null || !this._isConnected) {
      entry.reject(new CommunicationError('Not connected'));
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
        failed.reject(new CommunicationError('Command timed out'));
      }
      this.flushQueue(new CommunicationError('Communication failure after timeout'));
      this.scheduleReconnect();
    }, COMMAND_TIMEOUT_MS);
    if (this.commandTimer.unref) {
      this.commandTimer.unref();
    }

    this.log.debug(`→ ${this.host}:${this.port}: ${truncate(entry.command, 256)}`);
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

    // Fail the in-flight command.
    if (this.inFlight !== null) {
      const entry = this.inFlight;
      this.inFlight = null;
      entry.reject(new CommunicationError('Connection closed'));
    }

    if (this.shuttingDown) {
      return;
    }

    // Flush the queue and schedule a reconnect.
    this.flushQueue(new CommunicationError('Connection closed'));
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
