/**
 * Door state machine for the iTach Garage Door plugin.
 *
 * Manages state transitions, travel timers, and mid-travel behaviour for a
 * single garage door. Emits `stateChange` events when the door state changes.
 *
 * State model:
 * - CLOSED: door is fully closed
 * - OPEN: door is fully open
 * - OPENING: door is travelling toward open (timer running)
 * - CLOSING: door is travelling toward closed (timer running)
 * - STOPPED: door stopped mid-travel (no timer)
 *
 * Mid-travel behaviours:
 * - 'stop': any pulse during travel → STOPPED
 * - 'reverse': pulse for opposite direction → reverses; same direction → no-op
 */

import { EventEmitter } from 'events';
import type { DoorState, DoorStateChangeEvent, MidTravelBehaviour, PersistedState } from './types.js';

/** Action the caller should take after a request. */
export type PulseAction = 'pulse' | 'no-op';

export interface DoorStateMachineOptions {
  /** Time in seconds for the door to travel from closed to open. */
  openingTime: number;
  /** Time in seconds for the door to travel from open to closed. */
  closingTime: number;
  /** Behaviour when a command arrives during travel. */
  midTravelBehaviour: MidTravelBehaviour;
}

/**
 * Events emitted by the state machine, as a map of event name to argument
 * tuple. Passed to EventEmitter's type parameter so `on` and `emit` are
 * checked without resorting to declaration merging.
 */
export interface DoorStateMachineEvents {
  stateChange: [event: DoorStateChangeEvent];
}

/**
 * Manages the logical state of a single garage door.
 *
 * The state machine does not directly control hardware — it returns pulse
 * actions that the caller (accessory handler) should execute, and accepts
 * notifications about pulse outcomes and external state changes.
 */
export class DoorStateMachine extends EventEmitter<DoorStateMachineEvents> {
  private _state: DoorState = 'CLOSED';
  private _travelTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly openingTime: number;
  private readonly closingTime: number;
  private readonly midTravelBehaviour: MidTravelBehaviour;

  constructor(options: DoorStateMachineOptions) {
    super();
    this.openingTime = options.openingTime;
    this.closingTime = options.closingTime;
    this.midTravelBehaviour = options.midTravelBehaviour;
  }

  /** Current door state. */
  get state(): DoorState {
    return this._state;
  }

  /** Whether a travel timer is currently active. */
  get hasTimer(): boolean {
    return this._travelTimer !== null;
  }

  // ─── Public Commands ───────────────────────────────────────────────────────

  /**
   * Request to open the door. Returns the action the caller should take.
   *
   * - CLOSED or STOPPED → 'pulse' (will transition to OPENING)
   * - OPEN or OPENING → 'no-op'
   * - CLOSING + 'stop' mode → 'pulse' (will transition to STOPPED)
   * - CLOSING + 'reverse' mode → 'pulse' (will transition to OPENING)
   */
  requestOpen(): PulseAction {
    switch (this._state) {
      case 'CLOSED':
      case 'STOPPED':
        return 'pulse';

      case 'OPEN':
      case 'OPENING':
        return 'no-op';

      case 'CLOSING':
        return 'pulse';
    }
  }

  /**
   * Request to close the door. Returns the action the caller should take.
   *
   * - OPEN or STOPPED → 'pulse' (will transition to CLOSING)
   * - CLOSED or CLOSING → 'no-op'
   * - OPENING + 'stop' mode → 'pulse' (will transition to STOPPED)
   * - OPENING + 'reverse' mode → 'pulse' (will transition to CLOSING)
   */
  requestClose(): PulseAction {
    switch (this._state) {
      case 'OPEN':
      case 'STOPPED':
        return 'pulse';

      case 'CLOSED':
      case 'CLOSING':
        return 'no-op';

      case 'OPENING':
        return 'pulse';
    }
  }

  /**
   * Called after a successful relay pulse. Drives the state transition based
   * on the requested target and current state.
   *
   * @param requestedTarget - The target state the pulse was meant to achieve ('OPEN' or 'CLOSED').
   */
  pulseCompleted(requestedTarget: 'OPEN' | 'CLOSED'): void {
    const previous = this._state;

    if (requestedTarget === 'OPEN') {
      this.handleOpenPulse(previous);
    } else {
      this.handleClosePulse(previous);
    }
  }

  /**
   * Called when a relay pulse fails (e.g., command timeout or TCP error).
   * Preserves the current state and any active timer.
   */
  pulseFailed(): void {
    // No state change — current state and timer are preserved.
  }

  /**
   * Override the current state from an external source (e.g., webhook).
   * Cancels any active travel timer and sets the state directly.
   */
  setExternalState(state: DoorState): void {
    const previous = this._state;
    this.cancelTimer();

    this._state = state;

    // Start a timer if the new state is a travel state
    if (state === 'OPENING') {
      this.startTimer(this.openingTime * 1000, 'OPEN');
    } else if (state === 'CLOSING') {
      this.startTimer(this.closingTime * 1000, 'CLOSED');
    }

    if (previous !== state) {
      this.emitChange(previous, state, 'webhook');
    }
  }

  /**
   * Restore state from persisted storage on startup.
   * OPENING/CLOSING states are restored as STOPPED (we can't know the position).
   * Invalid/missing states default to CLOSED.
   */
  restoreState(persisted: PersistedState, key: string): void {
    const savedState = persisted[key];
    const previous = this._state;

    if (savedState === undefined || !isValidDoorState(savedState)) {
      // Missing or invalid → CLOSED
      this._state = 'CLOSED';
    } else if (savedState === 'OPENING' || savedState === 'CLOSING') {
      // Travel states → STOPPED (position unknown after restart)
      this._state = 'STOPPED';
    } else {
      this._state = savedState;
    }

    if (previous !== this._state) {
      this.emitChange(previous, this._state, 'restore');
    }
  }

  /**
   * Cancel any active travel timer. Call during shutdown.
   */
  cancelTimer(): void {
    if (this._travelTimer !== null) {
      clearTimeout(this._travelTimer);
      this._travelTimer = null;
    }
  }

  // ─── Internal State Transitions ────────────────────────────────────────────

  private handleOpenPulse(previous: DoorState): void {
    switch (previous) {
      case 'CLOSED':
      case 'STOPPED':
        // Start opening
        this.cancelTimer();
        this._state = 'OPENING';
        this.startTimer(this.openingTime * 1000, 'OPEN');
        this.emitChange(previous, 'OPENING', 'homekit');
        break;

      case 'CLOSING':
        if (this.midTravelBehaviour === 'stop') {
          // Any pulse during travel → STOPPED
          this.cancelTimer();
          this._state = 'STOPPED';
          this.emitChange(previous, 'STOPPED', 'homekit');
        } else {
          // 'reverse' mode: opposite direction → reverse
          this.cancelTimer();
          this._state = 'OPENING';
          this.startTimer(this.openingTime * 1000, 'OPEN');
          this.emitChange(previous, 'OPENING', 'homekit');
        }
        break;

      case 'OPENING':
        if (this.midTravelBehaviour === 'stop') {
          // Pulse during same-direction travel in stop mode → STOPPED
          this.cancelTimer();
          this._state = 'STOPPED';
          this.emitChange(previous, 'STOPPED', 'homekit');
        }
        // 'reverse' mode + same direction = no-op (shouldn't reach here via requestOpen)
        break;

      case 'OPEN':
        // Already open — no-op
        break;
    }
  }

  private handleClosePulse(previous: DoorState): void {
    switch (previous) {
      case 'OPEN':
      case 'STOPPED':
        // Start closing
        this.cancelTimer();
        this._state = 'CLOSING';
        this.startTimer(this.closingTime * 1000, 'CLOSED');
        this.emitChange(previous, 'CLOSING', 'homekit');
        break;

      case 'OPENING':
        if (this.midTravelBehaviour === 'stop') {
          // Any pulse during travel → STOPPED
          this.cancelTimer();
          this._state = 'STOPPED';
          this.emitChange(previous, 'STOPPED', 'homekit');
        } else {
          // 'reverse' mode: opposite direction → reverse
          this.cancelTimer();
          this._state = 'CLOSING';
          this.startTimer(this.closingTime * 1000, 'CLOSED');
          this.emitChange(previous, 'CLOSING', 'homekit');
        }
        break;

      case 'CLOSING':
        if (this.midTravelBehaviour === 'stop') {
          // Pulse during same-direction travel in stop mode → STOPPED
          this.cancelTimer();
          this._state = 'STOPPED';
          this.emitChange(previous, 'STOPPED', 'homekit');
        }
        // 'reverse' mode + same direction = no-op (shouldn't reach here via requestClose)
        break;

      case 'CLOSED':
        // Already closed — no-op
        break;
    }
  }

  private startTimer(durationMs: number, targetState: 'OPEN' | 'CLOSED'): void {
    this._travelTimer = setTimeout(() => {
      this._travelTimer = null;
      const previous = this._state;
      this._state = targetState;
      this.emitChange(previous, targetState, 'timer');
    }, durationMs);

    // Prevent timer from keeping the Node.js process alive
    if (this._travelTimer.unref) {
      this._travelTimer.unref();
    }
  }

  private emitChange(previous: DoorState, current: DoorState, trigger: DoorStateChangeEvent['trigger']): void {
    this.emit('stateChange', { previous, current, trigger });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_DOOR_STATES: ReadonlySet<string> = new Set(['CLOSED', 'OPEN', 'OPENING', 'CLOSING', 'STOPPED']);

function isValidDoorState(value: unknown): value is DoorState {
  return typeof value === 'string' && VALID_DOOR_STATES.has(value);
}
