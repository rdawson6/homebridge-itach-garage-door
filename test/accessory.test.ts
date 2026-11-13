/**
 * Unit tests for GarageDoorAccessory using a mock HAP API and mock actuator.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GarageDoorAccessory,
  presentDoorState,
  toCurrentDoorState,
  toTargetDoorState,
} from '../src/accessory.js';
import { DoorStateMachine } from '../src/door-state-machine.js';
import { PersistenceStore } from '../src/persistence-store.js';
import { CommunicationError } from '../src/command-client.js';
import type { PulseActuator, PulseResult, PulseTarget } from '../src/pulse-actuator.js';
import type { Logger } from '../src/logger.js';
import type {
  DoorState,
  MidTravelBehaviour,
  TravelDirection,
  ValidatedDoorEntry,
} from '../src/types.js';
import type {
  HapApiContainer,
  CharacteristicLike,
  ServiceLike,
  PlatformAccessoryLike,
  CharacteristicValue,
} from '../src/hap-types.js';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ─── Mock HAP ────────────────────────────────────────────────────────────────

// Unique reference objects standing in for HAP service/characteristic constructors.
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

class HapStatusErrorMock extends Error {
  constructor(public status: number) {
    super(`HapStatusError ${status}`);
    this.name = 'HapStatusError';
  }
}

class MockCharacteristic implements CharacteristicLike {
  setHandler: ((v: CharacteristicValue) => void | Promise<void>) | null = null;
  getHandler: (() => CharacteristicValue | Promise<CharacteristicValue>) | null = null;
  value: CharacteristicValue | undefined;

  onSet(handler: (v: CharacteristicValue) => void | Promise<void>): CharacteristicLike {
    this.setHandler = handler;
    return this;
  }
  onGet(handler: () => CharacteristicValue | Promise<CharacteristicValue>): CharacteristicLike {
    this.getHandler = handler;
    return this;
  }
}

class MockService implements ServiceLike {
  characteristics = new Map<unknown, MockCharacteristic>();
  updates: Array<{ ref: unknown; value: CharacteristicValue }> = [];

  getCharacteristic(ref: unknown): CharacteristicLike {
    let c = this.characteristics.get(ref);
    if (!c) {
      c = new MockCharacteristic();
      this.characteristics.set(ref, c);
    }
    return c;
  }
  setCharacteristic(ref: unknown, value: CharacteristicValue): ServiceLike {
    this.getCharacteristic(ref);
    (this.characteristics.get(ref) as MockCharacteristic).value = value;
    return this;
  }
  updateCharacteristic(ref: unknown, value: CharacteristicValue): ServiceLike {
    this.updates.push({ ref, value });
    this.getCharacteristic(ref);
    (this.characteristics.get(ref) as MockCharacteristic).value = value;
    return this;
  }
}

class MockAccessory implements PlatformAccessoryLike {
  UUID = 'test-uuid';
  displayName = 'Test';
  services = new Map<unknown, MockService>();

  getService(ref: unknown): ServiceLike | undefined {
    return this.services.get(ref);
  }
  addService(ref: unknown): ServiceLike {
    const s = new MockService();
    this.services.set(ref, s);
    return s;
  }
}

function makeHap(): HapApiContainer {
  return {
    hap: {
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
      HapStatusError: HapStatusErrorMock as unknown as HapApiContainer['hap']['HapStatusError'],
      HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
    },
  };
}

// ─── Mock actuator ───────────────────────────────────────────────────────────

class MockActuator {
  calls: PulseTarget[] = [];
  behaviour: (target: PulseTarget) => Promise<PulseResult> = (target) =>
    Promise.resolve({ target, holdMs: 500 });

  actuate(target: PulseTarget): Promise<PulseResult> {
    this.calls.push(target);
    return this.behaviour(target);
  }
  reset(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

// ─── Test harness ────────────────────────────────────────────────────────────

const CONFIG: ValidatedDoorEntry = {
  name: 'Garage',
  ipAddress: '192.168.4.235',
  relay: '1:1',
  port: 4998,
  doorId: 'garage',
  pulseDuration: 500,
  openingTime: 15,
  closingTime: 15,
  midTravelBehaviour: 'stop',
};

describe('GarageDoorAccessory', () => {
  let hap: HapApiContainer;
  let accessory: MockAccessory;
  let sm: DoorStateMachine;
  let actuator: MockActuator;
  let persistence: PersistenceStore;
  let log: Logger;

  beforeEach(() => {
    vi.useFakeTimers();
    hap = makeHap();
    accessory = new MockAccessory();
    sm = new DoorStateMachine({ openingTime: 15, closingTime: 15, midTravelBehaviour: 'stop' });
    actuator = new MockActuator();
    log = makeLogger();
    // Persistence writes to a nonexistent path — save fails silently, harmless here.
    persistence = new PersistenceStore('/tmp/itach-accessory-test', log);
    vi.spyOn(persistence, 'save').mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function build(): GarageDoorAccessory {
    return new GarageDoorAccessory(
      hap,
      accessory,
      CONFIG,
      sm,
      actuator as unknown as PulseActuator,
      persistence,
      log,
    );
  }

  function gdoService(): MockService {
    return accessory.services.get(REF.GarageDoorOpener) as MockService;
  }

  // ─── Setup ──────────────────────────────────────────────────────────────

  describe('service registration', () => {
    it('registers AccessoryInformation with manufacturer, model, serial', () => {
      build();
      const info = accessory.services.get(REF.AccessoryInformation) as MockService;
      expect(info.characteristics.get(REF.Manufacturer)?.value).toBe('Global Cache');
      expect(info.characteristics.get(REF.Model)?.value).toBe('iTach IP2CC');
      expect(info.characteristics.get(REF.SerialNumber)?.value).toBe('192.168.4.235-1:1');
    });

    it('registers the GarageDoorOpener service', () => {
      build();
      expect(accessory.services.has(REF.GarageDoorOpener)).toBe(true);
    });

    it('publishes initial characteristics from restored state', () => {
      sm.setExternalState('OPEN');
      build();
      const svc = gdoService();
      const currentUpdate = svc.updates.filter(u => u.ref === REF.CurrentDoorState).pop();
      expect(currentUpdate?.value).toBe(0); // OPEN
    });
  });

  // ─── TargetDoorState set ──────────────────────────────────────────────────

  describe('handleTargetDoorStateSet', () => {
    it('actuates a pulse and advances state to OPENING when opening from CLOSED', async () => {
      const acc = build();
      await acc.handleTargetDoorStateSet(0); // OPEN
      expect(actuator.calls).toEqual(['OPEN']);
      expect(sm.state).toBe('OPENING');
    });

    it('actuates a pulse and advances to CLOSING when closing from OPEN', async () => {
      sm.setExternalState('OPEN');
      const acc = build();
      await acc.handleTargetDoorStateSet(1); // CLOSED
      expect(actuator.calls).toEqual(['CLOSED']);
      expect(sm.state).toBe('CLOSING');
    });

    it('does not actuate when target equals current (no-op)', async () => {
      const acc = build(); // starts CLOSED
      await acc.handleTargetDoorStateSet(1); // CLOSED — already closed
      expect(actuator.calls).toHaveLength(0);
      expect(sm.state).toBe('CLOSED');
    });

    it('throws HapStatusError and leaves state unchanged on pulse failure', async () => {
      actuator.behaviour = () => Promise.reject(new CommunicationError('relay failed'));
      const acc = build();
      await expect(acc.handleTargetDoorStateSet(0)).rejects.toBeInstanceOf(HapStatusErrorMock);
      // State machine reverted (pulseFailed preserves prior state)
      expect(sm.state).toBe('CLOSED');
    });
  });

  // ─── CurrentDoorState get ──────────────────────────────────────────────────

  describe('handleCurrentDoorStateGet', () => {
    it('returns the mapped current state', () => {
      const acc = build();
      expect(acc.handleCurrentDoorStateGet()).toBe(1); // CLOSED
      sm.setExternalState('OPENING');
      expect(acc.handleCurrentDoorStateGet()).toBe(2); // OPENING
    });

    it('returns STOPPED for a stop-mode door stopped mid-travel', () => {
      const acc = build();
      sm.setExternalState('STOPPED');
      expect(acc.handleCurrentDoorStateGet()).toBe(4); // STOPPED
    });
  });

  // ─── State-machine reflection ──────────────────────────────────────────────

  describe('state change reflection', () => {
    it('updates CurrentDoorState on state machine changes', () => {
      build();
      const svc = gdoService();
      svc.updates.length = 0;
      sm.setExternalState('OPENING');
      const currentUpdate = svc.updates.filter(u => u.ref === REF.CurrentDoorState).pop();
      expect(currentUpdate?.value).toBe(2);
    });

    it('leaves TargetDoorState unchanged for STOPPED', () => {
      build();
      const svc = gdoService();
      svc.updates.length = 0;
      sm.setExternalState('STOPPED');
      const targetUpdates = svc.updates.filter(u => u.ref === REF.TargetDoorState);
      expect(targetUpdates).toHaveLength(0);
    });

    it('persists the new state on change', () => {
      build();
      sm.setExternalState('OPEN');
      expect(persistence.save).toHaveBeenCalledWith('192.168.4.235:1:1', 'OPEN');
    });
  });

  // ─── Obstruction ──────────────────────────────────────────────────────────

  describe('obstruction', () => {
    it('setObstruction updates the characteristic and getter', () => {
      const acc = build();
      acc.setObstruction(true);
      expect(acc.handleObstructionDetectedGet()).toBe(true);
      const svc = gdoService();
      const obstUpdate = svc.updates.filter(u => u.ref === REF.ObstructionDetected).pop();
      expect(obstUpdate?.value).toBe(true);
    });
  });

  // ─── WebhookDoorHandler ────────────────────────────────────────────────────

  describe('WebhookDoorHandler interface', () => {
    it('applyExternalState delegates to the state machine', () => {
      const acc = build();
      acc.applyExternalState('OPEN');
      expect(sm.state).toBe('OPEN');
      expect(acc.currentState).toBe('OPEN');
    });
  });
});

// ─── Pure mapping functions ────────────────────────────────────────────────

describe('characteristic mapping', () => {
  it('toCurrentDoorState maps all states', () => {
    expect(toCurrentDoorState('CLOSED')).toBe(1);
    expect(toCurrentDoorState('OPEN')).toBe(0);
    expect(toCurrentDoorState('OPENING')).toBe(2);
    expect(toCurrentDoorState('CLOSING')).toBe(3);
    expect(toCurrentDoorState('STOPPED')).toBe(4);
  });

  it('toTargetDoorState maps all states', () => {
    expect(toTargetDoorState('OPEN')).toBe(0);
    expect(toTargetDoorState('OPENING')).toBe(0);
    expect(toTargetDoorState('CLOSED')).toBe(1);
    expect(toTargetDoorState('CLOSING')).toBe(1);
    expect(toTargetDoorState('STOPPED')).toBe(1);
  });
});

// ─── One-push presentation mapping ─────────────────────────────────────────

describe('presentDoorState', () => {
  const states: DoorState[] = ['CLOSED', 'OPEN', 'OPENING', 'CLOSING', 'STOPPED'];
  const memories: Array<TravelDirection | null> = ['OPENING', 'CLOSING', null];

  it.each<MidTravelBehaviour>(['stop', 'reverse'])('is the identity for every state in %s mode', (mode) => {
    for (const state of states) {
      for (const memory of memories) {
        expect(presentDoorState(state, mode, memory)).toBe(state);
      }
    }
  });

  it('is the identity for every non-STOPPED state in one-push mode', () => {
    for (const state of states.filter((s) => s !== 'STOPPED')) {
      for (const memory of memories) {
        expect(presentDoorState(state, 'one-push', memory)).toBe(state);
      }
    }
  });

  it('holds the travel direction for a one-push door stopped mid-travel', () => {
    expect(presentDoorState('STOPPED', 'one-push', 'OPENING')).toBe('OPENING');
    expect(presentDoorState('STOPPED', 'one-push', 'CLOSING')).toBe('CLOSING');
  });

  it('settles on OPEN for a one-push door stopped with an unknown direction', () => {
    expect(presentDoorState('STOPPED', 'one-push', null)).toBe('OPEN');
  });

  it('never presents STOPPED in one-push mode', () => {
    for (const memory of memories) {
      expect(presentDoorState('STOPPED', 'one-push', memory)).not.toBe('STOPPED');
    }
  });
});

// ─── One-push door accessory behaviour ─────────────────────────────────────

const ONE_PUSH_CONFIG: ValidatedDoorEntry = {
  name: 'Garage',
  ipAddress: '192.168.4.235',
  relay: '1:1',
  port: 4998,
  doorId: 'garage',
  pulseDuration: 500,
  openingTime: 15,
  closingTime: 15,
  midTravelBehaviour: 'one-push',
};

describe('GarageDoorAccessory — one-push door', () => {
  let hap: HapApiContainer;
  let accessory: MockAccessory;
  let sm: DoorStateMachine;
  let actuator: MockActuator;
  let persistence: PersistenceStore;
  let log: Logger;

  beforeEach(() => {
    vi.useFakeTimers();
    hap = makeHap();
    accessory = new MockAccessory();
    sm = new DoorStateMachine({ openingTime: 15, closingTime: 15, midTravelBehaviour: 'one-push' });
    actuator = new MockActuator();
    log = makeLogger();
    persistence = new PersistenceStore('/tmp/itach-accessory-one-push-test', log);
    vi.spyOn(persistence, 'save').mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function build(): GarageDoorAccessory {
    return new GarageDoorAccessory(
      hap,
      accessory,
      ONE_PUSH_CONFIG,
      sm,
      actuator as unknown as PulseActuator,
      persistence,
      log,
    );
  }

  function gdoService(): MockService {
    return accessory.services.get(REF.GarageDoorOpener) as MockService;
  }

  function lastUpdate(ref: unknown): CharacteristicValue | undefined {
    return gdoService().updates.filter((u) => u.ref === ref).pop()?.value;
  }

  it('shows Opening while internally STOPPED after an interrupted opening leg', async () => {
    const acc = build();
    await acc.handleTargetDoorStateSet(0); // open
    await acc.handleTargetDoorStateSet(1); // interrupt → STOPPED

    expect(sm.state).toBe('STOPPED');
    expect(sm.lastTravelDirection).toBe('OPENING');
    expect(lastUpdate(REF.CurrentDoorState)).toBe(2); // OPENING
    expect(lastUpdate(REF.TargetDoorState)).toBe(0); // OPEN
    expect(persistence.save).toHaveBeenCalledWith('192.168.4.235:1:1', 'STOPPED');
  });

  it('shows Closing while internally STOPPED after an interrupted closing leg', async () => {
    sm.setExternalState('OPEN');
    const acc = build();
    await acc.handleTargetDoorStateSet(1); // close
    await acc.handleTargetDoorStateSet(0); // interrupt → STOPPED

    expect(sm.state).toBe('STOPPED');
    expect(lastUpdate(REF.CurrentDoorState)).toBe(3); // CLOSING
    expect(lastUpdate(REF.TargetDoorState)).toBe(1); // CLOSED
  });

  it('shows Open while internally STOPPED with an unknown direction', () => {
    sm.restoreState({ '192.168.4.235:1:1': 'OPENING' }, '192.168.4.235:1:1');
    build();

    expect(sm.state).toBe('STOPPED');
    expect(sm.lastTravelDirection).toBeNull();
    expect(lastUpdate(REF.CurrentDoorState)).toBe(0); // OPEN
    expect(lastUpdate(REF.TargetDoorState)).toBe(0); // OPEN
  });

  it('refuses a request the next press cannot achieve without actuating', async () => {
    const acc = build();
    await acc.handleTargetDoorStateSet(0); // open
    await acc.handleTargetDoorStateSet(1); // interrupt → STOPPED (was opening)
    actuator.calls.length = 0;
    gdoService().updates.length = 0;

    await expect(acc.handleTargetDoorStateSet(0)).resolves.toBeUndefined();

    expect(actuator.calls).toHaveLength(0);
    expect(sm.state).toBe('STOPPED');
    expect(sm.lastTravelDirection).toBe('OPENING');
    expect(log.warn).toHaveBeenCalled();
    expect(lastUpdate(REF.CurrentDoorState)).toBe(2);
    expect(lastUpdate(REF.TargetDoorState)).toBe(0);
  });

  it('honours the request the next press can achieve with exactly one pulse', async () => {
    const acc = build();
    await acc.handleTargetDoorStateSet(0);
    await acc.handleTargetDoorStateSet(1);
    actuator.calls.length = 0;

    await acc.handleTargetDoorStateSet(1); // close — achievable from STOPPED(was opening)

    expect(actuator.calls).toEqual(['CLOSED']);
    expect(sm.state).toBe('CLOSING');
  });

  it('actuates exactly one pulse per write that is not a no-op or refusal', async () => {
    const acc = build();

    await acc.handleTargetDoorStateSet(0); // pulse → OPENING
    await acc.handleTargetDoorStateSet(0); // no-op
    await acc.handleTargetDoorStateSet(1); // pulse → STOPPED
    await acc.handleTargetDoorStateSet(0); // unachievable → no pulse
    await acc.handleTargetDoorStateSet(1); // pulse → CLOSING
    await acc.handleTargetDoorStateSet(1); // no-op

    expect(actuator.calls).toEqual(['OPEN', 'CLOSED', 'CLOSED']);
    expect(sm.state).toBe('CLOSING');
  });

  it('warns when pulsing from STOPPED with an unknown direction', async () => {
    sm.restoreState({ 'k': 'OPENING' }, 'k');
    const acc = build();

    await acc.handleTargetDoorStateSet(0);

    expect(actuator.calls).toEqual(['OPEN']);
    expect(sm.state).toBe('OPENING');
    const warnings = (log.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warnings.some((m) => m.includes('no record of the last travel direction'))).toBe(true);
  });

  it('reads back the held travel direction while internally STOPPED', async () => {
    const acc = build();
    await acc.handleTargetDoorStateSet(0); // open
    await acc.handleTargetDoorStateSet(1); // interrupt → STOPPED (was opening)

    expect(sm.state).toBe('STOPPED');
    expect(acc.handleCurrentDoorStateGet()).toBe(2); // OPENING, not STOPPED

    sm.setExternalState('OPEN');
    await acc.handleTargetDoorStateSet(1); // close
    await acc.handleTargetDoorStateSet(0); // interrupt → STOPPED (was closing)

    expect(sm.state).toBe('STOPPED');
    expect(acc.handleCurrentDoorStateGet()).toBe(3); // CLOSING, not STOPPED
  });

  it('reads back OPEN while internally STOPPED with an unknown direction', () => {
    sm.restoreState({ '192.168.4.235:1:1': 'CLOSING' }, '192.168.4.235:1:1');
    const acc = build();

    expect(sm.state).toBe('STOPPED');
    expect(sm.lastTravelDirection).toBeNull();
    expect(acc.handleCurrentDoorStateGet()).toBe(0); // OPEN, not STOPPED
  });

  it('throws HapStatusError on pulse failure and leaves state and memory untouched', async () => {
    const acc = build();
    await acc.handleTargetDoorStateSet(0); // → OPENING
    actuator.behaviour = () => Promise.reject(new CommunicationError('relay failed'));

    await expect(acc.handleTargetDoorStateSet(1)).rejects.toBeInstanceOf(HapStatusErrorMock);
    expect(sm.state).toBe('OPENING');
    expect(sm.lastTravelDirection).toBe('OPENING');
  });
});
