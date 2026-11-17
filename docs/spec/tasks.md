# Implementation Plan: iTach Garage Door Plugin

## Overview

Build a Homebridge dynamic platform plugin (`homebridge-itach-garage-door`) that controls garage doors via Global Caché iTach IP2CC contact-closure relays over TCP. Implementation follows a bottom-up approach: shared types and protocol codec first, then state machine, command client, higher-level components (webhook, persistence, config validation), accessory and platform wiring, and finally packaging.

Language: TypeScript compiled to JavaScript. Test framework: vitest + fast-check.

## Tasks

- [x] 1. Project scaffolding and shared types
  - [x] 1.1 Initialise project structure with package.json, tsconfig.json, and vitest config
    - Create `homebridge-itach-garage-door/` directory structure matching the design
    - Create `package.json` with name `homebridge-itach-garage-door`, keywords `["homebridge-plugin"]`, engine ranges (`node >=20.0.0`, `homebridge >=1.8.0`), scripts (build, lint, test), devDependencies (typescript ^5.4, @types/node ^20, homebridge ^1.8.0, vitest ^2.0, fast-check ^3.19)
    - Create `tsconfig.json` targeting ES2022/NodeNext, outDir `dist/`, strict mode enabled
    - Create vitest config with test file patterns
    - _Requirements: 14.1, 14.2, 14.3_

  - [x] 1.2 Create `src/types.ts` with all shared type definitions
    - Define `DoorState` union type: `'CLOSED' | 'OPEN' | 'OPENING' | 'CLOSING' | 'STOPPED'`
    - Define `MidTravelBehaviour` type: `'stop' | 'reverse'`
    - Define `ValidatedDoorEntry` interface with all fields (name, ipAddress, relay, port, doorId, pulseDuration, openingTime, closingTime, midTravelBehaviour)
    - Define `CommandResult`, `StateResponse`, `SetStateEcho`, `ErrorResponse`, `DevicesResponse`, `ParseError` interfaces
    - Define `Response` union type
    - Define `DoorStateChangeEvent` interface with previous, current, trigger fields
    - Define `PersistedState` interface
    - _Requirements: 2.1, 4.3, 4.4, 6.1_

- [x] 2. Protocol codec implementation
  - [x] 2.1 Implement `src/protocol-codec.ts` — command encoding and response parsing
    - Implement `encodeSetState(module, connector, state)` producing `setstate,<m>:<c>,<s>` with no whitespace or line terminators
    - Implement `encodeGetState(module, connector)` producing `getstate,<m>:<c>`
    - Implement `encodeGetDevices()` producing `getdevices`
    - Implement `parseResponse(raw)` handling: state responses (`state,M:C,V`), setstate echoes (`setstate,M:C,V`), error responses (`ERR` with digit code), getdevices responses, and unknown formats returning ParseError
    - Implement `extractFrames(buffer)` splitting on `\r`, returning complete frames and remainder
    - Handle protocol quirk: setstate echoes the command name back
    - Truncate raw text to 256 chars in ParseError results
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.7, 4.8, 4.9, 4.10_

  - [x] 2.2 Write property test: Command Encoding Round-Trip
    - **Property 1: Command Encoding Round-Trip**
    - **Validates: Requirements 4.1, 4.2, 4.5, 3.2**
    - For any valid command (setstate module=1, connector∈{1,2,3}, state∈{0,1}; getstate module=1, connector∈{1,2,3}), encoding then parsing yields structurally equal value
    - Encoded string has no leading/trailing whitespace, no `\n`, no `\r`

  - [x] 2.3 Write property test: Response Parsing Round-Trip
    - **Property 2: Response Parsing Round-Trip**
    - **Validates: Requirements 4.3, 4.4, 4.6, 4.8**
    - For any valid structured response (state, setstate-echo, error, devices), serialising to wire format then parsing yields structurally equal value

  - [x] 2.4 Write property test: Parser Total Function
    - **Property 3: Parser Total Function (Never Throws)**
    - **Validates: Requirements 4.7, 4.9, 4.10**
    - For any string 0–256 chars from printable ASCII + `\r` + `\n`, parseResponse returns structured result or ParseError, never throws

  - [x] 2.5 Write unit tests for protocol codec edge cases
    - Test empty string, whitespace-only, partial frames
    - Test multi-frame buffer extraction
    - Test error responses with no digits (should return ParseError)
    - Test getdevices multi-part response parsing
    - _Requirements: 4.7, 4.9, 4.10_

- [x] 3. Checkpoint — Protocol codec tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Door state machine implementation
  - [x] 4.1 Implement `src/door-state-machine.ts` — state transitions and travel timers
    - Extend EventEmitter, emit `stateChange` events with `DoorStateChangeEvent`
    - Implement `requestOpen()` returning `'pulse'` or `'no-op'` based on current state
    - Implement `requestClose()` returning `'pulse'` or `'no-op'` based on current state
    - Implement `pulseCompleted(requestedTarget)` driving state transitions per mid-travel behaviour
    - Implement `pulseFailed()` preserving current state and timer
    - Implement `setExternalState(state)` cancelling timers and overriding state
    - Implement travel timer logic: start on OPENING/CLOSING, expire to OPEN/CLOSED
    - Implement `restoreState(persisted)` for startup recovery (OPENING/CLOSING → STOPPED)
    - Implement `cancelTimer()` for shutdown
    - Handle mid-travel `stop` mode: any command during travel → STOPPED
    - Handle mid-travel `reverse` mode: opposite target during travel reverses direction; same target is no-op
    - _Requirements: 6.1–6.11, 7.1–7.10, 8.2–8.8_

  - [x] 4.2 Write property test: State Machine Transition Correctness (Model-Based)
    - **Property 4: State Machine Transition Correctness (Model-Based)**
    - **Validates: Requirements 6.1–6.11, 7.2–7.6, 7.8, 7.10, 8.2–8.8**
    - Model-based test with reference model tracking state and timer
    - Generate arbitrary sequences of inputs from {requestOpen, requestClose, pulseCompleted, pulseFailed, setExternalState, timerExpiry}
    - Verify invariants: exactly one state, timer iff OPENING/CLOSING, idempotent no-ops, failure preserves state, external override

  - [x] 4.3 Write property test: State-to-Characteristic Mapping
    - **Property 5: State-to-Characteristic Mapping**
    - **Validates: Requirements 6.10, 7.7, 8.7, 11.8**
    - For any DoorState, verify CurrentDoorState mapping (CLOSED→0, OPEN→1, OPENING→2, CLOSING→3, STOPPED→4)
    - Verify TargetDoorState mapping (OPEN/OPENING→0, CLOSED/CLOSING/STOPPED→1)

  - [x] 4.4 Write property test: State Restoration Correctness
    - **Property 9: State Restoration Correctness**
    - **Validates: Requirements 11.4–11.8**
    - Terminal states restore unchanged; OPENING/CLOSING → STOPPED; absent/invalid → CLOSED
    - After restoration, characteristics match Property 5 mapping

  - [x] 4.5 Write unit tests for door state machine specific sequences
    - Test full open cycle: CLOSED → pulse → OPENING → timer → OPEN
    - Test full close cycle: OPEN → pulse → CLOSING → timer → CLOSED
    - Test mid-travel stop: OPENING → pulse → STOPPED
    - Test mid-travel reverse: OPENING → pulse(close) → CLOSING
    - Test webhook override during travel: OPENING + webhook(closed) → CLOSED, timer cancelled
    - Test pulseFailed leaves state unchanged
    - _Requirements: 6.2–6.9, 7.2–7.6_

- [x] 5. Checkpoint — State machine tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Configuration validator
  - [x] 6.1 Implement `src/config-validator.ts` — validate and normalise Door_Entry configs
    - Validate required fields: name (1–64 chars, non-whitespace), ipAddress (dotted-quad IPv4), relay (∈ {1:1, 1:2, 1:3})
    - Validate optional numeric fields with defaults: pulseDuration (100–2000, default 500), openingTime (1–120, default 15), closingTime (1–120, default 15), port (1–65535, default 4998)
    - Validate doorId: [a-z0-9-]{1,64}, default to array index
    - Validate midTravelBehaviour: ∈ {stop, reverse}, default 'stop'
    - Detect duplicate doorId values (first wins, log error for others)
    - Detect duplicate ipAddress+relay combinations (first wins, log error for others)
    - Validate webhook config: port (1024–65535), token (20–128 chars), bindAddress (dotted-quad)
    - Return array of ValidatedDoorEntry plus validation errors for logging
    - _Requirements: 2.1–2.15, 9.1, 9.2, 9.5_

  - [x] 6.2 Write property test: Configuration Validation — Ranges and Defaults
    - **Property 6: Configuration Validation — Ranges and Defaults**
    - **Validates: Requirements 2.2–2.9, 2.12, 2.13, 2.15**
    - For any integer pulseDuration: in-range preserved, out-of-range → 500
    - For any integer openingTime/closingTime: in-range preserved, out-of-range → 15
    - For any integer port: in-range preserved, out-of-range → 4998
    - Invalid field preserves all other fields unchanged
    - doorId regex acceptance/rejection
    - IPv4 regex acceptance/rejection

  - [x] 6.3 Write property test: UUID Determinism and Uniqueness
    - **Property 7: UUID Determinism and Uniqueness**
    - **Validates: Requirements 1.6**
    - Same (ipAddress, relay) → same UUID; different (ipAddress, relay) → different UUID
    - UUID independent of name, port, timing values, doorId

  - [x] 6.4 Write unit tests for config validator edge cases
    - Test empty config array (valid, 0 doors)
    - Test missing required fields
    - Test whitespace-only name
    - Test malformed IPv4 (e.g., `999.1.1.1`, `1.2.3`, `abc`)
    - Test duplicate doorId and duplicate relay scenarios
    - _Requirements: 2.6, 2.10, 2.13, 2.14_

- [x] 7. Rate limiter
  - [x] 7.1 Implement `src/rate-limiter.ts` — per-IP sliding window rate limiting
    - Implement sliding window: 10 requests per 1000ms per source IP
    - Track up to 256 distinct IPs with LRU eviction
    - Accept timestamp and source IP, return allow/reject
    - Monotonically non-decreasing timestamps assumed
    - _Requirements: 9.7_

  - [x] 7.2 Write property test: Rate Limiter Correctness
    - **Property 8: Rate Limiter Correctness**
    - **Validates: Requirements 9.7**
    - First 10 requests in window allowed, 11th+ rejected
    - After window expires, new window starts
    - 257th distinct IP evicts LRU

  - [x] 7.3 Write unit tests for rate limiter boundaries
    - Test exactly 10 requests allowed at boundary
    - Test window expiry resets count
    - Test LRU eviction at 256 IPs
    - _Requirements: 9.7_

- [x] 8. Command client implementation
  - [x] 8.1 Implement `src/command-client.ts` — TCP connection management and command queue
    - Use Node.js `net` module for TCP connection
    - Send commands terminated with `\r` (no `\n`)
    - Implement 16-deep FIFO command queue, reject overflow with communication failure
    - Implement 3000ms command timeout: close connection, report error, flush queue
    - Implement exponential backoff reconnection: 1s → 2s → 4s → ... → 60s cap
    - Implement 5000ms connection timeout
    - Send `getdevices` on each new connection before processing queue
    - Implement connection grace period (30s) returning last-known values
    - After grace period, report communication failure to HomeKit
    - On reconnection, reset backoff and resume characteristic reporting within 1000ms
    - Use ProtocolCodec for encoding/parsing
    - Use extractFrames for stream buffering (responses are \r-delimited and concatenated)
    - _Requirements: 3.1–3.13_

  - [x] 8.2 Write unit tests for command client with mock TCP server
    - Test successful command send/receive cycle
    - Test 3000ms timeout triggers connection close and queue flush
    - Test queue overflow at 16 commands returns error
    - Test exponential backoff reconnection sequence
    - Test grace period returns last-known values
    - Test getdevices sent on new connection
    - Test ERR response from getdevices logged but queue continues
    - _Requirements: 3.1–3.13_

- [x] 9. Persistence store
  - [x] 9.1 Implement `src/persistence-store.ts` — JSON file state persistence
    - Read/write `<storagePath>/itach-garage-door.state.json`
    - Key entries by `<ip>:<module>:<connector>` (survives config reordering)
    - `load()`: read file, parse JSON, return PersistedState (empty object on missing/corrupt file)
    - `save(key, state)`: read-modify-write with atomic rename pattern
    - Handle missing file gracefully (return empty state)
    - Handle corrupt JSON gracefully (log warn, return empty state)
    - _Requirements: 11.1–11.7_

  - [x] 9.2 Write unit tests for persistence store
    - Test normal read/write cycle
    - Test missing file returns empty state
    - Test corrupt JSON logs warning and returns empty state
    - Test write failure: retains in-memory state, logs error
    - Test key format uses ip:module:connector
    - _Requirements: 11.1–11.3, 11.6, 11.7_

- [x] 10. Checkpoint — Lower-level component tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Webhook listener
  - [x] 11.1 Implement `src/webhook-listener.ts` — HTTP server for external state correction
    - Use Node.js `http` module
    - Bind to configured port and address
    - Validate requests in strict order: rate limit → token → method → door ID → body
    - Parse path as `/door/<doorId>/state`
    - Authenticate via `X-Auth-Token` header with constant-time comparison (`crypto.timingSafeEqual`)
    - Accept only POST method
    - Validate body: max 1024 bytes, content-type application/json, parsable JSON object
    - Validate state value ∈ {open, closed, opening, closing, stopped}
    - Validate optional obstruction field (must be boolean true/false if present)
    - Reject obstruction without valid state with 400
    - Apply state change to DoorStateMachine, set obstruction on accessory
    - Respond with appropriate HTTP status codes (200, 400, 401, 404, 405, 429)
    - Respond within 500ms
    - Implement start/stop lifecycle with 5000ms bind timeout
    - _Requirements: 8.1, 8.9–8.15, 9.1–9.11, 10.2–10.7_

  - [x] 11.2 Write property test: Webhook Request Validation Pipeline Order
    - **Property 11: Webhook Request Validation Pipeline Order**
    - **Validates: Requirements 9.9**
    - For any HTTP request, response status determined by first failing check in order: rate limit (429) → auth (401) → method (405) → door ID (404) → body (400)
    - No later check evaluated once earlier check fails

  - [x] 11.3 Write unit tests for webhook listener
    - Test valid state update (each state value)
    - Test authentication failure (missing token, wrong token, duplicate header)
    - Test rate limiting (11th request gets 429)
    - Test wrong HTTP method (405)
    - Test unknown door ID (404)
    - Test invalid body (oversized, wrong content-type, malformed JSON, missing state, invalid state)
    - Test obstruction true/false updates
    - Test obstruction without state rejected
    - Test concurrent pulse + webhook (state applied, pulse completes)
    - _Requirements: 8.1, 8.10, 9.3, 9.7, 9.8, 10.2–10.7_

- [x] 12. Accessory handler
  - [x] 12.1 Implement `src/accessory.ts` — GarageDoorAccessory binding
    - Register `GarageDoorOpener` service with `CurrentDoorState`, `TargetDoorState`, `ObstructionDetected` characteristics
    - Set accessory category to GARAGE_DOOR_OPENER
    - Set AccessoryInformation: Manufacturer=`Global Cache`, Model=`iTach IP2CC`, SerialNumber=`<ip>-<relay>` (max 64 chars)
    - Implement `handleTargetDoorStateSet`: delegate to state machine, trigger pulse via command client
    - Implement pulse sequence: setstate 1 → wait pulseDuration → setstate 0
    - Implement pulse retry on state-0 failure: 3 retries at 500ms intervals
    - Implement actuation queue (max 2 pending, 1000ms delay between pulses)
    - Implement lockout on all-retries-failed for state-0
    - Listen to state machine `stateChange` events → update HomeKit characteristics
    - Map DoorState to CurrentDoorState characteristic values
    - Handle ObstructionDetected from webhook
    - Implement startup relay reset (setstate 0 before accepting actuation)
    - _Requirements: 1.2–1.5, 1.8, 5.1–5.10, 6.2–6.11_

  - [x] 12.2 Write unit tests for accessory handler
    - Test pulse sequence timing (setstate 1 → wait → setstate 0)
    - Test pulse failure on setstate 1: no setstate 0 sent, state unchanged
    - Test relay release retry (3 failures then success)
    - Test all-retries-failed lockout
    - Test actuation queue (max 2 pending requests)
    - Test characteristic updates on state changes
    - Test startup relay reset
    - _Requirements: 5.1–5.10, 6.2, 6.3_

- [x] 13. Platform implementation
  - [x] 13.1 Implement `src/platform.ts` — ItachGarageDoorPlatform
    - Register platform with Homebridge under single platform name
    - Implement `configureAccessory()` for cached accessory restore
    - Implement `discoverDevices()` on didFinishLaunching:
      - Validate configuration via config-validator
      - Load persisted state
      - Create shared CommandClient instances (one per IP2CC address:port)
      - Create DoorStateMachine per valid door (restore persisted state)
      - Create/reuse/unregister accessories (UUID from ipAddress + relay)
      - Unregister stale cached accessories (UUID matches no current door)
      - Publish within 5 seconds of didFinishLaunching
    - Start WebhookListener if configured with valid token/port
    - Implement graceful shutdown: cancel timers, release relays, stop webhook, close TCP connections
    - Log door IDs at info level on publish
    - Log unregistered stale accessories at info level
    - Handle per-door errors without affecting other doors
    - _Requirements: 1.1, 1.6, 1.7, 1.9–1.11, 12.1–12.7, 14.7, 14.8_

  - [x] 13.2 Implement `src/index.ts` — plugin registration entry point
    - Export default function that calls `api.registerPlatform()` with platform name matching config schema
    - _Requirements: 1.1, 14.6_

  - [x] 13.3 Write unit tests for platform with mocked Homebridge API
    - Test accessory discovery and registration
    - Test cached accessory reuse
    - Test stale accessory unregistration
    - Test per-door error isolation
    - Test graceful shutdown sequence
    - Test webhook not started when config missing token/port
    - _Requirements: 1.1, 1.7, 1.9, 1.10, 1.11, 14.7_

- [x] 14. Checkpoint — All component tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Multi-door isolation and integration
  - [x] 15.1 Implement door independence logic and shared CommandClient pooling
    - Ensure CommandClient instances are shared per address:port pair
    - Ensure each door has independent DoorStateMachine, actuation queue, travel timer, and persistence key
    - Handle connection loss per address:port (only affect doors on that connection)
    - Implement CommandClient cleanup when no doors reference an address:port
    - _Requirements: 12.1–12.7_

  - [x] 15.2 Write property test: Door Independence (Isolation)
    - **Property 10: Door Independence (Isolation)**
    - **Validates: Requirements 11.1, 12.1, 12.5**
    - For any multi-door config (2–8 doors) and state-changing operation on door A: DoorState, timer, actuation queue, and persisted state of all other doors remain unchanged

  - [x] 15.3 Write integration tests for multi-door scenarios
    - Test 2 doors on same IP2CC share TCP connection
    - Test 2 doors on different ports get separate connections
    - Test connection loss only affects doors on that connection
    - Test duplicate relay detection (first wins)
    - _Requirements: 12.2–12.6_

- [x] 16. Logging and token redaction
  - [x] 16.1 Implement logging throughout all components with token redaction
    - Add debug logging for commands sent/received (truncated to 256 chars)
    - Add info logging for state changes (door name, previous, new, trigger)
    - Add error logging for failures (door name, state, error description truncated to 512 chars)
    - Implement token redaction: replace any 4+ char substring of webhook token with `[REDACTED]` in all log output
    - Log webhook bind address and port at info level
    - Log getdevices response at info level
    - _Requirements: 13.1–13.8_

  - [x] 16.2 Write unit tests for logging and token redaction
    - Test token never appears in log output (no 4+ char substring)
    - Test command logging truncation at 256 chars
    - Test state change log includes all required fields
    - _Requirements: 13.5, 13.8_

- [x] 17. Config schema and packaging
  - [x] 17.1 Create `config.schema.json` at project root
    - Define pluginAlias matching platform registration name
    - Define all door configuration fields with types, ranges, defaults, and required flags
    - Define webhook configuration fields
    - Set pluginType to "platform", singular to true
    - _Requirements: 2.11, 14.1, 14.6_

  - [x] 17.2 Create README.md with documentation
    - Document relay wiring to connector 1:1
    - Document every configuration field with type, default, and range
    - Provide worked example config for single door (IP2CC at 192.168.4.235, relay 1:1)
    - Document webhook token generation procedure
    - Provide worked example of authenticated state update request
    - Document Home app automation pattern (Eve sensor → shortcut → webhook)
    - Include safety section: remote operation risk, obstruction detection requirement, timer-inferred state caveat, token disclosure risk
    - _Requirements: 14.4, 14.5_

- [x] 18. Final checkpoint — Full test suite passes and project builds
  - Ensure all tests pass, ask the user if questions arise.
  - Run `npm run build` to verify TypeScript compiles cleanly
  - Verify `dist/` output includes all expected JS files
  - Verify `config.schema.json` pluginAlias matches registered platform name

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The command client uses a mock TCP server in tests (no real IP2CC needed for unit tests)
- All source files use only Node.js built-in modules at runtime (net, http, fs, path, crypto, timers, events)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "7.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4", "2.5", "7.2", "7.3"] },
    { "id": 4, "tasks": ["4.1", "6.1"] },
    { "id": 5, "tasks": ["4.2", "4.3", "4.4", "4.5", "6.2", "6.3", "6.4"] },
    { "id": 6, "tasks": ["8.1", "9.1"] },
    { "id": 7, "tasks": ["8.2", "9.2"] },
    { "id": 8, "tasks": ["11.1"] },
    { "id": 9, "tasks": ["11.2", "11.3", "12.1"] },
    { "id": 10, "tasks": ["12.2", "13.1", "13.2"] },
    { "id": 11, "tasks": ["13.3", "15.1"] },
    { "id": 12, "tasks": ["15.2", "15.3", "16.1"] },
    { "id": 13, "tasks": ["16.2", "17.1", "17.2"] }
  ]
}
```
