/**
 * LED-visible plugin test for a real Global Caché iTach IP2CC.
 *
 * Runs the ACTUAL plugin (ItachGarageDoorPlatform, DoorStateMachine,
 * PulseActuator, GarageDoorAccessory, WebhookListener) against real hardware,
 * using 2000ms pulses — the maximum the config validator allows — so each relay
 * LED stays lit long enough to see clearly.
 *
 * Each action is announced with a countdown, and the relay state is read back
 * from the device while the LED should be lit, so what you see is corroborated
 * on the wire.
 *
 * SAFETY: actuates relays. Only run with relays DISCONNECTED from the opener.
 *
 * Usage: node led-test.mjs [ip] [port]
 */

import { createRequire } from 'module';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const require = createRequire(import.meta.url);

const { ItachGarageDoorPlatform } = require('./dist/platform.js');
const { ProtocolCodec } = require('./dist/protocol-codec.js');
const { CommandClient } = require('./dist/command-client.js');

const HOST = process.argv[2] ?? '192.168.4.235';
const PORT = Number(process.argv[3] ?? 4998);
const WEBHOOK_PORT = 18572;
const TOKEN = 'led-test-token-0123456789abcdef';

const out = (s = '') => process.stdout.write(s + '\n');
const inline = (s) => process.stdout.write(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed });
  out(`    ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function bar(title) {
  out('');
  out('─'.repeat(68));
  out(`  ${title}`);
  out('─'.repeat(68));
}

async function watchCountdown(message) {
  inline(`  ${message} `);
  for (let i = 3; i > 0; i--) { inline(`${i}… `); await sleep(1000); }
  out('NOW');
}

// ─── Minimal Homebridge API stand-in (real network layer untouched) ───────────

const REF = Object.fromEntries(
  ['AccessoryInformation', 'GarageDoorOpener', 'Manufacturer', 'Model', 'SerialNumber',
   'Name', 'CurrentDoorState', 'TargetDoorState', 'ObstructionDetected']
    .map((k) => [k, Symbol(k)]),
);

class FakeService {
  constructor() { this.values = new Map(); this.setHandlers = new Map(); }
  getCharacteristic(ref) {
    const self = this;
    return { onSet(h) { self.setHandlers.set(ref, h); return this; }, onGet() { return this; } };
  }
  setCharacteristic(ref, v) { this.values.set(ref, v); return this; }
  updateCharacteristic(ref, v) { this.values.set(ref, v); return this; }
}
class FakeAccessory {
  constructor(name, uuid) {
    this.displayName = name; this.UUID = uuid; this.category = 0; this.services = new Map();
  }
  getService(r) { return this.services.get(r); }
  addService(r) { const s = new FakeService(); this.services.set(r, s); return s; }
}
class FakeApi {
  constructor(storagePath) {
    this.registered = []; this.handlers = new Map();
    this.user = { storagePath: () => storagePath };
    this.platformAccessory = FakeAccessory;
    this.hap = {
      Service: { AccessoryInformation: REF.AccessoryInformation, GarageDoorOpener: REF.GarageDoorOpener },
      Characteristic: REF,
      HapStatusError: class extends Error {},
      HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
      uuid: { generate: (s) => `uuid-${s}` },
      Categories: { GARAGE_DOOR_OPENER: 4 },
    };
  }
  on(e, l) { const a = this.handlers.get(e) ?? []; a.push(l); this.handlers.set(e, a); }
  fire(e) { (this.handlers.get(e) ?? []).forEach((h) => h()); }
  registerPlatformAccessories(_p, _n, a) { this.registered.push(...a); }
  unregisterPlatformAccessories() {}
  updatePlatformAccessories() {}
}

const quietLog = { debug() {}, info() {}, warn() {}, error(m) { out(`    [error] ${m}`); } };
const codec = new ProtocolCodec();
const storageDir = mkdtempSync(join(tmpdir(), 'itach-led-'));

let inspector;
let platform;

const readRelay = async (c) =>
  (await inspector.sendCommand(codec.encodeGetState(1, c))).value;

async function webhook(doorId, body) {
  const res = await fetch(`http://127.0.0.1:${WEBHOOK_PORT}/door/${doorId}/state`, {
    method: 'POST',
    headers: { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * Trigger a HomeKit-style door write and sample the relay mid-pulse, so the
 * LED you see is confirmed by a readback at the same moment.
 */
async function triggerAndSample(setHandler, target, connector, label) {
  out(`  ${label}`);
  await watchCountdown(`  Watch relay ${connector} LED — activating in`);

  let midPulseState = null;
  // Sample ~700ms in, comfortably inside the 2000ms hold.
  const sampler = sleep(700).then(async () => {
    try { midPulseState = await readRelay(connector); } catch { /* ignore */ }
  });

  const t0 = Date.now();
  await setHandler(target);
  await sampler;
  const elapsed = Date.now() - t0;

  const after = await readRelay(connector);
  check(`relay ${connector} was CLOSED mid-pulse (LED lit)`, midPulseState === 1,
    `readback during pulse = ${midPulseState}`);
  check(`relay ${connector} released after pulse (LED off)`, after === 0, `readback = ${after}`);
  out(`    pulse took ${elapsed}ms`);
  out('');
}

async function main() {
  out('');
  out('═'.repeat(68));
  out('  PLUGIN TEST — WATCH THE RELAY LEDs');
  out(`  Device: ${HOST}:${PORT}`);
  out('');
  out('  Running the real plugin with 2000ms pulses so each LED stays');
  out('  lit for a full 2 seconds — easy to see, not a brief flicker.');
  out('  Every LED event is corroborated by a readback from the device.');
  out('═'.repeat(68));

  inspector = new CommandClient(HOST, PORT, codec, quietLog);
  await inspector.connect();
  await sleep(400);

  const api = new FakeApi(storageDir);
  const config = {
    platform: 'ItachGarageDoor',
    name: 'LED Test',
    doors: [
      { name: 'Door One', ipAddress: HOST, relay: '1:1', port: PORT,
        doorId: 'one', pulseDuration: 2000, openingTime: 4, closingTime: 4 },
      { name: 'Door Two', ipAddress: HOST, relay: '1:2', port: PORT,
        doorId: 'two', pulseDuration: 2000, openingTime: 4, closingTime: 4 },
    ],
    webhook: { port: WEBHOOK_PORT, bindAddress: '127.0.0.1', token: TOKEN },
  };

  // ── Startup ──
  bar('1. Plugin startup');
  out('  The plugin resets every relay to 0 on startup, so all LEDs');
  out('  should be OFF after this step.');
  out('');
  platform = new ItachGarageDoorPlatform(quietLog, config, api);
  api.fire('didFinishLaunching');
  const t0 = Date.now();
  while (platform.doorIds.length < 2 && Date.now() - t0 < 5000) await sleep(50);
  await sleep(800);

  check('both doors published by the plugin', platform.doorIds.length === 2,
    `[${platform.doorIds}]`);
  check('relay 1 OFF after startup reset', (await readRelay(1)) === 0);
  check('relay 2 OFF after startup reset', (await readRelay(2)) === 0);

  const svcOne = api.registered[0].services.get(REF.GarageDoorOpener);
  const svcTwo = api.registered[1].services.get(REF.GarageDoorOpener);
  const openOne = svcOne.setHandlers.get(REF.TargetDoorState);
  const openTwo = svcTwo.setHandlers.get(REF.TargetDoorState);

  // ── HomeKit OPEN on door one ──
  bar('2. HomeKit "open" on Door One → relay 1 LED');
  await sleep(1000);
  await triggerAndSample(openOne, 0, 1, 'HomeKit sets TargetDoorState = OPEN on Door One');
  check('Door One state machine is OPENING', platform.getDoor('one').stateMachine.state === 'OPENING',
    platform.getDoor('one').stateMachine.state);

  out('  Waiting for the 4s travel timer to reach OPEN…');
  await sleep(4400);
  check('Door One reached OPEN via travel timer',
    platform.getDoor('one').stateMachine.state === 'OPEN',
    platform.getDoor('one').stateMachine.state);

  // ── HomeKit CLOSE on door one ──
  bar('3. HomeKit "close" on Door One → relay 1 LED again');
  await sleep(1500);
  await triggerAndSample(openOne, 1, 1, 'HomeKit sets TargetDoorState = CLOSED on Door One');
  check('Door One state machine is CLOSING', platform.getDoor('one').stateMachine.state === 'CLOSING',
    platform.getDoor('one').stateMachine.state);
  await sleep(4400);

  // ── Door two, different relay ──
  bar('4. HomeKit "open" on Door Two → relay 2 LED (different relay)');
  out('  This proves the plugin targets the correct relay per door.');
  await sleep(1500);
  await triggerAndSample(openTwo, 0, 2, 'HomeKit sets TargetDoorState = OPEN on Door Two');
  check('relay 1 stayed OFF while relay 2 fired', (await readRelay(1)) === 0);
  await sleep(4400);

  // ── Webhook: state change with NO relay activity ──
  bar('5. Webhook state change → NO LED should light');
  out('  A webhook corrects the reported door state only. It must NOT');
  out('  actuate the relay, so NO LED should flash during this step.');
  out('');
  await watchCountdown('  Watch both LEDs (expect no change) — sending in');

  const before1 = await readRelay(1);
  const before2 = await readRelay(2);
  const reply = await webhook('one', { state: 'open' });
  // Sample repeatedly across the window a pulse would have occupied.
  let anyClosed = false;
  for (let i = 0; i < 6; i++) {
    if ((await readRelay(1)) === 1 || (await readRelay(2)) === 1) anyClosed = true;
    await sleep(300);
  }

  check('webhook accepted with 200', reply.status === 200, `status=${reply.status}`);
  check('webhook changed the reported door state', reply.body?.state === 'OPEN',
    JSON.stringify(reply.body));
  check('NO relay activated by the webhook (no LED)', anyClosed === false,
    `relays stayed at ${before1}/${before2}`);

  // ── Rapid visible sequence ──
  bar('6. Three deliberate pulses on relay 1 (2s lit, 2s dark)');
  out('  A clear on/off rhythm: LED lit 2s, dark 2s, three times.');
  out('');
  platform.getDoor('one').stateMachine.setExternalState('CLOSED');
  await sleep(1000);

  for (let i = 1; i <= 3; i++) {
    inline(`  Pulse ${i}/3 — relay 1 LED ON… `);
    const actuator = platform.getDoor('one').actuator;
    const pulse = actuator.actuate('OPEN');
    await sleep(700);
    const lit = await readRelay(1);
    await pulse;
    inline(`OFF   [mid-pulse readback ${lit}]\n`);
    check(`pulse ${i}: relay was closed mid-pulse`, lit === 1);
    platform.getDoor('one').stateMachine.setExternalState('CLOSED');
    await sleep(2000);
  }

  // ── Shutdown ──
  bar('7. Shutdown — relays left safe');
  await platform.shutdown();
  const finals = [await readRelay(1), await readRelay(2), await readRelay(3)];
  check('all relays OFF after shutdown (all LEDs dark)',
    finals.every((v) => v === 0), `states=[${finals}]`);
}

main()
  .catch((err) => {
    out(`\n  TEST FAILED: ${err?.stack ?? err}`);
    results.push({ name: 'test ran to completion', passed: false });
  })
  .finally(async () => {
    try { await platform?.shutdown(); } catch { /* down already */ }
    try {
      for (const c of [1, 2, 3]) await inspector?.sendCommand(codec.encodeSetState(1, c, 0));
      await inspector?.disconnect();
    } catch { /* closed already */ }
    try { rmSync(storageDir, { recursive: true, force: true }); } catch { /* ignore */ }

    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed);
    out('');
    out('═'.repeat(68));
    out(`  RESULT: ${passed}/${results.length} checks passed`);
    if (failed.length) {
      out('\n  Failed:');
      for (const f of failed) out(`    - ${f.name}`);
    }
    out('═'.repeat(68));
    out('');
    process.exit(failed.length ? 1 : 0);
  });
