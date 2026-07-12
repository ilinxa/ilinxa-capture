import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getVideoMetadata } from "../core/metadata.js";
import { extractFrames } from "../core/extractor.js";
import { composeGrid } from "../core/composer.js";
import { resolvePreset } from "../core/presets.js";
import { isUrl, downloadVideo } from "../core/downloader.js";
import { ValidationError, VideoTooLongError } from "../utils/errors.js";
import { combinedRequestSchema } from "./schemas.js";
import type { CombinedResponse } from "./schemas.js";
import type { Env } from "../lib/env.js";
import type { JobManager } from "../core/job-manager.js";
import { getMultipartFieldValue } from "./lib/multipart.js";
import { buildFileUrls } from "./lib/file-urls.js";
import { parseBody } from "./lib/validate.js";
import { runJob } from "./lib/run-job.js";

export function createCombinedHandler(env: Env, jobManager: JobManager) {
  return async function combinedHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    let tempPath: string | null = null;

    try {
      let source: string;
      let rawFields: Record<string, unknown> = {};

      if (request.isMultipart()) {
        const file = await request.file();
        if (!file) {
          throw new ValidationError("No file provided in multipart request");
        }

        tempPath = join(tmpdir(), `ilinxa-capture-${randomUUID()}-${file.filename}`);
        await pipeline(file.file, createWriteStream(tempPath));
        source = tempPath;

        const fields = file.fields;
        rawFields = {
          source,
          fps: getMultipartFieldValue(fields["fps"]),
          preset: getMultipartFieldValue(fields["preset"]),
          width: getMultipartFieldValue(fields["width"]),
          format: getMultipartFieldValue(fields["format"]),
          quality: getMultipartFieldValue(fields["quality"]),
          mode: getMultipartFieldValue(fields["mode"]),
          overlay_frame_number: getMultipartFieldValue(
            fields["overlay_frame_number"],
          ),
          overlay_timestamp: getMultipartFieldValue(
            fields["overlay_timestamp"],
          ),
          async: getMultipartFieldValue(fields["async"]),
          webhook_url: getMultipartFieldValue(fields["webhook_url"]),
        };
      } else {
        const body = request.body as Record<string, unknown> | null;
        if (!body?.["source"]) {
          throw new ValidationError(
            "Missing 'source' field — provide a video URL or upload a file",
          );
        }
        rawFields = { ...body };
        source = String(body["source"]);
      }

      // Download URL via yt-dlp if source is a URL
      if (!tempPath && isUrl(source)) {
        tempPath = await downloadVideo(source);
        source = tempPath;
        rawFields["source"] = source;
      }

      // Validate request fields
      const parsed = parseBody(combinedRequestSchema, rawFields);

      const {
        fps,
        preset: presetName,
        width,
        format,
        quality,
        mode,
        overlay_frame_number,
        overlay_timestamp,
      } = parsed;
      const isAsync = parsed.async;
      const webhookUrl = parsed.webhook_url;

      // Get source metadata and validate duration
      const metadata = await getVideoMetadata(source);
      if (metadata.duration > env.MAX_VIDEO_DURATION) {
        throw new VideoTooLongError(String(env.MAX_VIDEO_DURATION));
      }

      // Create job via manager
      const jobId = jobManager.generateJobId();
      await jobManager.createJob(jobId, { type: "combined", webhookUrl });

      const framesDir = resolve(env.LOCAL_OUTPUT_DIR, jobId, "frames");
      const sheetsDir = resolve(env.LOCAL_OUTPUT_DIR, jobId, "sheets");
      const resolvedPreset = resolvePreset(presetName, { width, format, quality });

      // Build the task function
      const task = async (): Promise<CombinedResponse> => {
        const startTime = Date.now();

        const extractResult = await extractFrames({
          videoPath: source,
          outputDir: framesDir,
          fps,
          preset: resolvedPreset,
        });

        const composeResult = await composeGrid({
          frameFiles: extractResult.frameFiles,
          outputDir: sheetsDir,
          mode,
          overlays: {
            frameNumber: overlay_frame_number,
            timestamp: overlay_timestamp,
          },
          fps,
        });

        const frameUrls = buildFileUrls(jobId, extractResult.frameFiles);
        const sheetUrls = buildFileUrls(jobId, composeResult.sheetFiles);

        return {
          job_id: jobId,
          status: "completed",
          frames: {
            count: extractResult.frameCount,
            files: extractResult.frameFiles,
            urls: frameUrls,
          },
          sheets: {
            count: composeResult.sheetCount,
            mode: composeResult.mode,
            grid: composeResult.grid,
            files: composeResult.sheetFiles,
            urls: sheetUrls,
          },
          source_metadata: {
            duration: metadata.duration,
            width: metadata.width,
            height: metadata.height,
            fps: metadata.fps,
          },
          processing_time_ms: Date.now() - startTime,
        };
      };

      const { tempPathOwnershipTransferred } = await runJob({
        jobManager,
        jobId,
        isAsync,
        task,
        reply,
        tempPath,
      });
      if (tempPathOwnershipTransferred) {
        tempPath = null;
      }
    } finally {
      if (tempPath) {
        await unlink(tempPath).catch(() => {
          // Temp file cleanup is best-effort
        });
      }
    }
  };
}
