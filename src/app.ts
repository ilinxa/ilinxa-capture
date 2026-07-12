import Fastify from "fastify";
import type { FastifyError, FastifyInstance, FastifyServerOptions } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import fastifySensible from "@fastify/sensible";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Env } from "./lib/env.js";
import { createLoggerOptions } from "./utils/logger.js";
import { registerRoutes } from "./api/routes.js";
import type { ErrorResponse } from "./utils/errors.js";
import { JobManager } from "./core/job-manager.js";
import { LocalStorage } from "./core/storage.js";
import type { Storage } from "./core/storage.js";
import { mcpHttpPlugin } from "./mcp/server.js";

export interface AppOptions {
  env: Env;
  logger?: false;
  storage?: Storage;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const fastifyOpts: FastifyServerOptions = {
    logger: opts.logger === false ? false : createLoggerOptions(opts.env),
    genReqId: () => randomUUID(),
    requestIdLogLabel: "reqId",
  };

  const app = Fastify(fastifyOpts).withTypeProvider<ZodTypeProvider>();

  // Zod compilers — must be set FIRST before any routes
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Infrastructure plugins
  await app.register(fastifySensible);
  await app.register(fastifyCors, { origin: true, credentials: true });
  await app.register(fastifyHelmet, { contentSecurityPolicy: false });
  await app.register(fastifyMultipart, {
    limits: { fileSize: opts.env.MAX_UPLOAD_SIZE },
  });

  // Error handler + 404 handler — MUST be set BEFORE routes for encapsulation inheritance
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const code = error.code ?? "INTERNAL_SERVER_ERROR";

    if (request.log) {
      request.log.error({ err: error, reqId: request.id }, "Request error");
    }

    const errorResponse: ErrorResponse = {
      error: {
        code,
        message:
          statusCode === 500 && opts.env.NODE_ENV === "production"
            ? "An unexpected error occurred"
            : error.message,
        details: error.validation
          ? { validation: error.validation }
          : undefined,
      },
    };

    void reply
      .status(statusCode)
      .header("content-type", "application/json; charset=utf-8")
      .send(JSON.stringify(errorResponse));
  });

  // Job manager
  const jobManager = new JobManager(opts.env, app.log);
  await jobManager.recover();

  // Storage
  const storage = opts.storage ?? new LocalStorage(resolve(opts.env.LOCAL_OUTPUT_DIR));

  app.addHook("onClose", async () => {
    await jobManager.shutdown();
  });

  // Routes
  await app.register(registerRoutes, { env: opts.env, jobManager, storage });

  // MCP Streamable HTTP transport at /mcp
  await app.register(mcpHttpPlugin, { env: opts.env, jobManager });

  // Static UI serving — only when ui/dist exists (skipped in tests / API-only mode)
  const uiDir = resolve(opts.env.UI_DIR);
  if (existsSync(uiDir)) {
    await app.register(fastifyStatic, {
      root: uiDir,
      prefix: "/",
      wildcard: false,
      decorateReply: false,
    });

    // SPA fallback — serve index.html for client routes, JSON 404 for API/MCP
    app.setNotFoundHandler((_request, reply) => {
      if (_request.url.startsWith("/api/") || _request.url.startsWith("/mcp")) {
        const errorResponse: ErrorResponse = {
          error: { code: "NOT_FOUND", message: "Route not found" },
        };
        void reply
          .status(404)
          .header("content-type", "application/json; charset=utf-8")
          .send(JSON.stringify(errorResponse));
        return;
      }
      void reply.sendFile("index.html");
    });
  } else {
    // API-only mode — JSON 404 for all unmatched routes
    app.setNotFoundHandler((_request, reply) => {
      const errorResponse: ErrorResponse = {
        error: { code: "NOT_FOUND", message: "Route not found" },
      };
      void reply
        .status(404)
        .header("content-type", "application/json; charset=utf-8")
        .send(JSON.stringify(errorResponse));
    });
  }

  return app;
}
