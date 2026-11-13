# homebridge-itach-garage-door

A Homebridge plugin that controls garage doors through a [Global Caché iTach IP2CC](https://www.globalcache.com/products/itach/ip2ccspecs/) contact-closure relay over TCP.

The IP2CC has no door position sensor, so the plugin infers position from configurable travel timers. An optional authenticated webhook lets an external source (typically a Home automation driven by a real door sensor) correct that inferred state.

- Appears in the Home app as a proper garage door accessory
- Up to 8 doors, up to 3 per IP2CC (one per relay connector)
- Momentary pulse that behaves exactly like pressing the wall button
- Automatic reconnection with exponential backoff
- Door state survives Homebridge restarts

## Requirements

- Node.js 20 or newer
- Homebridge 1.8.0 or newer
- A Global Caché iTach IP2CC reachable over the network

No native modules and no runtime dependencies — the plugin uses only Node.js built-ins.

## Installation

```bash
npm install -g homebridge-itach-garage-door
```

Or search for `itach garage door` in the Homebridge UI plugin browser.

## Wiring

> **Read the safety notes below before wiring anything.**

The relay replaces a momentary wall-button press. Wire one relay connector in parallel with your opener's existing wall button:

```
IP2CC relay connector 1:1  ──┬──  opener wall-button terminal A
                             │
                             └──  opener wall-button terminal B
```

Points to get right:

- The IP2CC relays are **dry contacts** — they carry no voltage of their own. They simply close a circuit, which is exactly what the wall button does.
- Connect across the **wall-button terminals** on the opener's control board, not to the motor or mains wiring.
- Leave the existing wall button connected. Both continue to work.
- Check your opener's documentation for the low-voltage button terminals (commonly 24 V or lower).
- Relay connectors are addressed `module:connector`. The IP2CC has one module with three connectors: `1:1`, `1:2`, `1:3`.

If you are not confident working on your opener's control wiring, have a qualified installer do it.

## Configuration

Minimal single-door configuration:

```json
{
  "platforms": [
    {
      "platform": "ItachGarageDoor",
      "name": "iTach Garage Door",
      "doors": [
        {
          "name": "Garage Door",
          "ipAddress": "192.168.4.235",
          "relay": "1:1"
        }
      ]
    }
  ]
}
```

Worked example with explicit timing and a webhook:

```json
{
  "platforms": [
    {
      "platform": "ItachGarageDoor",
      "name": "iTach Garage Door",
      "doors": [
        {
          "name": "Garage Door",
          "ipAddress": "192.168.4.235",
          "relay": "1:1",
          "port": 4998,
          "doorId": "garage",
          "pulseDuration": 500,
          "openingTime": 14,
          "closingTime": 16,
          "midTravelBehaviour": "stop"
        }
      ],
      "webhook": {
        "port": 8581,
        "bindAddress": "0.0.0.0",
        "token": "b7f3c1d9e2a48f6b0c5d7e9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c"
      }
    }
  ]
}
```

### Door fields

| Field | Type | Required | Default | Range / format | Description |
|---|---|---|---|---|---|
| `name` | string | yes | — | 1–64 chars | Name in the Home app. Longer values are truncated to 64 characters. |
| `ipAddress` | string | yes | — | dotted-quad IPv4 | Address of the IP2CC. |
| `relay` | string | yes | — | `1:1`, `1:2`, `1:3` | Relay connector driving this door. |
| `port` | integer | no | `4998` | 1–65535 | TCP port of the IP2CC API. |
| `doorId` | string | no | array index | `^[a-z0-9-]{1,64}$` | Identifier used in the webhook path. |
| `pulseDuration` | integer | no | `500` | 100–2000 ms | How long the relay is held closed. |
| `openingTime` | integer | no | `15` | 1–120 s | Time to travel fully open. |
| `closingTime` | integer | no | `15` | 1–120 s | Time to travel fully closed. |
| `midTravelBehaviour` | string | no | `stop` | `stop`, `reverse`, `one-push` | What your opener does when pressed mid-travel. See [Opener behaviour](#opener-behaviour). |

### Webhook fields

| Field | Type | Required | Default | Range / format | Description |
|---|---|---|---|---|---|
| `port` | integer | no | — | 1024–65535 | Listening port. Omit to disable the webhook entirely. |
| `bindAddress` | string | no | `0.0.0.0` | dotted-quad IPv4 | Interface to bind. Use `127.0.0.1` for local-only access. |
| `token` | string | yes if `port` set | — | 20–128 printable chars | Shared secret for the `X-Auth-Token` header. |

Out-of-range numeric values fall back to the default and are logged at error level; the rest of the door entry is preserved. A door with a missing or malformed required field is skipped, and the remaining doors still publish.

### Measuring your travel times

Time the door with a stopwatch from the moment it starts moving until it comes to a full stop, in each direction, and use those values. Accurate times matter: they are the only thing telling the plugin where the door is.

## Opener behaviour

The relay only ever does one thing: press the button once. What that press *means* depends on your opener, so set `midTravelBehaviour` to match the hardware.

| Value | Your opener does this | Press while moving |
|---|---|---|
| `stop` | Halts when pressed mid-travel, and the next press continues in the direction you ask for. | Door stops. |
| `reverse` | Reverses when pressed mid-travel. Common on gates. | Door turns around. |
| `one-push` | Single-button opener: one trigger input advancing a fixed cycle. | Door stops; the *next* press goes the opposite way to the last movement. |

### Single-button (`one-push`) openers

Many openers have one trigger input and advance a cycle, where the direction of the next press depends on which way the door last moved:

```
fully closed                 --press-->  opens
while opening                --press-->  stops (never reverses)
stopped, was opening         --press-->  closes
while closing                --press-->  stops
stopped, was closing         --press-->  opens
fully open                   --press-->  closes
```

With `one-push` the plugin tracks the direction of the last travel leg, so it knows which way the next press will actually move the door and reports the real outcome rather than the direction that was asked for.

**One press per request.** The plugin never fires an automatic sequence of presses. If you ask for a direction the next single press cannot achieve — asking for Open while the door is stopped part-way open, where the next press closes it — nothing is actuated, the door does not move, and a warning in the log names the door, its state and what the next press will do. Press again for the achievable direction. In the Home app this is hard to hit, because the tile offers exactly the one action the next press performs; the refusal exists for Siri, automations and other HomeKit clients.

**What Apple Home shows for an interrupted door.** A `one-push` door interrupted mid-travel is never shown as "Stopped". It keeps showing Opening or Closing until something resolves it: the next press starting the opposite leg, a travel timer completing, a webhook correction, or a restart. This is deliberate and was chosen over settling the tile on Open. Consequences worth knowing:

- Siri will describe the door as opening or closing while it is in fact stationary.
- The transitional label has no timeout, so it can persist for as long as the door sits part-way.
- Automations triggered by the door reaching Open or Closed will not fire until a leg actually completes.
- When a press does start the opposite leg, the tile does not visibly change, because it was already showing that direction.

Internally the plugin still knows the door is stopped, and `STOPPED` is what gets logged and persisted. Only the HomeKit presentation holds the travel direction.

**After a restart.** The last travel direction is not persisted — the state file format is unchanged from v1.0.0 — so after a Homebridge restart a door that was mid-travel comes back as stopped with the direction unknown. Apple Home shows it as Open, and the next request is honoured rather than refused, with the assumed direction recorded as a warning in the log. If the assumption was wrong the reported state stays inverted until a full travel leg completes or a webhook corrects it.

**Travel-time lag.** After an interrupted leg, the next leg still runs the full configured `openingTime` or `closingTime`, so the plugin can report a door as fully open or closed up to one travel time late. The plugin does not model partial positions.

## Multiple doors

Doors on the same IP2CC address and port share a single TCP connection. Each door keeps its own state, timers, and actuation queue, so one door's activity or a failure on its relay does not disturb another.

```json
{
  "doors": [
    { "name": "Left Door",  "ipAddress": "192.168.4.235", "relay": "1:1", "doorId": "left" },
    { "name": "Right Door", "ipAddress": "192.168.4.235", "relay": "1:2", "doorId": "right" }
  ]
}
```

If two entries claim the same `doorId`, or the same `ipAddress` + `relay` pair, the first one wins and the duplicate is skipped with an error in the log.

## Webhook: correcting the door state

Because position is inferred from timers, the plugin cannot tell when the door is operated by a remote control, the wall button, or a manual pull. The webhook closes that gap: point an automation at it whenever a real sensor sees the door change.

### Generate a token

```bash
openssl rand -hex 32
```

Put the result in `webhook.token`. Treat it like a password.

### Endpoint

```
POST /door/<doorId>/state
X-Auth-Token: <your token>
Content-Type: application/json
```

Body:

```json
{ "state": "open" }
```

`state` must be one of `open`, `closed`, `opening`, `closing`, `stopped`. You may optionally include `"obstruction": true` or `false`.

Authenticated example:

```bash
curl -X POST http://homebridge.local:8581/door/garage/state \
  -H "X-Auth-Token: b7f3c1d9e2a48f6b0c5d7e9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c" \
  -H "Content-Type: application/json" \
  -d '{"state":"open"}'
```

Successful response:

```json
{ "state": "OPEN" }
```

### Response codes

| Code | Meaning |
|---|---|
| `200` | Accepted; body carries the resulting door state. |
| `400` | Body problem: wrong content type, oversized (>1024 bytes), malformed JSON, missing or invalid `state`, or non-boolean `obstruction`. |
| `401` | Missing, duplicated, or incorrect `X-Auth-Token`. |
| `404` | No configured door matches `<doorId>`. |
| `405` | Method other than `POST`. |
| `429` | Rate limit exceeded (10 requests per second per source IP). |

Checks run in that order and stop at the first failure, so a request with a bad token never reveals whether the door exists.

### Home app automation pattern

To keep the tile accurate using an Eve Door & Window sensor (or any HomeKit contact sensor) on the door:

1. Fit the contact sensor so it reads **closed** when the door is fully shut.
2. In the Home app, create an automation: **When** the sensor *opens* → **Convert to Shortcut** → add **Get Contents of URL**.
3. Configure that action:
   - URL: `http://homebridge.local:8581/door/garage/state`
   - Method: `POST`
   - Headers: `X-Auth-Token` = your token, `Content-Type` = `application/json`
   - Request Body: JSON, `state` = `open`
4. Create the mirror automation for the sensor *closing*, sending `{"state":"closed"}`.

The sensor now corrects the plugin whenever the door is operated by any means, including a handheld remote.

## How door state is determined

| State | How it is reached |
|---|---|
| `CLOSED` | Closing travel timer expired, a webhook said so, or it is the startup default. |
| `OPEN` | Opening travel timer expired, or a webhook said so. |
| `OPENING` | A pulse was actuated toward open; the opening timer is running. |
| `CLOSING` | A pulse was actuated toward closed; the closing timer is running. |
| `STOPPED` | A pulse interrupted travel (`stop` or `one-push` mode), a webhook said so, or Homebridge restarted mid-travel. |

On a `one-push` door the state after a press is whatever the opener's cycle produces, not what was requested, and a `STOPPED` door is presented to HomeKit as Opening, Closing or Open rather than Stopped. See [Single-button (`one-push`) openers](#single-button-one-push-openers).

On restart, a door recorded as `OPEN`, `CLOSED`, or `STOPPED` is restored as-is. A door recorded mid-travel (`OPENING` / `CLOSING`) comes back as `STOPPED`, since its real position cannot be known. With no stored record, the door is assumed `CLOSED`.

State is stored in `itach-garage-door.state.json` in your Homebridge storage directory, keyed by IP address and relay, so reordering the `doors` array does not lose it.

## Troubleshooting

**Door does not respond.** Confirm the IP2CC is reachable and the API port is open:

```bash
nc -v 192.168.4.235 4998
```

Enable Homebridge debug logging (`homebridge -D`) to see every command sent and response received.

**Tile state drifts from reality.** Re-measure `openingTime` and `closingTime`. If the door is often operated by remote, set up the webhook — timers alone cannot detect that.

**Door locked out after an error.** If the relay fails to release after 3 retries the plugin stops accepting actuation for that door to avoid leaving the relay energised. It clears automatically once a release succeeds; check the wiring and the IP2CC, then restart Homebridge.

**Nothing happens mid-travel.** Check `midTravelBehaviour` matches what your opener physically does. On a single-button opener, a tap that appears to do nothing is usually a request the next press cannot achieve — the log says so, and pressing for the other direction will move the door.

**The tile says Opening or Closing but the door is not moving.** Expected on a `one-push` door that was interrupted mid-travel: the plugin holds the travel wording until the next press, a completed travel leg, a webhook correction, or a restart resolves it.

## Safety

Read this section before putting the plugin into service.

- **A garage door can injure or kill.** Never operate it remotely unless you can confirm nothing and nobody is in its path.
- **Remote operation risk.** HomeKit and this webhook let the door be opened from anywhere. Anyone with access to your HomeKit home, or to the webhook token, can open your garage. Restrict Home sharing accordingly.
- **Obstruction detection is not provided by this plugin.** The IP2CC cannot sense obstructions. The `ObstructionDetected` characteristic is only ever set by webhook requests you send. Your opener's own safety sensors (photo-eye, force cutout) remain the sole physical protection — verify they work and keep them working.
- **State is inferred, not measured.** Without a webhook the plugin only knows what its timers assume. It can report `CLOSED` while the door is open, for example after being moved by remote or by hand. Do not rely on the reported state as proof the door is shut.
- **Token disclosure.** Anyone holding the webhook token can change the reported state and cause automations to behave incorrectly. Keep the token secret, prefer binding to `127.0.0.1` or a trusted LAN, and never expose the webhook port directly to the internet. The plugin never writes the token to its logs.
- **Relay release failure.** If the relay were to stay closed, the opener would see a continuously held button. The plugin retries the release and then locks the door out rather than leaving that state unattended, but check the installation if you see lockout errors.

## Credits

**Global Caché Unified TCP/IP API**
Documented by [Global Caché](https://www.globalcache.com) in the iTach API specification.

**Built with Kiro AI**
This plugin was designed and built with [Kiro](https://kiro.dev), an AI-powered development environment. Kiro wrote the code and tests, and verified the protocol, pulse timing, multi-relay operation and webhook against a real iTach IP2CC before release.

---

## Licence

MIT
