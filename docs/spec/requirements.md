# Requirements Document

## Introduction

This document captures the requirements for a Homebridge plugin that exposes a garage door opener to Apple HomeKit, driven by a Global Caché iTach IP2CC contact-closure device. The plugin runs on the Raspberry Pi 4 alongside the existing Homebridge installation (Node.js 20 LTS, 64-bit Raspberry Pi OS) described in the `new-pi-build` spec.

The IP2CC exposes three relay connectors and is controlled over TCP port 4998 using the Global Caché Unified TCP/IP API. Relay connector `1:1` is wired in parallel with the garage door wall button, so the plugin operates the door by issuing a momentary pulse (close the relay, wait, open the relay).

In the deployment this specification is written for, the IP2CC is at IPv4 address `192.168.4.235` and the Raspberry Pi running Homebridge is at `192.168.4.173` (per the `new-pi-build` spec), so both sit on the same `192.168.4.0/24` subnet and the plugin reaches the IP2CC directly without routing. That address is a configuration value supplied per door, not a constant of the plugin: the plugin accepts any valid dotted-quad IPv4 address for an IP2CC, and `192.168.4.235` is used only as the worked example in documentation.

The physical door position is monitored by an Eve Door & Window sensor. That sensor is a native HomeKit accessory and is not readable by Homebridge, so the plugin cannot poll real door position. The plugin therefore infers door state from a timer following each pulse, and additionally accepts authenticated state updates over a local HTTP endpoint so that an external source (for example a Home app automation driven by the Eve sensor) can correct the plugin's view of the door when the door is operated by remote control or wall button.

The accessory must present as a true HomeKit garage door: a `GarageDoorOpener` service with `CurrentDoorState`, `TargetDoorState`, and `ObstructionDetected`, and the accessory category set so the Home app renders the garage door tile and control.

## Glossary

- **Plugin**: The Homebridge dynamic platform plugin defined by this specification.
- **Homebridge**: The HomeKit bridge service running on the Raspberry Pi, which loads the Plugin.
- **IP2CC**: A Global Caché iTach IP2CC device, an IP-to-contact-closure unit with three relay connectors, controlled over TCP.
- **Relay_Connector**: A single relay output on an IP2CC, addressed as `<module>:<connector>`, for example `1:1`.
- **Garage_Door_Accessory**: A HomeKit accessory published by the Plugin representing one garage door, carrying a `GarageDoorOpener` service.
- **Command_Client**: The Plugin component that owns the TCP connection to an IP2CC and exchanges Global Caché API commands and responses.
- **Connection_Level_Failure**: A failure the Command_Client reports for a command because no established TCP connection to the IP2CC was available to carry it, because the connection closed before a response to it arrived, or because no response to it arrived within the per-command timeout. It is distinct from an error response returned by the IP2CC.
- **Transient_Connection_Failure**: A Connection_Level_Failure reported while the elapsed time since the TCP connection to that IP2CC was lost is below the Connection_Grace_Period.
- **Persistent_Connection_Failure**: A Connection_Level_Failure reported when no TCP connection to that IP2CC has yet been established, or when the elapsed time since the connection to that IP2CC was lost has reached the Connection_Grace_Period.
- **Connection_Grace_Period**: The interval following the loss of a TCP connection to an IP2CC during which the Plugin continues to report the last known characteristic values to HomeKit rather than a communication failure.
- **Protocol_Codec**: The Plugin component that serialises Global Caché API commands to text and parses IP2CC response text into structured values.
- **Pulse**: The action of setting a Relay_Connector to state `1`, waiting for the configured pulse duration, and setting the Relay_Connector back to state `0`.
- **Pulse_Duration**: The configured time in milliseconds for which a Relay_Connector is held at state `1` during a Pulse.
- **Door_State_Machine**: The Plugin component that holds the inferred state of one garage door and governs transitions between states.
- **Door_State**: One of the values `CLOSED`, `OPEN`, `OPENING`, `CLOSING`, `STOPPED` held by the Door_State_Machine.
- **Terminal_State**: A Door_State of `CLOSED`, `OPEN`, or `STOPPED`, in which no travel timer is running.
- **Travel_Time**: The configured time in seconds that the door takes to move fully in one direction, configured separately for opening and closing.
- **Travel_Timer**: The timer the Door_State_Machine starts on entering `OPENING` or `CLOSING`, whose expiry drives the transition to `OPEN` or `CLOSED`.
- **Webhook_Listener**: The Plugin component that serves a local HTTP endpoint for externally supplied door state updates.
- **Webhook_Token**: The shared secret string that a caller must present to the Webhook_Listener to be treated as authenticated.
- **Door_Entry**: One element of the Plugin's configuration array, describing a single garage door.
- **Door_Id**: The stable identifier of a Door_Entry, used in Webhook_Listener request paths.
- **Config_Schema**: The `config.schema.json` file that describes the Plugin's configuration fields to the Homebridge UI.

---

## Requirements

### Requirement 1: HomeKit Garage Door Accessory Registration

**User Story:** As a HomeKit user, I want the garage door to appear in the Home app as a garage door accessory, so that I get the garage door tile, the open/close control, and correct Siri behaviour.

#### Acceptance Criteria

1. WHEN Homebridge loads the Plugin, THE Plugin SHALL register itself as a Homebridge dynamic platform under exactly one platform name.
2. WHEN the Plugin publishes a Garage_Door_Accessory, THE Plugin SHALL add exactly one HomeKit `GarageDoorOpener` service to that accessory.
3. WHEN the Plugin publishes a Garage_Door_Accessory, THE Plugin SHALL set the accessory category to `GARAGE_DOOR_OPENER`.
4. WHEN the Plugin adds a `GarageDoorOpener` service, THE Plugin SHALL expose the `CurrentDoorState`, `TargetDoorState`, and `ObstructionDetected` characteristics on that service, and SHALL initialise `CurrentDoorState` and `TargetDoorState` from the Door_State established for that door at startup before the accessory becomes readable by HomeKit.
5. WHEN the Plugin publishes a Garage_Door_Accessory, THE Plugin SHALL set the `AccessoryInformation` service Manufacturer to `Global Cache`, Model to `iTach IP2CC`, and SerialNumber to the configured IP2CC IPv4 address followed by a single separator character followed by the Relay_Connector address, yielding a value of at most 64 characters that is identical for the same Door_Entry across Homebridge restarts.
6. WHEN the Plugin derives the accessory UUID for a Door_Entry, THE Plugin SHALL derive that UUID from the IP2CC IPv4 address and the Relay_Connector address alone, so that the same Door_Entry yields the same UUID across Homebridge restarts and two Door_Entry values differing in either of those two fields yield different UUIDs.
7. WHEN Homebridge restores a cached Garage_Door_Accessory whose derived UUID matches no Door_Entry in the current configuration, THE Plugin SHALL unregister that accessory from the Homebridge bridge before publishing any Garage_Door_Accessory for the current configuration, and SHALL log the display name of the unregistered accessory at info level.
8. WHEN the Plugin publishes a Garage_Door_Accessory, THE Plugin SHALL set the accessory display name to the `name` value of the corresponding Door_Entry, using the first 64 characters of that value when it is longer than 64 characters.
9. WHEN Homebridge restores a cached Garage_Door_Accessory whose derived UUID matches a Door_Entry in the current configuration, THE Plugin SHALL reuse that cached accessory for that Door_Entry and SHALL register no additional accessory for it, so that exactly one Garage_Door_Accessory exists per Door_Entry.
10. WHEN Homebridge signals that it has finished launching, THE Plugin SHALL publish one Garage_Door_Accessory for every Door_Entry that passes configuration validation, within 5 seconds of that signal.
11. IF registering or publishing a Garage_Door_Accessory for a Door_Entry returns an error, THEN THE Plugin SHALL log an error naming that Door_Entry at error level, SHALL leave every already published Garage_Door_Accessory unchanged, and SHALL continue publishing the remaining valid Door_Entry values.

---

### Requirement 2: Plugin Configuration and Validation

**User Story:** As a Homebridge administrator, I want to configure the door through the Homebridge UI with validated values, so that a mistyped setting produces a clear message instead of unpredictable door behaviour.

#### Acceptance Criteria

1. THE Plugin SHALL accept a configuration array of 0 to 8 Door_Entry values, where each Door_Entry carries a display name of 1 to 64 characters, an IP2CC IPv4 address in dotted-quad notation, and a Relay_Connector address.
2. THE Plugin SHALL accept an optional Pulse_Duration per Door_Entry as an integer number of milliseconds in the inclusive range 100 to 2000, and SHALL apply a default Pulse_Duration of 500 milliseconds to a Door_Entry that omits it.
3. THE Plugin SHALL accept an optional opening Travel_Time per Door_Entry as an integer number of seconds in the inclusive range 1 to 120, and SHALL apply a default opening Travel_Time of 15 seconds to a Door_Entry that omits it.
4. THE Plugin SHALL accept an optional closing Travel_Time per Door_Entry as an integer number of seconds in the inclusive range 1 to 120, and SHALL apply a default closing Travel_Time of 15 seconds to a Door_Entry that omits it.
5. THE Plugin SHALL accept an optional IP2CC TCP port per Door_Entry as an integer in the inclusive range 1 to 65535, and SHALL apply a default IP2CC TCP port of 4998 to a Door_Entry that omits it.
6. IF a Door_Entry omits the display name, the IP2CC IPv4 address, or the Relay_Connector address, supplies any of those three fields as an empty or whitespace-only string, or supplies an IP2CC IPv4 address that is not four decimal octets each in the inclusive range 0 to 255 separated by full stops, THEN THE Plugin SHALL log a validation error at error level naming the array index of that Door_Entry and the offending field, and SHALL skip publishing an accessory for that Door_Entry.
7. IF a Door_Entry specifies a Pulse_Duration that is not an integer in the inclusive range 100 to 2000 milliseconds, THEN THE Plugin SHALL log a validation error at error level naming the Door_Entry and SHALL apply the default Pulse_Duration of 500 milliseconds to that Door_Entry.
8. IF a Door_Entry specifies a Travel_Time that is not an integer in the inclusive range 1 to 120 seconds, THEN THE Plugin SHALL log a validation error at error level naming the Door_Entry and the affected direction, and SHALL apply the default Travel_Time of 15 seconds to the affected direction of that Door_Entry.
9. WHEN the Plugin applies a default value to an invalid configuration field of a Door_Entry, THE Plugin SHALL retain the configured values of every other field of that Door_Entry.
10. IF a Door_Entry specifies a Relay_Connector address that is absent from the set `1:1`, `1:2`, `1:3`, THEN THE Plugin SHALL log a validation error at error level naming the Door_Entry and SHALL skip publishing an accessory for that Door_Entry.
11. THE Plugin SHALL provide a Config_Schema that describes every configuration field, its type, whether it is required, its default value, and its permitted range or permitted value set.
12. THE Plugin SHALL accept an optional Door_Id per Door_Entry of 1 to 64 characters drawn from the lower-case letters `a` to `z`, the digits `0` to `9`, and the hyphen character, and SHALL apply as the Door_Id of a Door_Entry that omits it the zero-based position of that Door_Entry in the configuration array expressed in decimal digits.
13. IF a Door_Entry specifies a Door_Id that is empty, longer than 64 characters, or contains a character outside the permitted Door_Id character set, THEN THE Plugin SHALL log a validation error at error level naming the array index of that Door_Entry and SHALL skip publishing an accessory for that Door_Entry.
14. IF two or more Door_Entry values resolve to the same Door_Id, THEN THE Plugin SHALL log a validation error at error level naming the array index of each of those Door_Entry values and SHALL publish an accessory for the one of those Door_Entry values at the lowest array index alone.
15. IF a Door_Entry specifies an IP2CC TCP port that is not an integer in the inclusive range 1 to 65535, THEN THE Plugin SHALL log a validation error at error level naming the Door_Entry and SHALL apply the default IP2CC TCP port of 4998 to that Door_Entry.

---

### Requirement 3: IP2CC Connection Management

**User Story:** As a HomeKit user, I want the plugin to keep a reliable connection to the IP2CC and recover from network interruptions, so that the door responds without a Homebridge restart.

#### Acceptance Criteria

1. WHEN the Plugin needs to exchange a command with an IP2CC, THE Command_Client SHALL send that command over an established TCP connection to the configured IPv4 address and TCP port for that IP2CC, opening a connection to that address and port first if no established connection to it exists.
2. WHEN the Command_Client sends a command, THE Command_Client SHALL terminate that command with a single carriage return character and no line feed character.
3. WHILE the Command_Client is awaiting a response for a command sent to an IP2CC, THE Command_Client SHALL hold up to 16 subsequent commands for that IP2CC in a first-in-first-out queue and SHALL send each queued command only after the response to the preceding command has arrived or that preceding command has failed.
4. WHEN the Command_Client establishes a connection to an IP2CC, THE Command_Client SHALL send a `getdevices` command before sending any queued command for that IP2CC and SHALL log the module and connector addresses reported in the response at info level.
5. IF the elapsed time since a command was sent to an IP2CC reaches 3000 milliseconds while no response has arrived for that command, THEN THE Command_Client SHALL close the connection, SHALL report a timeout error to the caller of that command, and SHALL report a communication failure error to the caller of every command then held in the queue for that IP2CC and discard those queued commands.
6. IF a TCP connection to an IP2CC closes while the Plugin is running, THEN THE Command_Client SHALL attempt to reconnect to that IP2CC, waiting 1 second before the first attempt and doubling the wait before each further attempt up to a maximum wait of 60 seconds, and SHALL continue attempting at 60 second intervals for as long as the Plugin is running and at least one Door_Entry names that IP2CC.
7. WHILE the Command_Client is reconnecting to an IP2CC and the elapsed time since the connection was lost is below the Connection_Grace_Period, WHEN HomeKit reads a characteristic of an affected Garage_Door_Accessory, THE Plugin SHALL return the last known value of that characteristic.
8. WHEN the elapsed time since a connection to an IP2CC was lost reaches the Connection_Grace_Period, THE Plugin SHALL report the affected Garage_Door_Accessory characteristics to HomeKit as unavailable with a communication failure status.
9. THE Plugin SHALL apply a Connection_Grace_Period of 30 seconds, measured from the moment the TCP connection to that IP2CC was lost.
10. WHEN the Command_Client establishes a connection to an IP2CC after a connection error, THE Plugin SHALL resume reporting the affected Garage_Door_Accessory characteristic values to HomeKit within 1000 milliseconds and THE Command_Client SHALL reset the reconnect wait for that IP2CC to 1 second.
11. IF a TCP connection attempt to an IP2CC does not reach the established state within 5000 milliseconds of the attempt starting, THEN THE Command_Client SHALL abandon that attempt, SHALL report a communication failure error to the caller of every command then held in the queue for that IP2CC and discard those queued commands, and SHALL schedule a further connection attempt using the reconnect waits defined in criterion 6.
12. IF a command is submitted for an IP2CC while the command queue for that IP2CC already holds 16 commands, THEN THE Command_Client SHALL reject that command with a communication failure error reported to the caller and SHALL leave the queued commands for that IP2CC unchanged.
13. IF the `getdevices` command sent after establishing a connection to an IP2CC returns a response whose text begins with `ERR`, THEN THE Command_Client SHALL log the IP2CC IPv4 address and the returned error code at warn level and SHALL continue sending queued commands for that IP2CC on that connection.
14. IF a TCP connection to an IP2CC closes while commands are held in the queue for that IP2CC, THEN THE Command_Client SHALL retain in the queue every held command that has not yet been written to a socket, SHALL send each retained command once and only once after the next connection to that IP2CC is established, and SHALL report a communication failure error to the caller of any retained command that is still unsent 2000 milliseconds after it was first held.
15. THE Command_Client SHALL write each command it accepts to a socket at most once, and IF a command has been written to a socket and the connection closes or that command times out before a response to it arrives, THEN THE Command_Client SHALL report a communication failure error to the caller of that command, SHALL identify that failure to the caller as one in which delivery of the command to the IP2CC cannot be determined, and SHALL NOT write that command to a socket again.
16. WHEN THE Command_Client reports a Connection_Level_Failure to the caller of a command, THE Command_Client SHALL identify that failure to the caller as a Transient_Connection_Failure or as a Persistent_Connection_Failure, determined at the moment the failure is reported.

---

### Requirement 4: Global Caché Protocol Serialisation and Parsing

**User Story:** As a developer, I want command generation and response parsing to be a separate, well-defined codec, so that protocol handling is verifiable in isolation from the network and the door logic.

#### Acceptance Criteria

1. WHEN the Plugin sets a Relay_Connector whose module number is `1` and whose connector number is in the set `1`, `2`, `3` to logical state `0` or `1`, THE Protocol_Codec SHALL produce the command string `setstate,<module>:<connector>,<state>` where `<state>` is `0` or `1`, containing no leading whitespace, no trailing whitespace, and no line terminator character.
2. WHEN the Plugin queries a Relay_Connector whose module number is `1` and whose connector number is in the set `1`, `2`, `3`, THE Protocol_Codec SHALL produce the command string `getstate,<module>:<connector>`, containing no leading whitespace, no trailing whitespace, and no line terminator character.
3. WHEN an IP2CC returns a state response whose text is `state,<module>:<connector>,<value>`, with or without a single trailing carriage return character, where `<module>` and `<connector>` are decimal digit sequences of 1 to 3 characters and `<value>` is `0` or `1`, THE Protocol_Codec SHALL parse that text into a structured result carrying the module number as an integer, the connector number as an integer, and the state value as `0` or `1`.
4. WHEN an IP2CC returns a response whose text begins with `ERR` and carries a decimal digit sequence of 1 to 8 characters within the remainder of that text, THE Protocol_Codec SHALL parse that text into an error result carrying that digit sequence as the returned error code together with the raw response text.
5. FOR ALL structured command values generated over the domain of module number `1`, connector numbers in the set `1`, `2`, `3`, and state values `0` and `1`, THE Protocol_Codec SHALL satisfy the property that parsing the serialised form of that command yields a value equal to the original command.
6. FOR ALL structured response values generated over the domain of state responses with module number `1`, connector numbers in the set `1`, `2`, `3`, and state values `0` and `1`, together with error responses whose error codes are decimal digit sequences of 1 to 8 characters, THE Protocol_Codec SHALL satisfy the property that parsing the serialised form of that response yields a value equal to the original response.
7. IF a response text matches no production of the Global Caché response grammar, THEN THE Protocol_Codec SHALL return a parse error carrying the raw response text truncated to its first 256 characters.
8. WHEN an IP2CC returns a response to a `getdevices` command, THE Protocol_Codec SHALL parse that text into a structured result carrying the reported module number and the reported connector configuration for that module.
9. IF a response text begins with `ERR` and carries no decimal digit within the remainder of that text, THEN THE Protocol_Codec SHALL return a parse error carrying the raw response text truncated to its first 256 characters.
10. FOR ALL response texts of length 0 to 256 characters drawn from the printable character range together with carriage return and line feed, THE Protocol_Codec SHALL satisfy the property that parsing returns either a structured result or a parse error, and SHALL raise no exception to the caller.

---

### Requirement 5: Momentary Pulse Actuation

**User Story:** As a garage owner, I want the plugin to trigger the opener with a clean momentary pulse and to release the relay reliably, so that the opener behaves exactly as it does when the wall button is pressed.

#### Acceptance Criteria

1. WHEN the Plugin actuates a Pulse for a door, THE Plugin SHALL set that door's Relay_Connector to state `1`, hold state `1` for the configured Pulse_Duration, and then send the command setting that Relay_Connector to state `0`, where the measured interval between the successful state `1` response and the sending of the state `0` command is no shorter than the configured Pulse_Duration and no longer than the configured Pulse_Duration plus 250 milliseconds.
2. WHEN the command setting a Relay_Connector to state `0` returns a successful response, THE Plugin SHALL treat the Pulse for that door as complete.
3. WHEN the Plugin starts, THE Plugin SHALL set each configured Relay_Connector to state `0` before accepting any actuation request for the door that uses that Relay_Connector.
4. IF the command setting a Relay_Connector to state `1` is sent to an IP2CC and that IP2CC returns an error response to it, THEN THE Plugin SHALL report a communication failure to the HomeKit write, SHALL leave the Door_State and `TargetDoorState` for that door unchanged, and SHALL send no state `0` command for that abandoned Pulse.

    *Rationale: this criterion previously covered every failure of that command, including a dropped TCP connection. It is narrowed to an error response returned by the device; a Connection_Level_Failure is governed by criteria 11 and 12 of this requirement.*
5. IF a command setting a Relay_Connector to state `0` returns an error or fails with a Connection_Level_Failure, THEN THE Plugin SHALL retry that command up to 3 further times at 500 millisecond intervals and SHALL log an error naming the Relay_Connector address at error level when the third retry fails.

    *Rationale: setting a Relay_Connector to state `0` is idempotent and de-energising, so retrying it cannot move a door and is safe whether or not the earlier attempt reached the device. This is the deliberate asymmetry with criterion 12, which forbids re-sending a state `1` command.*
6. IF every retry of a command setting a Relay_Connector to state `0` fails, THEN THE Plugin SHALL discard every queued actuation request for that door, SHALL report a communication failure to the HomeKit write that requested the Pulse being released, and SHALL reject further actuation requests for that door with a communication failure until a command setting that Relay_Connector to state `0` returns a successful response.

    *Rationale: a relay that will not release leaves the opener seeing a held button. That is a persistent physical fault, so it remains visible to HomeKit as a communication failure and is not covered by criterion 11.*
7. WHILE a Pulse is in progress for a door, THE Plugin SHALL hold up to 2 further actuation requests for that door in a first-in-first-out queue.
8. IF an actuation request arrives for a door while the actuation queue for that door already holds 2 requests, THEN THE Plugin SHALL reject that request with a communication failure reported to HomeKit and SHALL leave the Door_State for that door unchanged.
9. WHEN a Pulse for a door completes and the actuation queue for that door holds at least one request, THE Plugin SHALL wait 1000 milliseconds from Pulse completion and SHALL then actuate the next queued request for that door.
10. WHEN a Pulse completes, THE Plugin SHALL log the Relay_Connector address and the measured hold interval in milliseconds at debug level.
11. IF a Pulse for a door cannot be completed because the Command_Client reports a Transient_Connection_Failure for a command of that Pulse, THEN THE Plugin SHALL complete the HomeKit write without reporting a communication failure, SHALL leave the Door_State for that door unchanged, SHALL re-assert `CurrentDoorState` and `TargetDoorState` from that unchanged Door_State, SHALL send no further command for that abandoned Pulse, and SHALL log at warn level the door name, the unchanged Door_State, the requested direction, the reason reported by the Command_Client, and whether that command had been written to a socket before it failed.

    *Rationale: the connection to the IP2CC is re-established in about one second, and the correct user action is to tap again. Reporting a communication failure for a fault that short latches the accessory at "No Response" in the Home app until the user next interacts with it, which is a worse outcome than a door that did not move and a tile that settles back. A Door_State that has drifted from the physical door is the accepted cost.*
12. IF a Pulse for a door cannot be completed because the Command_Client reports a Persistent_Connection_Failure for a command of that Pulse, THEN THE Plugin SHALL report a communication failure to the HomeKit write and SHALL leave the Door_State for that door unchanged.

    *Rationale: an IP2CC that is powered off or off the network cannot operate the door at all, so accepting the write silently would be misleading. The Connection_Grace_Period of criterion 9 of Requirement 3 is the boundary between this criterion and criterion 11.*
13. THE Plugin SHALL send the command setting a Relay_Connector to state `1` at most once for each actuation request, and IF that command has been written to a socket and the connection closes or that command times out before a response to it arrives, THEN THE Plugin SHALL NOT send that command again for that actuation request.

    *Rationale: the Plugin cannot determine whether such a command reached the IP2CC. Re-sending it would risk a second momentary pulse, which on a single-button opener means start-then-stop or an unintended reversal of a moving door.*

---

### Requirement 6: Timer-Inferred Door State

**User Story:** As a HomeKit user, I want the Home app to show the door opening and closing in real time, so that the tile reflects what the door is doing during travel.

#### Acceptance Criteria

1. THE Door_State_Machine SHALL hold exactly one Door_State and at most one running Travel_Timer for each configured door.
2. WHEN HomeKit sets `TargetDoorState` to Open while the Door_State is `CLOSED`, THE Plugin SHALL actuate a Pulse, and on that Pulse completing without error SHALL set the Door_State to `OPENING` within 1000 milliseconds of the Pulse completing.
3. WHEN HomeKit sets `TargetDoorState` to Closed while the Door_State is `OPEN`, THE Plugin SHALL actuate a Pulse, and on that Pulse completing without error SHALL set the Door_State to `CLOSING` within 1000 milliseconds of the Pulse completing.
4. WHEN the Door_State becomes `OPENING`, THE Plugin SHALL set `CurrentDoorState` to Opening and `TargetDoorState` to Open within 500 milliseconds of that state change, and SHALL start a single running Travel_Timer whose duration in seconds equals the configured opening Travel_Time for that door.
5. WHEN the Door_State becomes `CLOSING`, THE Plugin SHALL set `CurrentDoorState` to Closing and `TargetDoorState` to Closed within 500 milliseconds of that state change, and SHALL start a single running Travel_Timer whose duration in seconds equals the configured closing Travel_Time for that door.
6. WHEN a Travel_Timer started for `OPENING` expires, THE Door_State_Machine SHALL set the Door_State to `OPEN` and THE Plugin SHALL set `CurrentDoorState` to Open within 500 milliseconds of that expiry.
7. WHEN a Travel_Timer started for `CLOSING` expires, THE Door_State_Machine SHALL set the Door_State to `CLOSED` and THE Plugin SHALL set `CurrentDoorState` to Closed within 500 milliseconds of that expiry.
8. WHEN HomeKit sets `TargetDoorState` to Open while the Door_State is `OPEN`, THE Plugin SHALL complete that write without error, SHALL actuate no Pulse, SHALL leave the Relay_Connector state unchanged, and SHALL leave the Door_State and `CurrentDoorState` for that door unchanged.
9. WHEN HomeKit sets `TargetDoorState` to Closed while the Door_State is `CLOSED`, THE Plugin SHALL complete that write without error, SHALL actuate no Pulse, SHALL leave the Relay_Connector state unchanged, and SHALL leave the Door_State and `CurrentDoorState` for that door unchanged.
10. WHEN HomeKit reads `CurrentDoorState` for a door, THE Plugin SHALL return Closed for the Door_State `CLOSED`, Open for the Door_State `OPEN`, Opening for the Door_State `OPENING`, Closing for the Door_State `CLOSING`, and Stopped for the Door_State `STOPPED`.
11. IF the Pulse actuated for a `TargetDoorState` write received while the Door_State is `CLOSED` or `OPEN` is sent and the IP2CC returns an error response to it, THEN THE Plugin SHALL report a communication failure to that write, SHALL leave the Door_State and `TargetDoorState` for that door unchanged, and SHALL start no Travel_Timer for that door. IF that Pulse cannot be completed because of a Connection_Level_Failure, THEN criterion 11 or criterion 12 of Requirement 5 SHALL apply according to whether that failure is transient or persistent, and THE Plugin SHALL start no Travel_Timer for that door in either case.
12. WHEN HomeKit reads `TargetDoorState` for a door, THE Plugin SHALL return the value most recently published for that characteristic by the Plugin or most recently written to it by HomeKit, whichever occurred later, and SHALL complete that read without error.

    *Rationale: without a read handler for this characteristic, a communication failure reported to a write remains the stored status of the characteristic and every later read of it fails, which is what latched the accessory at "No Response".*

---

### Requirement 7: Commands Received During Travel

**User Story:** As a garage owner, I want a command issued while the door is moving to match what my opener physically does, so that the Home app state stays aligned with the door.

#### Acceptance Criteria

1. THE Plugin SHALL accept an optional mid-travel behaviour setting per Door_Entry whose permitted values are exactly `stop` and `reverse`, and SHALL apply the default value `stop` when the setting is absent.
2. WHERE the mid-travel behaviour setting is `stop`, WHEN HomeKit sets `TargetDoorState` to either Open or Closed while the Door_State is `OPENING` or `CLOSING`, THE Plugin SHALL actuate a Pulse, and on that Pulse completing without error SHALL cancel the running Travel_Timer and set the Door_State to `STOPPED` within 1000 milliseconds of the Pulse completing, irrespective of whether the written value matches the current direction of travel.
3. WHERE the mid-travel behaviour setting is `reverse`, WHEN HomeKit sets `TargetDoorState` to Closed while the Door_State is `OPENING`, THE Plugin SHALL actuate a Pulse, and on that Pulse completing without error SHALL cancel the Travel_Timer running for `OPENING` and set the Door_State to `CLOSING`, so that a single Travel_Timer for the full configured closing Travel_Time is running for that door.
4. WHERE the mid-travel behaviour setting is `reverse`, WHEN HomeKit sets `TargetDoorState` to Open while the Door_State is `CLOSING`, THE Plugin SHALL actuate a Pulse, and on that Pulse completing without error SHALL cancel the Travel_Timer running for `CLOSING` and set the Door_State to `OPENING`, so that a single Travel_Timer for the full configured opening Travel_Time is running for that door.
5. WHILE the Door_State is `STOPPED`, WHEN HomeKit sets `TargetDoorState` to Open, THE Plugin SHALL actuate a Pulse, and on that Pulse completing without error SHALL set the Door_State to `OPENING` and start a running Travel_Timer for the full configured opening Travel_Time, without regard to the distance already travelled before the door stopped.
6. WHILE the Door_State is `STOPPED`, WHEN HomeKit sets `TargetDoorState` to Closed, THE Plugin SHALL actuate a Pulse, and on that Pulse completing without error SHALL set the Door_State to `CLOSING` and start a running Travel_Timer for the full configured closing Travel_Time, without regard to the distance already travelled before the door stopped.
7. WHILE the Door_State is `STOPPED`, THE Plugin SHALL report `CurrentDoorState` as Stopped and SHALL report `TargetDoorState` as the value most recently written by HomeKit for that door.
8. IF the Pulse actuated for a `TargetDoorState` write received while the Door_State is `OPENING`, `CLOSING`, or `STOPPED` is sent and the IP2CC returns an error response to it, THEN THE Plugin SHALL report the error to HomeKit, SHALL leave the Door_State unchanged, and SHALL leave any running Travel_Timer for that door running. IF that Pulse cannot be completed because of a Connection_Level_Failure, THEN criterion 11 or criterion 12 of Requirement 5 SHALL apply according to whether that failure is transient or persistent, and THE Plugin SHALL leave any running Travel_Timer for that door running in either case.
9. IF a Door_Entry specifies a mid-travel behaviour setting that is absent from the set `stop`, `reverse`, THEN THE Plugin SHALL log a validation error naming the Door_Entry and SHALL apply the default mid-travel behaviour setting `stop` to that Door_Entry.
10. WHERE the mid-travel behaviour setting is `reverse`, WHEN HomeKit sets `TargetDoorState` to Open while the Door_State is `OPENING`, or to Closed while the Door_State is `CLOSING`, THE Plugin SHALL acknowledge the write, SHALL leave the Relay_Connector state unchanged, SHALL leave the Door_State unchanged, and SHALL leave the running Travel_Timer running.

---

### Requirement 8: External State Correction Over HTTP

**User Story:** As a HomeKit user, I want an external source such as a Home automation driven by my Eve door sensor to correct the plugin's door state, so that the garage tile stays accurate when the door is operated by remote control or wall button.

#### Acceptance Criteria

1. WHERE a webhook port is configured, THE Webhook_Listener SHALL accept HTTP `POST` requests on that port at the path `/door/<Door_Id>/state` whose content type is `application/json` and whose body is a JSON object of no more than 1024 bytes carrying a state value, and SHALL read the supplied state value from that body.
2. WHEN the Webhook_Listener accepts an authenticated request carrying the state value `open`, THE Door_State_Machine SHALL cancel any running Travel_Timer for that door and set the Door_State to `OPEN`.
3. WHEN the Webhook_Listener accepts an authenticated request carrying the state value `closed`, THE Door_State_Machine SHALL cancel any running Travel_Timer for that door and set the Door_State to `CLOSED`.
4. WHEN the Webhook_Listener accepts an authenticated request carrying the state value `opening`, THE Door_State_Machine SHALL cancel any running Travel_Timer for that door, set the Door_State to `OPENING`, and start a single running Travel_Timer for the full configured opening Travel_Time.
5. WHEN the Webhook_Listener accepts an authenticated request carrying the state value `closing`, THE Door_State_Machine SHALL cancel any running Travel_Timer for that door, set the Door_State to `CLOSING`, and start a single running Travel_Timer for the full configured closing Travel_Time.
6. WHEN the Webhook_Listener accepts an authenticated request carrying the state value `stopped`, THE Door_State_Machine SHALL cancel any running Travel_Timer for that door and set the Door_State to `STOPPED`.
7. WHEN the Door_State_Machine changes the Door_State while processing a Webhook_Listener request, THE Plugin SHALL set `TargetDoorState` to Open for the resulting Door_States `OPEN` and `OPENING`, SHALL set `TargetDoorState` to Closed for the resulting Door_States `CLOSED` and `CLOSING`, and SHALL leave `TargetDoorState` unchanged for the resulting Door_State `STOPPED`.
8. WHEN the Door_State_Machine changes the Door_State while processing a Webhook_Listener request, THE Plugin SHALL leave the Relay_Connector state unchanged.
9. WHEN the Webhook_Listener has authenticated a request, validated the named Door_Id, and validated the supplied state value, THE Webhook_Listener SHALL respond within 500 milliseconds of receiving that request with HTTP status 200 and a JSON body carrying the resulting Door_State.
10. IF an authenticated request carries a body that exceeds 1024 bytes, a content type that differs from `application/json`, a body that is not a parsable JSON object, an absent state value, or a state value that is absent from the set `open`, `closed`, `opening`, `closing`, `stopped`, THEN THE Webhook_Listener SHALL respond with HTTP status 400 and a JSON body naming the permitted state values, and SHALL leave every Door_State and every running Travel_Timer unchanged.
11. IF an authenticated request names a Door_Id that matches no configured Door_Entry, THEN THE Webhook_Listener SHALL respond with HTTP status 404 and SHALL leave every Door_State unchanged.
12. WHERE a webhook port is absent from the configuration, THE Plugin SHALL determine Door_State from Travel_Timer expiry alone.
13. WHEN the Plugin publishes a Garage_Door_Accessory, THE Plugin SHALL log the Door_Id of that Garage_Door_Accessory at info level.
14. WHEN the Door_State_Machine changes the Door_State while processing a Webhook_Listener request, THE Plugin SHALL set `CurrentDoorState` to the HomeKit value that corresponds to the resulting Door_State within 500 milliseconds of the Webhook_Listener accepting that request.
15. WHILE a Pulse is in progress for a door, WHEN the Webhook_Listener accepts an authenticated request carrying a permitted state value for that door, THE Plugin SHALL apply the Door_State change specified by that state value, SHALL allow the Pulse in progress to run to completion including the command setting the Relay_Connector to state `0`, and SHALL leave the Door_State resulting from that request unchanged on the Pulse completing.

---

### Requirement 9: Webhook Access Control

**User Story:** As a homeowner, I want the state endpoint protected, so that a device on my network cannot manipulate the reported state of my garage door.

#### Acceptance Criteria

1. WHERE a webhook port is configured, THE Plugin SHALL require a Webhook_Token in the configuration of 20 to 128 characters drawn from the printable character range, excluding leading and trailing whitespace.
2. IF a webhook port is configured while the Webhook_Token is absent, shorter than 20 characters, or longer than 128 characters, or while the configured webhook port is not an integer in the inclusive range 1024 to 65535, or while the configured webhook bind address is not four decimal octets each in the inclusive range 0 to 255 separated by full stops, THEN THE Plugin SHALL log a configuration error at error level naming the offending field, SHALL keep the Webhook_Listener stopped so that no port is bound, and SHALL continue publishing a Garage_Door_Accessory for every Door_Entry that passes configuration validation.
3. WHEN the Webhook_Listener receives a request that passes the rate limit and whose `X-Auth-Token` header is absent, is supplied more than once, or carries a value differing from the configured Webhook_Token, THE Webhook_Listener SHALL respond within 500 milliseconds of receiving that request with HTTP status 401, SHALL leave every Door_State and every running Travel_Timer unchanged, and SHALL include no indication in that response of whether the named Door_Id matches a configured Door_Entry.
4. WHEN the Webhook_Listener compares a presented token to the configured Webhook_Token, THE Webhook_Listener SHALL use a constant-time comparison over the full length of both values.
5. THE Plugin SHALL accept an optional webhook port as an integer in the inclusive range 1024 to 65535 and an optional webhook bind address in dotted-quad IPv4 notation, and SHALL apply a default webhook bind address of `0.0.0.0` when the bind address is absent while a webhook port is configured.
6. WHEN the Webhook_Listener begins accepting requests on the configured port, THE Plugin SHALL log the bound IPv4 address and the bound port at info level within 500 milliseconds of that port accepting requests.
7. WHEN the Webhook_Listener receives an eleventh request from a single source IPv4 address within a 1000 millisecond window that starts when the first request counted for that address is received, THE Webhook_Listener SHALL respond with HTTP status 429 to that request and to every further request from that address until that window ends, SHALL start a new window on the first request received from that address after the window ends, SHALL leave every Door_State and every running Travel_Timer unchanged, and SHALL track windows for at most 256 distinct source IPv4 addresses concurrently, discarding the least recently active tracked address when a request arrives from an untracked address while 256 addresses are tracked.
8. WHEN the Webhook_Listener receives a request that passes the rate limit and passes authentication and whose HTTP method differs from `POST`, THE Webhook_Listener SHALL respond within 500 milliseconds of receiving that request with HTTP status 405 indicating that `POST` is the only permitted method, and SHALL leave every Door_State and every running Travel_Timer unchanged.
9. WHEN the Webhook_Listener receives a request, THE Webhook_Listener SHALL evaluate that request in the order rate limit, then `X-Auth-Token` header, then HTTP method, then the Door_Id named in the request path, then the request content type and body, SHALL respond with the status determined by the first failing check alone, being 429 for the rate limit, 401 for the token, 405 for the method, 404 for the Door_Id and 400 for the content type or body, and SHALL perform no check later in that order once a check has failed.
10. IF the Webhook_Listener cannot bind the configured webhook port on the configured bind address within 5000 milliseconds of the Plugin starting the listener, THEN THE Plugin SHALL log an error at error level naming the configured bind address, the configured port, and the reason reported by the operating system, SHALL keep the Webhook_Listener stopped so that no port is bound, SHALL attempt no further bind until the Plugin is next started, and SHALL continue publishing a Garage_Door_Accessory for every Door_Entry that passes configuration validation.
11. WHEN Homebridge signals that it is shutting down, THE Plugin SHALL stop the Webhook_Listener so that it accepts no further requests, and SHALL close the listening socket within 5000 milliseconds of that signal.

---

### Requirement 10: Obstruction Reporting

**User Story:** As a HomeKit user, I want the obstruction characteristic to be present and truthful, so that the Home app garage door accessory is fully formed and can surface an obstruction if one is reported.

#### Acceptance Criteria

1. WHEN the Plugin publishes a Garage_Door_Accessory, THE Plugin SHALL set `ObstructionDetected` to `false` for that door before the accessory becomes readable by HomeKit, on every publish including the first publish after each Homebridge restart, so that no obstruction value recorded before that restart is retained.
2. WHEN the Webhook_Listener accepts an authenticated request for a door that carries a permitted state value together with an obstruction value equal to the JSON boolean `true`, THE Plugin SHALL set `ObstructionDetected` to `true` for that door within 500 milliseconds of the Webhook_Listener accepting that request.
3. WHEN the Webhook_Listener accepts an authenticated request for a door that carries a permitted state value together with an obstruction value equal to the JSON boolean `false`, THE Plugin SHALL set `ObstructionDetected` to `false` for that door within 500 milliseconds of the Webhook_Listener accepting that request.
4. WHEN HomeKit reads `ObstructionDetected` for a door, THE Plugin SHALL return the most recent obstruction value recorded for that door since that door's Garage_Door_Accessory was last published, and SHALL return `false` if no obstruction value has been recorded for that door since that publish.
5. IF the Webhook_Listener accepts an authenticated request for a door whose body carries no obstruction value, THEN THE Plugin SHALL leave `ObstructionDetected` unchanged for that door and for every other door.
6. IF an authenticated request carries an obstruction value that is not the JSON boolean `true` or the JSON boolean `false`, THEN THE Webhook_Listener SHALL respond with HTTP status 400 and a JSON body indicating that the obstruction value must be a boolean, and SHALL leave `ObstructionDetected` and every Door_State unchanged.
7. IF an authenticated request carries an obstruction value while carrying no state value from the set `open`, `closed`, `opening`, `closing`, `stopped`, THEN THE Webhook_Listener SHALL reject that request with HTTP status 400 as specified for an absent or unpermitted state value, and SHALL leave `ObstructionDetected` unchanged for every door.

---

### Requirement 11: State Persistence Across Restarts

**User Story:** As a HomeKit user, I want the door tile to show a sensible state after Homebridge restarts, so that the accessory does not claim the door is closed when it was left open.

#### Acceptance Criteria

1. WHEN the Door_State_Machine sets a Door_State for a door, THE Plugin SHALL write that Door_State to the Plugin's persisted state record in the Homebridge persistent storage directory within 1000 milliseconds of that state change, and SHALL leave the persisted Door_State of every other configured door unchanged.
2. IF the write of a Door_State to the Homebridge persistent storage directory returns an error, THEN THE Plugin SHALL retain the new Door_State in memory, SHALL log the storage error and the door display name at error level, SHALL leave the previously persisted Door_State for that door unchanged, and SHALL continue to accept actuation requests and Webhook_Listener requests for that door.
3. WHEN the Plugin writes or reads the persisted Door_State of a Door_Entry, THE Plugin SHALL key that persisted entry on the IP2CC IPv4 address and the Relay_Connector address of that Door_Entry alone, so that the persisted Door_State of a door is recovered unchanged when the position of its Door_Entry in the configuration array changes, and two Door_Entry values differing in either of those two fields address different persisted entries.
4. WHEN the Plugin starts and the persisted state record holds a Terminal_State for the persisted entry key of a Door_Entry, THE Plugin SHALL set the Door_State for that door to that persisted value before publishing the Garage_Door_Accessory for that Door_Entry.
5. WHEN the Plugin starts and the persisted state record holds a Door_State of `OPENING` or `CLOSING` for the persisted entry key of a Door_Entry, THE Plugin SHALL set the Door_State for that door to `STOPPED` before publishing the Garage_Door_Accessory for that Door_Entry, SHALL start no Travel_Timer for that door, and SHALL log the persisted value and the applied Door_State at info level.
6. IF the persisted state record holds no entry for the persisted entry key of a Door_Entry when the Plugin starts, THEN THE Plugin SHALL set the Door_State for that door to `CLOSED` before publishing the Garage_Door_Accessory for that Door_Entry and SHALL log at info level that an assumed state was applied.
7. IF the persisted state record cannot be parsed, or holds for the persisted entry key of a Door_Entry a value that is absent from the set `CLOSED`, `OPEN`, `OPENING`, `CLOSING`, `STOPPED`, THEN THE Plugin SHALL set the Door_State of each affected door to `CLOSED`, SHALL log at warn level that unreadable persisted state was discarded, and SHALL publish a Garage_Door_Accessory for every valid Door_Entry in the current configuration.
8. WHEN the Plugin establishes the startup Door_State for a door, THE Plugin SHALL set `TargetDoorState` to Open for the Door_State `OPEN`, to Closed for the Door_State `CLOSED`, and to Closed for the Door_State `STOPPED`, and SHALL set `CurrentDoorState` to the HomeKit value corresponding to that Door_State, before the Garage_Door_Accessory for that door becomes readable by HomeKit.

---

### Requirement 12: Multiple Doors on One or More IP2CC Devices

**User Story:** As an owner of more than one garage door, I want to drive several doors from the plugin, so that each door gets its own HomeKit tile without running several plugin instances.

#### Acceptance Criteria

1. WHERE the configuration contains 2 to 8 Door_Entry values, THE Plugin SHALL publish exactly one Garage_Door_Accessory, carrying its own Door_State_Machine, for each of those Door_Entry values that passes the configuration validation of Requirement 2, and SHALL publish no Garage_Door_Accessory for any Door_Entry that fails that validation.
2. WHERE two or more Door_Entry values that pass configuration validation name the same IP2CC IPv4 address together with the same IP2CC TCP port, THE Command_Client SHALL use one shared TCP connection and one shared first-in-first-out command queue holding at most 16 commands for that address and port combination.
3. WHERE two or more Door_Entry values that pass configuration validation name the same IP2CC IPv4 address with differing IP2CC TCP ports, THE Command_Client SHALL use one separate TCP connection and one separate first-in-first-out command queue holding at most 16 commands for each distinct address and port combination.
4. IF two or more Door_Entry values name the same IP2CC IPv4 address together with the same Relay_Connector address, THEN THE Plugin SHALL log a configuration error at error level naming the array index of each of those Door_Entry values and SHALL publish a Garage_Door_Accessory for the one of those Door_Entry values at the lowest array index alone.
5. WHEN the Plugin actuates a Pulse for one door, THE Plugin SHALL leave the Door_State, the running Travel_Timer, the queued actuation requests, and the Relay_Connector state of every other configured door unchanged, each configured door holding its own Travel_Timer and its own actuation queue of at most 2 requests.
6. IF the TCP connection to one IP2CC address and TCP port combination is lost or a connection attempt to that combination fails, THEN THE Plugin SHALL apply the Connection_Grace_Period and the communication failure reporting of Requirement 3 only to the Garage_Door_Accessory values whose Door_Entry names that combination, and SHALL continue returning current characteristic values to HomeKit for every Garage_Door_Accessory whose Door_Entry names a different combination.
7. WHEN the number of Door_Entry values that pass configuration validation and name an IP2CC address and TCP port combination for which the Command_Client holds an established connection or a pending reconnect attempt reaches zero, THE Command_Client SHALL report a communication failure error to the caller of every command then held in the queue for that combination, SHALL close that connection within 5 seconds, and SHALL schedule no further connection attempt to that combination.

---

### Requirement 13: Logging and Diagnostics

**User Story:** As a Homebridge administrator, I want clear logs of commands, state changes, and failures, so that I can diagnose a misbehaving door from the Homebridge log.

#### Acceptance Criteria

1. WHEN the Command_Client sends a command to an IP2CC, THE Plugin SHALL write one debug level log entry carrying the command string truncated to its first 256 characters together with the target IPv4 address and TCP port of that IP2CC.
2. WHEN the Command_Client receives a response from an IP2CC, THE Plugin SHALL write one debug level log entry carrying the response text truncated to its first 256 characters together with the IPv4 address of that IP2CC.
3. WHEN the Door_State_Machine changes the Door_State for a door, THE Plugin SHALL write one info level log entry carrying the door display name, the previous Door_State, the new Door_State, and a trigger source drawn from exactly the set: a HomeKit `TargetDoorState` write, a Travel_Timer expiry, an accepted Webhook_Listener request, restoration of a persisted Door_State at Plugin start, and application of an assumed Door_State at Plugin start.
4. IF the Plugin encounters an error while operating a door, THEN THE Plugin SHALL write one error level log entry carrying the door display name, the Door_State held for that door at the time of the error, and a description of the error truncated to its first 512 characters.
5. WHEN the Plugin writes a log entry whose content includes a configuration value, Webhook_Listener request content including any inbound request header value, or a serialised error value, THE Plugin SHALL replace every occurrence of the configured Webhook_Token in that entry with a single fixed placeholder of 1 to 16 characters that shares no substring of 4 or more consecutive characters with the Webhook_Token, and SHALL leave the remaining content of that entry unchanged.
6. IF Homebridge debug logging is disabled, THEN THE Plugin SHALL write no debug level log entry.
7. WHEN the Plugin writes a log entry at info, warn, or error level, THE Plugin SHALL write that entry irrespective of whether Homebridge debug logging is enabled.
8. THE Plugin SHALL write no log entry at any level that contains any substring of 4 or more consecutive characters of the configured Webhook_Token.

---

### Requirement 14: Packaging and Installation on the Raspberry Pi

**User Story:** As a Pi owner, I want the plugin installable through the Homebridge UI on the 64-bit Pi, so that it fits the existing plugin layout and survives future rebuilds.

#### Acceptance Criteria

1. THE Plugin SHALL be packaged as an npm package whose name begins with `homebridge-`, whose package keywords include `homebridge-plugin`, and whose published package contents include the Config_Schema and every JavaScript file the Plugin loads at runtime, so that the package is listed by a Homebridge UI plugin search for its package name.
2. THE Plugin SHALL declare a Homebridge engine range that is satisfied by Homebridge version 1.8.0 and by every later 1.x version, and a Node engine range that is satisfied by every Node.js 20.x version and not satisfied by any Node.js version below 20.0.0.
3. THE Plugin SHALL implement all functionality in JavaScript or in TypeScript compiled to JavaScript, and SHALL declare no runtime dependency that requires a compilation step during installation, so that installing the package on `aarch64` completes with no compiler toolchain present.
4. THE Plugin SHALL provide a README that documents, in named sections, the relay wiring to Relay_Connector `1:1`, every configuration field together with its type, its default value, and its permitted range or permitted value set, a worked example configuration for a single Door_Entry naming the IP2CC IPv4 address `192.168.4.235` and Relay_Connector `1:1`, the procedure for generating a Webhook_Token of at least 20 characters, a worked example of an authenticated state update request to the Webhook_Listener showing the request path, the token header, and the request body, and the Home app automation pattern in which an Eve Door & Window sensor state change triggers that state update to correct the Door_State.
5. THE Plugin SHALL provide a README section, reachable from the README table of contents, that states at least the following four safety points: that the Plugin can operate the door with no person present at the door, that the door mechanism must retain its own obstruction detection and reversal mechanism, that the reported Door_State is inferred from timers and may differ from the physical door position until corrected through the Webhook_Listener, and that a Webhook_Token disclosed to another device on the network allows that device to falsify the reported door state.
6. THE Plugin SHALL place the Config_Schema at the root of the published npm package, and the platform name declared in the Config_Schema SHALL be identical, character for character, to the single platform name under which the Plugin registers itself with Homebridge as required by Requirement 1 criterion 1, so that the Homebridge UI presents a configuration form for the Plugin.
7. WHEN Homebridge signals that it is shutting down, THE Plugin SHALL, within 5 seconds of that signal, cancel every running Travel_Timer, send the command setting every Relay_Connector then at state `1` to state `0`, stop the Webhook_Listener from accepting further requests, and close every TCP connection to an IP2CC.
8. THE Plugin SHALL publish every Garage_Door_Accessory through the Homebridge bridge that loads it, and SHALL expose no HomeKit pairing identity, pairing code, or bridge of its own, so that no additional accessory or bridge is offered for pairing in the Home app when the Plugin is installed.
