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
import type { DoorState, DoorStateChangeEvent, ValidatedDoorEntry } from './types.js';
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

    const target: 'OPEN' | 'CLOSED' = wantsOpen ? 'OPEN' : 'CLOSED';

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
    this.service.updateCharacteristic(Characteristic.CurrentDoorState, toCurrentDoorState(state));
    // STOPPED leaves TargetDoorState unchanged (Requirement 8.7).
    if (state !== 'STOPPED') {
      this.service.updateCharacteristic(Characteristic.TargetDoorState, toTargetDoorState(state));
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
