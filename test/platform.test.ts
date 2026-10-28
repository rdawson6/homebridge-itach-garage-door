/**
 * Unit tests for ItachGarageDoorPlatform with a mocked Homebridge API.
 *
 * Command clients are injected so no real TCP connections are opened, and the
 * webhook listener is disabled unless a test explicitly enables it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ItachGarageDoorPlatform,
  PLATFORM_NAME,
  PLUGIN_IDENTIFIER,
  type PlatformDependencies,
} from '../src/platform.js';
import type { CommandClient } from '../src/command-client.js';
import type { Logger } from '../src/logger.js';
import type { Response } from '../src/types.js';
import type {
  HomebridgeApi,
  PlatformAccessoryLike,
  PlatformConfigLike,
  ServiceLike,
  CharacteristicLike,
  CharacteristicValue,
} from '../src/hap-types.js';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ─── Mock HAP objects ────────────────────────────────────────────────────────

const REF = {
  AccessoryInformation: Symbol('AccessoryInformation'),
  GarageDoorOpener: Symbol('GarageDoorOpener'),
  Manufacturer: Symbol('Manufacturer'),
  Model: Symbol('Model'),
  SerialNumber: Symbol('SerialNumber'),
  Name: Symbol('Name'),
  CurrentDoorState: Symbol('CurrentDoorState'),
  TargetDoorState: Symbol('TargetDoorState'),
  ObstructionDetected: Symbol('ObstructionDetected'),
};

class MockCharacteristic implements CharacteristicLike {
  value: CharacteristicValue | undefined;
  onSet(): CharacteristicLike { return this; }
  onGet(): CharacteristicLike { return this; }
}

class MockService implements ServiceLike {
  chars = new Map<unknown, MockCharacteristic>();
  private ensure(ref: unknown): MockCharacteristic {
    let c = this.chars.get(ref);
    if (!c) { c = new MockCharacteristic(); this.chars.set(ref, c); }
    return c;
  }
  getCharacteristic(ref: unknown): CharacteristicLike { return this.ensure(ref); }
  setCharacteristic(ref: unknown, v: CharacteristicValue): ServiceLike { this.ensure(ref).value = v; return this; }
  updateCharacteristic(ref: unknown, v: CharacteristicValue): ServiceLike { this.ensure(ref).value = v; return this; }
}

class MockAccessory implements PlatformAccessoryLike {
  category = 0;
  services = new Map<unknown, MockService>();
  constructor(public displayName: string, public UUID: string) {}
  getService(ref: unknown): ServiceLike | undefined { return this.services.get(ref); }
  addService(ref: unknown): ServiceLike {
    const s = new MockService();
    this.services.set(ref, s);
    return s;
  }
}

class HapStatusErrorMock extends Error {
  constructor(public status: number) { super(`HapStatusError ${status}`); }
}

/** A mock Homebridge API that records registration calls and lifecycle hooks. */
class MockApi {
  registered: PlatformAccessoryLike[] = [];
  unregistered: PlatformAccessoryLike[] = [];
  updated: PlatformAccessoryLike[] = [];
  private handlers = new Map<string, Array<() => void>>();

  hap = {
    Service: {
      AccessoryInformation: REF.AccessoryInformation,
      GarageDoorOpener: REF.GarageDoorOpener,
    },
    Characteristic: {
      Manufacturer: REF.Manufacturer,
      Model: REF.Model,
      SerialNumber: REF.SerialNumber,
      Name: REF.Name,
      CurrentDoorState: REF.CurrentDoorState,
      TargetDoorState: REF.TargetDoorState,
      ObstructionDetected: REF.ObstructionDetected,
    },
    HapStatusError: HapStatusErrorMock as unknown as HomebridgeApi['hap']['HapStatusError'],
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
    uuid: { generate: (seed: string) => `uuid-${seed}` },
    Categories: { GARAGE_DOOR_OPENER: 4 },
  };

  platformAccessory = MockAccessory as unknown as HomebridgeApi['platformAccessory'];

  user = { storagePath: () => '/tmp/itach-platform-test-default' };

  on(event: string, listener: () => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
  }

  fire(event: string): void {
    (this.handlers.get(event) ?? []).forEach((h) => h());
  }

  registerPlatformAccessories(_p: string, _n: string, accs: PlatformAccessoryLike[]): void {
    this.registered.push(...accs);
  }
  unregisterPlatformAccessories(_p: string, _n: string, accs: PlatformAccessoryLike[]): void {
    this.unregistered.push(...accs);
  }
  updatePlatformAccessories(accs: PlatformAccessoryLike[]): void {
    this.updated.push(...accs);
  }
}

// ─── Mock command client ─────────────────────────────────────────────────────

class MockClient {
  sent: string[] = [];
  disconnected = false;
  responder: (cmd: string) => Response = (cmd) => {
    const m = cmd.match(/^setstate,(\d+):(\d+),([01])$/);
    if (m) {
      return {
        type: 'setstate-echo',
        module: parseInt(m[1]!, 10),
        connector: parseInt(m[2]!, 10),
        value: parseInt(m[3]!, 10) as 0 | 1,
        raw: cmd,
      };
    }
    return { type: 'devices', modules: [], raw: cmd };
  };

  sendCommand(cmd: string): Promise<Response> {
    this.sent.push(cmd);
    return Promise.resolve(this.responder(cmd));
  }
  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): Promise<void> { this.disconnected = true; return Promise.resolve(); }
}

// ─── Harness ────────────────────────────────────────────────────────────────

describe('ItachGarageDoorPlatform', () => {
  let api: MockApi;
  let log: Logger;
  let storageDir: string;
  let createdClients: Map<string, MockClient>;

  beforeEach(async () => {
    api = new MockApi();
    log = makeLogger();
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'itach-platform-'));
    createdClients = new Map();
  });

  afterEach(async () => {
    // Let any in-flight fire-and-forget persistence writes settle before the
    // temp directory is removed, otherwise rmdir races with writeFile/rename.
    await new Promise((r) => setTimeout(r, 25));
    await fs.rm(storageDir, { recursive: true, force: true, maxRetries: 3 });
  });

  function deps(overrides: Partial<PlatformDependencies> = {}): PlatformDependencies {
    return {
      storagePath: storageDir,
      startWebhook: false,
      createClient: (ip, port) => {
        const key = `${ip}:${port}`;
        const client = new MockClient();
        createdClients.set(key, client);
        return client as unknown as CommandClient;
      },
      ...overrides,
    };
  }

  function build(config: PlatformConfigLike, depOverrides: Partial<PlatformDependencies> = {}) {
    return new ItachGarageDoorPlatform(
      log,
      config,
      api as unknown as HomebridgeApi,
      deps(depOverrides),
    );
  }

  const door = (over: Record<string, unknown> = {}) => ({
    name: 'Garage',
    ipAddress: '192.168.4.235',
    relay: '1:1',
    doorId: 'garage',
    ...over,
  });

  // ─── Registration ───────────────────────────────────────────────────────

  describe('accessory discovery and registration', () => {
    it('registers a new accessory for a valid door', async () => {
      const platform = build({ doors: [door()] });
      await platform.discoverDevices();

      expect(api.registered).toHaveLength(1);
      expect(api.registered[0]!.UUID).toBe('uuid-192.168.4.235:1:1');
      expect(api.registered[0]!.displayName).toBe('Garage');
      expect(platform.doorIds).toEqual(['garage']);
    });

    it('sets the accessory category to GARAGE_DOOR_OPENER', async () => {
      const platform = build({ doors: [door()] });
      await platform.discoverDevices();
      expect((api.registered[0] as unknown as MockAccessory).category).toBe(4);
    });

    it('logs the door ID at info level on publish', async () => {
      const platform = build({ doors: [door()] });
      await platform.discoverDevices();
      const messages = (log.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('garage'))).toBe(true);
    });

    it('registers nothing for an empty door array', async () => {
      const platform = build({ doors: [] });
      await platform.discoverDevices();
      expect(api.registered).toHaveLength(0);
      expect(platform.doorIds).toEqual([]);
    });

    it('registers one accessory per valid door', async () => {
      const platform = build({
        doors: [
          door({ doorId: 'a', ipAddress: '192.168.1.1' }),
          door({ doorId: 'b', ipAddress: '192.168.1.2' }),
        ],
      });
      await platform.discoverDevices();
      expect(api.registered).toHaveLength(2);
      expect(platform.doorIds).toEqual(['a', 'b']);
    });
  });

  // ─── Cached accessory reuse ─────────────────────────────────────────────

  describe('cached accessory reuse', () => {
    it('reuses a cached accessory whose UUID matches a configured door', async () => {
      const cached = new MockAccessory('Old Name', 'uuid-192.168.4.235:1:1');
      const platform = build({ doors: [door()] });
      platform.configureAccessory(cached);

      await platform.discoverDevices();

      expect(api.registered).toHaveLength(0);
      expect(api.updated).toHaveLength(1);
      expect(cached.displayName).toBe('Garage');
    });

    it('does not unregister a cached accessory that matches a door', async () => {
      const cached = new MockAccessory('Garage', 'uuid-192.168.4.235:1:1');
      const platform = build({ doors: [door()] });
      platform.configureAccessory(cached);
      await platform.discoverDevices();
      expect(api.unregistered).toHaveLength(0);
    });
  });

  // ─── Stale accessory unregistration ─────────────────────────────────────

  describe('stale accessory unregistration', () => {
    it('unregisters a cached accessory whose UUID matches no door', async () => {
      const stale = new MockAccessory('Removed Door', 'uuid-10.0.0.9:1:3');
      const platform = build({ doors: [door()] });
      platform.configureAccessory(stale);

      await platform.discoverDevices();

      expect(api.unregistered).toHaveLength(1);
      expect(api.unregistered[0]!.UUID).toBe('uuid-10.0.0.9:1:3');
    });

    it('logs the unregistered accessory display name at info level', async () => {
      const stale = new MockAccessory('Removed Door', 'uuid-10.0.0.9:1:3');
      const platform = build({ doors: [door()] });
      platform.configureAccessory(stale);
      await platform.discoverDevices();

      const messages = (log.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('Removed Door'))).toBe(true);
    });

    it('unregisters stale accessories and still publishes valid ones', async () => {
      const stale = new MockAccessory('Gone', 'uuid-nonexistent');
      const platform = build({ doors: [door()] });
      platform.configureAccessory(stale);
      await platform.discoverDevices();

      expect(api.unregistered).toHaveLength(1);
      expect(api.registered).toHaveLength(1);
    });
  });

  // ─── Config validation errors ───────────────────────────────────────────

  describe('configuration validation', () => {
    it('logs validation errors and skips invalid doors', async () => {
      const platform = build({
        doors: [door({ doorId: 'good' }), door({ ipAddress: 'bad-ip', doorId: 'bad' })],
      });
      await platform.discoverDevices();

      expect(platform.doorIds).toEqual(['good']);
      expect(log.error).toHaveBeenCalled();
    });

    it('publishes valid doors when another door is invalid (isolation)', async () => {
      const platform = build({
        doors: [
          door({ doorId: 'a', ipAddress: '192.168.1.1' }),
          door({ relay: '9:9', doorId: 'invalid' }),
          door({ doorId: 'c', ipAddress: '192.168.1.3' }),
        ],
      });
      await platform.discoverDevices();
      expect(platform.doorIds).toEqual(['a', 'c']);
    });
  });

  // ─── Command client pooling ─────────────────────────────────────────────

  describe('command client pooling', () => {
    it('shares one client for two doors on the same IP2CC address:port', async () => {
      const platform = build({
        doors: [
          door({ doorId: 'a', relay: '1:1' }),
          door({ doorId: 'b', relay: '1:2' }),
        ],
      });
      await platform.discoverDevices();

      expect(platform.clientCount).toBe(1);
      expect(platform.clientKeys).toEqual(['192.168.4.235:4998']);
    });

    it('creates separate clients for different ports on the same IP', async () => {
      const platform = build({
        doors: [
          door({ doorId: 'a', relay: '1:1', port: 4998 }),
          door({ doorId: 'b', relay: '1:2', port: 4999 }),
        ],
      });
      await platform.discoverDevices();

      expect(platform.clientCount).toBe(2);
      expect(platform.clientKeys.sort()).toEqual([
        '192.168.4.235:4998',
        '192.168.4.235:4999',
      ]);
    });

    it('creates separate clients for different IPs', async () => {
      const platform = build({
        doors: [
          door({ doorId: 'a', ipAddress: '192.168.1.1' }),
          door({ doorId: 'b', ipAddress: '192.168.1.2' }),
        ],
      });
      await platform.discoverDevices();
      expect(platform.clientCount).toBe(2);
    });
  });

  // ─── Startup relay reset ────────────────────────────────────────────────

  describe('startup relay reset', () => {
    it('sends setstate 0 for each configured relay on startup', async () => {
      const platform = build({
        doors: [door({ doorId: 'a', relay: '1:1' }), door({ doorId: 'b', relay: '1:2' })],
      });
      await platform.discoverDevices();
      await new Promise((r) => setImmediate(r));

      const client = createdClients.get('192.168.4.235:4998')!;
      expect(client.sent).toContain('setstate,1:1,0');
      expect(client.sent).toContain('setstate,1:2,0');
      expect(platform.doorIds).toEqual(['a', 'b']);
    });
  });

  // ─── Persisted state restoration ────────────────────────────────────────

  describe('persisted state restoration', () => {
    it('restores a persisted terminal state', async () => {
      await fs.writeFile(
        path.join(storageDir, 'itach-garage-door.state.json'),
        JSON.stringify({ '192.168.4.235:1:1': 'OPEN' }),
        'utf8',
      );
      const platform = build({ doors: [door()] });
      await platform.discoverDevices();

      expect(platform.getDoor('garage')!.stateMachine.state).toBe('OPEN');
    });

    it('restores OPENING as STOPPED with no timer', async () => {
      await fs.writeFile(
        path.join(storageDir, 'itach-garage-door.state.json'),
        JSON.stringify({ '192.168.4.235:1:1': 'OPENING' }),
        'utf8',
      );
      const platform = build({ doors: [door()] });
      await platform.discoverDevices();

      expect(platform.getDoor('garage')!.stateMachine.state).toBe('STOPPED');
      expect(platform.getDoor('garage')!.stateMachine.hasTimer).toBe(false);
    });

    it('defaults to CLOSED when no persisted state exists', async () => {
      const platform = build({ doors: [door()] });
      await platform.discoverDevices();
      expect(platform.getDoor('garage')!.stateMachine.state).toBe('CLOSED');
    });
  });

  // ─── Webhook ────────────────────────────────────────────────────────────

  describe('webhook listener', () => {
    it('does not start the webhook when config is absent', async () => {
      const platform = build({ doors: [door()] }, { startWebhook: true });
      await platform.discoverDevices();
      expect(platform.isWebhookRunning).toBe(false);
    });

    it('does not start the webhook when the token is missing', async () => {
      const platform = build(
        { doors: [door()], webhook: { port: 18099 } },
        { startWebhook: true },
      );
      await platform.discoverDevices();
      expect(platform.isWebhookRunning).toBe(false);
      expect(log.error).toHaveBeenCalled();
    });

    it('does not start the webhook when the port is out of range', async () => {
      const platform = build(
        { doors: [door()], webhook: { port: 80, token: 'a'.repeat(32) } },
        { startWebhook: true },
      );
      await platform.discoverDevices();
      expect(platform.isWebhookRunning).toBe(false);
    });

    it('starts the webhook with valid config and stops it on shutdown', async () => {
      const platform = build(
        {
          doors: [door()],
          webhook: { port: 18123, bindAddress: '127.0.0.1', token: 'z'.repeat(32) },
        },
        { startWebhook: true },
      );
      await platform.discoverDevices();
      expect(platform.isWebhookRunning).toBe(true);

      await platform.shutdown();
      expect(platform.isWebhookRunning).toBe(false);
    });
  });

  // ─── Shutdown ───────────────────────────────────────────────────────────

  describe('graceful shutdown', () => {
    it('cancels travel timers, closes clients, and clears the pool', async () => {
      const platform = build({ doors: [door()] });
      await platform.discoverDevices();

      const runtime = platform.getDoor('garage')!;
      runtime.stateMachine.setExternalState('OPENING');
      expect(runtime.stateMachine.hasTimer).toBe(true);

      const client = createdClients.get('192.168.4.235:4998')!;
      await platform.shutdown();

      expect(runtime.stateMachine.hasTimer).toBe(false);
      expect(client.disconnected).toBe(true);
      expect(platform.clientCount).toBe(0);
    });

    it('is safe to call with no doors configured', async () => {
      const platform = build({ doors: [] });
      await platform.discoverDevices();
      await expect(platform.shutdown()).resolves.toBeUndefined();
    });
  });

  // ─── Lifecycle wiring ───────────────────────────────────────────────────

  describe('lifecycle wiring', () => {
    it('subscribes to didFinishLaunching and discovers on that event', async () => {
      const platform = build({ doors: [door()] });
      api.fire('didFinishLaunching');
      await new Promise((r) => setTimeout(r, 30));
      expect(platform.doorIds).toEqual(['garage']);
    });

    it('subscribes to shutdown', async () => {
      const platform = build({ doors: [door()] });
      await platform.discoverDevices();
      api.fire('shutdown');
      await new Promise((r) => setTimeout(r, 30));
      expect(platform.clientCount).toBe(0);
    });
  });

  // ─── Constants ──────────────────────────────────────────────────────────

  describe('identifiers', () => {
    it('uses the platform name matching config.schema.json pluginAlias', () => {
      expect(PLATFORM_NAME).toBe('ItachGarageDoor');
    });

    it('uses the package name as plugin identifier', () => {
      expect(PLUGIN_IDENTIFIER).toBe('homebridge-itach-garage-door');
    });
  });
});
