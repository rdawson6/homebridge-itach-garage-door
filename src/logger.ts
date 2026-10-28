/**
 * Minimal logger interface compatible with Homebridge's Logging type.
 *
 * Homebridge passes a logger with these methods to plugins. Defining our own
 * structural interface lets the components stay decoupled from Homebridge and
 * be tested with a simple mock.
 */
export interface Logger {
  debug(message: string, ...params: unknown[]): void;
  info(message: string, ...params: unknown[]): void;
  warn(message: string, ...params: unknown[]): void;
  error(message: string, ...params: unknown[]): void;
}
