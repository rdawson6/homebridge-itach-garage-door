/**
 * Electrical continuity test for a real Global Caché iTach IP2CC.
 *
 * The IP2CC uses SOLID-STATE relays — they are silent. There is no click to
 * hear. This test instead proves the switching electrically by reading the
 * relay state back from the device, and holds contacts closed long enough for
 * you to confirm with a multimeter.
 *
 * SAFETY: only run with relays DISCONNECTED from the garage door opener.
 *
 * Usage:
 *   node continuity-test.mjs                  # readback verification
 *   node continuity-test.mjs --hold 1 30      # hold relay 1:1 closed for 30s
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { ProtocolCodec } = require('./dist/protocol-codec.js');
const { CommandClient } = require('./dist/command-client.js');

const HOST = process.env.ITACH_HOST ?? '192.168.4.235';
const PORT = Number(process.env.ITACH_PORT ?? 4998);

const args = process.argv.slice(2);
const holdIndex = args.indexOf('--hold');
const holdMode = holdIndex !== -1;
const holdConnector = holdMode ? Number(args[holdIndex + 1] ?? 1) : null;
const holdSeconds = holdMode ? Number(args[holdIndex + 2] ?? 30) : null;

const quiet = { debug() {}, info() {}, warn() {}, error(m) { console.log('  [error]', m); } };
const codec = new ProtocolCodec();
const client = new CommandClient(HOST, PORT, codec, quiet);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s = '') => process.stdout.write(s + '\n');
const inline = (s) => process.stdout.write(s);

const set = (c, v) => client.sendCommand(codec.encodeSetState(1, c, v));
const read = async (c) => (await client.sendCommand(codec.encodeGetState(1, c))).value;

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed });
  say(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Terminal labels on the IP2CC for each relay connector. */
const TERMINALS = {
  1: 'relay 1 terminals (first pair)',
  2: 'relay 2 terminals (second pair)',
  3: 'relay 3 terminals (third pair)',
};

async function holdClosed() {
  say('');
  say('═'.repeat(70));
  say('  SUSTAINED HOLD — multimeter continuity check');
  say('═'.repeat(70));
  say('');
  say(`  Relay 1:${holdConnector} will be held CLOSED for ${holdSeconds} seconds.`);
  say('');
  say('  Set your multimeter to continuity (the ♪ or Ω symbol) and place the');
  say(`  probes across ${TERMINALS[holdConnector] ?? `relay ${holdConnector}`}.`);
  say('');
  say('    While CLOSED  → meter beeps / reads near 0 Ω  (circuit complete)');
  say('    While OPEN    → meter silent / reads open      (no circuit)');
  say('');
  say('  This is the switching your garage opener will see as a button press.');
  say('');

  const before = await read(holdConnector);
  check(`relay 1:${holdConnector} starts open`, before === 0, `getstate=${before}`);

  say('');
  inline('  Closing in 3… '); await sleep(1000);
  inline('2… '); await sleep(1000);
  inline('1… '); await sleep(1000);
  say('now');
  say('');

  await set(holdConnector, 1);
  const during = await read(holdConnector);
  check(`relay 1:${holdConnector} reports CLOSED`, during === 1, `getstate=${during}`);
  say('');
  say(`  >>> CONTACTS ARE NOW CLOSED — check your meter <<<`);
  say('');

  for (let s = holdSeconds; s > 0; s--) {
    inline(`\r  CLOSED — ${String(s).padStart(3)}s remaining   `);
    await sleep(1000);
  }
  say('\r  Releasing…                    ');

  await set(holdConnector, 0);
  const after = await read(holdConnector);
  check(`relay 1:${holdConnector} reports OPEN again`, after === 0, `getstate=${after}`);
  say('');
  say('  >>> CONTACTS ARE NOW OPEN — meter should have stopped <<<');
}

async function readbackVerification() {
  say('');
  say('═'.repeat(70));
  say('  IP2CC ELECTRICAL VERIFICATION (relays are solid-state = silent)');
  say(`  Device: ${HOST}:${PORT}`);
  say('═'.repeat(70));

  say('\n  Confirming device identity');
  const devices = await client.sendCommand(codec.encodeGetDevices());
  const relayModule = devices.type === 'devices'
    ? devices.modules.find((m) => m.type === 'RELAY')
    : undefined;
  check('device reports a RELAY module', relayModule !== undefined,
    relayModule ? `module ${relayModule.module}, ${relayModule.connectors} connectors` : 'none found');
  check('relay module exposes 3 connectors', relayModule?.connectors === 3,
    `connectors=${relayModule?.connectors}`);

  say('\n  Verifying each relay switches, confirmed by readback');
  for (const c of [1, 2, 3]) {
    await set(c, 0);
    const open = await read(c);

    await set(c, 1);
    const closed = await read(c);

    await set(c, 0);
    const reopened = await read(c);

    const ok = open === 0 && closed === 1 && reopened === 0;
    check(`relay 1:${c} switches 0 → 1 → 0`, ok, `readback ${open} → ${closed} → ${reopened}`);
  }

  say('\n  Verifying relays are independent');
  await set(1, 1);
  const [s1, s2, s3] = [await read(1), await read(2), await read(3)];
  check('closing relay 1 leaves relays 2 and 3 open',
    s1 === 1 && s2 === 0 && s3 === 0, `1:1=${s1} 1:2=${s2} 1:3=${s3}`);
  await set(1, 0);

  say('\n  Verifying rapid switching is tracked correctly');
  let consistent = true;
  for (let i = 0; i < 8; i++) {
    const target = i % 2 === 0 ? 1 : 0;
    await set(1, target);
    if ((await read(1)) !== target) consistent = false;
  }
  await set(1, 0);
  check('8 rapid transitions all read back correctly', consistent);

  say('\n  Leaving all relays open');
  for (const c of [1, 2, 3]) await set(c, 0);
  const finals = [await read(1), await read(2), await read(3)];
  check('all relays open', finals.every((v) => v === 0), `states=[${finals}]`);

  say('');
  say('─'.repeat(70));
  say('  Why you heard nothing');
  say('─'.repeat(70));
  say('  The IP2CC switches with solid-state relays. They have no moving');
  say('  armature, so they make no sound at all. Silence is correct and');
  say('  expected — it is not a fault.');
  say('');
  say('  To confirm the switching physically, run a sustained hold and');
  say('  watch a multimeter set to continuity:');
  say('');
  say('      node continuity-test.mjs --hold 1 30');
  say('');
}

async function main() {
  await client.connect();
  await sleep(400);
  if (holdMode) {
    await holdClosed();
  } else {
    await readbackVerification();
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed);
  say('═'.repeat(70));
  say(`  RESULT: ${passed}/${results.length} checks passed`);
  if (failed.length) {
    say('\n  Failed:');
    for (const f of failed) say(`    - ${f.name}`);
  }
  say('═'.repeat(70));
  say('');
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    say(`\n  TEST FAILED: ${err?.message ?? err}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      for (const c of [1, 2, 3]) await set(c, 0);
      await client.disconnect();
    } catch { /* already closed */ }
  });
