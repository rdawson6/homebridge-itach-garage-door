/**
 * Hardware integration probe for a real Global Caché iTach IP2CC.
 *
 * Exercises the plugin's compiled dist/ code against the device and checks the
 * observable behaviour against the acceptance criteria that unit tests could
 * only assert against mocks.
 *
 * SAFETY: this DOES actuate relays. Only run it with the relay disconnected
 * from the garage door opener.
 *
 * Usage: node hardware-probe.mjs [ip] [port]
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { ProtocolCodec } = require('./dist/protocol-codec.js');
const { CommandClient } = require('./dist/command-client.js');
const { PulseActuator } = require('./dist/pulse-actuator.js');
const { DoorStateMachine } = require('./dist/door-state-machine.js');
const { GarageDoorAccessory } = require('./dist/accessory.js');
const { PersistenceStore } = require('./dist/persistence-store.js');
const { validateConfig } = require('./dist/config-validator.js');

const HOST = process.argv[2] ?? '192.168.4.235';
const PORT = Number(process.argv[3] ?? 4998);
const RELAY = '1:1';

// ─── Result tracking ─────────────────────────────────────────────────────────

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  const tag = passed ? '  PASS' : '  FAIL';
  console.log(`${tag}  ${name}${detail ? `  — ${detail}` : ''}`);
}
function section(title) {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

// Quiet logger; set VERBOSE=1 to see the wire traffic.
const verbose = process.env.VERBOSE === '1';
const log = {
  debug: (m) => verbose && console.log('    [debug]', m),
  info: (m) => verbose && console.log('    [info ]', m),
  warn: (m) => console.log('    [warn ]', m),
  error: (m) => console.log('    [error]', m),
};

const codec = new ProtocolCodec();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Minimal HAP stand-in, mirroring what Homebridge passes ──────────────────

const REF = Object.fromEntries(
  ['AccessoryInformation', 'GarageDoorOpener', 'Manufacturer', 'Model', 'SerialNumber',
   'Name', 'CurrentDoorState', 'TargetDoorState', 'ObstructionDetected']
    .map((k) => [k, Symbol(k)]),
);

class FakeService {
  constructor() { this.values = new Map(); this.history = []; }
  getCharacteristic() { return { onSet: () => this, onGet: () => this }; }
  setCharacteristic(ref, v) { this.values.set(ref, v); return this; }
  updateCharacteristic(ref, v) {
    this.values.set(ref, v);
    this.history.push({ ref, v });
    return this;
  }
}

class FakeAccessory {
  constructor(name, uuid) {
    this.displayName = name; this.UUID = uuid; this.category = 0;
    this.services = new Map();
  }
  getService(ref) { return this.services.get(ref); }
  addService(ref) { const s = new FakeService(); this.services.set(ref, s); return s; }
}

const hapContainer = {
  hap: {
    Service: { AccessoryInformation: REF.AccessoryInformation, GarageDoorOpener: REF.GarageDoorOpener },
    Characteristic: REF,
    HapStatusError: class extends Error {},
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
  },
};

// ─── Probe ───────────────────────────────────────────────────────────────────

const client = new CommandClient(HOST, PORT, codec, log);

async function main() {
  console.log(`\niTach IP2CC hardware probe → ${HOST}:${PORT}, relay ${RELAY}`);
  console.log('Relay must be DISCONNECTED from the opener. Relays will be actuated.');

  // ── 1. Connection and device discovery ──
  section('1. Connection and device discovery');
  const tConnect = Date.now();
  await client.connect();
  const connectMs = Date.now() - tConnect;
  check('TCP connection established', client.isConnected, `${connectMs}ms`);
  check('connection well under the 5000ms timeout', connectMs < 5000, `${connectMs}ms`);

  await sleep(500); // let the automatic getdevices settle

  const devices = await client.sendCommand(codec.encodeGetDevices());
  check('getdevices parsed as a devices response', devices.type === 'devices', `type=${devices.type}`);

  // ── 2. Read-only state queries ──
  section('2. Read-only state queries (getstate)');
  for (const c of [1, 2, 3]) {
    const res = await client.sendCommand(codec.encodeGetState(1, c));
    check(`getstate 1:${c} returns a parsed state`, res.type === 'state' && (res.value === 0 || res.value === 1),
      `value=${res.value}`);
  }

  // ── 3. Raw setstate round trip ──
  section('3. Raw relay control (setstate echo behaviour)');
  const engage = await client.sendCommand(codec.encodeSetState(1, 1, 1));
  check('setstate 1 echoes back as setstate-echo', engage.type === 'setstate-echo',
    `type=${engage.type} value=${engage.value}`);

  const readBack = await client.sendCommand(codec.encodeGetState(1, 1));
  check('getstate confirms relay is energised (value 1)', readBack.value === 1, `value=${readBack.value}`);

  const release = await client.sendCommand(codec.encodeSetState(1, 1, 0));
  check('setstate 0 echoes back as setstate-echo', release.type === 'setstate-echo',
    `type=${release.type} value=${release.value}`);

  const readBack2 = await client.sendCommand(codec.encodeGetState(1, 1));
  check('getstate confirms relay released (value 0)', readBack2.value === 0, `value=${readBack2.value}`);

  // ── 4. Startup reset ──
  section('4. Startup relay reset (Req 5.3)');
  const actuator500 = new PulseActuator(client, codec, log, RELAY, 500);
  const resetOk = await actuator500.reset();
  check('reset() succeeds and marks the actuator ready', resetOk && actuator500.isReady);
  const afterReset = await client.sendCommand(codec.encodeGetState(1, 1));
  check('relay is at state 0 after reset', afterReset.value === 0, `value=${afterReset.value}`);

  // ── 5. Pulse timing across the configured range ──
  section('5. Pulse hold interval (Req 5.1: pulseDuration .. +250ms)');
  for (const duration of [100, 500, 2000]) {
    const actuator = new PulseActuator(client, codec, log, RELAY, duration);
    await actuator.reset();
    const t0 = Date.now();
    const result = await actuator.actuate('OPEN');
    const wall = Date.now() - t0;
    const withinSpec = result.holdMs >= duration && result.holdMs <= duration + 250;
    check(`pulse ${duration}ms: hold interval within spec`, withinSpec,
      `measured hold=${result.holdMs}ms, total=${wall}ms`);
    const resting = await client.sendCommand(codec.encodeGetState(1, 1));
    check(`pulse ${duration}ms: relay returned to 0`, resting.value === 0, `value=${resting.value}`);
  }

  // ── 6. Queue behaviour under real latency ──
  section('6. Actuation queue (Req 5.7/5.8: max 2 queued, 1000ms spacing)');
  const qActuator = new PulseActuator(client, codec, log, RELAY, 200);
  await qActuator.reset();
  const p1 = qActuator.actuate('OPEN');
  const p2 = qActuator.actuate('CLOSED');
  const p3 = qActuator.actuate('OPEN');
  check('two requests queue behind the in-flight pulse', qActuator.queueDepth === 2,
    `queueDepth=${qActuator.queueDepth}`);
  let overflowRejected = false;
  try { await qActuator.actuate('CLOSED'); } catch { overflowRejected = true; }
  check('a third queued request is rejected', overflowRejected);

  const tQueue = Date.now();
  await Promise.all([p1, p2, p3]);
  const queueMs = Date.now() - tQueue;
  // 3 pulses: first in flight, then 2 more each after a 1000ms gap + 200ms hold.
  check('queued pulses honour the inter-pulse delay', queueMs >= 2000,
    `3 pulses drained in ${queueMs}ms (expected >=2000ms)`);
  const restAfterQueue = await client.sendCommand(codec.encodeGetState(1, 1));
  check('relay at rest after queue drains', restAfterQueue.value === 0, `value=${restAfterQueue.value}`);

  // ── 7. End-to-end accessory + state machine cycle ──
  section('7. End-to-end open/close cycle through the accessory');
  const cfg = validateConfig([{
    name: 'Probe Door', ipAddress: HOST, relay: RELAY, port: PORT,
    doorId: 'probe', pulseDuration: 300, openingTime: 2, closingTime: 2,
  }]).doors[0];
  check('probe config passes validation', cfg !== undefined);

  const sm = new DoorStateMachine({
    openingTime: cfg.openingTime, closingTime: cfg.closingTime,
    midTravelBehaviour: cfg.midTravelBehaviour,
  });
  const actuator2 = new PulseActuator(client, codec, log, cfg.relay, cfg.pulseDuration);
  await actuator2.reset();

  const store = new PersistenceStore('/tmp', log);
  const accessory = new FakeAccessory(cfg.name, 'probe-uuid');
  const handler = new GarageDoorAccessory(hapContainer, accessory, cfg, sm, actuator2, store, log);
  const svc = accessory.services.get(REF.GarageDoorOpener);

  check('door starts CLOSED', sm.state === 'CLOSED', `state=${sm.state}`);

  // HomeKit asks to open (TargetDoorState = 0)
  await handler.handleTargetDoorStateSet(0);
  check('open request drives state to OPENING', sm.state === 'OPENING', `state=${sm.state}`);
  check('CurrentDoorState characteristic reports OPENING (2)',
    svc.values.get(REF.CurrentDoorState) === 2, `value=${svc.values.get(REF.CurrentDoorState)}`);

  await sleep(cfg.openingTime * 1000 + 400);
  check('travel timer completes to OPEN', sm.state === 'OPEN', `state=${sm.state}`);
  check('CurrentDoorState characteristic reports OPEN (0)',
    svc.values.get(REF.CurrentDoorState) === 0, `value=${svc.values.get(REF.CurrentDoorState)}`);

  // HomeKit asks to close (TargetDoorState = 1)
  await handler.handleTargetDoorStateSet(1);
  check('close request drives state to CLOSING', sm.state === 'CLOSING', `state=${sm.state}`);

  await sleep(cfg.closingTime * 1000 + 400);
  check('travel timer completes to CLOSED', sm.state === 'CLOSED', `state=${sm.state}`);
  check('CurrentDoorState characteristic reports CLOSED (1)',
    svc.values.get(REF.CurrentDoorState) === 1, `value=${svc.values.get(REF.CurrentDoorState)}`);

  // Idempotent write: closing an already-closed door must not actuate.
  const restingState = await client.sendCommand(codec.encodeGetState(1, 1));
  await handler.handleTargetDoorStateSet(1);
  check('closing an already-CLOSED door is a no-op', sm.state === 'CLOSED', `state=${sm.state}`);
  check('no-op write left the relay untouched',
    (await client.sendCommand(codec.encodeGetState(1, 1))).value === restingState.value);

  // ── 8. Mid-travel stop ──
  section('8. Mid-travel behaviour (stop mode)');
  await handler.handleTargetDoorStateSet(0); // start opening
  check('door is OPENING before interruption', sm.state === 'OPENING', `state=${sm.state}`);
  await sleep(200);
  await handler.handleTargetDoorStateSet(1); // interrupt
  check('mid-travel command stops the door', sm.state === 'STOPPED', `state=${sm.state}`);
  check('travel timer cancelled on stop', sm.hasTimer === false);
  check('CurrentDoorState characteristic reports STOPPED (4)',
    svc.values.get(REF.CurrentDoorState) === 4, `value=${svc.values.get(REF.CurrentDoorState)}`);
  sm.setExternalState('CLOSED');
  sm.cancelTimer();

  // ── 9. Shared connection across relays ──
  section('9. Multiple relays over one shared connection (Req 12.2)');
  const actA = new PulseActuator(client, codec, log, '1:1', 150);
  const actB = new PulseActuator(client, codec, log, '1:2', 150);
  await Promise.all([actA.reset(), actB.reset()]);
  const [rA, rB] = await Promise.all([actA.actuate('OPEN'), actB.actuate('OPEN')]);
  check('relay 1:1 pulsed over the shared connection', rA.holdMs >= 150, `hold=${rA.holdMs}ms`);
  check('relay 1:2 pulsed over the shared connection', rB.holdMs >= 150, `hold=${rB.holdMs}ms`);
  const sA = await client.sendCommand(codec.encodeGetState(1, 1));
  const sB = await client.sendCommand(codec.encodeGetState(1, 2));
  check('both relays at rest afterwards', sA.value === 0 && sB.value === 0,
    `1:1=${sA.value} 1:2=${sB.value}`);

  // ── 10. Reconnection ──
  section('10. Reconnection after connection loss (Req 3.x)');
  await client.disconnect();
  check('client reports disconnected', client.isConnected === false);
  const client2 = new CommandClient(HOST, PORT, codec, log);
  await client2.connect();
  await sleep(400);
  check('a fresh connection re-establishes', client2.isConnected);
  const afterReconnect = await client2.sendCommand(codec.encodeGetState(1, 1));
  check('commands work after reconnecting', afterReconnect.type === 'state',
    `value=${afterReconnect.value}`);

  // Leave every relay de-energised.
  section('Leaving hardware in a safe resting state');
  for (const c of [1, 2, 3]) {
    await client2.sendCommand(codec.encodeSetState(1, c, 0));
  }
  const finals = [];
  for (const c of [1, 2, 3]) {
    finals.push((await client2.sendCommand(codec.encodeGetState(1, c))).value);
  }
  check('all three relays left at state 0', finals.every((v) => v === 0), `states=[${finals}]`);
  await client2.disconnect();
}

main()
  .catch((err) => {
    console.log('\nPROBE ABORTED:', err?.message ?? err);
    results.push({ name: 'probe ran to completion', passed: false, detail: String(err?.message ?? err) });
  })
  .finally(async () => {
    try { await client.disconnect(); } catch { /* already closed */ }
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed);
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`RESULT: ${passed}/${results.length} checks passed`);
    if (failed.length > 0) {
      console.log('\nFailed checks:');
      for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
    }
    console.log('═'.repeat(72));
    process.exit(failed.length > 0 ? 1 : 0);
  });
