import pino from "pino";
import type { Env } from "../lib/env.js";

export function createLoggerOptions(env: Env): pino.LoggerOptions {
  const isDevelopment = env.NODE_ENV === "development";

  return {
    level: env.LOG_LEVEL,
    transport: isDevelopment
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss Z",
            ignore: "pid,hostname",
          },
        }
      : undefined,
    serializers: {
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
      err: pino.stdSerializers.err,
    },
  };
}
