/**
 * ItachGarageDoorPlatform — the top-level Homebridge dynamic platform.
 *
 * Orchestrates configuration validation, persistence, per-address:port command
 * client pooling, per-door state machines / actuators / accessories, the
 * webhook listener, and graceful shutdown.
 *
 * Requirements: 1.1, 1.6–1.11, 12.1–12.7, 14.7, 14.8.
 */

import { ProtocolCodec } from './protocol-codec.js';
import { CommandClient } from './command-client.js';
import { DoorStateMachine } from './door-state-machine.js';
import { PulseActuator } from './pulse-actuator.js';
import { GarageDoorAccessory } from './accessory.js';
import { WebhookListener, type WebhookDoorHandler } from './webhook-listener.js';
import { PersistenceStore, persistenceKey } from './persistence-store.js';
import { validateConfig, deriveUuid, type RawDoorEntry, type RawWebhookConfig } from './config-validator.js';
import { redactToken } from './redact.js';
import type { Logger } from './logger.js';
import type {
  HomebridgeApi,
  PlatformConfigLike,
  PlatformAccessoryLike,
  HapApiContainer,
} from './hap-types.js';
import { CATEGORY_GARAGE_DOOR_OPENER } from './hap-types.js';
import type { ValidatedDoorEntry } from './types.js';

export const PLUGIN_IDENTIFIER = 'homebridge-itach-garage-door';
export const PLATFORM_NAME = 'ItachGarageDoor';

/** Runtime state tracked per configured door. */
export interface DoorRuntime {
  config: ValidatedDoorEntry;
  stateMachine: DoorStateMachine;
  actuator: PulseActuator;
  accessory: GarageDoorAccessory;
}

/**
 * Optional injected dependencies. Homebridge only ever passes (log, config, api),
 * so these default to the real implementations; tests override them to avoid
 * opening real TCP connections or binding real ports.
 */
export interface PlatformDependencies {
  /** Factory for the shared per-address:port command client. */
  createClient?: (ip: string, port: number, codec: ProtocolCodec, log: Logger) => CommandClient;
  /** Override the storage directory used for state persistence. */
  storagePath?: string;
  /** Set false to skip starting the webhook listener (tests). */
  startWebhook?: boolean;
}

export class ItachGarageDoorPlatform {
  /** Cached accessories restored by Homebridge before didFinishLaunching. */
  readonly cachedAccessories: PlatformAccessoryLike[] = [];

  private readonly log: Logger;
  private readonly config: PlatformConfigLike;
  private readonly api: HomebridgeApi;
  private readonly codec = new ProtocolCodec();

  /** Shared command clients keyed by "ip:port". */
  private readonly clients = new Map<string, CommandClient>();
  /** Reference count of doors per client key, for cleanup. */
  private readonly clientRefs = new Map<string, number>();

  private readonly doors = new Map<string, DoorRuntime>();
  private persistence: PersistenceStore | null = null;
  private webhook: WebhookListener | null = null;
  private redactedToken: string | null = null;

  private readonly deps: PlatformDependencies;

  constructor(
    log: Logger,
    config: PlatformConfigLike,
    api: HomebridgeApi,
    deps: PlatformDependencies = {},
  ) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.deps = deps;

    this.api.on('didFinishLaunching', () => {
      void this.discoverDevices();
    });
    this.api.on('shutdown', () => {
      void this.shutdown();
    });
  }

  /** Homebridge calls this for each cached accessory during startup. */
  configureAccessory(accessory: PlatformAccessoryLike): void {
    this.cachedAccessories.push(accessory);
  }

  // ─── Read accessors (used by tests and diagnostics) ──────────────────────

  /** Number of distinct command clients (one per address:port). */
  get clientCount(): number {
    return this.clients.size;
  }

  /** The command client keys currently pooled, as "ip:port" strings. */
  get clientKeys(): string[] {
    return [...this.clients.keys()];
  }

  /** Door IDs successfully published. */
  get doorIds(): string[] {
    return [...this.doors.keys()];
  }

  /** Look up the runtime for a published door. */
  getDoor(doorId: string): DoorRuntime | undefined {
    return this.doors.get(doorId);
  }

  /** Whether the webhook listener is currently running. */
  get isWebhookRunning(): boolean {
    return this.webhook !== null && this.webhook.isListening;
  }

  // ─── Discovery ─────────────────────────────────────────────────────────

  async discoverDevices(): Promise<void> {
    const rawDoors = this.config['doors'] as RawDoorEntry[] | undefined;
    const rawWebhook = this.config['webhook'] as RawWebhookConfig | undefined;

    const result = validateConfig(rawDoors, rawWebhook);

    // Set up token redaction as early as possible.
    if (result.webhook !== null) {
      this.redactedToken = result.webhook.token;
    }

    // Log validation errors (with token redaction applied defensively).
    for (const err of result.errors) {
      this.log.error(this.redact(err.message));
    }

    // Persistence
    const storagePath = this.deps.storagePath ?? this.api.user.storagePath();
    this.persistence = new PersistenceStore(storagePath, this.log);
    await this.persistence.load();

    // Build UUID → door map for the valid configuration.
    const validUuids = new Set<string>();
    const doorByUuid = new Map<string, ValidatedDoorEntry>();
    for (const door of result.doors) {
      const uuid = this.uuidFor(door);
      validUuids.add(uuid);
      doorByUuid.set(uuid, door);
    }

    // Unregister stale cached accessories (UUID matches no current door).
    const stale = this.cachedAccessories.filter((a) => !validUuids.has(a.UUID));
    if (stale.length > 0) {
      for (const acc of stale) {
        this.log.info(`Unregistering stale accessory "${acc.displayName}"`);
      }
      this.api.unregisterPlatformAccessories(PLUGIN_IDENTIFIER, PLATFORM_NAME, stale);
    }

    // Publish / reuse accessories for each valid door.
    const webhookDoors = new Map<string, WebhookDoorHandler>();
    for (const door of result.doors) {
      try {
        const runtime = this.setupDoor(door, doorByUuid);
        this.doors.set(door.doorId, runtime);
        webhookDoors.set(door.doorId, runtime.accessory);
        this.log.info(`Published garage door "${door.name}" (doorId: ${door.doorId})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(`Failed to publish door "${door.name}": ${this.redact(message)}`);
      }
    }

    // Start the webhook listener if configured.
    const webhookEnabled = this.deps.startWebhook !== false;
    if (webhookEnabled && result.webhook !== null && webhookDoors.size > 0) {
      this.webhook = new WebhookListener({
        port: result.webhook.port,
        bindAddress: result.webhook.bindAddress,
        token: result.webhook.token,
        doors: webhookDoors,
        log: this.wrapLogger(),
      });
      try {
        await this.webhook.start();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(`Webhook listener failed to start: ${this.redact(message)}`);
        this.webhook = null;
      }
    }

    // Kick off startup relay resets (non-blocking).
    for (const runtime of this.doors.values()) {
      void runtime.actuator.reset();
    }
  }

  // ─── Per-door setup ────────────────────────────────────────────────────

  private setupDoor(
    door: ValidatedDoorEntry,
    doorByUuid: Map<string, ValidatedDoorEntry>,
  ): DoorRuntime {
    const uuid = this.uuidFor(door);

    // Shared command client for this address:port.
    const client = this.acquireClient(door.ipAddress, door.port);

    // State machine (restore persisted state).
    const stateMachine = new DoorStateMachine({
      openingTime: door.openingTime,
      closingTime: door.closingTime,
      midTravelBehaviour: door.midTravelBehaviour,
    });
    const key = persistenceKey(door.ipAddress, door.relay);
    stateMachine.restoreState(this.persistence!.snapshot(), key);

    // Actuator.
    const actuator = new PulseActuator(client, this.codec, this.log, door.relay, door.pulseDuration);

    // Accessory (reuse cached or create new).
    const accessory = this.resolveAccessory(uuid, door);

    const handler = new GarageDoorAccessory(
      this.hapContainer(),
      accessory,
      door,
      stateMachine,
      actuator,
      this.persistence!,
      this.log,
    );

    void doorByUuid; // reserved for future cross-checks
    return { config: door, stateMachine, actuator, accessory: handler };
  }

  /** Reuse a cached accessory with a matching UUID or register a new one. */
  private resolveAccessory(uuid: string, door: ValidatedDoorEntry): PlatformAccessoryLike {
    const cached = this.cachedAccessories.find((a) => a.UUID === uuid);
    if (cached !== undefined) {
      cached.displayName = door.name;
      (cached as unknown as { category: number }).category = CATEGORY_GARAGE_DOOR_OPENER;
      this.api.updatePlatformAccessories([cached]);
      return cached;
    }

    const accessory = new this.api.platformAccessory(door.name, uuid);
    accessory.category = CATEGORY_GARAGE_DOOR_OPENER;
    this.api.registerPlatformAccessories(PLUGIN_IDENTIFIER, PLATFORM_NAME, [accessory]);
    return accessory;
  }

  // ─── Command client pooling ──────────────────────────────────────────────

  private acquireClient(ip: string, port: number): CommandClient {
    const clientKey = `${ip}:${port}`;
    let client = this.clients.get(clientKey);
    if (client === undefined) {
      client = this.deps.createClient
        ? this.deps.createClient(ip, port, this.codec, this.log)
        : new CommandClient(ip, port, this.codec, this.log);
      this.clients.set(clientKey, client);
      this.clientRefs.set(clientKey, 0);
    }
    this.clientRefs.set(clientKey, (this.clientRefs.get(clientKey) ?? 0) + 1);
    return client;
  }

  // ─── Shutdown ────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    // 1. Cancel travel timers.
    for (const runtime of this.doors.values()) {
      runtime.stateMachine.cancelTimer();
    }

    // 2. Stop the webhook listener.
    if (this.webhook !== null) {
      await this.webhook.stop();
      this.webhook = null;
    }

    // 3. Close all TCP connections.
    for (const client of this.clients.values()) {
      await client.disconnect();
    }
    this.clients.clear();
    this.clientRefs.clear();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private uuidFor(door: ValidatedDoorEntry): string {
    // Prefer Homebridge's HAP uuid generator (deterministic on the same seed);
    // fall back to our own deterministic derivation if unavailable.
    const seed = `${door.ipAddress}:${door.relay}`;
    if (this.api.hap.uuid && typeof this.api.hap.uuid.generate === 'function') {
      return this.api.hap.uuid.generate(seed);
    }
    return deriveUuid(door.ipAddress, door.relay);
  }

  private hapContainer(): HapApiContainer {
    return { hap: this.api.hap };
  }

  private redact(text: string): string {
    return this.redactedToken !== null ? redactToken(text, this.redactedToken) : text;
  }

  /** Wrap the logger so every message passes through token redaction. */
  private wrapLogger(): Logger {
    const base = this.log;
    const redact = (msg: string): string => this.redact(msg);
    return {
      debug: (m, ...p) => base.debug(redact(m), ...p),
      info: (m, ...p) => base.info(redact(m), ...p),
      warn: (m, ...p) => base.warn(redact(m), ...p),
      error: (m, ...p) => base.error(redact(m), ...p),
    };
  }
}
