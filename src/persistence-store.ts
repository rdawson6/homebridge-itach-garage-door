/**
 * JSON file persistence for door state.
 *
 * State is stored at `<storagePath>/itach-garage-door.state.json`, keyed by
 * `<ip>:<module>:<connector>` so a door's persisted state survives config
 * reordering (Requirement 11.3).
 *
 * Writes use a temp-file + atomic rename pattern to avoid partial-write
 * corruption. Reads recover gracefully from missing or corrupt files.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { DoorState, PersistedState } from './types.js';
import type { Logger } from './logger.js';

const STATE_FILENAME = 'itach-garage-door.state.json';

const VALID_STATES: ReadonlySet<string> = new Set(['CLOSED', 'OPEN', 'OPENING', 'CLOSING', 'STOPPED']);

/**
 * Build the persistence key for a door from its IP, module, and connector.
 * Relay is provided as "<module>:<connector>".
 */
export function persistenceKey(ipAddress: string, relay: string): string {
  return `${ipAddress}:${relay}`;
}

export class PersistenceStore {
  private readonly filePath: string;
  private readonly log: Logger;
  /** In-memory copy of the persisted state. */
  private state: PersistedState = {};

  constructor(storagePath: string, log: Logger) {
    this.filePath = path.join(storagePath, STATE_FILENAME);
    this.log = log;
  }

  /**
   * Load persisted state from disk. Returns the parsed state, or an empty
   * object if the file is missing or corrupt. Invalid state values are
   * dropped (the caller applies the CLOSED default).
   */
  async load(): Promise<PersistedState> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        // Missing file is normal on first run.
        this.state = {};
        return {};
      }
      this.log.warn(`Could not read persisted state file (${nodeErr.code ?? 'error'}); starting with empty state`);
      this.state = {};
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log.warn('Persisted state file is corrupt (invalid JSON); discarding and starting with empty state');
      this.state = {};
      return {};
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.log.warn('Persisted state file is not an object; discarding and starting with empty state');
      this.state = {};
      return {};
    }

    // Keep only valid state values; drop the rest.
    const clean: PersistedState = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && VALID_STATES.has(value)) {
        clean[key] = value as DoorState;
      } else {
        this.log.warn(`Persisted state for key "${key}" holds unreadable value; it will be discarded`);
      }
    }

    this.state = clean;
    return { ...clean };
  }

  /**
   * Persist the state for a single key using read-modify-write with an atomic
   * rename. On write failure the in-memory state is retained and the error is
   * logged; the previously persisted value on disk is left unchanged.
   *
   * @returns true if the write succeeded, false if it failed.
   */
  async save(key: string, doorState: DoorState): Promise<boolean> {
    // Update the in-memory copy first (retained even if the write fails).
    this.state[key] = doorState;

    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(this.state, null, 2);

    try {
      await fs.writeFile(tmpPath, payload, 'utf8');
      await fs.rename(tmpPath, this.filePath);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Failed to persist door state for key "${key}": ${message}`);
      // Best-effort cleanup of the temp file.
      try {
        await fs.unlink(tmpPath);
      } catch {
        // Ignore cleanup errors.
      }
      return false;
    }
  }

  /** Return the current in-memory state (a shallow copy). */
  snapshot(): PersistedState {
    return { ...this.state };
  }
}
