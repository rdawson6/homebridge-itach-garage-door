import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { satisfies } from 'semver';
import { PLATFORM_NAME } from '../src/platform.js';

interface PackageManifest {
  name: string;
  main: string;
  keywords: string[];
  engines: { node: string; homebridge: string };
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  files: string[];
}

const manifest: PackageManifest = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as PackageManifest;

describe('package manifest', () => {
  it('is named with the homebridge- prefix', () => {
    expect(manifest.name).toBe('homebridge-itach-garage-door');
    expect(manifest.name.startsWith('homebridge-')).toBe(true);
  });

  it('declares the homebridge-plugin keyword', () => {
    expect(manifest.keywords).toContain('homebridge-plugin');
  });

  it('declares node >=20 and a homebridge range covering v1.8+ and v2', () => {
    expect(manifest.engines.node).toBe('>=20.0.0');
    // Must be satisfied by 1.8.0 and every later 1.x (Req 14.2), and also
    // explicitly declare Homebridge 2.x support — the deployment target runs
    // Homebridge 2.4.0.
    expect(manifest.engines.homebridge).toBe('^1.8.0 || ^2.0.0');
  });

  it('homebridge engine range accepts 1.8.0, later 1.x, and 2.x but not 1.7.x', () => {
    const range = manifest.engines.homebridge;
    expect(satisfies('1.8.0', range)).toBe(true);
    expect(satisfies('1.9.5', range)).toBe(true);
    expect(satisfies('2.4.0', range)).toBe(true);
    expect(satisfies('1.7.9', range)).toBe(false);
  });

  it('declares build, lint and test scripts', () => {
    expect(manifest.scripts.build).toBeDefined();
    expect(manifest.scripts.lint).toBeDefined();
    expect(manifest.scripts.test).toBeDefined();
  });

  it('declares no runtime dependencies', () => {
    expect(Object.keys(manifest.dependencies ?? {})).toHaveLength(0);
  });

  it('publishes dist output and the config schema', () => {
    expect(manifest.main).toBe('dist/index.js');
    expect(manifest.files).toContain('dist/');
    expect(manifest.files).toContain('config.schema.json');
  });
});

// ─── Config schema ───────────────────────────────────────────────────────────

interface ConfigSchema {
  pluginAlias: string;
  pluginType: string;
  singular: boolean;
  schema: {
    properties: {
      doors: {
        maxItems?: number;
        items: { properties: Record<string, Record<string, unknown>> };
      };
      webhook: { properties: Record<string, Record<string, unknown>> };
    };
  };
}

const schema: ConfigSchema = JSON.parse(
  readFileSync(join(__dirname, '..', 'config.schema.json'), 'utf8'),
) as ConfigSchema;

describe('config schema', () => {
  it('declares a platform plugin registered as a singleton', () => {
    expect(schema.pluginType).toBe('platform');
    expect(schema.singular).toBe(true);
  });

  it('pluginAlias matches the platform name the plugin registers', () => {
    expect(schema.pluginAlias).toBe(PLATFORM_NAME);
  });

  it('allows at most 8 doors', () => {
    expect(schema.schema.properties.doors.maxItems).toBe(8);
  });

  it('marks name, ipAddress and relay as required door fields', () => {
    const props = schema.schema.properties.doors.items.properties;
    expect(props['name']!['required']).toBe(true);
    expect(props['ipAddress']!['required']).toBe(true);
    expect(props['relay']!['required']).toBe(true);
  });

  it('declares door numeric ranges matching the validator', () => {
    const props = schema.schema.properties.doors.items.properties;
    expect(props['pulseDuration']).toMatchObject({ minimum: 100, maximum: 2000, default: 500 });
    expect(props['openingTime']).toMatchObject({ minimum: 1, maximum: 120, default: 15 });
    expect(props['closingTime']).toMatchObject({ minimum: 1, maximum: 120, default: 15 });
    expect(props['port']).toMatchObject({ minimum: 1, maximum: 65535, default: 4998 });
  });

  it('declares the doorId pattern matching the validator', () => {
    const props = schema.schema.properties.doors.items.properties;
    expect(props['doorId']!['pattern']).toBe('^[a-z0-9-]{1,64}$');
  });

  it('declares webhook port and token constraints matching the validator', () => {
    const props = schema.schema.properties.webhook.properties;
    expect(props['port']).toMatchObject({ minimum: 1024, maximum: 65535 });
    expect(props['token']).toMatchObject({ minLength: 20, maxLength: 128 });
    expect(props['bindAddress']).toMatchObject({ default: '0.0.0.0' });
  });
});
