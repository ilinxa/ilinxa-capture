import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { composeGrid } from "../core/composer.js";
import { ValidationError } from "../utils/errors.js";
import { composeRequestSchema } from "./schemas.js";
import type { ComposeResponse } from "./schemas.js";
import type { Env } from "../lib/env.js";
import type { JobManager } from "../core/job-manager.js";
import { buildFileUrls } from "./lib/file-urls.js";
import { parseBody } from "./lib/validate.js";
import { runJob } from "./lib/run-job.js";

export function createComposeHandler(env: Env, jobManager: JobManager) {
  return async function composeHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const body = request.body as Record<string, unknown> | null;
    if (!body) {
      throw new ValidationError("Request body is required");
    }

    // Validate request fields
    const parsed = parseBody(composeRequestSchema, body);

    const {
      job_id: inputJobId,
      frames: inputFrames,
      mode,
      overlay_frame_number,
      overlay_timestamp,
      fps,
    } = parsed;
    const isAsync = parsed.async;
    const webhookUrl = parsed.webhook_url;

    // Exactly one of job_id or frames must be provided
    if (inputJobId && inputFrames) {
      throw new ValidationError(
        "Provide either 'job_id' or 'frames', not both",
      );
    }
    if (!inputJobId && !inputFrames) {
      throw new ValidationError(
        "Either 'job_id' or 'frames' must be provided",
      );
    }

    // Timestamp overlay requires fps
    if (overlay_timestamp && !fps) {
      throw new ValidationError(
        "'fps' is required when 'overlay_timestamp' is enabled",
      );
    }

    // Resolve frame files before queuing (need to read filesystem)
    let frameFiles: string[];
    let jobId: string;

    if (inputJobId) {
      jobId = inputJobId;
      const framesDir = resolve(env.LOCAL_OUTPUT_DIR, inputJobId, "frames");
      const entries = await readdir(framesDir);
      frameFiles = entries
        .filter((f) => f.startsWith("frame_"))
        .sort()
        .map((f) => join(framesDir, f));

      if (frameFiles.length === 0) {
        throw new ValidationError(
          `No frame files found for job '${inputJobId}'`,
        );
      }
    } else {
      jobId = jobManager.generateJobId();
      frameFiles = inputFrames!;
    }

    // Create job via manager
    await jobManager.createJob(jobId, { type: "compose", webhookUrl });

    const outputDir = resolve(env.LOCAL_OUTPUT_DIR, jobId, "sheets");

    // Build the task function
    const task = async (): Promise<ComposeResponse> => {
      const startTime = Date.now();
      const result = await composeGrid({
        frameFiles,
        outputDir,
        mode,
        overlays: {
          frameNumber: overlay_frame_number,
          timestamp: overlay_timestamp,
        },
        fps: fps ?? 1,
      });

      const urls = buildFileUrls(jobId, result.sheetFiles);

      return {
        job_id: jobId,
        status: "completed",
        sheets: {
          count: result.sheetCount,
          mode: result.mode,
          grid: result.grid,
          files: result.sheetFiles,
          urls,
        },
        processing_time_ms: Date.now() - startTime,
      };
    };

    await runJob({ jobManager, jobId, isAsync, task, reply });
  };
}
