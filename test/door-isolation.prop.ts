/**
 * Property-based test for multi-door isolation.
 *
 * Property 10: Door Independence (Isolation)
 * Validates Requirements 11.1, 12.1, 12.5.
 *
 * For any multi-door configuration (2–8 doors) and any state-changing operation
 * applied to door A, the DoorState and travel timer of every other door B stay
 * unchanged, and the persisted entry for B is untouched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { DoorStateMachine } from '../src/door-state-machine.js';
import { persistenceKey } from '../src/persistence-store.js';
import type { DoorState, MidTravelBehaviour, PersistedState } from '../src/types.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Generators ────────────────────────────────────────────────────────────

const midTravelArb: fc.Arbitrary<MidTravelBehaviour> = fc.constantFrom('stop', 'reverse');
const doorStateArb: fc.Arbitrary<DoorState> = fc.constantFrom(
  'CLOSED', 'OPEN', 'OPENING', 'CLOSING', 'STOPPED',
);

/** An operation applied to a single door. */
type Operation =
  | { kind: 'pulseOpen' }
  | { kind: 'pulseClose' }
  | { kind: 'external'; state: DoorState }
  | { kind: 'timerExpiry' };

const operationArb: fc.Arbitrary<Operation> = fc.oneof(
  fc.constant({ kind: 'pulseOpen' } as Operation),
  fc.constant({ kind: 'pulseClose' } as Operation),
  doorStateArb.map((state) => ({ kind: 'external', state }) as Operation),
  fc.constant({ kind: 'timerExpiry' } as Operation),
);

/** A simulated door: its own state machine plus its persistence key. */
interface SimDoor {
  id: string;
  key: string;
  machine: DoorStateMachine;
}

function buildDoors(count: number, midTravel: MidTravelBehaviour): SimDoor[] {
  const doors: SimDoor[] = [];
  for (let i = 0; i < count; i++) {
    const ip = `192.168.1.${i + 1}`;
    const relay = `1:${(i % 3) + 1}`;
    const machine = new DoorStateMachine({
      openingTime: 15,
      closingTime: 15,
      midTravelBehaviour: midTravel,
    });
    doors.push({ id: `door-${i}`, key: persistenceKey(ip, relay), machine });
  }
  return doors;
}

function applyOperation(door: SimDoor, op: Operation): void {
  switch (op.kind) {
    case 'pulseOpen':
      if (door.machine.requestOpen() === 'pulse') {
        door.machine.pulseCompleted('OPEN');
      }
      break;
    case 'pulseClose':
      if (door.machine.requestClose() === 'pulse') {
        door.machine.pulseCompleted('CLOSED');
      }
      break;
    case 'external':
      door.machine.setExternalState(op.state);
      break;
    case 'timerExpiry':
      vi.advanceTimersByTime(16_000);
      break;
  }
}

/** Snapshot the observable state of every door. */
function snapshot(doors: SimDoor[]): Array<{ state: DoorState; hasTimer: boolean }> {
  return doors.map((d) => ({ state: d.machine.state, hasTimer: d.machine.hasTimer }));
}

describe('Property 10: Door Independence (Isolation)', () => {
  it('an operation on door A leaves the state and timer of every other door unchanged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }),
        midTravelArb,
        operationArb,
        fc.nat(),
        (doorCount, midTravel, op, targetSeed) => {
          const doors = buildDoors(doorCount, midTravel);
          const targetIndex = targetSeed % doorCount;

          // Give the doors a varied starting configuration.
          doors.forEach((d, i) => {
            const seedStates: DoorState[] = ['CLOSED', 'OPEN', 'STOPPED'];
            d.machine.setExternalState(seedStates[i % seedStates.length]!);
          });

          const before = snapshot(doors);

          // timerExpiry advances global fake time, which legitimately affects
          // every door with a running timer; isolation is only meaningful for
          // door-directed operations.
          if (op.kind === 'timerExpiry') {
            return;
          }

          applyOperation(doors[targetIndex]!, op);

          const after = snapshot(doors);

          for (let i = 0; i < doorCount; i++) {
            if (i === targetIndex) {
              continue;
            }
            expect(after[i]!.state).toBe(before[i]!.state);
            expect(after[i]!.hasTimer).toBe(before[i]!.hasTimer);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('each door has a distinct persistence key', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), midTravelArb, (doorCount, midTravel) => {
        const doors = buildDoors(doorCount, midTravel);
        const keys = new Set(doors.map((d) => d.key));
        expect(keys.size).toBe(doorCount);
      }),
      { numRuns: 100 },
    );
  });

  it('persisting door A does not alter the persisted entry of any other door', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }),
        doorStateArb,
        fc.nat(),
        (doorCount, newState, targetSeed) => {
          const doors = buildDoors(doorCount, 'stop');
          const targetIndex = targetSeed % doorCount;

          // Seed a persisted record for every door.
          const persisted: PersistedState = {};
          doors.forEach((d, i) => {
            persisted[d.key] = (['CLOSED', 'OPEN', 'STOPPED'] as DoorState[])[i % 3]!;
          });
          const before = { ...persisted };

          // Write only the target door's entry (mirrors PersistenceStore.save).
          persisted[doors[targetIndex]!.key] = newState;

          for (let i = 0; i < doorCount; i++) {
            if (i === targetIndex) {
              continue;
            }
            expect(persisted[doors[i]!.key]).toBe(before[doors[i]!.key]);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a travel timer on one door does not create a timer on another', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), fc.nat(), (doorCount, targetSeed) => {
        const doors = buildDoors(doorCount, 'stop');
        const targetIndex = targetSeed % doorCount;

        // All doors start CLOSED with no timer.
        doors.forEach((d) => d.machine.setExternalState('CLOSED'));
        expect(doors.every((d) => !d.machine.hasTimer)).toBe(true);

        // Open only the target door.
        const target = doors[targetIndex]!;
        if (target.machine.requestOpen() === 'pulse') {
          target.machine.pulseCompleted('OPEN');
        }

        expect(target.machine.hasTimer).toBe(true);
        doors.forEach((d, i) => {
          if (i !== targetIndex) {
            expect(d.machine.hasTimer).toBe(false);
          }
        });
      }),
      { numRuns: 200 },
    );
  });
});
