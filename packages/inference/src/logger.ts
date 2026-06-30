/**
 * Minimal leveled logger mirroring the Python `logging` calls the inference
 * modules make (`logger.warning(...)`, `logger.debug(...)`). Warnings go to
 * `console.warn`; debug is silent by default (set `BOURDON_DEBUG` to surface it),
 * matching Python's default WARNING threshold.
 */

const DEBUG = Boolean(process.env.BOURDON_DEBUG);

export const logger = {
  warn(message: string, ...args: unknown[]): void {
    console.warn(message, ...args);
  },
  debug(message: string, ...args: unknown[]): void {
    if (DEBUG) console.debug(message, ...args);
  },
};
