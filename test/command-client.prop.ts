/**
 * Property-based test for the CommandClient write-once invariant.
 *
 * Property 12: At-Most-Once Delivery Attempt
 * Validates Requirements 3.14, 3.15, 5.13.
 *
 * For any sequence of submissions, connects, closes and elapsed time, every
 * command the client accepts is written to a socket at most once, across every
 * socket the client ever creates. This is the invariant that makes the hold
 * across a reconnect safe on relays wired to a real garage door and real gates:
 * a second `setstate <relay>,1` would be a second press of the opener button.
 *
 * The companion invariant is that a command which resolved successfully was
 * written exactly once — the hold must not quietly swallow the request either.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { CommandClient, type SocketLike } from '../src/command-client.js';
import { ProtocolCodec } from '../src/protocol-codec.js';
import type { Logger } from '../src/logger.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Test double ───────────────────────────────────────────────────────────

type Listener = (...args: never[]) => void;

class MockSocket implements SocketLike {
  writes: string[] = [];
  connected = false;
  closed = false;
  private listeners: Record<string, Listener[]> = {};

  connect(): void {
    // Established explicitly by the script.
  }
  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }
  destroy(): void {
    this.closed = true;
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
    if (this.connected || this.closed) {
      return;
    }
    this.connected = true;
    (this.listeners['connect'] ?? []).forEach((l) => (l as () => void)());
  }
  emitData(data: string): void {
    (this.listeners['data'] ?? []).forEach((l) => (l as (b: Buffer) => void)(Buffer.from(data, 'utf8')));
  }
  emitClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.connected = false;
    (this.listeners['close'] ?? []).forEach((l) => (l as () => void)());
  }
}

// ─── Generators ────────────────────────────────────────────────────────────

/** One step of a scripted connection history. */
type Step =
  | { kind: 'submit' }
  | { kind: 'connect' }
  | { kind: 'close' }
  | { kind: 'respond' }
  | { kind: 'advance'; ms: number };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { arbitrary: fc.constant({ kind: 'submit' } as Step), weight: 3 },
  { arbitrary: fc.constant({ kind: 'connect' } as Step), weight: 2 },
  { arbitrary: fc.constant({ kind: 'close' } as Step), weight: 2 },
  { arbitrary: fc.constant({ kind: 'respond' } as Step), weight: 2 },
  {
    arbitrary: fc.constantFrom(1, 100, 1000, 2000, 3000, 6000, 31_000).map(
      (ms) => ({ kind: 'advance', ms }) as Step,
    ),
    weight: 3,
  },
);

// ─── Property ──────────────────────────────────────────────────────────────

describe('Property 12: a command is written at most once', () => {
  it('never writes any accepted command to a socket twice', async () => {
    // Guards against a vacuous property: if no generated script ever got a
    // command through, "written at most once" would hold trivially.
    let resolvedTotal = 0;
    let writtenTotal = 0;

    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 24 }), async (steps) => {
        const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const sockets: MockSocket[] = [];
        const client = new CommandClient('192.168.4.235', 4998, new ProtocolCodec(), log, () => {
          const s = new MockSocket();
          sockets.push(s);
          return s;
        });

        /** Submitted commands and whether each one resolved. */
        const submitted: Array<{ command: string; settled: Promise<'resolved' | 'rejected'> }> = [];
        let counter = 0;

        const latest = (): MockSocket | undefined => sockets[sockets.length - 1];

        for (const step of steps) {
          switch (step.kind) {
            case 'submit': {
              // Unique command strings, so a repeated write is unambiguous.
              const command = `getstate,1:${++counter}`;
              const settled = client
                .sendCommand(command)
                .then(() => 'resolved' as const)
                .catch(() => 'rejected' as const);
              submitted.push({ command, settled });
              break;
            }
            case 'connect':
              latest()?.emitConnect();
              break;
            case 'close':
              latest()?.emitClose();
              break;
            case 'respond':
              // Satisfies an in-flight getdevices block and resolves any other
              // in-flight command, which is enough to drive the queue along.
              latest()?.emitData('endlistdevices\r');
              break;
            case 'advance':
              await vi.advanceTimersByTimeAsync(step.ms);
              break;
          }
          await Promise.resolve();
        }

        await client.disconnect();
        await vi.advanceTimersByTimeAsync(10_000);
        const outcomes = await Promise.all(submitted.map((s) => s.settled));

        const writes = sockets.flatMap((s) => s.writes);
        for (const [index, { command }] of submitted.entries()) {
          const count = writes.filter((w) => w === `${command}\r`).length;
          expect(count).toBeLessThanOrEqual(1);
          writtenTotal += count;
          // A command that succeeded must have gone out exactly once: the hold
          // must not resolve a request it never actually sent.
          if (outcomes[index] === 'resolved') {
            resolvedTotal += 1;
            expect(count).toBe(1);
          }
        }
      }),
      { numRuns: 150 },
    );

    expect(writtenTotal).toBeGreaterThan(0);
    expect(resolvedTotal).toBeGreaterThan(0);
  });
});
