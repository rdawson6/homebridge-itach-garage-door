/**
 * Unit tests for DoorStateMachine.
 *
 * Tests specific sequences: full open/close cycles, mid-travel behaviour,
 * webhook overrides, pulse failures, and state restoration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DoorStateMachine } from '../src/door-state-machine.js';
import type { DoorStateChangeEvent } from '../src/types.js';

describe('DoorStateMachine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createMachine(opts?: Partial<{ openingTime: number; closingTime: number; midTravelBehaviour: 'stop' | 'reverse' }>) {
    return new DoorStateMachine({
      openingTime: opts?.openingTime ?? 15,
      closingTime: opts?.closingTime ?? 15,
      midTravelBehaviour: opts?.midTravelBehaviour ?? 'stop',
    });
  }

  function collectEvents(machine: DoorStateMachine): DoorStateChangeEvent[] {
    const events: DoorStateChangeEvent[] = [];
    machine.on('stateChange', (e) => events.push(e));
    return events;
  }

  // ─── Full Open Cycle ─────────────────────────────────────────────────────

  describe('full open cycle', () => {
    it('CLOSED → requestOpen → pulse → OPENING → timer → OPEN', () => {
      const machine = createMachine();
      const events = collectEvents(machine);

      expect(machine.state).toBe('CLOSED');
      const action = machine.requestOpen();
      expect(action).toBe('pulse');

      machine.pulseCompleted('OPEN');
      expect(machine.state).toBe('OPENING');
      expect(machine.hasTimer).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ previous: 'CLOSED', current: 'OPENING', trigger: 'homekit' });

      // Advance timer to completion
      vi.advanceTimersByTime(15_000);
      expect(machine.state).toBe('OPEN');
      expect(machine.hasTimer).toBe(false);
      expect(events).toHaveLength(2);
      expect(events[1]).toEqual({ previous: 'OPENING', current: 'OPEN', trigger: 'timer' });
    });
  });

  // ─── Full Close Cycle ────────────────────────────────────────────────────

  describe('full close cycle', () => {
    it('OPEN → requestClose → pulse → CLOSING → timer → CLOSED', () => {
      const machine = createMachine();
      const events = collectEvents(machine);

      // Get to OPEN state
      machine.setExternalState('OPEN');
      events.length = 0; // Clear setup events

      expect(machine.state).toBe('OPEN');
      const action = machine.requestClose();
      expect(action).toBe('pulse');

      machine.pulseCompleted('CLOSED');
      expect(machine.state).toBe('CLOSING');
      expect(machine.hasTimer).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ previous: 'OPEN', current: 'CLOSING', trigger: 'homekit' });

      vi.advanceTimersByTime(15_000);
      expect(machine.state).toBe('CLOSED');
      expect(machine.hasTimer).toBe(false);
      expect(events).toHaveLength(2);
      expect(events[1]).toEqual({ previous: 'CLOSING', current: 'CLOSED', trigger: 'timer' });
    });
  });

  // ─── No-op Cases ─────────────────────────────────────────────────────────

  describe('no-op cases', () => {
    it('requestOpen when already OPEN returns no-op', () => {
      const machine = createMachine();
      machine.setExternalState('OPEN');
      expect(machine.requestOpen()).toBe('no-op');
    });

    it('requestOpen when OPENING returns no-op', () => {
      const machine = createMachine();
      machine.requestOpen();
      machine.pulseCompleted('OPEN');
      expect(machine.state).toBe('OPENING');
      expect(machine.requestOpen()).toBe('no-op');
    });

    it('requestClose when already CLOSED returns no-op', () => {
      const machine = createMachine();
      expect(machine.requestClose()).toBe('no-op');
    });

    it('requestClose when CLOSING returns no-op', () => {
      const machine = createMachine();
      machine.setExternalState('OPEN');
      machine.requestClose();
      machine.pulseCompleted('CLOSED');
      expect(machine.state).toBe('CLOSING');
      expect(machine.requestClose()).toBe('no-op');
    });
  });

  // ─── Mid-Travel: Stop Mode ──────────────────────────────────────────────

  describe('mid-travel stop mode', () => {
    it('OPENING + requestClose → pulse → STOPPED', () => {
      const machine = createMachine({ midTravelBehaviour: 'stop' });
      const events = collectEvents(machine);

      machine.requestOpen();
      machine.pulseCompleted('OPEN');
      expect(machine.state).toBe('OPENING');
      events.length = 0;

      const action = machine.requestClose();
      expect(action).toBe('pulse');

      machine.pulseCompleted('CLOSED');
      expect(machine.state).toBe('STOPPED');
      expect(machine.hasTimer).toBe(false);
      expect(events[0]).toEqual({ previous: 'OPENING', current: 'STOPPED', trigger: 'homekit' });
    });

    it('CLOSING + requestOpen → pulse → STOPPED', () => {
      const machine = createMachine({ midTravelBehaviour: 'stop' });
      machine.setExternalState('OPEN');

      machine.requestClose();
      machine.pulseCompleted('CLOSED');
      expect(machine.state).toBe('CLOSING');

      const events = collectEvents(machine);
      const action = machine.requestOpen();
      expect(action).toBe('pulse');

      machine.pulseCompleted('OPEN');
      expect(machine.state).toBe('STOPPED');
      expect(machine.hasTimer).toBe(false);
      expect(events[0]).toEqual({ previous: 'CLOSING', current: 'STOPPED', trigger: 'homekit' });
    });

    it('STOPPED + requestOpen → pulse → OPENING', () => {
      const machine = createMachine({ midTravelBehaviour: 'stop' });
      machine.setExternalState('STOPPED');

      const action = machine.requestOpen();
      expect(action).toBe('pulse');

      machine.pulseCompleted('OPEN');
      expect(machine.state).toBe('OPENING');
      expect(machine.hasTimer).toBe(true);
    });

    it('STOPPED + requestClose → pulse → CLOSING', () => {
      const machine = createMachine({ midTravelBehaviour: 'stop' });
      machine.setExternalState('STOPPED');

      const action = machine.requestClose();
      expect(action).toBe('pulse');

      machine.pulseCompleted('CLOSED');
      expect(machine.state).toBe('CLOSING');
      expect(machine.hasTimer).toBe(true);
    });
  });

  // ─── Mid-Travel: Reverse Mode ──────────────────────────────────────────

  describe('mid-travel reverse mode', () => {
    it('OPENING + requestClose → pulse → CLOSING (reverses)', () => {
      const machine = createMachine({ midTravelBehaviour: 'reverse' });
      const events = collectEvents(machine);

      machine.requestOpen();
      machine.pulseCompleted('OPEN');
      expect(machine.state).toBe('OPENING');
      events.length = 0;

      const action = machine.requestClose();
      expect(action).toBe('pulse');

      machine.pulseCompleted('CLOSED');
      expect(machine.state).toBe('CLOSING');
      expect(machine.hasTimer).toBe(true);
      expect(events[0]).toEqual({ previous: 'OPENING', current: 'CLOSING', trigger: 'homekit' });
    });

    it('CLOSING + requestOpen → pulse → OPENING (reverses)', () => {
      const machine = createMachine({ midTravelBehaviour: 'reverse' });
      machine.setExternalState('OPEN');

      machine.requestClose();
      machine.pulseCompleted('CLOSED');
      expect(machine.state).toBe('CLOSING');

      const events = collectEvents(machine);
      const action = machine.requestOpen();
      expect(action).toBe('pulse');

      machine.pulseCompleted('OPEN');
      expect(machine.state).toBe('OPENING');
      expect(machine.hasTimer).toBe(true);
      expect(events[0]).toEqual({ previous: 'CLOSING', current: 'OPENING', trigger: 'homekit' });
    });

    it('OPENING + requestOpen → no-op (same direction)', () => {
      const machine = createMachine({ midTravelBehaviour: 'reverse' });
      machine.requestOpen();
      machine.pulseCompleted('OPEN');
      expect(machine.state).toBe('OPENING');
      expect(machine.requestOpen()).toBe('no-op');
    });

    it('CLOSING + requestClose → no-op (same direction)', () => {
      const machine = createMachine({ midTravelBehaviour: 'reverse' });
      machine.setExternalState('OPEN');
      machine.requestClose();
      machine.pulseCompleted('CLOSED');
      expect(machine.state).toBe('CLOSING');
      expect(machine.requestClose()).toBe('no-op');
    });

    it('reversed travel uses correct timer duration', () => {
      const machine = createMachine({ midTravelBehaviour: 'reverse', openingTime: 10, closingTime: 20 });

      // Start closing (20s timer)
      machine.setExternalState('OPEN');
      machine.requestClose();
      machine.pulseCompleted('CLOSED');
      expect(machine.state).toBe('CLOSING');

      // Reverse to opening (10s timer)
      machine.requestOpen();
      machine.pulseCompleted('OPEN');
      expect(machine.state).toBe('OPENING');

      // Should not be OPEN at 9s
      vi.advanceTimersByTime(9_000);
      expect(machine.state).toBe('OPENING');

      // Should be OPEN at 10s
      vi.advanceTimersByTime(1_000);
      expect(machine.state).toBe('OPEN');
    });
  });

  // ─── Webhook Override ────────────────────────────────────────────────────

  describe('setExternalState (webhook override)', () => {
    it('OPENING + webhook(CLOSED) → CLOSED, timer cancelled', () => {
      const machine = createMachine();
      const events = collectEvents(machine);

      machine.requestOpen();
      machine.pulseCompleted('OPEN');
      expect(machine.state).toBe('OPENING');
      expect(machine.hasTimer).toBe(true);
      events.length = 0;

      machine.setExternalState('CLOSED');
      expect(machine.state).toBe('CLOSED');
      expect(machine.hasTimer).toBe(false);
      expect(events[0]).toEqual({ previous: 'OPENING', current: 'CLOSED', trigger: 'webhook' });
    });

    it('CLOSING + webhook(OPEN) → OPEN, timer cancelled', () => {
      const machine = createMachine();
      machine.setExternalState('OPEN');
      machine.requestClose();
      machine.pulseCompleted('CLOSED');
      expect(machine.state).toBe('CLOSING');
      expect(machine.hasTimer).toBe(true);

      const events = collectEvents(machine);
      machine.setExternalState('OPEN');
      expect(machine.state).toBe('OPEN');
      expect(machine.hasTimer).toBe(false);
      expect(events[0]).toEqual({ previous: 'CLOSING', current: 'OPEN', trigger: 'webhook' });
    });

    it('webhook with same state does not emit event', () => {
      const machine = createMachine();
      const events = collectEvents(machine);

      machine.setExternalState('CLOSED');
      expect(events).toHaveLength(0);
    });

    it('webhook OPENING starts a timer', () => {
      const machine = createMachine({ openingTime: 12 });
      machine.setExternalState('OPENING');
      expect(machine.state).toBe('OPENING');
      expect(machine.hasTimer).toBe(true);

      vi.advanceTimersByTime(12_000);
      expect(machine.state).toBe('OPEN');
    });

    it('webhook CLOSING starts a timer', () => {
      const machine = createMachine({ closingTime: 8 });
      machine.setExternalState('OPEN');
      machine.setExternalState('CLOSING');
      expect(machine.state).toBe('CLOSING');
      expect(machine.hasTimer).toBe(true);

      vi.advanceTimersByTime(8_000);
      expect(machine.state).toBe('CLOSED');
    });
  });

  // ─── Pulse Failed ───────────────────────────────────────────────────────

  describe('pulseFailed', () => {
    it('preserves CLOSED state', () => {
      const machine = createMachine();
      machine.pulseFailed();
      expect(machine.state).toBe('CLOSED');
    });

    it('preserves OPENING state and timer', () => {
      const machine = createMachine();
      machine.requestOpen();
      machine.pulseCompleted('OPEN');
      expect(machine.state).toBe('OPENING');
      expect(machine.hasTimer).toBe(true);

      machine.pulseFailed();
      expect(machine.state).toBe('OPENING');
      expect(machine.hasTimer).toBe(true);

      // Timer still works after failure
      vi.advanceTimersByTime(15_000);
      expect(machine.state).toBe('OPEN');
    });

    it('does not emit events', () => {
      const machine = createMachine();
      const events = collectEvents(machine);
      machine.pulseFailed();
      expect(events).toHaveLength(0);
    });
  });

  // ─── State Restoration ──────────────────────────────────────────────────

  describe('restoreState', () => {
    it('restores CLOSED unchanged', () => {
      const machine = createMachine();
      machine.restoreState({ 'key': 'CLOSED' }, 'key');
      expect(machine.state).toBe('CLOSED');
    });

    it('restores OPEN unchanged', () => {
      const machine = createMachine();
      machine.restoreState({ 'key': 'OPEN' }, 'key');
      expect(machine.state).toBe('OPEN');
    });

    it('restores STOPPED unchanged', () => {
      const machine = createMachine();
      machine.restoreState({ 'key': 'STOPPED' }, 'key');
      expect(machine.state).toBe('STOPPED');
    });

    it('OPENING → STOPPED on restore', () => {
      const machine = createMachine();
      const events = collectEvents(machine);
      machine.restoreState({ 'key': 'OPENING' }, 'key');
      expect(machine.state).toBe('STOPPED');
      expect(machine.hasTimer).toBe(false);
      expect(events[0]).toEqual({ previous: 'CLOSED', current: 'STOPPED', trigger: 'restore' });
    });

    it('CLOSING → STOPPED on restore', () => {
      const machine = createMachine();
      const events = collectEvents(machine);
      machine.restoreState({ 'key': 'CLOSING' }, 'key');
      expect(machine.state).toBe('STOPPED');
      expect(events[0]).toEqual({ previous: 'CLOSED', current: 'STOPPED', trigger: 'restore' });
    });

    it('missing key → CLOSED (default)', () => {
      const machine = createMachine();
      machine.restoreState({}, 'missing-key');
      expect(machine.state).toBe('CLOSED');
    });

    it('invalid value → CLOSED (default)', () => {
      const machine = createMachine();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      machine.restoreState({ 'key': 'INVALID' as any }, 'key');
      expect(machine.state).toBe('CLOSED');
    });

    it('does not emit when state unchanged (CLOSED → CLOSED)', () => {
      const machine = createMachine();
      const events = collectEvents(machine);
      machine.restoreState({ 'key': 'CLOSED' }, 'key');
      expect(events).toHaveLength(0);
    });
  });

  // ─── Cancel Timer ───────────────────────────────────────────────────────

  describe('cancelTimer', () => {
    it('cancels active travel timer', () => {
      const machine = createMachine();
      machine.requestOpen();
      machine.pulseCompleted('OPEN');
      expect(machine.hasTimer).toBe(true);

      machine.cancelTimer();
      expect(machine.hasTimer).toBe(false);

      // Timer should not fire
      vi.advanceTimersByTime(20_000);
      expect(machine.state).toBe('OPENING');
    });

    it('no-op when no timer active', () => {
      const machine = createMachine();
      expect(() => machine.cancelTimer()).not.toThrow();
    });
  });

  // ─── Custom Timing ──────────────────────────────────────────────────────

  describe('custom timing', () => {
    it('uses configured openingTime', () => {
      const machine = createMachine({ openingTime: 30 });
      machine.requestOpen();
      machine.pulseCompleted('OPEN');

      vi.advanceTimersByTime(29_000);
      expect(machine.state).toBe('OPENING');

      vi.advanceTimersByTime(1_000);
      expect(machine.state).toBe('OPEN');
    });

    it('uses configured closingTime', () => {
      const machine = createMachine({ closingTime: 20 });
      machine.setExternalState('OPEN');
      machine.requestClose();
      machine.pulseCompleted('CLOSED');

      vi.advanceTimersByTime(19_000);
      expect(machine.state).toBe('CLOSING');

      vi.advanceTimersByTime(1_000);
      expect(machine.state).toBe('CLOSED');
    });
  });
});
