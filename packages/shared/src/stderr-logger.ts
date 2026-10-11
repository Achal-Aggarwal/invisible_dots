import type { Logger } from "./support.js";

/** Lines on stderr, each with the time and `[prefix]`; debug lines only when `debug` is set. */
export function prefixedStderrLogger(prefix: string, debug = false): Logger {
  const write = (level: string, message: string, fields?: Record<string, unknown>) => {
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
    process.stderr.write(`${new Date().toISOString()} [${prefix}] ${level} ${message}${suffix}\n`);
  };
  return {
    debug: debug ? (m, f) => write("debug", m, f) : () => {},
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
