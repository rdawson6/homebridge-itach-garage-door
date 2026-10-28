# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-10-28

First working release. Controls one or more garage doors or gates through a
Global Caché iTach IP2CC contact-closure relay over TCP.

### Added

- Homebridge dynamic platform (`ItachGarageDoor`) publishing a HomeKit
  `GarageDoorOpener` accessory per configured door, up to 8 doors.
- Global Caché Unified TCP/IP API codec: `setstate`, `getstate`, `getdevices`,
  with `\r`-delimited stream framing and a total (never-throwing) parser.
- TCP command client with a 16-deep FIFO queue, 3000 ms command timeout,
  5000 ms connection timeout, exponential reconnect backoff (1 s → 60 s), and a
  30 s grace period during which last-known values are reported.
- Momentary pulse actuation (relay closed for `pulseDuration`, then released),
  with 3 release retries at 500 ms intervals and a lockout if all retries fail.
- Per-door actuation queue holding up to 2 pending requests, with 1000 ms
  spacing between consecutive pulses.
- Timer-inferred door state machine (`CLOSED`, `OPEN`, `OPENING`, `CLOSING`,
  `STOPPED`) with configurable opening and closing travel times.
- Configurable mid-travel behaviour per door: `stop` (a trigger while moving
  halts the door) or `reverse` (a trigger while moving reverses direction).
- Optional authenticated HTTP webhook for external state correction, with
  constant-time token comparison, per-IP rate limiting (10 requests/second),
  and a strict validation order: rate limit → token → method → door ID → body.
- Obstruction reporting via the webhook's optional `obstruction` field.
- State persistence to `itach-garage-door.state.json`, keyed by IP address and
  relay so entries survive reordering of the `doors` array. Travel states are
  restored as `STOPPED`, since real position cannot be known after a restart.
- Shared TCP connection pooling: doors on the same IP2CC address and port share
  one connection, while keeping independent state, timers, and queues.
- Startup relay reset (`setstate 0`) before any actuation is accepted.
- Webhook token redaction in all log output.
- `config.schema.json` for Homebridge UI configuration.

### Notes

- Verified against real hardware (iTach IP2CC at 192.168.4.235): protocol,
  pulse timing, multi-relay operation over a shared connection, webhook
  control, persistence, and graceful shutdown.
- Measured pulse hold intervals tracked the configured duration closely
  (500 ms configured → 501 ms measured), well inside the 250 ms tolerance.
- Engine range covers Homebridge 1.8+ and 2.x; deployed and tested against
  Homebridge 2.4.0 on Node.js 22 (aarch64).

### Known limitations

- The IP2CC has no door position sensor, so door state is inferred from travel
  timers. It can disagree with physical reality until corrected via the webhook
  (for example after the door is operated by a handheld remote).
- Obstruction detection is not provided by the hardware. The
  `ObstructionDetected` characteristic only reflects values supplied by webhook
  requests; the opener's own safety mechanisms remain the sole physical
  protection.
- The relay release retry and lockout path is covered by unit tests only; it
  has not been exercised against induced hardware failure.
