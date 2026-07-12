import type { FastifyInstance } from "fastify";
import type { Env } from "../lib/env.js";
import type { JobManager } from "../core/job-manager.js";
import type { Storage } from "../core/storage.js";
import { healthCheckHandler, healthResponseSchema } from "./health.handler.js";
import { metadataHandler } from "./metadata.handler.js";
import { createExtractHandler } from "./extract.handler.js";
import { createComposeHandler } from "./compose.handler.js";
import { createCombinedHandler } from "./combined.handler.js";
import {
  createGetJobHandler,
  createDeleteJobHandler,
} from "./jobs.handler.js";
import { createFileHandler } from "./files.handler.js";
import { createDownloadHandler } from "./download.handler.js";
import { createVideoFormatsHandler } from "./video-formats.handler.js";
import { createVideoDownloadHandler } from "./video-download.handler.js";
import { createVideoServeHandler } from "./video-serve.handler.js";
import { createHlsDiscoverHandler } from "./hls-discover.handler.js";
import {
  metadataResponseSchema,
  extractResponseSchema,
  composeResponseSchema,
  combinedResponseSchema,
  asyncJobResponseSchema,
  jobIdParamsSchema,
  fileParamsSchema,
  downloadQuerySchema,
  videoFormatsResponseSchema,
  videoDownloadResponseSchema,
  hlsDiscoverResponseSchema,
} from "./schemas.js";

interface RouteOptions {
  env: Env;
  jobManager: JobManager;
  storage: Storage;
}

export async function registerRoutes(
  app: FastifyInstance,
  opts: RouteOptions,
): Promise<void> {
  app.get(
    "/api/v1/health",
    {
      schema: {
        response: { 200: healthResponseSchema },
      },
    },
    healthCheckHandler,
  );

  app.post(
    "/api/v1/metadata",
    {
      schema: {
        response: { 200: metadataResponseSchema },
      },
    },
    metadataHandler,
  );

  app.post(
    "/api/v1/extract",
    {
      schema: {
        response: {
          200: extractResponseSchema,
          202: asyncJobResponseSchema,
        },
      },
    },
    createExtractHandler(opts.env, opts.jobManager),
  );

  app.post(
    "/api/v1/compose",
    {
      schema: {
        response: {
          200: composeResponseSchema,
          202: asyncJobResponseSchema,
        },
      },
    },
    createComposeHandler(opts.env, opts.jobManager),
  );

  app.post(
    "/api/v1/extract-and-compose",
    {
      schema: {
        response: {
          200: combinedResponseSchema,
          202: asyncJobResponseSchema,
        },
      },
    },
    createCombinedHandler(opts.env, opts.jobManager),
  );

  app.get(
    "/api/v1/jobs/:id",
    {
      schema: {
        params: jobIdParamsSchema,
      },
    },
    createGetJobHandler(opts.jobManager),
  );

  app.delete(
    "/api/v1/jobs/:id",
    {
      schema: {
        params: jobIdParamsSchema,
      },
    },
    createDeleteJobHandler(opts.jobManager),
  );

  app.get(
    "/api/v1/files/:jobId/*",
    {
      schema: {
        params: fileParamsSchema,
      },
    },
    createFileHandler(opts.jobManager, opts.storage),
  );

  app.get(
    "/api/v1/jobs/:id/download",
    {
      schema: {
        params: jobIdParamsSchema,
        querystring: downloadQuerySchema,
      },
    },
    createDownloadHandler(opts.jobManager, opts.storage),
  );

  app.post(
    "/api/v1/hls/discover",
    {
      schema: {
        response: { 200: hlsDiscoverResponseSchema },
      },
    },
    createHlsDiscoverHandler(),
  );

  app.post(
    "/api/v1/video/formats",
    {
      schema: {
        response: { 200: videoFormatsResponseSchema },
      },
    },
    createVideoFormatsHandler(),
  );

  app.post(
    "/api/v1/video/download",
    {
      schema: {
        response: {
          200: videoDownloadResponseSchema,
          202: asyncJobResponseSchema,
        },
      },
    },
    createVideoDownloadHandler(opts.env, opts.jobManager),
  );

  app.get(
    "/api/v1/jobs/:id/video",
    {
      schema: {
        params: jobIdParamsSchema,
      },
    },
    createVideoServeHandler(opts.jobManager, opts.storage),
  );
}
