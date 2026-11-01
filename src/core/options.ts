import { z } from "zod";
import { JOB_ID_PATTERN } from "./job-id.js";

/**
 * Request options, defined once. REST and MCP build their schemas from these
 * shapes, so an option added here reaches both. The only difference between
 * them is how scalars arrive: JSON values for MCP, and for REST possibly the
 * strings of a multipart form.
 */
export interface Scalars {
  number(): z.ZodNumber;
  boolean(): z.ZodBoolean;
  list<T extends z.ZodType>(item: T): z.ZodArray<T>;
}

// z.coerce.boolean() would read the string "false" as true.
const formBoolean = z.preprocess((value) => {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}, z.boolean());

// A form has no arrays: accept "first,last", and "none" for an empty list. A
// repeated field reaches here as an array already.
function formList<T extends z.ZodType>(item: T): z.ZodArray<T> {
  return z.preprocess((value) => {
    if (value === "none") return [];
    if (typeof value !== "string") return value;
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }, z.array(item)) as unknown as z.ZodArray<T>;
}

export const restScalars: Scalars = {
  number: () => z.coerce.number() as unknown as z.ZodNumber,
  boolean: () => formBoolean as unknown as z.ZodBoolean,
  list: formList,
};

export const mcpScalars: Scalars = {
  number: () => z.number(),
  boolean: () => z.boolean(),
  list: (item) => z.array(item),
};

export const httpUrlSchema = z
  .string()
  .url()
  .refine((url) => /^https?:\/\//i.test(url), {
    message: "Only http and https URLs are supported",
  });

const jobIdSchema = z.string().regex(JOB_ID_PATTERN, "Invalid job ID");

// An .m3u8 here is handed to FFmpeg as a URL, so it must be one.
const formatSelectorSchema = z.string().refine(
  (selector) =>
    !/\.m3u8(\?|$)/i.test(selector) || /^https?:\/\//i.test(selector),
  { message: "An .m3u8 format_selector must be an http or https URL" },
);
const timeSchema = z.union([z.number().nonnegative(), z.string()]);
const headersSchema = z.record(z.string(), z.string()).optional();

function modeSchema(s: Scalars) {
  return s
    .number()
    .int()
    .refine((v): v is 1 | 4 | 16 => [1, 4, 16].includes(v), {
      message: "Mode must be 1, 4, or 16",
    })
    .describe("Grid mode: 1 (single/overlay-only), 4 (2x2), 16 (4x4)");
}

function jobShape(s: Scalars) {
  return {
    async: s
      .boolean()
      .default(false)
      .describe("Return a job immediately instead of waiting for the result"),
  };
}

function overlayShape(s: Scalars) {
  return {
    overlay_frame_number: s
      .boolean()
      .default(false)
      .describe("Overlay frame number on each cell"),
    overlay_timestamp: s
      .boolean()
      .default(false)
      .describe("Overlay the frame's real timestamp on each cell"),
    max_sheet_edge: s
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Longest grid sheet edge in pixels; frames shrink to fit. 0 = no limit. " +
          "Defaults to MAX_SHEET_EDGE for the llm preset, no limit otherwise",
      ),
  };
}

function rangeShape() {
  return {
    start: timeSchema
      .optional()
      .describe("Start of the range to process: seconds, MM:SS or HH:MM:SS"),
    end: timeSchema
      .optional()
      .describe("End of the range to process: seconds, MM:SS or HH:MM:SS"),
  };
}

function presetShape(s: Scalars) {
  return {
    preset: z
      .enum(["llm", "high", "custom"])
      .default("llm")
      .describe("Quality preset: llm (1024px JPEG 80%), high (original PNG), custom"),
    width: s
      .number()
      .int()
      .positive()
      .optional()
      .describe("Custom width in pixels (only with preset=custom)"),
    format: z
      .enum(["jpeg", "png"])
      .optional()
      .describe("Output format (only with preset=custom)"),
    quality: s
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("JPEG quality 1-100 (only with preset=custom)"),
  };
}

const sourceSchema = z.string().min(1).describe("Video file path or URL");

function extractShape(s: Scalars) {
  return {
    source: sourceSchema,
    fps: s
      .number()
      .min(0.001)
      .max(30)
      .optional()
      .describe("Frames per second to sample, 0.001-30. Fractions are allowed"),
    every_seconds: s
      .number()
      .min(0.04)
      .max(3600)
      .optional()
      .describe("Sample one frame every N seconds, instead of fps"),
    ...rangeShape(),
    ...presetShape(s),
  };
}

export function extractOptionsShape(s: Scalars) {
  return { ...extractShape(s), ...jobShape(s) };
}

export function composeOptionsShape(s: Scalars) {
  return {
    job_id: jobIdSchema.optional().describe("Job ID from a previous extraction"),
    frames: z
      .array(z.string())
      .min(1)
      .optional()
      .describe("Array of absolute frame file paths"),
    timestamps: z
      .array(z.number().nonnegative())
      .optional()
      .describe("Real time in seconds of each entry in frames, for overlays"),
    mode: modeSchema(s),
    fps: s
      .number()
      .positive()
      .optional()
      .describe(
        "FPS for timestamp labels. Needed only with frames and no timestamps",
      ),
    ...overlayShape(s),
    ...jobShape(s),
  };
}

export function combinedOptionsShape(s: Scalars) {
  return {
    ...extractShape(s),
    mode: modeSchema(s),
    ...overlayShape(s),
    ...jobShape(s),
  };
}

export function shotsOptionsShape(s: Scalars) {
  return {
    source: sourceSchema,
    ...rangeShape(),
    scene_threshold: s
      .number()
      .min(0.01)
      .max(1)
      .default(0.3)
      .describe(
        "Scene change score that counts as a cut, 0.01-1. Lower finds more cuts",
      ),
    min_shot_seconds: s
      .number()
      .min(0)
      .max(60)
      .default(0.25)
      .describe("Shortest shot to keep. Closer cuts are ignored"),
    frame_positions: s
      .list(z.enum(["first", "middle", "last"]))
      .default(["middle"])
      .describe("Frames to capture from each shot. Empty for the shot list only"),
    ...presetShape(s),
    ...jobShape(s),
  };
}

export function audioOptionsShape(s: Scalars) {
  return {
    source: sourceSchema,
    ...rangeShape(),
    format: z
      .enum(["wav", "flac", "mp3", "m4a"])
      .default("wav")
      .describe("Output format"),
    stream: s
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Which audio stream: 0 is the first. See audio_streams in metadata"),
    sample_rate: s
      .number()
      .int()
      .min(8000)
      .max(192000)
      .optional()
      .describe("Sample rate in Hz, e.g. 16000 for speech models. Default: source rate"),
    channels: s
      .number()
      .int()
      .min(1)
      .max(2)
      .optional()
      .describe("1 for mono, 2 for stereo. Default: as in the source"),
    ...jobShape(s),
  };
}

export function videoDownloadOptionsShape(s: Scalars) {
  return {
    url: httpUrlSchema.describe("Video URL to download"),
    preset: z
      .enum(["best", "1080p", "720p", "480p", "360p", "audio_only"])
      .optional()
      .describe("Download quality preset (default: best)"),
    format_selector: formatSelectorSchema
      .optional()
      .describe(
        "Advanced: raw yt-dlp format selector or HLS variant .m3u8 URL (overrides preset)",
      ),
    merge_format: z
      .enum(["mp4", "webm", "mkv", "mp3"])
      .default("mp4")
      .describe("Output container format"),
    headers: headersSchema.describe(
      "Optional HTTP headers (e.g., Referer, Cookie) for protected streams",
    ),
    ...jobShape(s),
  };
}

// Option types as the service sees them, after parsing on either interface.
const types = {
  extract: z.object(extractOptionsShape(mcpScalars)),
  compose: z.object(composeOptionsShape(mcpScalars)),
  combined: z.object(combinedOptionsShape(mcpScalars)),
  shots: z.object(shotsOptionsShape(mcpScalars)),
  audio: z.object(audioOptionsShape(mcpScalars)),
  videoDownload: z.object(videoDownloadOptionsShape(mcpScalars)),
};

export type ExtractOptions = z.output<typeof types.extract>;
export type ComposeOptions = z.output<typeof types.compose>;
export type CombinedOptions = z.output<typeof types.combined>;
export type ShotsOptions = z.output<typeof types.shots>;
export type AudioOptions = z.output<typeof types.audio>;
export type VideoDownloadOptions = z.output<typeof types.videoDownload>;
