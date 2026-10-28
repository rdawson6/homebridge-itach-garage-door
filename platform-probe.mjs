/**
 * Full-platform hardware probe: runs ItachGarageDoorPlatform exactly as
 * Homebridge would (no injected fakes for the network layer), against a real
 * IP2CC, and drives it through HomeKit-style writes and live webhook requests.
 *
 * SAFETY: actuates relays. Only run with the relay disconnected from the opener.
 */

import { createRequire } from 'module';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const require = createRequire(import.meta.url);

const { ItachGarageDoorPlatform, PLATFORM_NAME } = require('./dist/platform.js');
const { ProtocolCodec } = require('./dist/protocol-codec.js');
const { CommandClient } = require('./dist/command-client.js');

const HOST = process.argv[2] ?? '192.168.4.235';
const PORT = Number(process.argv[3] ?? 4998);
const WEBHOOK_PORT = 18571;
const TOKEN = 'hardware-probe-token-0123456789abcdef';

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
function section(t) { console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`); }

const verbose = process.env.VERBOSE === '1';
const logLines = [];
const log = {
  debug: (m) => { logLines.push(String(m)); verbose && console.log('    [debug]', m); },
  info: (m) => { logLines.push(String(m)); verbose && console.log('    [info ]', m); },
  warn: (m) => { logLines.push(String(m)); console.log('    [warn ]', m); },
  error: (m) => { logLines.push(String(m)); console.log('    [error]', m); },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Homebridge API stand-in (real network layer left untouched) ──────────────

const REF = Object.fromEntries(
  ['AccessoryInformation', 'GarageDoorOpener', 'Manufacturer', 'Model', 'SerialNumber',
   'Name', 'CurrentDoorState', 'TargetDoorState', 'ObstructionDetected']
    .map((k) => [k, Symbol(k)]),
);

class FakeService {
  constructor() { this.values = new Map(); this.setHandlers = new Map(); }
  getCharacteristic(ref) {
    const self = this;
    return {
      onSet(h) { self.setHandlers.set(ref, h); return this; },
      onGet() { return this; },
    };
  }
  setCharacteristic(ref, v) { this.values.set(ref, v); return this; }
  updateCharacteristic(ref, v) { this.values.set(ref, v); return this; }
}

class FakeAccessory {
  constructor(name, uuid) {
    this.displayName = name; this.UUID = uuid; this.category = 0;
    this.services = new Map();
  }
  getService(ref) { return this.services.get(ref); }
  addService(ref) { const s = new FakeService(); this.services.set(ref, s); return s; }
}

class FakeApi {
  constructor(storagePath) {
    this.registered = []; this.unregistered = [];
    this.handlers = new Map();
    this.user = { storagePath: () => storagePath };
    this.platformAccessory = FakeAccessory;
    this.hap = {
      Service: { AccessoryInformation: REF.AccessoryInformation, GarageDoorOpener: REF.GarageDoorOpener },
      Characteristic: REF,
      HapStatusError: class extends Error {},
      HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
      uuid: { generate: (seed) => `uuid-${seed}` },
      Categories: { GARAGE_DOOR_OPENER: 4 },
    };
  }
  on(e, l) { const a = this.handlers.get(e) ?? []; a.push(l); this.handlers.set(e, a); }
  fire(e) { (this.handlers.get(e) ?? []).forEach((h) => h()); }
  registerPlatformAccessories(_p, _n, a) { this.registered.push(...a); }
  unregisterPlatformAccessories(_p, _n, a) { this.unregistered.push(...a); }
  updatePlatformAccessories() {}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function webhook(doorId, body, token = TOKEN) {
  const res = await fetch(`http://127.0.0.1:${WEBHOOK_PORT}/door/${doorId}/state`, {
    method: 'POST',
    headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

const codec = new ProtocolCodec();
let inspector;
async function relayState(connector) {
  const res = await inspector.sendCommand(codec.encodeGetState(1, connector));
  return res.value;
}

const storageDir = mkdtempSync(join(tmpdir(), 'itach-platform-probe-'));
let platform;

async function main() {
  console.log(`\nFull-platform hardware probe → ${HOST}:${PORT}`);
  console.log(`Platform: ${PLATFORM_NAME}, webhook on 127.0.0.1:${WEBHOOK_PORT}`);
  console.log('Relay must be DISCONNECTED from the opener.\n');

  inspector = new CommandClient(HOST, PORT, codec, { debug(){}, info(){}, warn(){}, error(){} });
  await inspector.connect();
  await sleep(300);

  const api = new FakeApi(storageDir);
  const config = {
    platform: PLATFORM_NAME,
    name: 'iTach Garage Door',
    doors: [
      { name: 'Probe Left',  ipAddress: HOST, relay: '1:1', port: PORT,
        doorId: 'left',  pulseDuration: 250, openingTime: 2, closingTime: 2 },
      { name: 'Probe Right', ipAddress: HOST, relay: '1:2', port: PORT,
        doorId: 'right', pulseDuration: 250, openingTime: 2, closingTime: 2 },
    ],
    webhook: { port: WEBHOOK_PORT, bindAddress: '127.0.0.1', token: TOKEN },
  };

  // ── 1. Platform startup ──
  section('1. Platform startup via didFinishLaunching');
  platform = new ItachGarageDoorPlatform(log, config, api);
  const t0 = Date.now();
  api.fire('didFinishLaunching');
  // Poll until both doors publish (Req 1.10: within 5s).
  while (platform.doorIds.length < 2 && Date.now() - t0 < 5000) await sleep(50);
  const publishMs = Date.now() - t0;

  check('both doors published', platform.doorIds.length === 2, `doorIds=[${platform.doorIds}]`);
  check('published within the 5s budget (Req 1.10)', publishMs < 5000, `${publishMs}ms`);
  check('two accessories registered with Homebridge', api.registered.length === 2);
  check('accessory category set to GARAGE_DOOR_OPENER', api.registered.every((a) => a.category === 4));
  check('doors on one IP2CC share a single TCP connection (Req 12.2)',
    platform.clientCount === 1, `clientKeys=[${platform.clientKeys}]`);
  check('webhook listener is running', platform.isWebhookRunning);

  await sleep(600); // let the startup relay resets land
  check('relay 1:1 reset to 0 on startup (Req 5.3)', (await relayState(1)) === 0);
  check('relay 1:2 reset to 0 on startup (Req 5.3)', (await relayState(2)) === 0);

  // ── 2. Accessory information ──
  section('2. Accessory information (Req 1.5)');
  const infoSvc = api.registered[0].services.get(REF.AccessoryInformation);
  check('Manufacturer is "Global Cache"', infoSvc.values.get(REF.Manufacturer) === 'Global Cache',
    String(infoSvc.values.get(REF.Manufacturer)));
  check('Model is "iTach IP2CC"', infoSvc.values.get(REF.Model) === 'iTach IP2CC',
    String(infoSvc.values.get(REF.Model)));
  const serial = infoSvc.values.get(REF.SerialNumber);
  check('SerialNumber encodes ip and relay, <=64 chars',
    serial === `${HOST}-1:1` && serial.length <= 64, String(serial));

  // ── 3. HomeKit write actuates the real relay ──
  section('3. HomeKit TargetDoorState write drives real hardware');
  const left = platform.getDoor('left');
  const leftSvc = api.registered[0].services.get(REF.GarageDoorOpener);
  const setHandler = leftSvc.setHandlers.get(REF.TargetDoorState);
  check('TargetDoorState onSet handler registered', typeof setHandler === 'function');

  check('left door starts CLOSED', left.stateMachine.state === 'CLOSED', left.stateMachine.state);

  // Drive it the way HomeKit does: through the registered characteristic handler.
  await setHandler(0); // OPEN
  check('HomeKit open write moved door to OPENING', left.stateMachine.state === 'OPENING',
    left.stateMachine.state);
  check('relay released after the pulse', (await relayState(1)) === 0);
  check('other door unaffected (Req 12.1 isolation)',
    platform.getDoor('right').stateMachine.state === 'CLOSED',
    platform.getDoor('right').stateMachine.state);

  await sleep(2400);
  check('left door reached OPEN via travel timer', left.stateMachine.state === 'OPEN',
    left.stateMachine.state);

  // ── 4. Webhook corrects state on real hardware ──
  section('4. Webhook state correction (Req 8.x)');
  const wClosed = await webhook('left', { state: 'closed' });
  check('webhook accepted and returned 200', wClosed.status === 200, `status=${wClosed.status}`);
  check('webhook response carries resulting state', wClosed.body?.state === 'CLOSED',
    JSON.stringify(wClosed.body));
  check('state machine applied the webhook state', left.stateMachine.state === 'CLOSED',
    left.stateMachine.state);
  check('webhook left the relay untouched (Req 8.8)', (await relayState(1)) === 0);

  const wOpening = await webhook('left', { state: 'opening' });
  check('webhook "opening" starts a travel timer', wOpening.status === 200 && left.stateMachine.hasTimer,
    `hasTimer=${left.stateMachine.hasTimer}`);
  await sleep(2400);
  check('webhook-started timer completed to OPEN', left.stateMachine.state === 'OPEN',
    left.stateMachine.state);

  const wObstruct = await webhook('left', { state: 'stopped', obstruction: true });
  check('webhook obstruction accepted', wObstruct.status === 200);
  check('ObstructionDetected characteristic set',
    leftSvc.values.get(REF.ObstructionDetected) === true,
    String(leftSvc.values.get(REF.ObstructionDetected)));
  await webhook('left', { state: 'closed', obstruction: false });

  // ── 5. Webhook access control against the live listener ──
  section('5. Webhook access control on the live listener');
  const bad = await webhook('left', { state: 'open' }, 'wrong-token-aaaaaaaaaaaaaaaaaaaa');
  check('wrong token rejected with 401', bad.status === 401, `status=${bad.status}`);
  const unknown = await webhook('nonexistent', { state: 'open' });
  check('unknown doorId rejected with 404', unknown.status === 404, `status=${unknown.status}`);
  const badState = await webhook('left', { state: 'ajar' });
  check('invalid state rejected with 400', badState.status === 400, `status=${badState.status}`);
  check('rejected requests left the door state unchanged',
    left.stateMachine.state === 'CLOSED', left.stateMachine.state);
  check('rejected requests left the relay at rest', (await relayState(1)) === 0);

  // ── 6. Independent control of the second door ──
  section('6. Second door operates independently (Req 12.1)');
  const leftStateBefore = left.stateMachine.state;
  const rightSvc = api.registered[1].services.get(REF.GarageDoorOpener);
  await rightSvc.setHandlers.get(REF.TargetDoorState)(0); // open right
  check('right door moved to OPENING', platform.getDoor('right').stateMachine.state === 'OPENING',
    platform.getDoor('right').stateMachine.state);
  check('left door state unchanged by right door activity',
    left.stateMachine.state === leftStateBefore, left.stateMachine.state);
  check('relay 1:2 released after pulse', (await relayState(2)) === 0);
  await sleep(2400);

  // ── 7. Token never logged ──
  section('7. Token redaction in log output (Req 13.5)');
  const leaked = logLines.filter((l) => l.includes(TOKEN));
  check('webhook token never appears in any log line', leaked.length === 0,
    leaked.length > 0 ? `${leaked.length} leaking line(s)` : `${logLines.length} lines checked`);

  // ── 8. Persistence ──
  section('8. State persistence (Req 11.x)');
  await sleep(300);
  const { readFileSync, existsSync } = require('fs');
  const stateFile = join(storageDir, 'itach-garage-door.state.json');
  check('state file written to the storage directory', existsSync(stateFile));
  if (existsSync(stateFile)) {
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
    check('state keyed by ip:module:connector (Req 11.3)',
      Object.keys(persisted).includes(`${HOST}:1:1`), Object.keys(persisted).join(', '));
    check('persisted values are valid door states',
      Object.values(persisted).every((v) => ['OPEN','CLOSED','OPENING','CLOSING','STOPPED'].includes(v)),
      JSON.stringify(persisted));
  }

  // ── 9. Graceful shutdown ──
  section('9. Graceful shutdown (Req 14.8)');
  platform.getDoor('left').stateMachine.setExternalState('OPENING');
  check('a travel timer is running before shutdown', platform.getDoor('left').stateMachine.hasTimer);
  await platform.shutdown();
  check('travel timers cancelled', platform.getDoor('left').stateMachine.hasTimer === false);
  check('webhook listener stopped', platform.isWebhookRunning === false);
  check('TCP connection pool cleared', platform.clientCount === 0);

  const refused = await fetch(`http://127.0.0.1:${WEBHOOK_PORT}/door/left/state`, {
    method: 'POST', headers: { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'open' }),
  }).then(() => 'accepted').catch(() => 'refused');
  check('webhook port no longer accepts connections', refused === 'refused', refused);

  // ── Safe resting state ──
  section('Leaving hardware in a safe resting state');
  for (const c of [1, 2, 3]) await inspector.sendCommand(codec.encodeSetState(1, c, 0));
  const finals = [await relayState(1), await relayState(2), await relayState(3)];
  check('all relays left de-energised', finals.every((v) => v === 0), `states=[${finals}]`);
}

main()
  .catch((err) => {
    console.log('\nPROBE ABORTED:', err?.stack ?? err);
    results.push({ name: 'probe ran to completion', passed: false, detail: String(err?.message ?? err) });
  })
  .finally(async () => {
    try { await platform?.shutdown(); } catch { /* already down */ }
    try { await inspector?.disconnect(); } catch { /* already closed */ }
    try { rmSync(storageDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed);
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`RESULT: ${passed}/${results.length} checks passed`);
    if (failed.length) {
      console.log('\nFailed checks:');
      for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
    }
    console.log('═'.repeat(72));
    process.exit(failed.length ? 1 : 0);
  });
