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
 * - 'one-push': single-button opener following a fixed cycle, where the next
 *   pulse's direction depends on the direction of the last movement:
 *
 *     CLOSED            --pulse-->  OPENING
 *     OPENING           --pulse-->  STOPPED   (stops, never reverses)
 *     STOPPED (was opening) --pulse-->  CLOSING
 *     CLOSING           --pulse-->  STOPPED
 *     STOPPED (was closing) --pulse-->  OPENING
 *     OPEN              --pulse-->  CLOSING
 *
 *   The direction of the last travel leg is held in auxiliary direction
 *   memory (`lastTravelDirection`), because DoorState.STOPPED carries none.
 */

import { EventEmitter } from 'events';
import type {
  DoorState,
  DoorStateChangeEvent,
  MidTravelBehaviour,
  PersistedState,
  TravelDirection,
} from './types.js';

/**
 * Action the caller should take after a request.
 *
 * 'unachievable' means the requested direction cannot be reached with a single
 * pulse — only possible on a 'one-push' opener stopped mid-travel, where the
 * next press moves the door the other way. The caller must not actuate.
 */
export type PulseAction = 'pulse' | 'no-op' | 'unachievable';

/**
 * What a single pulse does to a one-push opener, given where the door is and
 * how it last moved. Pure and total; returns 'UNKNOWN' when the door is
 * stopped mid-travel and the last travel direction is not known.
 */
export function nextOnePushOutcome(
  state: DoorState,
  lastDirection: TravelDirection | null,
): DoorState | 'UNKNOWN' {
  switch (state) {
    case 'CLOSED': return 'OPENING';
    case 'OPEN': return 'CLOSING';
    case 'OPENING': return 'STOPPED';
    case 'CLOSING': return 'STOPPED';
    case 'STOPPED':
      if (lastDirection === 'OPENING') {
        return 'CLOSING';
      }
      if (lastDirection === 'CLOSING') {
        return 'OPENING';
      }
      return 'UNKNOWN';
  }
}

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
  private _lastTravelDirection: TravelDirection | null = null;
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

  /**
   * Direction of the most recent travel leg, or null when unknown (after a
   * restart) or irrelevant (the door is at a terminal position). Auxiliary
   * data, not a door state: it is never persisted and is only read by the
   * 'one-push' logic and the HomeKit presentation layer.
   */
  get lastTravelDirection(): TravelDirection | null {
    return this._lastTravelDirection;
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
   * - 'one-push' mode → see `requestOnePush`; may return 'unachievable'
   */
  requestOpen(): PulseAction {
    if (this.midTravelBehaviour === 'one-push') {
      return this.requestOnePush('OPEN');
    }

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
   * - 'one-push' mode → see `requestOnePush`; may return 'unachievable'
   */
  requestClose(): PulseAction {
    if (this.midTravelBehaviour === 'one-push') {
      return this.requestOnePush('CLOSED');
    }

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

    if (this.midTravelBehaviour === 'one-push') {
      this.handleOnePushPulse(requestedTarget);
      return;
    }

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

    this.assignState(state);

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
   *
   * Direction memory is deliberately not persisted (it would change the state
   * file format), so it is left unknown after a restore. On a one-push door
   * that means the next request is honoured and its direction assumed.
   */
  restoreState(persisted: PersistedState, key: string): void {
    const savedState = persisted[key];
    const previous = this._state;

    this._lastTravelDirection = null;

    if (savedState === undefined || !isValidDoorState(savedState)) {
      // Missing or invalid → CLOSED
      this.assignState('CLOSED');
    } else if (savedState === 'OPENING' || savedState === 'CLOSING') {
      // Travel states → STOPPED (position unknown after restart)
      this.assignState('STOPPED');
    } else {
      this.assignState(savedState);
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

  // ─── One-push (single-button) cycle ────────────────────────────────────────

  /**
   * Decide the action for a request on a single-button opener.
   *
   * Exactly one pulse is ever reported; the plugin never sequences presses.
   * A request the next press cannot achieve returns 'unachievable' so the
   * caller actuates nothing.
   */
  private requestOnePush(target: 'OPEN' | 'CLOSED'): PulseAction {
    // Already satisfied — nothing to do (as in the other behaviours).
    if (target === 'OPEN' && (this._state === 'OPEN' || this._state === 'OPENING')) {
      return 'no-op';
    }
    if (target === 'CLOSED' && (this._state === 'CLOSED' || this._state === 'CLOSING')) {
      return 'no-op';
    }

    const outcome = nextOnePushOutcome(this._state, this._lastTravelDirection);

    // Direction unknown (post-restart, or a webhook set STOPPED): honour the
    // request rather than leaving the door inert, and assume it was reached.
    if (outcome === 'UNKNOWN') {
      return 'pulse';
    }

    // Interrupting travel stops the door — physically what the press does.
    if (outcome === 'STOPPED') {
      return 'pulse';
    }

    const wanted: DoorState = target === 'OPEN' ? 'OPENING' : 'CLOSING';
    return outcome === wanted ? 'pulse' : 'unachievable';
  }

  /**
   * Advance the single-button cycle after a successful pulse.
   *
   * The outcome is recomputed from the state at completion time, not from the
   * requested target, so a webhook correction landing between the request and
   * the pulse completing is respected. The requested target is only consulted
   * when the direction memory is unknown.
   */
  private handleOnePushPulse(requestedTarget: 'OPEN' | 'CLOSED'): void {
    const outcome = nextOnePushOutcome(this._state, this._lastTravelDirection);
    const next: DoorState = outcome === 'UNKNOWN'
      ? (requestedTarget === 'OPEN' ? 'OPENING' : 'CLOSING')
      : outcome;

    this.transitionTo(next, 'homekit');
  }

  /**
   * Move to `next`, maintaining the travel timer and direction memory.
   * Used by the one-push path only; 'stop' and 'reverse' keep their own
   * transition handlers untouched.
   */
  private transitionTo(next: DoorState, trigger: DoorStateChangeEvent['trigger']): void {
    const previous = this._state;

    this.cancelTimer();
    this.assignState(next);

    if (next === 'OPENING') {
      this.startTimer(this.openingTime * 1000, 'OPEN');
    } else if (next === 'CLOSING') {
      this.startTimer(this.closingTime * 1000, 'CLOSED');
    }

    if (previous !== next) {
      this.emitChange(previous, next, trigger);
    }
  }

  // ─── Internal State Transitions ────────────────────────────────────────────

  /**
   * The single place `_state` is assigned, so direction memory can never drift
   * from it: entering a travel state records the direction, reaching a
   * terminal position clears it, and STOPPED preserves whatever the
   * interrupted leg recorded.
   */
  private assignState(next: DoorState): void {
    this._state = next;

    if (next === 'OPENING' || next === 'CLOSING') {
      this._lastTravelDirection = next;
    } else if (next === 'OPEN' || next === 'CLOSED') {
      this._lastTravelDirection = null;
    }
  }

  private handleOpenPulse(previous: DoorState): void {
    switch (previous) {
      case 'CLOSED':
      case 'STOPPED':
        // Start opening
        this.cancelTimer();
        this.assignState('OPENING');
        this.startTimer(this.openingTime * 1000, 'OPEN');
        this.emitChange(previous, 'OPENING', 'homekit');
        break;

      case 'CLOSING':
        if (this.midTravelBehaviour === 'stop') {
          // Any pulse during travel → STOPPED
          this.cancelTimer();
          this.assignState('STOPPED');
          this.emitChange(previous, 'STOPPED', 'homekit');
        } else {
          // 'reverse' mode: opposite direction → reverse
          this.cancelTimer();
          this.assignState('OPENING');
          this.startTimer(this.openingTime * 1000, 'OPEN');
          this.emitChange(previous, 'OPENING', 'homekit');
        }
        break;

      case 'OPENING':
        if (this.midTravelBehaviour === 'stop') {
          // Pulse during same-direction travel in stop mode → STOPPED
          this.cancelTimer();
          this.assignState('STOPPED');
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
        this.assignState('CLOSING');
        this.startTimer(this.closingTime * 1000, 'CLOSED');
        this.emitChange(previous, 'CLOSING', 'homekit');
        break;

      case 'OPENING':
        if (this.midTravelBehaviour === 'stop') {
          // Any pulse during travel → STOPPED
          this.cancelTimer();
          this.assignState('STOPPED');
          this.emitChange(previous, 'STOPPED', 'homekit');
        } else {
          // 'reverse' mode: opposite direction → reverse
          this.cancelTimer();
          this.assignState('CLOSING');
          this.startTimer(this.closingTime * 1000, 'CLOSED');
          this.emitChange(previous, 'CLOSING', 'homekit');
        }
        break;

      case 'CLOSING':
        if (this.midTravelBehaviour === 'stop') {
          // Pulse during same-direction travel in stop mode → STOPPED
          this.cancelTimer();
          this.assignState('STOPPED');
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
      this.assignState(targetState);
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
