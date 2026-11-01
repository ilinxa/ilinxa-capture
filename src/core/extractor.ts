import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ProcessingError, ValidationError } from "../utils/errors.js";
import {
  PRINT_PTS_FILTER,
  mediaInputArgs,
  parsePtsLine,
  runFfmpeg,
  type TimeRange,
} from "./ffmpeg.js";
import { compareNatural } from "./natural-sort.js";
import type { ResolvedPreset } from "./presets.js";
import { qualityToQscale } from "./presets.js";

export interface ExtractionOptions {
  videoPath: string;
  outputDir: string;
  /** Samples per second. May be fractional, e.g. 0.2 for one every 5 seconds. */
  fps: number;
  preset: ResolvedPreset;
  range?: TimeRange | undefined;
  /** Seconds of media covered, for progress. */
  durationSeconds?: number | undefined;
  /** Seconds between source frames, when known. See samplingFilter. */
  frameInterval?: number | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((percent: number) => void) | undefined;
}

export interface ExtractionResult {
  frameFiles: string[];
  frameCount: number;
  /** Source time of each frame, in seconds. Parallel to frameFiles. */
  frameTimes: number[];
}

/**
 * Take the first frame of each sampling interval. The `fps` filter is not used
 * because its output frames do not sit at index/fps: they land about half an
 * interval late. This keeps a real source frame with a known time, and leaves
 * a gap in the source as a gap, rather than duplicating or bursting frames.
 */
function samplingFilter(fps: number, frameInterval: number): string {
  // Timestamps can be rounded, as MKV's are to the millisecond: 0.033 s then
  // falls short of the 1/30 boundary and the frame is lost. Just under half a
  // source frame of slack absorbs that without moving an exact frame. The
  // epsilon does the same where a rate like 1/3 has no exact binary form.
  const slack = frameInterval * 0.49;
  const interval = (t: string): string =>
    slack > 0
      ? `floor((${t}+${slack})*${fps}+0.000001)`
      : `floor(${t}*${fps}+0.000001)`;
  return `select='isnan(prev_selected_t)+gt(${interval("t")},${interval("prev_selected_t")})'`;
}

/**
 * Build the FFmpeg video filter string for frame extraction.
 */
export function buildVideoFilter(
  fps: number,
  preset: ResolvedPreset,
  frameInterval = 0,
): string {
  const filters: string[] = [samplingFilter(fps, frameInterval), PRINT_PTS_FILTER];

  if (preset.width !== null) {
    // -2 keeps aspect ratio with even dimensions (required by many codecs)
    filters.push(`scale=${preset.width}:-2`);
  }

  return filters.join(",");
}

/**
 * Build the full FFmpeg argument array for frame extraction.
 */
export function buildFfmpegArgs(opts: ExtractionOptions): string[] {
  const ext = opts.preset.format === "png" ? "png" : "jpg";
  const outputPattern = join(opts.outputDir, `frame_%04d.${ext}`);

  const args: string[] = [
    ...mediaInputArgs(opts.videoPath, opts.range),
    "-vf", buildVideoFilter(opts.fps, opts.preset, opts.frameInterval),
    "-fps_mode", "passthrough",
    "-an",
  ];

  // JPEG quality
  if (opts.preset.format === "jpeg" && opts.preset.quality !== null) {
    args.push("-q:v", String(qualityToQscale(opts.preset.quality)));
  }

  args.push(outputPattern);

  return args;
}

/**
 * Extract frames from a video using FFmpeg.
 */
export async function extractFrames(
  opts: ExtractionOptions,
): Promise<ExtractionResult> {
  await mkdir(opts.outputDir, { recursive: true });

  // With a seek, FFmpeg's clock restarts at the range start.
  const offset = opts.range?.start ?? 0;
  const printedTimes: number[] = [];

  try {
    await runFfmpeg(buildFfmpegArgs(opts), {
      signal: opts.signal,
      durationSeconds: opts.durationSeconds,
      onProgress: opts.onProgress,
      onStdoutLine: (line) => {
        const pts = parsePtsLine(line);
        if (pts !== null) printedTimes.push(pts + offset);
      },
    });
  } catch (err) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    // Some encoders fail rather than finish when no frame ever reaches them.
    if (opts.range && printedTimes.length === 0) {
      throw new ValidationError("No video frames in the requested range");
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ProcessingError(`FFmpeg extraction failed: ${message}`);
  }

  const entries = await readdir(opts.outputDir);
  const frameFiles = entries
    .filter((f) => f.startsWith("frame_"))
    .sort(compareNatural)
    .map((f) => join(opts.outputDir, f));

  if (opts.range && frameFiles.length === 0) {
    throw new ValidationError("No video frames in the requested range");
  }

  return {
    frameFiles,
    frameCount: frameFiles.length,
    frameTimes: frameFiles.map(
      (_, i) => printedTimes[i] ?? offset + i / opts.fps,
    ),
  };
}
