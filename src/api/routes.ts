import type { FastifyInstance } from "fastify";
import type { Env } from "../lib/env.js";
import type { JobManager } from "../core/job-manager.js";
import type { Storage } from "../core/storage.js";
import type { CaptureService } from "../core/service.js";
import { createHealthHandler, healthResponseSchema } from "./health.handler.js";
import { createMetadataHandler } from "./metadata.handler.js";
import { createVideoJobHandler } from "./video-job.handler.js";
import { createComposeHandler } from "./compose.handler.js";
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
  extractRequestSchema,
  extractResponseSchema,
  composeResponseSchema,
  combinedRequestSchema,
  combinedResponseSchema,
  shotsRequestSchema,
  shotsResponseSchema,
  audioRequestSchema,
  audioResponseSchema,
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
  service: CaptureService;
}

export async function registerRoutes(
  app: FastifyInstance,
  opts: RouteOptions,
): Promise<void> {
  const { service } = opts;

  app.get(
    "/api/v1/health",
    {
      schema: {
        response: { 200: healthResponseSchema },
      },
    },
    createHealthHandler(opts.env),
  );

  app.post(
    "/api/v1/metadata",
    {
      schema: {
        response: { 200: metadataResponseSchema },
      },
    },
    createMetadataHandler(opts.service),
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
    createVideoJobHandler(service, extractRequestSchema, (source, options, run) =>
      service.extract(source, options, run),
    ),
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
    createComposeHandler(opts.service),
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
    createVideoJobHandler(service, combinedRequestSchema, (source, options, run) =>
      service.extractAndCompose(source, options, run),
    ),
  );

  app.post(
    "/api/v1/shots",
    {
      schema: {
        response: {
          200: shotsResponseSchema,
          202: asyncJobResponseSchema,
        },
      },
    },
    createVideoJobHandler(service, shotsRequestSchema, (source, options, run) =>
      service.detectShots(source, options, run),
    ),
  );

  app.post(
    "/api/v1/audio",
    {
      schema: {
        response: {
          200: audioResponseSchema,
          202: asyncJobResponseSchema,
        },
      },
    },
    createVideoJobHandler(service, audioRequestSchema, (source, options, run) =>
      service.extractAudio(source, options, run),
    ),
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
    createVideoDownloadHandler(opts.service),
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
