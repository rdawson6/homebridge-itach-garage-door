/**
 * Property-based test for WebhookListener.
 *
 * Property 11: Webhook Request Validation Pipeline Order (Requirement 9.9)
 *
 * For any HTTP request, the response status is determined by the first failing
 * check in the order: rate limit (429) → auth (401) → method (405) →
 * door ID (404) → body (400). No later check is evaluated once one fails.
 *
 * We drive the listener with synthetic req/res objects via an injected server
 * factory, so we can construct arbitrary combinations of failing conditions.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { EventEmitter } from 'events';
import { WebhookListener, type WebhookDoorHandler } from '../src/webhook-listener.js';
import type { DoorState } from '../src/types.js';
import type { Logger } from '../src/logger.js';

const TOKEN = 'property-test-token-abcdef123456'; // valid length

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeDoor(): WebhookDoorHandler {
  let state: DoorState = 'CLOSED';
  return {
    applyExternalState(s) { state = s; },
    setObstruction() { /* no-op */ },
    get currentState() { return state; },
  };
}

// ─── Synthetic req/res ─────────────────────────────────────────────────────

class FakeRequest extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  socket = { remoteAddress: '10.0.0.1' };
  private body: string;

  constructor(opts: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }) {
    super();
    this.method = opts.method;
    this.url = opts.url;
    this.headers = opts.headers;
    this.body = opts.body;
  }

  destroy(): void { /* no-op */ }

  /** Emit the body then end on next tick. */
  drive(): void {
    setImmediate(() => {
      if (this.body.length > 0) {
        this.emit('data', Buffer.from(this.body, 'utf8'));
      }
      this.emit('end');
    });
  }
}

class FakeResponse {
  statusCode = 0;
  private chunks: string[] = [];
  private resolver: ((r: { status: number; body: string }) => void) | null = null;

  writeHead(status: number): this {
    this.statusCode = status;
    return this;
  }

  end(data?: string): void {
    if (data) {
      this.chunks.push(data);
    }
    if (this.resolver) {
      this.resolver({ status: this.statusCode, body: this.chunks.join('') });
    }
  }

  onDone(): Promise<{ status: number; body: string }> {
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }
}

/**
 * Build a listener whose injected server captures the request handler so we
 * can invoke it directly with synthetic req/res pairs.
 */
function buildListener(clock: { now: number }): {
  invoke: (req: FakeRequest, res: FakeResponse) => void;
} {
  const doors = new Map<string, WebhookDoorHandler>([['front', makeDoor()]]);
  let capturedHandler: ((req: any, res: any) => void) | null = null;

  const listener = new WebhookListener({
    port: 0,
    bindAddress: '127.0.0.1',
    token: TOKEN,
    doors,
    log: makeLogger(),
    now: () => clock.now,
    createServer: (handler) => {
      capturedHandler = handler as unknown as (req: any, res: any) => void;
      // Return a minimal stub server; start() is not used in this test.
      return {
        listen: () => { /* no-op */ },
        close: (cb?: () => void) => cb?.(),
        on: () => { /* no-op */ },
        once: () => { /* no-op */ },
        removeAllListeners: () => { /* no-op */ },
        address: () => ({ port: 12345 }),
      } as any;
    },
  });

  // Trigger createServer by calling start (the stub never actually binds).
  void listener.start().catch(() => { /* ignore */ });

  return {
    invoke: (req, res) => {
      if (capturedHandler === null) {
        throw new Error('handler not captured');
      }
      capturedHandler(req, res);
      req.drive();
    },
  };
}

// ─── Generators for failing conditions ───────────────────────────────────

interface RequestSpec {
  rateLimitFail: boolean;
  authFail: boolean;
  methodFail: boolean;
  doorFail: boolean;
  bodyFail: boolean;
}

const requestSpecArb: fc.Arbitrary<RequestSpec> = fc.record({
  rateLimitFail: fc.boolean(),
  authFail: fc.boolean(),
  methodFail: fc.boolean(),
  doorFail: fc.boolean(),
  bodyFail: fc.boolean(),
});

/** Compute the expected status given which checks fail, honouring the order. */
function expectedStatus(spec: RequestSpec): number {
  if (spec.rateLimitFail) return 429;
  if (spec.authFail) return 401;
  if (spec.methodFail) return 405;
  if (spec.doorFail) return 404;
  if (spec.bodyFail) return 400;
  return 200;
}

describe('Property 11: Webhook Request Validation Pipeline Order', () => {
  it('response status is the first failing check in strict order', async () => {
    await fc.assert(
      fc.asyncProperty(requestSpecArb, async (spec) => {
        const clock = { now: 5_000_000 + Math.floor(Math.random() * 1_000_000) };
        const { invoke } = buildListener(clock);

        // If rate limit should fail, exhaust the window first (11 hits from same IP).
        // We do this by sending 10 valid-ish requests. But since each invoke is a
        // fresh listener, we instead simulate by pre-filling: send 10 requests
        // that pass rate limit, then the 11th fails. Simpler: for rateLimitFail,
        // fire 10 dummy requests before the measured one.
        if (spec.rateLimitFail) {
          for (let i = 0; i < 10; i++) {
            const dummyRes = new FakeResponse();
            const done = dummyRes.onDone();
            invoke(
              new FakeRequest({
                method: 'POST',
                url: '/door/front/state',
                headers: { 'x-auth-token': TOKEN, 'content-type': 'application/json' },
                body: JSON.stringify({ state: 'open' }),
              }),
              dummyRes,
            );
            await done;
          }
        }

        // Build the measured request per the spec.
        const method = spec.methodFail ? 'GET' : 'POST';
        const url = spec.doorFail ? '/door/unknown/state' : '/door/front/state';
        const headers: Record<string, string | string[] | undefined> = {};
        headers['x-auth-token'] = spec.authFail ? 'wrong-token-value-xxxx' : TOKEN;
        headers['content-type'] = 'application/json';
        const body = spec.bodyFail ? '{ invalid json' : JSON.stringify({ state: 'open' });

        const res = new FakeResponse();
        const done = res.onDone();
        invoke(new FakeRequest({ method, url, headers, body }), res);
        const result = await done;

        expect(result.status).toBe(expectedStatus(spec));
      }),
      { numRuns: 200 },
    );
  });

  it('a request that passes all checks returns 200', async () => {
    const clock = { now: 9_000_000 };
    const { invoke } = buildListener(clock);
    const res = new FakeResponse();
    const done = res.onDone();
    invoke(
      new FakeRequest({
        method: 'POST',
        url: '/door/front/state',
        headers: { 'x-auth-token': TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'open' }),
      }),
      res,
    );
    const result = await done;
    expect(result.status).toBe(200);
  });
});
