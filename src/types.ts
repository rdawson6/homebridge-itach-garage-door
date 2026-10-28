/**
 * Shared type definitions for the iTach Garage Door plugin.
 *
 * These types are used across multiple modules: protocol codec, state machine,
 * config validator, webhook listener, persistence store, and accessory handler.
 */

// ---------------------------------------------------------------------------
// Door State
// ---------------------------------------------------------------------------

/** All possible states of a garage door. */
export type DoorState = 'CLOSED' | 'OPEN' | 'OPENING' | 'CLOSING' | 'STOPPED';

/** Behaviour when a command is issued while the door is mid-travel. */
export type MidTravelBehaviour = 'stop' | 'reverse';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** A fully validated and normalised door configuration entry. */
export interface ValidatedDoorEntry {
  readonly name: string;                          // 1–64 chars
  readonly ipAddress: string;                     // dotted-quad IPv4
  readonly relay: string;                         // "1:1" | "1:2" | "1:3"
  readonly port: number;                          // 1–65535, default 4998
  readonly doorId: string;                        // [a-z0-9-]{1,64}
  readonly pulseDuration: number;                 // 100–2000 ms, default 500
  readonly openingTime: number;                   // 1–120 s, default 15
  readonly closingTime: number;                   // 1–120 s, default 15
  readonly midTravelBehaviour: MidTravelBehaviour; // default 'stop'
}

// ---------------------------------------------------------------------------
// Protocol Codec — Response Types
// ---------------------------------------------------------------------------

/** Base interface for all parsed protocol responses. */
export interface CommandResult {
  readonly raw: string;
}

/** Parsed response for a `getstate` query: `state,M:C,V`. */
export interface StateResponse extends CommandResult {
  readonly type: 'state';
  readonly module: number;
  readonly connector: number;
  readonly value: 0 | 1;
}

/** Parsed echo of a `setstate` command: `setstate,M:C,V`. */
export interface SetStateEcho extends CommandResult {
  readonly type: 'setstate-echo';
  readonly module: number;
  readonly connector: number;
  readonly value: 0 | 1;
}

/** Parsed error response: `ERR_<code>` or `ERR <code>`. */
export interface ErrorResponse extends CommandResult {
  readonly type: 'error';
  readonly code: string;
}

/** Parsed `getdevices` response listing available modules. */
export interface DevicesResponse extends CommandResult {
  readonly type: 'devices';
  readonly modules: ReadonlyArray<{
    readonly module: number;
    readonly type: string;
    readonly connectors: number;
  }>;
}

/** Returned when a response string cannot be parsed into a known format. */
export interface ParseError extends CommandResult {
  readonly type: 'parse-error';
}

/** Discriminated union of all possible parsed responses. */
export type Response =
  | StateResponse
  | SetStateEcho
  | ErrorResponse
  | DevicesResponse
  | ParseError;

// ---------------------------------------------------------------------------
// State Machine Events
// ---------------------------------------------------------------------------

/** Emitted by DoorStateMachine on every state transition. */
export interface DoorStateChangeEvent {
  readonly previous: DoorState;
  readonly current: DoorState;
  readonly trigger: 'homekit' | 'timer' | 'webhook' | 'restore' | 'assumed';
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Shape of the persisted state JSON file. Key = "ip:module:connector". */
export interface PersistedState {
  [key: string]: DoorState;
}
