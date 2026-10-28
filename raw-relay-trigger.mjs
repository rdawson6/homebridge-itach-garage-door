/**
 * Raw iTach IP2CC relay trigger — no plugin code involved.
 *
 * Opens a plain TCP socket and speaks the Global Caché Unified TCP/IP API
 * directly: setstate,<module>:<connector>,<state> terminated with \r.
 * Every byte sent and received is printed as it happens.
 *
 * Long holds are used so the engage and release are clearly separated in time.
 *
 * SAFETY: actuates relays. Only run with relays DISCONNECTED from the opener.
 *
 * Usage: node raw-relay-trigger.mjs [ip] [port]
 */

import net from 'net';

const HOST = process.argv[2] ?? '192.168.4.235';
const PORT = Number(process.argv[3] ?? 4998);

const out = (s = '') => process.stdout.write(s + '\n');
const inline = (s) => process.stdout.write(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const socket = net.connect(PORT, HOST);
socket.setNoDelay(true); // no Nagle buffering — send each command immediately

let rxBuffer = '';
const waiters = [];

socket.on('data', (chunk) => {
  rxBuffer += chunk.toString('utf8');
  let idx;
  while ((idx = rxBuffer.indexOf('\r')) !== -1) {
    const frame = rxBuffer.slice(0, idx);
    rxBuffer = rxBuffer.slice(idx + 1);
    if (frame.length === 0) continue;
    out(`        RX  ${JSON.stringify(frame)}`);
    const w = waiters.shift();
    if (w) w(frame);
  }
});

/** Send a raw command and wait for the device's reply frame. */
function send(command) {
  return new Promise((resolve, reject) => {
    out(`        TX  ${JSON.stringify(command + '\r')}`);
    waiters.push(resolve);
    socket.write(command + '\r', (err) => { if (err) reject(err); });
    setTimeout(() => reject(new Error(`no reply to "${command}" within 3000ms`)), 3000);
  });
}

const setState = (c, v) => send(`setstate,1:${c},${v}`);
const getState = (c) => send(`getstate,1:${c}`);

function bar(title) {
  out('');
  out('─'.repeat(68));
  out(`  ${title}`);
  out('─'.repeat(68));
}

async function main() {
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  out('');
  out('═'.repeat(68));
  out('  RAW IP2CC PROTOCOL — DIRECT RELAY TRIGGER');
  out(`  Socket: ${HOST}:${PORT}   (plain TCP, no plugin code)`);
  out('═'.repeat(68));
  out('');
  out('  Every command and reply is shown on the wire as TX / RX.');
  out('  Holds are long, so ENGAGE and RELEASE are well separated.');

  // Drain the greeting/unsolicited data some units emit on connect.
  await sleep(500);
  rxBuffer = '';
  waiters.length = 0;

  // ── Baseline ──
  bar('Baseline — read all three relays');
  for (const c of [1, 2, 3]) {
    const reply = await getState(c);
    out(`    relay 1:${c} → ${reply}`);
    await sleep(200);
  }

  // ── Slow deliberate cycles on relay 1 ──
  bar('Relay 1:1 — three slow cycles, 3 second holds');
  out('  Listen for TWO separate events each cycle: engage, then release.');
  out('');
  await sleep(1500);

  for (let i = 1; i <= 3; i++) {
    out(`  ── Cycle ${i} of 3 ──`);

    inline('    ENGAGE relay 1:1 now\n');
    await setState(1, 1);
    const confirmOn = await getState(1);
    out(`    confirmed: ${confirmOn}`);

    for (let s = 3; s > 0; s--) {
      inline(`\r    holding closed — ${s}s  `);
      await sleep(1000);
    }
    out('');

    inline('    RELEASE relay 1:1 now\n');
    await setState(1, 0);
    const confirmOff = await getState(1);
    out(`    confirmed: ${confirmOff}`);

    out('');
    await sleep(2500);
  }

  // ── Each relay in turn, long holds ──
  bar('Each relay in turn — 2 second holds, 3 seconds between');
  await sleep(1000);

  for (const c of [1, 2, 3]) {
    out(`  ── Relay 1:${c} ──`);
    inline(`    ENGAGE 1:${c}\n`);
    await setState(c, 1);
    out(`    confirmed: ${await getState(c)}`);
    await sleep(2000);
    inline(`    RELEASE 1:${c}\n`);
    await setState(c, 0);
    out(`    confirmed: ${await getState(c)}`);
    out('');
    await sleep(3000);
  }

  // ── Garage door pulse, raw protocol ──
  bar('Garage door pulse — raw protocol, 500ms hold');
  out('  This is the exact command pair the plugin sends for one button press.');
  out('');
  await sleep(1500);

  for (let i = 1; i <= 4; i++) {
    out(`  ── Pulse ${i} of 4 ──`);
    const t0 = Date.now();
    await setState(1, 1);
    await sleep(500);
    await setState(1, 0);
    out(`    pulse complete in ${Date.now() - t0}ms`);
    out('');
    await sleep(2500);
  }

  // ── Alternating chatter ──
  bar('Rapid alternation — 12 transitions on relay 1:1');
  out('  If the relay is mechanical this should be a rapid chatter.');
  out('');
  await sleep(1500);

  for (let i = 0; i < 12; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    inline(`\r    transition ${String(i + 1).padStart(2)}/12 → state ${v}   `);
    await setState(1, v);
    await sleep(250);
  }
  out('');
  await setState(1, 0);

  // ── Final state ──
  bar('Final state — leaving all relays open');
  const finals = [];
  for (const c of [1, 2, 3]) {
    await setState(c, 0);
    const reply = await getState(c);
    finals.push(reply);
    out(`    relay 1:${c} → ${reply}`);
  }
  const allOpen = finals.every((f) => f.endsWith(',0'));

  out('');
  out('═'.repeat(68));
  out(allOpen ? '  DONE — all relays confirmed OPEN (safe)' : '  DONE — WARNING: a relay is still closed');
  out('═'.repeat(68));
  out('');
}

main()
  .catch((err) => {
    out(`\n  FAILED: ${err?.message ?? err}`);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      // Belt and braces: de-energise everything before closing.
      socket.write('setstate,1:1,0\rsetstate,1:2,0\rsetstate,1:3,0\r');
      setTimeout(() => { socket.end(); process.exit(process.exitCode ?? 0); }, 400);
    } catch {
      socket.destroy();
    }
  });
