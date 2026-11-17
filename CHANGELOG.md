# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] — 2026-11-17

### Added

- `midTravelBehaviour: "one-push"` for single-button openers, where one trigger
  input advances a fixed cycle and the direction of the next press depends on
  which way the door last moved: closed → opens, pressed while moving → stops,
  pressed again → moves opposite to the last leg.
- Direction memory in the door state machine, so a door stopped mid-travel
  knows which way the next press will move it and reports the outcome the
  opener actually produces rather than the direction that was requested.
  It is auxiliary data: the five `DoorState` values and the persisted state
  file format are unchanged.
- A refusal path for a request a single press cannot achieve on a `one-push`
  door. Nothing is actuated, the door state is left alone, and a warning names
  the door, its state and what the next press will do. One press per HomeKit
  request; the plugin never sequences presses automatically.

### Changed

- Apple Home presentation for `one-push` doors only: a door interrupted
  mid-travel shows Opening or Closing (or Open when the direction is unknown,
  such as after a restart) instead of Stopped. Internally, in the log and on
  disk the state is still `STOPPED`. Doors on `stop` or `reverse` are
  unaffected and still present Stopped, and `stop` remains the default.
- A HomeKit open or close write is now completed without an error when the
  IP2CC connection drops and is re-established inside the 30-second grace
  period. The door does not move, a warning names the door, its unchanged
  state, the requested direction and the reason, and the tile settles back,
  rather than the accessory latching "No Response". A device error response, a
  relay-release lockout, a full actuation queue, and an outage that has reached
  30 seconds all still report a communication failure to HomeKit.
- Spec amended accordingly, since the previous wording mandated a communication
  failure for every failed relay-engage command: Requirement 3.14–3.16 (holding
  an unsent command across a reconnect, write-once, and labelling a failure
  transient or persistent), 5.4–5.6 (narrowed to a device error response, with
  the state-0 retry policy explicitly covering connection failures too),
  5.11–5.13 (the transient and persistent pulse outcomes, and the rule that a
  relay engage is sent at most once), 6.11 and 6.12 (the `TargetDoorState` read
  handler), and 7.8. The spec is not part of this package, so this entry is its
  only record here.

### Fixed

- The accessory category persisted as OTHER instead of GARAGE_DOOR_OPENER.
  Homebridge keeps the category twice: `accessory.category` is a mirror field,
  while the value written to `cachedAccessories` comes from the wrapped
  hap-nodejs accessory, which the plugin never set. Both are now set, and an
  accessory already cached with the wrong category is corrected on the next
  Homebridge restart.
- A relay command submitted while the IP2CC connection was down failed
  immediately, which burned the tap. The command client now holds a command
  that has not yet been written to a socket for up to 2 seconds across the
  reconnect and sends it once on the new connection. A command that *had* been
  written when the connection closed is never sent again, because whether it
  reached the device cannot be determined and a second relay engage would be a
  second press of the opener button; the log now distinguishes the two cases.
- `TargetDoorState` had no read handler, so a communication failure reported to
  a write stayed on the characteristic and every later read of it failed. An
  accessory could show "No Response" indefinitely until the user next operated
  it.

## [1.0.1] — 2026-11-11

### Changed

- README: added a Credits section, matching the author's other plugins.

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
