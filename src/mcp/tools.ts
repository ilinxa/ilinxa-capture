import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";
import { listVideoFormats } from "../core/downloader.js";
import { discoverHlsUrls } from "../core/hls.js";
import { InputPolicy, type InputMode } from "../core/input-policy.js";
import { JOB_ID_PATTERN } from "../core/job-id.js";
import type { JobManager, JobProgress, JobState } from "../core/job-manager.js";
import { manifestPath, readManifest } from "../core/manifest.js";
import {
  audioOptionsShape,
  combinedOptionsShape,
  composeOptionsShape,
  extractOptionsShape,
  httpUrlSchema,
  mcpScalars,
  shotsOptionsShape,
  videoDownloadOptionsShape,
} from "../core/options.js";
import { CaptureService, type Submission } from "../core/service.js";
import type { Env } from "../lib/env.js";

/** Longest list returned inline. Beyond this, callers page through the manifest. */
const INLINE_LIMIT = 200;

export interface ToolDeps {
  env: Env;
  jobManager: JobManager;
  /** How callers reach this server. Decides the default local path policy. */
  inputMode?: InputMode;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

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

/** Run a tool body, turning any failure into an MCP tool error. */
async function guarded(
  body: () => Promise<unknown>,
): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
  try {
    return textResult(await body());
  } catch (err) {
    return errorResult(err);
  }
}

/** Forward job progress to a client that asked for it with a progress token. */
function progressSender(
  extra: ToolExtra,
): ((progress: JobProgress) => void) | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;

  let step = 0;
  let lastMessage = "";

  return ({ stage, percent }) => {
    const message = percent === null ? stage : `${stage} ${percent}%`;
    if (message === lastMessage) return;
    lastMessage = message;
    step += 1;

    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: step, message },
      })
      .catch(() => {
        // The client may have gone away; the job carries on regardless
      });
  };
}

/** Cut a list down to size, saying so when it was cut. */
function inlineList<T>(items: T[]): T[] {
  return items.slice(0, INLINE_LIMIT);
}

/**
 * Trim a job result for an agent's context. A film can yield thousands of
 * frames, and every path listed is tokens spent. The manifest holds it all.
 */
function compactResult(result: unknown, jobDir: string): unknown {
  if (typeof result !== "object" || result === null) return result;

  const { frames, sheets, shots, manifest_url: _url, ...rest } = result as {
    frames?: { count: number; files: string[]; timestamps?: number[] };
    sheets?: { count: number; files: string[] } & Record<string, unknown>;
    shots?: { count: number; items: unknown[] };
    manifest_url?: string;
  };

  const output: Record<string, unknown> = { ...rest };

  if (frames) {
    output["frames"] = {
      count: frames.count,
      files: inlineList(frames.files),
      timestamps: inlineList(frames.timestamps ?? []),
      truncated: frames.count > INLINE_LIMIT,
    };
    output["manifest_file"] = manifestPath(jobDir);
  }
  if (shots) {
    output["shots"] = {
      count: shots.count,
      items: inlineList(shots.items),
      truncated: shots.count > INLINE_LIMIT,
    };
  }
  if (sheets) {
    const { urls: _urls, ...sheetFields } = sheets as typeof sheets & {
      urls?: string[];
    };
    output["sheets"] = {
      ...sheetFields,
      files: inlineList(sheets.files),
      truncated: sheets.count > INLINE_LIMIT,
    };
  }

  return output;
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { env, jobManager } = deps;
  const service = new CaptureService(
    env,
    jobManager,
    InputPolicy.fromEnv(env, deps.inputMode ?? "http"),
  );

  /** What a tool returns for a finished job, or for one left running. */
  function outcome<T>(submission: Submission<T>): unknown {
    if (submission.status === "accepted") {
      return {
        job_id: submission.jobId,
        status: "pending",
        next: "Poll capture_job_status with this job_id",
      };
    }
    return compactResult(
      submission.result,
      jobManager.getJobDir(submission.jobId),
    );
  }

  function compactJob(job: JobState): unknown {
    return { ...job, result: compactResult(job.result, jobManager.getJobDir(job.id)) };
  }

  // ─── Tool 1: capture_metadata ───────────────────────────────────────

  server.registerTool(
    "capture_metadata",
    {
      description:
        "Get video metadata (duration, resolution, FPS, codec) from a local file or URL. " +
        "URLs are downloaded via yt-dlp first.",
      inputSchema: {
        source: z.string().describe("Video file path or URL"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ source }) => guarded(() => service.probe(source)),
  );

  // ─── Tool 2: capture_extract ────────────────────────────────────────

  server.registerTool(
    "capture_extract",
    {
      description:
        "Extract frames from a video, at a rate (fps or every_seconds) and optionally " +
        "from a time range. Downloads URLs via yt-dlp automatically. Returns absolute " +
        "file paths and each frame's real timestamp. For long videos, pass async: true " +
        "and poll capture_job_status.",
      inputSchema: extractOptionsShape(mcpScalars),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args, extra) =>
      guarded(async () => {
        const source = await service.resolveSource(args.source);
        return outcome(
          await service.extract(source, args, {
            async: args.async,
            onProgress: progressSender(extra),
          }),
        );
      }),
  );

  // ─── Tool 3: capture_compose ────────────────────────────────────────

  server.registerTool(
    "capture_compose",
    {
      description:
        "Compose extracted frames into grid sheets. " +
        "Provide either job_id (from a previous extraction) or frames (array of file paths), not both.",
      inputSchema: composeOptionsShape(mcpScalars),
      annotations: { readOnlyHint: false },
    },
    async (args, extra) =>
      guarded(async () =>
        outcome(
          await service.compose(args, {
            async: args.async,
            onProgress: progressSender(extra),
          }),
        ),
      ),
  );

  // ─── Tool 4: capture_extract_and_compose ────────────────────────────

  server.registerTool(
    "capture_extract_and_compose",
    {
      description:
        "Extract frames from a video and compose them into grid sheets in one operation. " +
        "Downloads URLs via yt-dlp automatically. Returns both frame and sheet file paths. " +
        "For long videos, pass async: true and poll capture_job_status.",
      inputSchema: combinedOptionsShape(mcpScalars),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args, extra) =>
      guarded(async () => {
        const source = await service.resolveSource(args.source);
        return outcome(
          await service.extractAndCompose(source, args, {
            async: args.async,
            onProgress: progressSender(extra),
          }),
        );
      }),
  );

  // ─── Tool 5: capture_shots ──────────────────────────────────────────

  server.registerTool(
    "capture_shots",
    {
      description:
        "Detect the shots in a video: where each starts and ends and how long it lasts, " +
        "with first, middle or last frames from each, labeled by shot and real timestamp. " +
        "Compose the frames with capture_compose and this job_id. Finds hard cuts well; " +
        "lower scene_threshold if dissolves are missed. Decodes the whole range, so for " +
        "long videos pass async: true and poll capture_job_status.",
      inputSchema: shotsOptionsShape(mcpScalars),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args, extra) =>
      guarded(async () => {
        const source = await service.resolveSource(args.source);
        return outcome(
          await service.detectShots(source, args, {
            async: args.async,
            onProgress: progressSender(extra),
          }),
        );
      }),
  );

  // ─── Tool 6: capture_audio ──────────────────────────────────────────

  server.registerTool(
    "capture_audio",
    {
      description:
        "Export the audio track of a video for separate speech or music models, " +
        "choosing the stream, sample rate, channels and format. With start and end, " +
        "add timeline_offset to a time in the audio to get a time in the video.",
      inputSchema: audioOptionsShape(mcpScalars),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args, extra) =>
      guarded(async () => {
        const source = await service.resolveSource(args.source);
        return outcome(
          await service.extractAudio(source, args, {
            async: args.async,
            onProgress: progressSender(extra),
          }),
        );
      }),
  );

  // ─── Tool 7: capture_video_formats ──────────────────────────────────

  server.registerTool(
    "capture_video_formats",
    {
      description:
        "List available download formats for a video URL. " +
        "Returns title, duration, and available formats with resolution/codec/size info. " +
        "Supports HLS (.m3u8) URLs natively.",
      inputSchema: {
        url: httpUrlSchema.describe(
          "Video URL (YouTube, Vimeo, HLS .m3u8, or direct link)",
        ),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Optional HTTP headers (e.g., Referer, Cookie) for protected streams"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, headers }) => guarded(() => listVideoFormats(url, headers)),
  );

  // ─── Tool 8: capture_video_download ───────────────────────────────

  server.registerTool(
    "capture_video_download",
    {
      description:
        "Download a video from a URL in a specified format and resolution. " +
        "Returns the job ID and file path to the downloaded video. " +
        "Supports HLS (.m3u8) URLs natively via FFmpeg.",
      inputSchema: videoDownloadOptionsShape(mcpScalars),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args, extra) =>
      guarded(async () =>
        outcome(
          await service.downloadVideo(args, {
            async: args.async,
            onProgress: progressSender(extra),
          }),
        ),
      ),
  );

  // ─── Tool 9: capture_hls_discover ──────────────────────────────────

  server.registerTool(
    "capture_hls_discover",
    {
      description:
        "Scan a web page URL for HLS (.m3u8) video stream URLs. " +
        "Fetches the page HTML and searches for embedded .m3u8 playlist links.",
      inputSchema: {
        url: httpUrlSchema.describe("Web page URL to scan for HLS streams"),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Optional HTTP headers (e.g., Referer, Cookie)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, headers }) => guarded(() => discoverHlsUrls(url, headers)),
  );

  // ─── Tool 10: capture_job_status ────────────────────────────────────

  const jobIdInput = z
    .string()
    .regex(JOB_ID_PATTERN, "Invalid job ID")
    .describe("Job ID (e.g. cap_1a2b3c4d)");

  server.registerTool(
    "capture_job_status",
    {
      description:
        "Check a job: status, progress while it runs, and its result or error when done",
      inputSchema: { job_id: jobIdInput },
      annotations: { readOnlyHint: true },
    },
    async ({ job_id }) =>
      guarded(async () => compactJob(jobManager.getJob(job_id))),
  );

  // ─── Tool 11: capture_job_manifest ──────────────────────────────────

  server.registerTool(
    "capture_job_manifest",
    {
      description:
        "Read a finished job's timeline one page at a time: every frame with its real " +
        "timestamp, every shot, and which frames each sheet holds",
      inputSchema: {
        job_id: jobIdInput,
        section: z
          .enum(["frames", "shots", "sheets"])
          .default("frames")
          .describe("Which list to read"),
        offset: z.number().int().nonnegative().default(0).describe("Items to skip"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(INLINE_LIMIT)
          .describe("Items to return, up to 1000"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ job_id, section, offset, limit }) =>
      guarded(async () => {
        jobManager.getJob(job_id);
        const manifest = await readManifest(jobManager.getJobDir(job_id));
        if (!manifest) {
          throw new Error(`Job '${job_id}' has no manifest`);
        }

        const items: unknown[] = manifest[section] ?? [];
        return {
          job_id,
          section,
          total: items.length,
          offset,
          items: items.slice(offset, offset + limit),
        };
      }),
  );

  // ─── Tool 12: capture_job_delete ────────────────────────────────────

  server.registerTool(
    "capture_job_delete",
    {
      description:
        "Stop a job if it is running, then delete it and all its output files",
      inputSchema: { job_id: jobIdInput },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ job_id }) =>
      guarded(async () => {
        await jobManager.deleteJob(job_id);
        return { job_id, deleted: true };
      }),
  );
}
