import { createRequire } from "node:module";
import pino from "pino";
import type { Env } from "../lib/env.js";

/** pino-pretty is a dev dependency, so an installed package does not have it. */
function hasPrettyPrinter(): boolean {
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

export function createLoggerOptions(env: Env): pino.LoggerOptions {
  const isDevelopment = env.NODE_ENV === "development" && hasPrettyPrinter();

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
