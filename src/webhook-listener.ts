/**
 * HTTP webhook listener for external door-state correction.
 *
 * Serves POST requests at `/door/<doorId>/state`. Validates each request in a
 * strict order and stops at the first failing check (Requirement 9.9):
 *
 *   1. rate limit        → 429
 *   2. X-Auth-Token      → 401
 *   3. HTTP method       → 405
 *   4. Door_Id lookup    → 404
 *   5. content-type/body → 400
 *
 * Authentication uses a constant-time comparison (`crypto.timingSafeEqual`).
 * The token is never emitted in responses or logs.
 */

import * as http from 'http';
import { timingSafeEqual } from 'crypto';
import { RateLimiter } from './rate-limiter.js';
import type { DoorState } from './types.js';
import type { Logger } from './logger.js';

/** Maximum request body size in bytes. */
const MAX_BODY_BYTES = 1024;

/** Timeout for binding the listening socket. */
const BIND_TIMEOUT_MS = 5000;

/** Permitted state values accepted in webhook request bodies (lowercase wire form). */
const WIRE_TO_STATE: Readonly<Record<string, DoorState>> = {
  open: 'OPEN',
  closed: 'CLOSED',
  opening: 'OPENING',
  closing: 'CLOSING',
  stopped: 'STOPPED',
};

const PERMITTED_STATES = Object.keys(WIRE_TO_STATE);

/**
 * Abstraction over a single door as seen by the webhook. The accessory handler
 * implements this so the listener stays decoupled from HomeKit specifics.
 */
export interface WebhookDoorHandler {
  /** Apply an externally-supplied state (cancels timers, updates characteristics). */
  applyExternalState(state: DoorState): void;
  /** Set the obstruction-detected flag. */
  setObstruction(obstructed: boolean): void;
  /** The current door state, for the 200 response body. */
  readonly currentState: DoorState;
}

export interface WebhookListenerConfig {
  port: number;
  bindAddress: string;
  token: string;
  doors: Map<string, WebhookDoorHandler>;
  log: Logger;
  /** Optional clock for testing rate-limit windows. Defaults to Date.now. */
  now?: () => number;
  /** Optional server factory for testing. Defaults to http.createServer. */
  createServer?: (handler: http.RequestListener) => http.Server;
}

export class WebhookListener {
  private readonly port: number;
  private readonly bindAddress: string;
  private readonly tokenBuffer: Buffer;
  private readonly doors: Map<string, WebhookDoorHandler>;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly rateLimiter = new RateLimiter();
  private readonly createServer: (handler: http.RequestListener) => http.Server;

  private server: http.Server | null = null;
  private _isListening = false;

  constructor(config: WebhookListenerConfig) {
    this.port = config.port;
    this.bindAddress = config.bindAddress;
    this.tokenBuffer = Buffer.from(config.token, 'utf8');
    this.doors = config.doors;
    this.log = config.log;
    this.now = config.now ?? Date.now;
    this.createServer = config.createServer ?? ((h) => http.createServer(h));
  }

  get isListening(): boolean {
    return this._isListening;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Start the HTTP server. Resolves once listening, rejects on bind error or
   * a 5000ms bind timeout. On failure the listener stays stopped.
   */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = this.createServer((req, res) => this.handleRequest(req, res));
      this.server = server;

      const bindTimer = setTimeout(() => {
        this.log.error(
          `Webhook listener failed to bind ${this.bindAddress}:${this.port} within ${BIND_TIMEOUT_MS}ms; listener stopped`,
        );
        server.removeAllListeners();
        try {
          server.close();
        } catch {
          // ignore
        }
        this.server = null;
        this._isListening = false;
        reject(new Error('Webhook bind timeout'));
      }, BIND_TIMEOUT_MS);
      if (bindTimer.unref) {
        bindTimer.unref();
      }

      server.once('error', (err: Error) => {
        clearTimeout(bindTimer);
        this.log.error(
          `Webhook listener could not bind ${this.bindAddress}:${this.port}: ${err.message}; listener stopped`,
        );
        this.server = null;
        this._isListening = false;
        reject(err);
      });

      server.listen(this.port, this.bindAddress, () => {
        clearTimeout(bindTimer);
        this._isListening = true;
        this.log.info(`Webhook listener bound to ${this.bindAddress}:${this.port}`);
        resolve();
      });
    });
  }

  /** Stop the server and close the listening socket. */
  stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.server === null) {
        this._isListening = false;
        resolve();
        return;
      }
      const server = this.server;
      this.server = null;
      this._isListening = false;
      server.close(() => resolve());
    });
  }

  // ─── Request handling ────────────────────────────────────────────────────

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const sourceIp = this.resolveSourceIp(req);

    // 1. Rate limit
    if (!this.rateLimiter.allow(this.now(), sourceIp)) {
      this.respond(res, 429, { error: 'Rate limit exceeded' });
      return;
    }

    // 2. Authentication token (constant-time)
    if (!this.isAuthenticated(req)) {
      this.respond(res, 401, { error: 'Unauthorized' });
      return;
    }

    // 3. HTTP method
    if (req.method !== 'POST') {
      this.respond(res, 405, { error: 'Only POST is permitted' });
      return;
    }

    // 4. Door_Id lookup
    const doorId = this.parseDoorId(req.url ?? '');
    const handler = doorId !== null ? this.doors.get(doorId) : undefined;
    if (handler === undefined) {
      this.respond(res, 404, { error: 'Unknown door' });
      return;
    }

    // 5. Content type + body
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      this.respond(res, 400, { error: 'Content-Type must be application/json' });
      return;
    }

    this.readBody(req, (bodyErr, body) => {
      if (bodyErr !== null) {
        this.respond(res, 400, { error: bodyErr });
        return;
      }
      this.applyBody(handler, body!, res);
    });
  }

  private applyBody(handler: WebhookDoorHandler, rawBody: string, res: http.ServerResponse): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      this.respond(res, 400, { error: 'Body must be valid JSON' });
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.respond(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const obj = parsed as Record<string, unknown>;

    // Validate state value
    const stateValue = obj['state'];
    if (typeof stateValue !== 'string' || !(stateValue in WIRE_TO_STATE)) {
      this.respond(res, 400, {
        error: 'Missing or invalid state',
        permitted: PERMITTED_STATES,
      });
      return;
    }

    // Validate optional obstruction (must be a boolean if present)
    let obstruction: boolean | undefined;
    if ('obstruction' in obj && obj['obstruction'] !== undefined) {
      if (typeof obj['obstruction'] !== 'boolean') {
        this.respond(res, 400, { error: 'obstruction must be a boolean' });
        return;
      }
      obstruction = obj['obstruction'];
    }

    // Apply state first, then obstruction.
    const newState = WIRE_TO_STATE[stateValue]!;
    handler.applyExternalState(newState);
    if (obstruction !== undefined) {
      handler.setObstruction(obstruction);
    }

    this.respond(res, 200, { state: handler.currentState });
  }

  // ─── Validation helpers ────────────────────────────────────────────────

  private isAuthenticated(req: http.IncomingMessage): boolean {
    const header = req.headers['x-auth-token'];
    // Reject absent or duplicate (array) headers.
    if (typeof header !== 'string') {
      return false;
    }
    const presented = Buffer.from(header, 'utf8');
    // timingSafeEqual requires equal-length buffers; compare lengths first but
    // still run the comparison to preserve constant time where possible.
    if (presented.length !== this.tokenBuffer.length) {
      return false;
    }
    return timingSafeEqual(presented, this.tokenBuffer);
  }

  private parseDoorId(url: string): string | null {
    // Expected path: /door/<doorId>/state
    const pathname = url.split('?')[0] ?? '';
    const match = pathname.match(/^\/door\/([^/]+)\/state\/?$/);
    if (!match) {
      return null;
    }
    return decodeURIComponent(match[1]!);
  }

  private readBody(req: http.IncomingMessage, callback: (err: string | null, body: string | null) => void): void {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) {
        return;
      }
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        callback(`Body exceeds ${MAX_BODY_BYTES} bytes`, null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) {
        return;
      }
      callback(null, Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', () => {
      if (!aborted) {
        aborted = true;
        callback('Error reading request body', null);
      }
    });
  }

  private resolveSourceIp(req: http.IncomingMessage): string {
    return req.socket?.remoteAddress ?? 'unknown';
  }

  private respond(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  }
}
