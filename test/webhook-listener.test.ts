/**
 * Unit tests for WebhookListener using a real HTTP server on an ephemeral port.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import { WebhookListener, type WebhookDoorHandler } from '../src/webhook-listener.js';
import type { DoorState } from '../src/types.js';
import type { Logger } from '../src/logger.js';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A simple in-memory door handler for assertions. */
class FakeDoor implements WebhookDoorHandler {
  currentState: DoorState = 'CLOSED';
  obstruction = false;
  stateCalls: DoorState[] = [];
  obstructionCalls: boolean[] = [];

  applyExternalState(state: DoorState): void {
    this.stateCalls.push(state);
    this.currentState = state;
  }

  setObstruction(obstructed: boolean): void {
    this.obstructionCalls.push(obstructed);
    this.obstruction = obstructed;
  }
}

const TOKEN = 'test-token-1234567890abcdef'; // 27 chars, valid length

interface Reply {
  status: number;
  body: any;
}

describe('WebhookListener', () => {
  let listener: WebhookListener;
  let door: FakeDoor;
  let doors: Map<string, WebhookDoorHandler>;
  let log: Logger;
  let boundPort: number;
  let clock: number;

  beforeEach(async () => {
    door = new FakeDoor();
    doors = new Map([['front', door]]);
    log = makeLogger();
    clock = 1_000_000;

    listener = new WebhookListener({
      port: 0, // ephemeral
      bindAddress: '127.0.0.1',
      token: TOKEN,
      doors,
      log,
      now: () => clock,
    });

    await listener.start();
    boundPort = getBoundPort(listener);
  });

  afterEach(async () => {
    await listener.stop();
  });

  // ─── Helper: make a request ──────────────────────────────────────────────

  function request(options: {
    method?: string;
    path?: string;
    token?: string | string[] | null;
    contentType?: string | null;
    body?: string;
  }): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = {};
      // Default to the valid token unless the test explicitly passes null.
      const token = options.token === undefined ? TOKEN : options.token;
      if (token !== null) {
        headers['X-Auth-Token'] = token;
      }
      if (options.contentType !== null) {
        headers['Content-Type'] = options.contentType ?? 'application/json';
      }
      const body = options.body ?? '';
      if (body.length > 0) {
        headers['Content-Length'] = Buffer.byteLength(body);
      }

      const req = http.request(
        {
          host: '127.0.0.1',
          port: boundPort,
          method: options.method ?? 'POST',
          path: options.path ?? '/door/front/state',
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: any = text;
            try {
              parsed = JSON.parse(text);
            } catch {
              // leave as text
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('error', reject);
      if (body.length > 0) {
        req.write(body);
      }
      req.end();
    });
  }

  // ─── Valid state updates ─────────────────────────────────────────────────

  describe('valid state updates', () => {
    it.each([
      ['open', 'OPEN'],
      ['closed', 'CLOSED'],
      ['opening', 'OPENING'],
      ['closing', 'CLOSING'],
      ['stopped', 'STOPPED'],
    ])('accepts state "%s" and returns 200 with resulting state', async (wire, expected) => {
      const reply = await request({ body: JSON.stringify({ state: wire }) });
      expect(reply.status).toBe(200);
      expect(reply.body.state).toBe(expected);
      expect(door.stateCalls).toContain(expected as DoorState);
    });
  });

  // ─── Authentication ──────────────────────────────────────────────────────

  describe('authentication', () => {
    it('rejects missing token with 401', async () => {
      const reply = await request({ token: null, body: JSON.stringify({ state: 'open' }) });
      expect(reply.status).toBe(401);
      expect(door.stateCalls).toHaveLength(0);
    });

    it('rejects wrong token with 401', async () => {
      const reply = await request({ token: 'wrong-token-abcdefghij', body: JSON.stringify({ state: 'open' }) });
      expect(reply.status).toBe(401);
    });

    it('rejects duplicate token headers with 401', async () => {
      const reply = await request({ token: [TOKEN, TOKEN], body: JSON.stringify({ state: 'open' }) });
      expect(reply.status).toBe(401);
    });

    it('401 response does not reveal whether door exists', async () => {
      const unknownDoor = await request({
        token: null,
        path: '/door/nonexistent/state',
        body: JSON.stringify({ state: 'open' }),
      });
      const knownDoor = await request({ token: null, body: JSON.stringify({ state: 'open' }) });
      expect(unknownDoor.status).toBe(401);
      expect(knownDoor.status).toBe(401);
    });
  });

  // ─── HTTP method ───────────────────────────────────────────────────────

  describe('HTTP method', () => {
    it('rejects GET with 405', async () => {
      const reply = await request({ method: 'GET' });
      expect(reply.status).toBe(405);
    });

    it('rejects PUT with 405', async () => {
      const reply = await request({ method: 'PUT', body: JSON.stringify({ state: 'open' }) });
      expect(reply.status).toBe(405);
    });
  });

  // ─── Door lookup ─────────────────────────────────────────────────────────

  describe('door lookup', () => {
    it('returns 404 for unknown door', async () => {
      const reply = await request({ path: '/door/unknown/state', body: JSON.stringify({ state: 'open' }) });
      expect(reply.status).toBe(404);
    });

    it('returns 404 for malformed path', async () => {
      const reply = await request({ path: '/wrong/path', body: JSON.stringify({ state: 'open' }) });
      expect(reply.status).toBe(404);
    });
  });

  // ─── Body validation ─────────────────────────────────────────────────────

  describe('body validation', () => {
    it('rejects wrong content-type with 400', async () => {
      const reply = await request({ contentType: 'text/plain', body: JSON.stringify({ state: 'open' }) });
      expect(reply.status).toBe(400);
    });

    it('rejects malformed JSON with 400', async () => {
      const reply = await request({ body: '{ not json' });
      expect(reply.status).toBe(400);
    });

    it('rejects missing state with 400 naming permitted values', async () => {
      const reply = await request({ body: JSON.stringify({ foo: 'bar' }) });
      expect(reply.status).toBe(400);
      expect(reply.body.permitted).toContain('open');
    });

    it('rejects invalid state value with 400', async () => {
      const reply = await request({ body: JSON.stringify({ state: 'ajar' }) });
      expect(reply.status).toBe(400);
    });

    it('rejects oversized body with 400', async () => {
      const bigBody = JSON.stringify({ state: 'open', pad: 'x'.repeat(2000) });
      const reply = await request({ body: bigBody });
      expect(reply.status).toBe(400);
    });

    it('rejects JSON array body with 400', async () => {
      const reply = await request({ body: JSON.stringify(['open']) });
      expect(reply.status).toBe(400);
    });
  });

  // ─── Obstruction ──────────────────────────────────────────────────────

  describe('obstruction handling', () => {
    it('sets obstruction true', async () => {
      const reply = await request({ body: JSON.stringify({ state: 'open', obstruction: true }) });
      expect(reply.status).toBe(200);
      expect(door.obstructionCalls).toContain(true);
    });

    it('sets obstruction false', async () => {
      const reply = await request({ body: JSON.stringify({ state: 'closed', obstruction: false }) });
      expect(reply.status).toBe(200);
      expect(door.obstructionCalls).toContain(false);
    });

    it('leaves obstruction unchanged when absent', async () => {
      const reply = await request({ body: JSON.stringify({ state: 'open' }) });
      expect(reply.status).toBe(200);
      expect(door.obstructionCalls).toHaveLength(0);
    });

    it('rejects non-boolean obstruction with 400 and does not change state', async () => {
      const reply = await request({ body: JSON.stringify({ state: 'open', obstruction: 'yes' }) });
      expect(reply.status).toBe(400);
      expect(door.stateCalls).toHaveLength(0);
      expect(door.obstructionCalls).toHaveLength(0);
    });
  });

  // ─── Rate limiting ─────────────────────────────────────────────────────

  describe('rate limiting', () => {
    it('returns 429 on the 11th request within a window', async () => {
      // Clock is fixed, so all requests fall in one window.
      for (let i = 0; i < 10; i++) {
        const reply = await request({ body: JSON.stringify({ state: 'open' }) });
        expect(reply.status).toBe(200);
      }
      const eleventh = await request({ body: JSON.stringify({ state: 'open' }) });
      expect(eleventh.status).toBe(429);
    });

    it('allows requests again after the window advances', async () => {
      for (let i = 0; i < 10; i++) {
        await request({ body: JSON.stringify({ state: 'open' }) });
      }
      expect((await request({ body: JSON.stringify({ state: 'open' }) })).status).toBe(429);

      // Advance the clock beyond the window
      clock += 1001;
      const reply = await request({ body: JSON.stringify({ state: 'open' }) });
      expect(reply.status).toBe(200);
    });
  });

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('reports isListening true while running', () => {
      expect(listener.isListening).toBe(true);
    });

    it('stops cleanly', async () => {
      await listener.stop();
      expect(listener.isListening).toBe(false);
    });

    it('logs bound address and port at info level', () => {
      expect(log.info).toHaveBeenCalled();
    });
  });
});

// ─── Utility to read the OS-assigned port ────────────────────────────────────

function getBoundPort(listener: WebhookListener): number {
  // Access the private server via a controlled cast for testing.
  const server = (listener as unknown as { server: http.Server }).server;
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('Could not determine bound port');
  }
  return addr.port;
}
