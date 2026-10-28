/**
 * Plugin entry point.
 *
 * Homebridge calls the default-exported initialiser with the API object and
 * expects a synchronous `registerPlatform` call. We register the platform
 * under the same name declared in `config.schema.json` (`ItachGarageDoor`).
 *
 * The `api` parameter is typed structurally (see hap-types) rather than pulling
 * in the full `homebridge` type graph, which keeps `tsc` fast. At runtime the
 * object Homebridge passes is compatible.
 */

import { ItachGarageDoorPlatform, PLATFORM_NAME } from './platform.js';
import type { HomebridgeApi, PlatformConfigLike } from './hap-types.js';
import type { Logger } from './logger.js';

/** The shape of the Homebridge API object at the registration boundary. */
interface RegistrarApi extends HomebridgeApi {
  registerPlatform(
    platformName: string,
    constructor: new (log: Logger, config: PlatformConfigLike, api: HomebridgeApi) => unknown,
  ): void;
}

export default function initialiser(api: RegistrarApi): void {
  api.registerPlatform(PLATFORM_NAME, ItachGarageDoorPlatform);
}
