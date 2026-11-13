/**
 * HomeKit accessory handler for a single garage door.
 *
 * Binds a PlatformAccessory's GarageDoorOpener service to the DoorStateMachine
 * and PulseActuator. Maps DoorState → HomeKit characteristic values, handles
 * TargetDoorState writes (actuating a pulse), reflects state-machine changes
 * onto CurrentDoorState/TargetDoorState, and exposes obstruction detection for
 * webhook updates.
 *
 * Requirements: 1.2–1.5, 1.8, 5.1–5.10, 6.2–6.11, 8.7.
 */

import type {
  HapApiContainer,
  CharacteristicValue,
  PlatformAccessoryLike,
  ServiceLike,
} from './hap-types.js';
import type {
  DoorState,
  DoorStateChangeEvent,
  MidTravelBehaviour,
  TravelDirection,
  ValidatedDoorEntry,
} from './types.js';
import type { DoorStateMachine } from './door-state-machine.js';
import type { PulseActuator } from './pulse-actuator.js';
import type { WebhookDoorHandler } from './webhook-listener.js';
import type { Logger } from './logger.js';
import type { PersistenceStore } from './persistence-store.js';
import { persistenceKey } from './persistence-store.js';

/** Map a DoorState to the HAP CurrentDoorState characteristic value. */
export function toCurrentDoorState(state: DoorState): number {
  switch (state) {
    case 'CLOSED': return 1; // Characteristic.CurrentDoorState.CLOSED
    case 'OPEN': return 0; // OPEN
    case 'OPENING': return 2; // OPENING
    case 'CLOSING': return 3; // CLOSING
    case 'STOPPED': return 4; // STOPPED
  }
}

/** Map a DoorState to the HAP TargetDoorState characteristic value. */
export function toTargetDoorState(state: DoorState): number {
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

/**
 * Presentation choice for a one-push door that is internally STOPPED.
 *
 * 'HOLD_TRAVEL' — keep showing OPENING/CLOSING (the owner's stated preference).
 * 'OPEN'        — settle the tile on OPEN.
 *
 * This single constant is the whole switch: set it to 'OPEN' to change the
 * behaviour. Nothing else in the plugin needs to change, and no config option
 * is exposed for it.
 */
const ONE_PUSH_STOPPED_PRESENTATION: 'HOLD_TRAVEL' | 'OPEN' = 'HOLD_TRAVEL';

/**
 * Map the internal door state to the state HomeKit is shown. Pure and total.
 *
 * Identity for every state on a 'stop' or 'reverse' door, and for every state
 * other than STOPPED. A one-push door interrupted mid-travel is never shown as
 * STOPPED: it holds the travel direction it was last moving in, or settles on
 * OPEN when that direction is unknown (after a restart, for example) rather
 * than inventing one.
 */
export function presentDoorState(
  state: DoorState,
  midTravelBehaviour: MidTravelBehaviour,
  lastDirection: TravelDirection | null,
): DoorState {
  if (state !== 'STOPPED' || midTravelBehaviour !== 'one-push') {
    return state;
  }
  if (ONE_PUSH_STOPPED_PRESENTATION === 'OPEN') {
    return 'OPEN';
  }
  return lastDirection ?? 'OPEN';
}

export class GarageDoorAccessory implements WebhookDoorHandler {
  private readonly api: HapApiContainer;
  private readonly accessory: PlatformAccessoryLike;
  private readonly config: ValidatedDoorEntry;
  private readonly stateMachine: DoorStateMachine;
  private readonly actuator: PulseActuator;
  private readonly log: Logger;
  private readonly persistence: PersistenceStore;
  private readonly persistKey: string;

  private readonly service: ServiceLike;
  private obstructionDetected = false;

  constructor(
    api: HapApiContainer,
    accessory: PlatformAccessoryLike,
    config: ValidatedDoorEntry,
    stateMachine: DoorStateMachine,
    actuator: PulseActuator,
    persistence: PersistenceStore,
    log: Logger,
  ) {
    this.api = api;
    this.accessory = accessory;
    this.config = config;
    this.stateMachine = stateMachine;
    this.actuator = actuator;
    this.persistence = persistence;
    this.log = log;
    this.persistKey = persistenceKey(config.ipAddress, config.relay);

    const { Service, Characteristic } = this.api.hap;

    // AccessoryInformation
    const info =
      this.accessory.getService(Service.AccessoryInformation) ??
      this.accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Global Cache')
      .setCharacteristic(Characteristic.Model, 'iTach IP2CC')
      .setCharacteristic(Characteristic.SerialNumber, this.serialNumber());

    // GarageDoorOpener service
    this.service =
      this.accessory.getService(Service.GarageDoorOpener) ??
      this.accessory.addService(Service.GarageDoorOpener, config.name);

    this.service.setCharacteristic(Characteristic.Name, config.name);

    // Characteristic handlers
    this.service
      .getCharacteristic(Characteristic.TargetDoorState)
      .onSet((value) => this.handleTargetDoorStateSet(value));

    this.service
      .getCharacteristic(Characteristic.CurrentDoorState)
      .onGet(() => this.handleCurrentDoorStateGet());

    this.service
      .getCharacteristic(Characteristic.ObstructionDetected)
      .onGet(() => this.handleObstructionDetectedGet());

    // Reflect state-machine changes onto characteristics.
    this.stateMachine.on('stateChange', (event) => this.onStateChange(event));

    // Publish the initial characteristic values from the (restored) state.
    this.pushCharacteristics(this.stateMachine.state);
  }

  // ─── WebhookDoorHandler ──────────────────────────────────────────────────

  get currentState(): DoorState {
    return this.stateMachine.state;
  }

  applyExternalState(state: DoorState): void {
    this.stateMachine.setExternalState(state);
  }

  setObstruction(obstructed: boolean): void {
    this.obstructionDetected = obstructed;
    const { Characteristic } = this.api.hap;
    this.service.updateCharacteristic(Characteristic.ObstructionDetected, obstructed);
  }

  // ─── Characteristic handlers ─────────────────────────────────────────────

  /**
   * HomeKit TargetDoorState write. Determines whether a pulse is required,
   * actuates it, and advances the state machine on success. Throws (rejects)
   * on communication failure so HomeKit surfaces the error.
   */
  async handleTargetDoorStateSet(value: CharacteristicValue): Promise<void> {
    const wantsOpen = value === 0; // TargetDoorState.OPEN === 0

    const action = wantsOpen ? this.stateMachine.requestOpen() : this.stateMachine.requestClose();
    if (action === 'no-op') {
      // Nothing to do — write completes without error.
      return;
    }

    if (action === 'unachievable') {
      // One-push opener stopped mid-travel: the next press goes the other way,
      // and one press per request means there is nothing safe to actuate.
      const lastDirection = this.stateMachine.lastTravelDirection;
      const nextPress = lastDirection === 'OPENING' ? 'close' : 'open';
      this.log.warn(
        `Door "${this.config.name}" ignored a ${wantsOpen ? 'open' : 'close'} request: the door is ` +
        `stopped mid-travel (was ${String(lastDirection)}) and this single-button opener's next press ` +
        `will ${nextPress} it. One press per request, so nothing was actuated; press again to ${nextPress}.`,
      );
      // Re-assert the real situation so the Home app settles rather than
      // showing a target that never arrives.
      this.pushCharacteristics(this.stateMachine.state);
      return;
    }

    const target: 'OPEN' | 'CLOSED' = wantsOpen ? 'OPEN' : 'CLOSED';

    if (
      this.config.midTravelBehaviour === 'one-push' &&
      this.stateMachine.state === 'STOPPED' &&
      this.stateMachine.lastTravelDirection === null
    ) {
      this.log.warn(
        `Door "${this.config.name}" is stopped mid-travel with no record of the last travel ` +
        'direction (the direction is not persisted across restarts), so the direction of the next ' +
        `press cannot be known. Assuming this press ${wantsOpen ? 'opens' : 'closes'} the door; the ` +
        'reported state may be inverted until a full travel leg completes or a webhook corrects it.',
      );
    }

    try {
      await this.actuator.actuate(target);
      // Pulse succeeded — advance the state machine, which emits stateChange.
      this.stateMachine.pulseCompleted(target);
    } catch (err) {
      this.stateMachine.pulseFailed();
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(
        `Door "${this.config.name}" (${this.stateMachine.state}) pulse failed: ${truncate(message, 512)}`,
      );
      const { HapStatusError, HAPStatus } = this.api.hap;
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  handleCurrentDoorStateGet(): CharacteristicValue {
    return toCurrentDoorState(this.stateMachine.state);
  }

  handleObstructionDetectedGet(): boolean {
    return this.obstructionDetected;
  }

  // ─── State-machine reflection ────────────────────────────────────────────

  private onStateChange(event: DoorStateChangeEvent): void {
    this.log.info(
      `Door "${this.config.name}" ${event.previous} → ${event.current} (${event.trigger})`,
    );
    this.pushCharacteristics(event.current);

    // Persist the new state (best-effort; failures are logged, state retained).
    void this.persistence.save(this.persistKey, event.current).then((ok) => {
      if (!ok) {
        this.log.error(`Door "${this.config.name}" state ${event.current} could not be persisted`);
      }
    });
  }

  private pushCharacteristics(state: DoorState): void {
    const { Characteristic } = this.api.hap;
    const shown = presentDoorState(
      state,
      this.config.midTravelBehaviour,
      this.stateMachine.lastTravelDirection,
    );
    this.service.updateCharacteristic(Characteristic.CurrentDoorState, toCurrentDoorState(shown));
    // A presented STOPPED leaves TargetDoorState unchanged (Requirement 8.7).
    if (shown !== 'STOPPED') {
      this.service.updateCharacteristic(Characteristic.TargetDoorState, toTargetDoorState(shown));
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private serialNumber(): string {
    const sn = `${this.config.ipAddress}-${this.config.relay}`;
    return sn.length > 64 ? sn.slice(0, 64) : sn;
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
