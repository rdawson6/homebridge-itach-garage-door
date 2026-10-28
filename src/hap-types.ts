/**
 * Minimal structural HAP / Homebridge type shims.
 *
 * Importing the `homebridge` package root into a NodeNext type-check pulls in
 * its full runtime type graph (hap-nodejs, dgram, streams, etc.), which makes
 * `tsc` extremely slow on some filesystems. Since the accessory handler only
 * touches a small surface of the API, we model exactly that surface here as
 * structural interfaces. At runtime Homebridge passes objects that satisfy
 * these shapes; the real `homebridge` types are structurally compatible.
 */

/** HomeKit characteristic values are primitives (we use numbers/booleans). */
export type CharacteristicValue = string | number | boolean;

/** A characteristic constructor reference (used as a lookup key). */
export type CharacteristicRef = unknown;

/** A service constructor reference (used as a lookup key). */
export type ServiceRef = unknown;

/** The characteristic object returned by getCharacteristic. */
export interface CharacteristicLike {
  onSet(handler: (value: CharacteristicValue) => void | Promise<void>): CharacteristicLike;
  onGet(handler: () => CharacteristicValue | Promise<CharacteristicValue>): CharacteristicLike;
}

/** A HomeKit service (e.g. GarageDoorOpener, AccessoryInformation). */
export interface ServiceLike {
  getCharacteristic(characteristic: CharacteristicRef): CharacteristicLike;
  setCharacteristic(characteristic: CharacteristicRef, value: CharacteristicValue): ServiceLike;
  updateCharacteristic(characteristic: CharacteristicRef, value: CharacteristicValue): ServiceLike;
}

/** A PlatformAccessory as used by the handler. */
export interface PlatformAccessoryLike {
  readonly UUID: string;
  displayName: string;
  getService(service: ServiceRef): ServiceLike | undefined;
  addService(service: ServiceRef, ...args: unknown[]): ServiceLike;
}

/** Constructor for HapStatusError, used to signal HomeKit failures. */
export interface HapStatusErrorConstructor {
  new (status: number): Error;
}

/**
 * The subset of `api.hap` the accessory relies on. The Service and
 * Characteristic namespaces expose the constructor references and the nested
 * characteristic value enums used for mapping.
 */
export interface HapApi {
  Service: {
    AccessoryInformation: ServiceRef;
    GarageDoorOpener: ServiceRef;
  };
  Characteristic: {
    Manufacturer: CharacteristicRef;
    Model: CharacteristicRef;
    SerialNumber: CharacteristicRef;
    Name: CharacteristicRef;
    CurrentDoorState: CharacteristicRef;
    TargetDoorState: CharacteristicRef;
    ObstructionDetected: CharacteristicRef;
  };
  HapStatusError: HapStatusErrorConstructor;
  HAPStatus: {
    SERVICE_COMMUNICATION_FAILURE: number;
  };
}

/** The subset of the Homebridge API object the accessory relies on. */
export interface HapApiContainer {
  readonly hap: HapApi;
}

// ─── Platform-level shims ────────────────────────────────────────────────────

/** Accessory category enum values used by the platform (GARAGE_DOOR_OPENER = 4). */
export const CATEGORY_GARAGE_DOOR_OPENER = 4;

/**
 * A constructable PlatformAccessory (matches Homebridge's exported
 * `api.platformAccessory` constructor). The category property is assignable.
 */
export interface PlatformAccessoryConstructable extends PlatformAccessoryLike {
  category: number;
}

export interface PlatformAccessoryConstructor {
  new (displayName: string, uuid: string): PlatformAccessoryConstructable;
}

/** Minimal HAP uuid helper. */
export interface HapUuidHelper {
  generate(data: string): string;
}

/** Full HAP surface exposed on `api.hap`, extending the accessory subset. */
export interface HapFull extends HapApi {
  uuid: HapUuidHelper;
  Categories: { GARAGE_DOOR_OPENER: number };
}

/** Homebridge lifecycle event names the platform subscribes to. */
export type ApiEventName = 'didFinishLaunching' | 'shutdown';

/**
 * The subset of the Homebridge `API` object the platform relies on. Homebridge's
 * real API object is structurally compatible with this interface.
 */
export interface HomebridgeApi {
  readonly hap: HapFull;
  readonly platformAccessory: PlatformAccessoryConstructor;
  readonly user: { storagePath(): string };
  on(event: ApiEventName, listener: () => void): void;
  registerPlatformAccessories(
    pluginIdentifier: string,
    platformName: string,
    accessories: PlatformAccessoryLike[],
  ): void;
  unregisterPlatformAccessories(
    pluginIdentifier: string,
    platformName: string,
    accessories: PlatformAccessoryLike[],
  ): void;
  updatePlatformAccessories(accessories: PlatformAccessoryLike[]): void;
}

/** The `user`-supplied platform config object (arbitrary shape). */
export interface PlatformConfigLike {
  [key: string]: unknown;
  platform?: string;
  name?: string;
}
