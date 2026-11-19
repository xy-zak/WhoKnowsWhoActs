import { mkdirSync } from "node:fs";
import path from "node:path";
import pino, { type Logger } from "pino";

/**
 * Logger with data minimisation built in:
 *  - no hostname / pid in the base record,
 *  - HTTP requests are logged as method + path ONLY (no query string, no
 *    remote address, no user agent, no headers; a participant code in the path is redacted),
 *  - output goes to data/logs/server.log (inside the git-ignored data dir).
 */
export function createLogger(dataDir: string, opts: { stdout: boolean; level: string }): Logger {
  const logDir = path.join(dataDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const streams: pino.StreamEntry[] = [
    { stream: pino.destination({ dest: path.join(logDir, "server.log"), sync: false }) },
  ];
  if (opts.stdout) streams.push({ stream: process.stdout });
  return pino(
    {
      level: opts.level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      serializers: {
        req: (req: { method?: string; url?: string }) => ({
          method: req.method,
          // a participant code in the path is personal data: /api/participants/:code(/erase)
          path: (req.url ?? "")
            .split("?")[0]
            ?.replace(/^\/api\/participants\/[^/]+/, "/api/participants/:code"),
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
        err: pino.stdSerializers.err,
      },
    },
    pino.multistream(streams),
  );
}
