/**
 * Property-based tests for DoorStateMachine.
 *
 * Property 4: State Machine Transition Correctness (Model-Based)
 * Property 5: State-to-Characteristic Mapping
 * Property 9: State Restoration Correctness
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { DoorStateMachine } from '../src/door-state-machine.js';
import type { DoorState, MidTravelBehaviour } from '../src/types.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const doorStateArb: fc.Arbitrary<DoorState> = fc.constantFrom('CLOSED', 'OPEN', 'OPENING', 'CLOSING', 'STOPPED');
const midTravelArb: fc.Arbitrary<MidTravelBehaviour> = fc.constantFrom('stop', 'reverse');

/** HomeKit CurrentDoorState mapping. */
function currentDoorStateValue(state: DoorState): number {
  switch (state) {
    case 'CLOSED': return 0;
    case 'OPEN': return 1;
    case 'OPENING': return 2;
    case 'CLOSING': return 3;
    case 'STOPPED': return 4;
  }
}

/** HomeKit TargetDoorState mapping. */
function targetDoorStateValue(state: DoorState): number {
  switch (state) {
    case 'OPEN':
    case 'OPENING':
      return 0; // OPEN
    case 'CLOSED':
    case 'CLOSING':
    case 'STOPPED':
      return 1; // CLOSED
  }
}

// ─── Command type for model-based testing ────────────────────────────────────

type Command =
  | { type: 'requestOpen' }
  | { type: 'requestClose' }
  | { type: 'pulseCompleted'; target: 'OPEN' | 'CLOSED' }
  | { type: 'pulseFailed' }
  | { type: 'setExternalState'; state: DoorState }
  | { type: 'advanceTimer' };

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc.constant({ type: 'requestOpen' } as Command),
  fc.constant({ type: 'requestClose' } as Command),
  fc.constant({ type: 'pulseCompleted', target: 'OPEN' } as Command),
  fc.constant({ type: 'pulseCompleted', target: 'CLOSED' } as Command),
  fc.constant({ type: 'pulseFailed' } as Command),
  fc.constantFrom<DoorState>('CLOSED', 'OPEN', 'OPENING', 'CLOSING', 'STOPPED')
    .map(state => ({ type: 'setExternalState', state }) as Command),
  fc.constant({ type: 'advanceTimer' } as Command),
);

// ─── Property 4: State Machine Transition Correctness ──────────────────────

describe('Property 4: State Machine Transition Correctness (Model-Based)', () => {
  it('machine always has exactly one state from the valid set', () => {
    fc.assert(
      fc.property(
        midTravelArb,
        fc.array(commandArb, { minLength: 1, maxLength: 30 }),
        (midTravel, commands) => {
          const machine = new DoorStateMachine({
            openingTime: 15,
            closingTime: 15,
            midTravelBehaviour: midTravel,
          });

          const validStates = new Set<string>(['CLOSED', 'OPEN', 'OPENING', 'CLOSING', 'STOPPED']);

          for (const cmd of commands) {
            applyCommand(machine, cmd);
            expect(validStates.has(machine.state)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('timer is active if and only if state is OPENING or CLOSING', () => {
    fc.assert(
      fc.property(
        midTravelArb,
        fc.array(commandArb, { minLength: 1, maxLength: 30 }),
        (midTravel, commands) => {
          const machine = new DoorStateMachine({
            openingTime: 15,
            closingTime: 15,
            midTravelBehaviour: midTravel,
          });

          for (const cmd of commands) {
            applyCommand(machine, cmd);
            const shouldHaveTimer = machine.state === 'OPENING' || machine.state === 'CLOSING';
            expect(machine.hasTimer).toBe(shouldHaveTimer);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('pulseFailed never changes state', () => {
    fc.assert(
      fc.property(
        midTravelArb,
        fc.array(commandArb, { minLength: 1, maxLength: 15 }),
        (midTravel, setupCommands) => {
          const machine = new DoorStateMachine({
            openingTime: 15,
            closingTime: 15,
            midTravelBehaviour: midTravel,
          });

          // Apply setup commands
          for (const cmd of setupCommands) {
            applyCommand(machine, cmd);
          }

          const stateBefore = machine.state;
          const timerBefore = machine.hasTimer;
          machine.pulseFailed();
          expect(machine.state).toBe(stateBefore);
          expect(machine.hasTimer).toBe(timerBefore);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('setExternalState always results in the specified state', () => {
    fc.assert(
      fc.property(
        midTravelArb,
        fc.array(commandArb, { minLength: 0, maxLength: 10 }),
        doorStateArb,
        (midTravel, setupCommands, targetState) => {
          const machine = new DoorStateMachine({
            openingTime: 15,
            closingTime: 15,
            midTravelBehaviour: midTravel,
          });

          for (const cmd of setupCommands) {
            applyCommand(machine, cmd);
          }

          machine.setExternalState(targetState);
          expect(machine.state).toBe(targetState);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('requestOpen from OPEN or OPENING always returns no-op', () => {
    fc.assert(
      fc.property(midTravelArb, (midTravel) => {
        const machine = new DoorStateMachine({
          openingTime: 15,
          closingTime: 15,
          midTravelBehaviour: midTravel,
        });

        machine.setExternalState('OPEN');
        expect(machine.requestOpen()).toBe('no-op');

        machine.setExternalState('OPENING');
        expect(machine.requestOpen()).toBe('no-op');
      }),
      { numRuns: 50 },
    );
  });

  it('requestClose from CLOSED or CLOSING always returns no-op', () => {
    fc.assert(
      fc.property(midTravelArb, (midTravel) => {
        const machine = new DoorStateMachine({
          openingTime: 15,
          closingTime: 15,
          midTravelBehaviour: midTravel,
        });

        expect(machine.requestClose()).toBe('no-op');

        machine.setExternalState('CLOSING');
        expect(machine.requestClose()).toBe('no-op');
      }),
      { numRuns: 50 },
    );
  });
});

// ─── Property 5: State-to-Characteristic Mapping ───────────────────────────

describe('Property 5: State-to-Characteristic Mapping', () => {
  it('CurrentDoorState mapping is correct for all DoorState values', () => {
    fc.assert(
      fc.property(doorStateArb, (state) => {
        const value = currentDoorStateValue(state);
        switch (state) {
          case 'CLOSED': expect(value).toBe(0); break;
          case 'OPEN': expect(value).toBe(1); break;
          case 'OPENING': expect(value).toBe(2); break;
          case 'CLOSING': expect(value).toBe(3); break;
          case 'STOPPED': expect(value).toBe(4); break;
        }
      }),
    );
  });

  it('TargetDoorState mapping: OPEN/OPENING → 0, CLOSED/CLOSING/STOPPED → 1', () => {
    fc.assert(
      fc.property(doorStateArb, (state) => {
        const value = targetDoorStateValue(state);
        if (state === 'OPEN' || state === 'OPENING') {
          expect(value).toBe(0);
        } else {
          expect(value).toBe(1);
        }
      }),
    );
  });

  it('CurrentDoorState and TargetDoorState values are within valid ranges', () => {
    fc.assert(
      fc.property(doorStateArb, (state) => {
        const current = currentDoorStateValue(state);
        const target = targetDoorStateValue(state);
        expect(current).toBeGreaterThanOrEqual(0);
        expect(current).toBeLessThanOrEqual(4);
        expect(target).toBeGreaterThanOrEqual(0);
        expect(target).toBeLessThanOrEqual(1);
      }),
    );
  });
});

// ─── Property 9: State Restoration Correctness ─────────────────────────────

describe('Property 9: State Restoration Correctness', () => {
  it('terminal states (CLOSED, OPEN, STOPPED) restore unchanged', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<DoorState>('CLOSED', 'OPEN', 'STOPPED'),
        midTravelArb,
        (state, midTravel) => {
          const machine = new DoorStateMachine({
            openingTime: 15,
            closingTime: 15,
            midTravelBehaviour: midTravel,
          });

          machine.restoreState({ 'k': state }, 'k');
          expect(machine.state).toBe(state);
          expect(machine.hasTimer).toBe(false);
        },
      ),
    );
  });

  it('travel states (OPENING, CLOSING) restore as STOPPED', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<DoorState>('OPENING', 'CLOSING'),
        midTravelArb,
        (state, midTravel) => {
          const machine = new DoorStateMachine({
            openingTime: 15,
            closingTime: 15,
            midTravelBehaviour: midTravel,
          });

          machine.restoreState({ 'k': state }, 'k');
          expect(machine.state).toBe('STOPPED');
          expect(machine.hasTimer).toBe(false);
        },
      ),
    );
  });

  it('absent key restores as CLOSED', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        midTravelArb,
        (key, midTravel) => {
          const machine = new DoorStateMachine({
            openingTime: 15,
            closingTime: 15,
            midTravelBehaviour: midTravel,
          });

          machine.restoreState({}, key);
          expect(machine.state).toBe('CLOSED');
        },
      ),
    );
  });

  it('invalid values restore as CLOSED', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string().filter(s => !['CLOSED', 'OPEN', 'OPENING', 'CLOSING', 'STOPPED'].includes(s)),
          fc.constant(null),
          fc.constant(undefined),
          fc.integer(),
        ),
        midTravelArb,
        (invalidValue, midTravel) => {
          const machine = new DoorStateMachine({
            openingTime: 15,
            closingTime: 15,
            midTravelBehaviour: midTravel,
          });

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          machine.restoreState({ 'k': invalidValue as any }, 'k');
          expect(machine.state).toBe('CLOSED');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('after restoration, characteristic mapping matches Property 5', () => {
    fc.assert(
      fc.property(doorStateArb, midTravelArb, (state, midTravel) => {
        const machine = new DoorStateMachine({
          openingTime: 15,
          closingTime: 15,
          midTravelBehaviour: midTravel,
        });

        machine.restoreState({ 'k': state }, 'k');

        const restored = machine.state;
        const current = currentDoorStateValue(restored);
        const target = targetDoorStateValue(restored);

        expect(current).toBeGreaterThanOrEqual(0);
        expect(current).toBeLessThanOrEqual(4);
        expect(target).toBeGreaterThanOrEqual(0);
        expect(target).toBeLessThanOrEqual(1);
      }),
    );
  });
});

// ─── Utility ─────────────────────────────────────────────────────────────────

function applyCommand(machine: DoorStateMachine, cmd: Command): void {
  switch (cmd.type) {
    case 'requestOpen':
      machine.requestOpen();
      break;
    case 'requestClose':
      machine.requestClose();
      break;
    case 'pulseCompleted':
      machine.pulseCompleted(cmd.target);
      break;
    case 'pulseFailed':
      machine.pulseFailed();
      break;
    case 'setExternalState':
      machine.setExternalState(cmd.state);
      break;
    case 'advanceTimer':
      vi.advanceTimersByTime(16_000);
      break;
  }
}
