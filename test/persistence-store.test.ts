/**
 * Unit tests for PersistenceStore using a real temp directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PersistenceStore, persistenceKey } from '../src/persistence-store.js';
import type { Logger } from '../src/logger.js';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('PersistenceStore', () => {
  let dir: string;
  let log: Logger;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'itach-persist-'));
    log = makeLogger();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const filePath = () => path.join(dir, 'itach-garage-door.state.json');

  // ─── persistenceKey ────────────────────────────────────────────────────

  describe('persistenceKey', () => {
    it('uses ip:module:connector format', () => {
      expect(persistenceKey('192.168.4.235', '1:1')).toBe('192.168.4.235:1:1');
      expect(persistenceKey('10.0.0.1', '1:2')).toBe('10.0.0.1:1:2');
    });
  });

  // ─── load ──────────────────────────────────────────────────────────────

  describe('load', () => {
    it('returns empty state when file is missing', async () => {
      const store = new PersistenceStore(dir, log);
      const state = await store.load();
      expect(state).toEqual({});
      // Missing file is normal — should not warn
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('loads a valid state file', async () => {
      await fs.writeFile(
        filePath(),
        JSON.stringify({ '192.168.4.235:1:1': 'CLOSED', '192.168.4.235:1:2': 'OPEN' }),
        'utf8',
      );
      const store = new PersistenceStore(dir, log);
      const state = await store.load();
      expect(state).toEqual({ '192.168.4.235:1:1': 'CLOSED', '192.168.4.235:1:2': 'OPEN' });
    });

    it('returns empty state and warns on corrupt JSON', async () => {
      await fs.writeFile(filePath(), '{ not valid json', 'utf8');
      const store = new PersistenceStore(dir, log);
      const state = await store.load();
      expect(state).toEqual({});
      expect(log.warn).toHaveBeenCalled();
    });

    it('drops invalid state values and keeps valid ones', async () => {
      await fs.writeFile(
        filePath(),
        JSON.stringify({ 'a:1:1': 'CLOSED', 'b:1:1': 'INVALID', 'c:1:1': 'OPEN' }),
        'utf8',
      );
      const store = new PersistenceStore(dir, log);
      const state = await store.load();
      expect(state).toEqual({ 'a:1:1': 'CLOSED', 'c:1:1': 'OPEN' });
      expect(log.warn).toHaveBeenCalled();
    });

    it('returns empty state when file is a JSON array (not object)', async () => {
      await fs.writeFile(filePath(), '["CLOSED"]', 'utf8');
      const store = new PersistenceStore(dir, log);
      const state = await store.load();
      expect(state).toEqual({});
      expect(log.warn).toHaveBeenCalled();
    });
  });

  // ─── save ──────────────────────────────────────────────────────────────

  describe('save', () => {
    it('writes state to disk and can be re-read', async () => {
      const store = new PersistenceStore(dir, log);
      const ok = await store.save('192.168.4.235:1:1', 'OPEN');
      expect(ok).toBe(true);

      const store2 = new PersistenceStore(dir, log);
      const state = await store2.load();
      expect(state['192.168.4.235:1:1']).toBe('OPEN');
    });

    it('preserves other keys when saving one key', async () => {
      const store = new PersistenceStore(dir, log);
      await store.save('a:1:1', 'CLOSED');
      await store.save('b:1:1', 'OPEN');
      await store.save('a:1:1', 'OPENING'); // update existing

      const state = store.snapshot();
      expect(state).toEqual({ 'a:1:1': 'OPENING', 'b:1:1': 'OPEN' });
    });

    it('retains in-memory state and logs error on write failure', async () => {
      // Use a store whose file path points at a non-existent directory to force failure
      const badStore = new PersistenceStore(path.join(dir, 'does-not-exist'), log);
      const ok = await badStore.save('a:1:1', 'OPEN');
      expect(ok).toBe(false);
      expect(log.error).toHaveBeenCalled();
      // In-memory retained
      expect(badStore.snapshot()['a:1:1']).toBe('OPEN');
    });

    it('does not leave temp files behind after successful write', async () => {
      const store = new PersistenceStore(dir, log);
      await store.save('a:1:1', 'CLOSED');
      const files = await fs.readdir(dir);
      const tmpFiles = files.filter(f => f.includes('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('produces valid JSON on disk', async () => {
      const store = new PersistenceStore(dir, log);
      await store.save('a:1:1', 'STOPPED');
      const raw = await fs.readFile(filePath(), 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(JSON.parse(raw)).toEqual({ 'a:1:1': 'STOPPED' });
    });
  });

  // ─── round-trip ──────────────────────────────────────────────────────────

  describe('round-trip', () => {
    it('load after save preserves all door states', async () => {
      const store = new PersistenceStore(dir, log);
      await store.save('192.168.4.235:1:1', 'OPEN');
      await store.save('192.168.4.235:1:2', 'CLOSED');
      await store.save('10.0.0.5:1:1', 'STOPPED');

      const store2 = new PersistenceStore(dir, log);
      const state = await store2.load();
      expect(state).toEqual({
        '192.168.4.235:1:1': 'OPEN',
        '192.168.4.235:1:2': 'CLOSED',
        '10.0.0.5:1:1': 'STOPPED',
      });
    });
  });
});
