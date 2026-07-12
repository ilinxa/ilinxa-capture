import { z } from "zod";

export const metadataRequestSchema = z.object({
  source: z.string().min(1),
});

export type MetadataRequest = z.infer<typeof metadataRequestSchema>;

export const metadataResponseSchema = z.object({
  duration: z.number(),
  width: z.number().int(),
  height: z.number().int(),
  fps: z.number(),
  codec: z.string(),
  size_bytes: z.number().int(),
  format: z.string(),
});

export type MetadataResponse = z.infer<typeof metadataResponseSchema>;

// --- Extract ---

export const extractRequestSchema = z.object({
  source: z.string().min(1),
  fps: z.coerce.number().int().min(1).max(30),
  preset: z.enum(["llm", "high", "custom"]).default("llm"),
  width: z.coerce.number().int().positive().optional(),
  format: z.enum(["jpeg", "png"]).optional(),
  quality: z.coerce.number().int().min(1).max(100).optional(),
  async: z.coerce.boolean().default(false),
  webhook_url: z.string().url().optional(),
});

export type ExtractRequest = z.infer<typeof extractRequestSchema>;

export const sourceMetadataSchema = z.object({
  duration: z.number(),
  width: z.number().int(),
  height: z.number().int(),
  fps: z.number(),
});

export const extractResponseSchema = z.object({
  job_id: z.string(),
  status: z.literal("completed"),
  frames: z.object({
    count: z.number().int(),
    files: z.array(z.string()),
    urls: z.array(z.string()),
  }),
  source_metadata: sourceMetadataSchema,
  processing_time_ms: z.number(),
});

export type ExtractResponse = z.infer<typeof extractResponseSchema>;

// --- Compose ---

const modeSchema = z.coerce
  .number()
  .int()
  .refine((v): v is 1 | 4 | 16 => [1, 4, 16].includes(v), {
    message: "Mode must be 1, 4, or 16",
  });

export const composeRequestSchema = z.object({
  job_id: z.string().optional(),
  frames: z.array(z.string()).min(1).optional(),
  mode: modeSchema,
  overlay_frame_number: z.coerce.boolean().default(false),
  overlay_timestamp: z.coerce.boolean().default(false),
  fps: z.coerce.number().positive().optional(),
  async: z.coerce.boolean().default(false),
  webhook_url: z.string().url().optional(),
});

export type ComposeRequest = z.infer<typeof composeRequestSchema>;

const sheetsSchema = z.object({
  count: z.number().int(),
  mode: z.number().int(),
  grid: z.string(),
  files: z.array(z.string()),
  urls: z.array(z.string()),
});

export const composeResponseSchema = z.object({
  job_id: z.string(),
  status: z.literal("completed"),
  sheets: sheetsSchema,
  processing_time_ms: z.number(),
});

export type ComposeResponse = z.infer<typeof composeResponseSchema>;

// --- Combined (Extract + Compose) ---

export const combinedRequestSchema = extractRequestSchema.extend({
  mode: modeSchema,
  overlay_frame_number: z.coerce.boolean().default(false),
  overlay_timestamp: z.coerce.boolean().default(false),
});

export type CombinedRequest = z.infer<typeof combinedRequestSchema>;

export const combinedResponseSchema = z.object({
  job_id: z.string(),
  status: z.literal("completed"),
  frames: z.object({
    count: z.number().int(),
    files: z.array(z.string()),
    urls: z.array(z.string()),
  }),
  sheets: sheetsSchema,
  source_metadata: sourceMetadataSchema,
  processing_time_ms: z.number(),
});

export type CombinedResponse = z.infer<typeof combinedResponseSchema>;

// --- Async Job ---

export const asyncJobResponseSchema = z.object({
  job_id: z.string(),
  status: z.literal("pending"),
  poll_url: z.string(),
});

export type AsyncJobResponse = z.infer<typeof asyncJobResponseSchema>;

export const jobIdParamsSchema = z.object({
  id: z.string().min(1),
});

export type JobIdParams = z.infer<typeof jobIdParamsSchema>;

// --- File Serving ---

export const fileParamsSchema = z.object({
  jobId: z.string().min(1),
  "*": z.string().min(1),
});

export type FileParams = z.infer<typeof fileParamsSchema>;

// --- Download ---

export const downloadQuerySchema = z.object({
  include: z.enum(["frames", "sheets", "all"]).default("all"),
});

export type DownloadQuery = z.infer<typeof downloadQuerySchema>;

// --- HTTP Headers (shared) ---

const httpHeadersSchema = z.record(z.string(), z.string()).optional();

// --- Video Formats ---

const ytdlpFormatSchema = z.object({
  format_id: z.string(),
  ext: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  fps: z.number().nullable(),
  vcodec: z.string(),
  acodec: z.string(),
  filesize: z.number().int().nullable(),
  filesize_approx: z.number().int().nullable(),
  format_note: z.string(),
  resolution: z.string(),
});

export const videoFormatsRequestSchema = z.object({
  url: z.string().url().min(1),
  headers: httpHeadersSchema,
});

export type VideoFormatsRequest = z.infer<typeof videoFormatsRequestSchema>;

export const videoFormatsResponseSchema = z.object({
  title: z.string(),
  duration: z.number(),
  formats: z.array(ytdlpFormatSchema),
});

export type VideoFormatsResponse = z.infer<typeof videoFormatsResponseSchema>;

// --- Video Download ---

export const videoDownloadRequestSchema = z.object({
  url: z.string().url().min(1),
  preset: z
    .enum(["best", "1080p", "720p", "480p", "360p", "audio_only"])
    .optional(),
  format_selector: z.string().optional(),
  merge_format: z.enum(["mp4", "webm", "mkv", "mp3"]).default("mp4"),
  headers: httpHeadersSchema,
  async: z.coerce.boolean().default(false),
  webhook_url: z.string().url().optional(),
});

export type VideoDownloadRequest = z.infer<typeof videoDownloadRequestSchema>;

export const videoDownloadResponseSchema = z.object({
  job_id: z.string(),
  status: z.literal("completed"),
  video: z.object({
    filename: z.string(),
    filesize: z.number().int(),
    ext: z.string(),
    download_url: z.string(),
  }),
  processing_time_ms: z.number(),
});

export type VideoDownloadResponse = z.infer<
  typeof videoDownloadResponseSchema
>;

// --- HLS Discovery ---

export const hlsDiscoverRequestSchema = z.object({
  url: z.string().url().min(1),
  headers: httpHeadersSchema,
});

export type HlsDiscoverRequest = z.infer<typeof hlsDiscoverRequestSchema>;

const discoveredStreamSchema = z.object({
  url: z.string(),
  source: z.string(),
});

export const hlsDiscoverResponseSchema = z.object({
  page_url: z.string(),
  page_title: z.string().nullable(),
  streams: z.array(discoveredStreamSchema),
});

export type HlsDiscoverResponse = z.infer<typeof hlsDiscoverResponseSchema>;
