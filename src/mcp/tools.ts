import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolve, join } from "node:path";
import { readdir } from "node:fs/promises";
import { unlink } from "node:fs/promises";
import { getVideoMetadata } from "../core/metadata.js";
import { extractFrames } from "../core/extractor.js";
import { composeGrid } from "../core/composer.js";
import { resolvePreset } from "../core/presets.js";
import {
  isUrl,
  downloadVideo,
  listVideoFormats,
  downloadVideoWithFormat,
  VIDEO_DOWNLOAD_PRESETS,
  type VideoDownloadPreset,
} from "../core/downloader.js";
import { discoverHlsUrls } from "../core/hls.js";
import type { Env } from "../lib/env.js";
import type { JobManager } from "../core/job-manager.js";

export interface ToolDeps {
  env: Env;
  jobManager: JobManager;
}

function errorResult(err: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  return {
    isError: true,
    content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
  };
}

function textResult(data: unknown): { content: [{ type: "text"; text: string }] } {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

type AcquireSourceResult =
  | { videoPath: string; cleanup: () => Promise<void>; error?: never }
  | { videoPath?: never; cleanup?: never; error: ReturnType<typeof errorResult> };

/**
 * Resolve a tool's `source` input into a local video path, downloading URLs
 * via yt-dlp and validating duration against MAX_VIDEO_DURATION. Shared by
 * capture_extract and capture_extract_and_compose, which both need
 * download + duration-check + temp-file-cleanup around the same source.
 *
 * On success, `cleanup()` unlinks the downloaded temp file (best-effort) —
 * always call it in a `finally` block. On failure, `error` is a ready-to-return
 * CallToolResult.
 */
async function acquireSource(source: string, env: Env): Promise<AcquireSourceResult> {
  let tempPath: string | null = null;
  const cleanup = async (): Promise<void> => {
    if (tempPath) {
      await unlink(tempPath).catch(() => {
        // best-effort temp cleanup
      });
    }
  };

  try {
    let videoPath = source;

    if (isUrl(source)) {
      tempPath = await downloadVideo(source);
      videoPath = tempPath;
    }

    const metadata = await getVideoMetadata(videoPath);
    if (metadata.duration > env.MAX_VIDEO_DURATION) {
      await cleanup();
      return {
        error: errorResult(
          new Error(
            `Video duration ${metadata.duration}s exceeds maximum of ${env.MAX_VIDEO_DURATION}s`,
          ),
        ),
      };
    }

    return { videoPath, cleanup };
  } catch (err) {
    await cleanup();
    return { error: errorResult(err) };
  }
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { env, jobManager } = deps;

  // ─── Tool 1: capture_metadata ───────────────────────────────────────

  server.registerTool(
    "capture_metadata",
    {
      description:
        "Get video metadata (duration, resolution, FPS, codec) from a local file or URL. " +
        "ffprobe handles URLs natively — no download needed.",
      inputSchema: {
        source: z.string().describe("Video file path or URL"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ source }) => {
      try {
        const metadata = await getVideoMetadata(source);
        return textResult(metadata);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─── Tool 2: capture_extract ────────────────────────────────────────

  server.registerTool(
    "capture_extract",
    {
      description:
        "Extract frames from a video at a specified FPS rate. " +
        "Downloads URLs via yt-dlp automatically. Returns absolute file paths to extracted frames.",
      inputSchema: {
        source: z.string().describe("Video file path or URL"),
        fps: z
          .number()
          .int()
          .min(1)
          .max(30)
          .describe("Frames per second to extract (1-30)"),
        preset: z
          .enum(["llm", "high", "custom"])
          .default("llm")
          .describe(
            "Quality preset: llm (1024px JPEG 80%), high (original PNG), custom",
          ),
        width: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Custom width in pixels (only with preset=custom)"),
        format: z
          .enum(["jpeg", "png"])
          .optional()
          .describe("Output format (only with preset=custom)"),
        quality: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("JPEG quality 1-100 (only with preset=custom)"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ source, fps, preset, width, format, quality }) => {
      const acquired = await acquireSource(source, env);
      if (acquired.error) {
        return acquired.error;
      }
      const { videoPath, cleanup } = acquired;

      try {
        const jobId = jobManager.generateJobId();
        await jobManager.createJob(jobId, { type: "extract" });

        const outputDir = resolve(env.LOCAL_OUTPUT_DIR, jobId, "frames");
        const resolvedPreset = resolvePreset(preset, { width, format, quality });

        const result = await jobManager.runSync(jobId, async () => {
          return await extractFrames({
            videoPath,
            outputDir,
            fps,
            preset: resolvedPreset,
          });
        });

        return textResult({
          job_id: jobId,
          frames: {
            count: result.frameCount,
            files: result.frameFiles,
          },
        });
      } catch (err) {
        return errorResult(err);
      } finally {
        await cleanup();
      }
    },
  );

  // ─── Tool 3: capture_compose ────────────────────────────────────────

  server.registerTool(
    "capture_compose",
    {
      description:
        "Compose extracted frames into grid sheets. " +
        "Provide either job_id (from a previous extraction) or frames (array of file paths), not both.",
      inputSchema: {
        job_id: z
          .string()
          .optional()
          .describe("Job ID from a previous extraction"),
        frames: z
          .array(z.string())
          .min(1)
          .optional()
          .describe("Array of absolute frame file paths"),
        mode: z
          .number()
          .int()
          .refine(
            (v): v is 1 | 4 | 16 => [1, 4, 16].includes(v),
            { message: "Mode must be 1, 4, or 16" },
          )
          .describe("Grid mode: 1 (single/overlay-only), 4 (2x2), 16 (4x4)"),
        overlay_frame_number: z
          .boolean()
          .default(false)
          .describe("Overlay frame number on each cell"),
        overlay_timestamp: z
          .boolean()
          .default(false)
          .describe("Overlay timestamp on each cell"),
        fps: z
          .number()
          .positive()
          .optional()
          .describe(
            "FPS for timestamp calculation (required when overlay_timestamp is true)",
          ),
      },
      annotations: { readOnlyHint: false },
    },
    async ({
      job_id: inputJobId,
      frames: inputFrames,
      mode,
      overlay_frame_number,
      overlay_timestamp,
      fps,
    }) => {
      try {
        // Validate exactly one of job_id/frames
        if (inputJobId && inputFrames) {
          return errorResult(
            new Error("Provide either 'job_id' or 'frames', not both"),
          );
        }
        if (!inputJobId && !inputFrames) {
          return errorResult(
            new Error("Either 'job_id' or 'frames' must be provided"),
          );
        }

        if (overlay_timestamp && !fps) {
          return errorResult(
            new Error("'fps' is required when 'overlay_timestamp' is enabled"),
          );
        }

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
            return errorResult(
              new Error(`No frame files found for job '${inputJobId}'`),
            );
          }
        } else {
          jobId = jobManager.generateJobId();
          frameFiles = inputFrames!;
        }

        await jobManager.createJob(jobId, { type: "compose" });
        const outputDir = resolve(env.LOCAL_OUTPUT_DIR, jobId, "sheets");

        const result = await jobManager.runSync(jobId, async () => {
          return await composeGrid({
            frameFiles,
            outputDir,
            mode: mode as 1 | 4 | 16,
            overlays: {
              frameNumber: overlay_frame_number,
              timestamp: overlay_timestamp,
            },
            fps: fps ?? 1,
          });
        });

        return textResult({
          job_id: jobId,
          sheets: {
            count: result.sheetCount,
            mode: result.mode,
            grid: result.grid,
            files: result.sheetFiles,
          },
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─── Tool 4: capture_extract_and_compose ────────────────────────────

  server.registerTool(
    "capture_extract_and_compose",
    {
      description:
        "Extract frames from a video and compose them into grid sheets in one operation. " +
        "Downloads URLs via yt-dlp automatically. Returns both frame and sheet file paths.",
      inputSchema: {
        source: z.string().describe("Video file path or URL"),
        fps: z
          .number()
          .int()
          .min(1)
          .max(30)
          .describe("Frames per second to extract (1-30)"),
        mode: z
          .number()
          .int()
          .refine(
            (v): v is 1 | 4 | 16 => [1, 4, 16].includes(v),
            { message: "Mode must be 1, 4, or 16" },
          )
          .describe("Grid mode: 1 (single/overlay-only), 4 (2x2), 16 (4x4)"),
        preset: z
          .enum(["llm", "high", "custom"])
          .default("llm")
          .describe("Quality preset"),
        overlay_frame_number: z
          .boolean()
          .default(false)
          .describe("Overlay frame number on each cell"),
        overlay_timestamp: z
          .boolean()
          .default(false)
          .describe("Overlay timestamp on each cell"),
        width: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Custom width in pixels"),
        format: z
          .enum(["jpeg", "png"])
          .optional()
          .describe("Output format"),
        quality: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("JPEG quality 1-100"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({
      source,
      fps,
      mode,
      preset,
      overlay_frame_number,
      overlay_timestamp,
      width,
      format,
      quality,
    }) => {
      const acquired = await acquireSource(source, env);
      if (acquired.error) {
        return acquired.error;
      }
      const { videoPath, cleanup } = acquired;

      try {
        const jobId = jobManager.generateJobId();
        await jobManager.createJob(jobId, { type: "combined" });

        const framesDir = resolve(env.LOCAL_OUTPUT_DIR, jobId, "frames");
        const sheetsDir = resolve(env.LOCAL_OUTPUT_DIR, jobId, "sheets");
        const resolvedPreset = resolvePreset(preset, { width, format, quality });

        const result = await jobManager.runSync(jobId, async () => {
          const extractResult = await extractFrames({
            videoPath,
            outputDir: framesDir,
            fps,
            preset: resolvedPreset,
          });

          const composeResult = await composeGrid({
            frameFiles: extractResult.frameFiles,
            outputDir: sheetsDir,
            mode: mode as 1 | 4 | 16,
            overlays: {
              frameNumber: overlay_frame_number,
              timestamp: overlay_timestamp,
            },
            fps,
          });

          return { extractResult, composeResult };
        });

        return textResult({
          job_id: jobId,
          frames: {
            count: result.extractResult.frameCount,
            files: result.extractResult.frameFiles,
          },
          sheets: {
            count: result.composeResult.sheetCount,
            mode: result.composeResult.mode,
            grid: result.composeResult.grid,
            files: result.composeResult.sheetFiles,
          },
        });
      } catch (err) {
        return errorResult(err);
      } finally {
        await cleanup();
      }
    },
  );

  // ─── Tool 5: capture_video_formats ──────────────────────────────────

  server.registerTool(
    "capture_video_formats",
    {
      description:
        "List available download formats for a video URL. " +
        "Returns title, duration, and available formats with resolution/codec/size info. " +
        "Supports HLS (.m3u8) URLs natively.",
      inputSchema: {
        url: z
          .string()
          .url()
          .describe("Video URL (YouTube, Vimeo, HLS .m3u8, or direct link)"),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Optional HTTP headers (e.g., Referer, Cookie) for protected streams"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, headers }) => {
      try {
        const info = await listVideoFormats(url, headers);
        return textResult(info);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─── Tool 6: capture_video_download ───────────────────────────────

  server.registerTool(
    "capture_video_download",
    {
      description:
        "Download a video from a URL in a specified format and resolution. " +
        "Returns the job ID and file path to the downloaded video. " +
        "Supports HLS (.m3u8) URLs natively via FFmpeg.",
      inputSchema: {
        url: z
          .string()
          .url()
          .describe("Video URL to download"),
        preset: z
          .enum(["best", "1080p", "720p", "480p", "360p", "audio_only"])
          .optional()
          .describe("Download quality preset (default: best)"),
        format_selector: z
          .string()
          .optional()
          .describe("Advanced: raw yt-dlp format selector or HLS variant .m3u8 URL (overrides preset)"),
        merge_format: z
          .enum(["mp4", "webm", "mkv", "mp3"])
          .default("mp4")
          .describe("Output container format"),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Optional HTTP headers (e.g., Referer, Cookie) for protected streams"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ url, preset, format_selector, merge_format, headers }) => {
      try {
        if (preset && format_selector) {
          return errorResult(
            new Error("Provide either 'preset' or 'format_selector', not both"),
          );
        }

        let resolvedSelector: string;
        if (format_selector) {
          resolvedSelector = format_selector;
        } else {
          const presetKey: VideoDownloadPreset = preset ?? "best";
          resolvedSelector = VIDEO_DOWNLOAD_PRESETS[presetKey].formatSelector;
        }

        const jobId = jobManager.generateJobId();
        await jobManager.createJob(jobId, { type: "video_download" });

        const outputDir = resolve(env.LOCAL_OUTPUT_DIR, jobId, "video");

        const result = await jobManager.runSync(jobId, async () => {
          return await downloadVideoWithFormat({
            url,
            outputDir,
            formatSelector: resolvedSelector,
            mergeFormat: merge_format,
            headers,
          });
        });

        return textResult({
          job_id: jobId,
          video: {
            filename: result.filename,
            filesize: result.filesize,
            ext: result.ext,
            file_path: result.filePath,
          },
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─── Tool 7: capture_hls_discover ──────────────────────────────────

  server.registerTool(
    "capture_hls_discover",
    {
      description:
        "Scan a web page URL for HLS (.m3u8) video stream URLs. " +
        "Fetches the page HTML and searches for embedded .m3u8 playlist links.",
      inputSchema: {
        url: z
          .string()
          .url()
          .describe("Web page URL to scan for HLS streams"),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Optional HTTP headers (e.g., Referer, Cookie)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, headers }) => {
      try {
        const result = await discoverHlsUrls(url, headers);
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ─── Tool 8: capture_job_status ─────────────────────────────────────

  server.registerTool(
    "capture_job_status",
    {
      description: "Check the status of a processing job",
      inputSchema: {
        job_id: z
          .string()
          .describe("Job ID to check (e.g. cap_abc12345)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ job_id }) => {
      try {
        const job = jobManager.getJob(job_id);
        return textResult(job);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
