/**
 * Tests for the plugin entry point.
 */

import { describe, it, expect, vi } from 'vitest';
import initialiser from '../src/index.js';
import { ItachGarageDoorPlatform, PLATFORM_NAME } from '../src/platform.js';

describe('plugin entry point', () => {
  it('registers the platform under the configured platform name', () => {
    const registerPlatform = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initialiser({ registerPlatform } as any);

    expect(registerPlatform).toHaveBeenCalledTimes(1);
    expect(registerPlatform).toHaveBeenCalledWith(PLATFORM_NAME, ItachGarageDoorPlatform);
  });

  it('registers exactly one platform', () => {
    const registerPlatform = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initialiser({ registerPlatform } as any);
    expect(registerPlatform.mock.calls).toHaveLength(1);
  });

  it('uses a platform name matching the config schema pluginAlias', () => {
    expect(PLATFORM_NAME).toBe('ItachGarageDoor');
  });
});
