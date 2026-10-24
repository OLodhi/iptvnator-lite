/** The server's structured log. Callers redact provider URLs (`redactUrl`) before anything gets here. */
export type Log = { info(o: object, msg: string): void; warn(o: object, msg: string): void };

export const silentLog: Log = { info() {}, warn() {} };

/** One JSON line per event on the console. */
export function consoleLog(): Log {
  const line = (level: string, o: object, msg: string) =>
    JSON.stringify({ time: new Date().toISOString(), level, msg, ...o });
  return {
    info: (o, msg) => console.log(line('info', o, msg)),
    warn: (o, msg) => console.warn(line('warn', o, msg)),
  };
}
