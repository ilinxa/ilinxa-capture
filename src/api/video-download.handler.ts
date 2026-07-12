import { resolve } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  VIDEO_DOWNLOAD_PRESETS,
  downloadVideoWithFormat,
  type VideoDownloadPreset,
} from "../core/downloader.js";
import { ValidationError } from "../utils/errors.js";
import { videoDownloadRequestSchema } from "./schemas.js";
import type { VideoDownloadResponse } from "./schemas.js";
import type { Env } from "../lib/env.js";
import type { JobManager } from "../core/job-manager.js";
import { parseBody } from "./lib/validate.js";
import { runJob } from "./lib/run-job.js";

export function createVideoDownloadHandler(env: Env, jobManager: JobManager) {
  return async function videoDownloadHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const body = request.body as Record<string, unknown> | null;
    if (!body?.["url"]) {
      throw new ValidationError("Missing 'url' field");
    }

    const parsed = parseBody(videoDownloadRequestSchema, body);

    const { url, preset, format_selector, merge_format, headers } = parsed;
    const isAsync = parsed.async;
    const webhookUrl = parsed.webhook_url;

    // Validate: cannot provide both preset and format_selector
    if (preset && format_selector) {
      throw new ValidationError(
        "Provide either 'preset' or 'format_selector', not both",
      );
    }

    // Resolve format selector
    let resolvedSelector: string;
    if (format_selector) {
      resolvedSelector = format_selector;
    } else {
      const presetKey: VideoDownloadPreset = preset ?? "best";
      resolvedSelector = VIDEO_DOWNLOAD_PRESETS[presetKey].formatSelector;
    }

    const jobId = jobManager.generateJobId();
    await jobManager.createJob(jobId, {
      type: "video_download",
      webhookUrl,
    });

    const outputDir = resolve(env.LOCAL_OUTPUT_DIR, jobId, "video");

    const task = async (): Promise<VideoDownloadResponse> => {
      const startTime = Date.now();
      const result = await downloadVideoWithFormat({
        url,
        outputDir,
        formatSelector: resolvedSelector,
        mergeFormat: merge_format,
        headers,
      });

      return {
        job_id: jobId,
        status: "completed",
        video: {
          filename: result.filename,
          filesize: result.filesize,
          ext: result.ext,
          download_url: `/api/v1/jobs/${jobId}/video`,
        },
        processing_time_ms: Date.now() - startTime,
      };
    };

    await runJob({ jobManager, jobId, isAsync, task, reply });
  };
}
