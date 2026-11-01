import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ProcessingError } from "../utils/errors.js";
import {
  PRINT_PTS_FILTER,
  parsePtsLine,
  rangeInputArgs,
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
function samplingFilter(fps: number): string {
  // The epsilon keeps a frame exactly on a boundary in its own interval, where
  // a rate like 1/3 has no exact binary form.
  const interval = (t: string): string => `floor(${t}*${fps}+0.000001)`;
  return `select='isnan(prev_selected_t)+gt(${interval("t")},${interval("prev_selected_t")})'`;
}

/**
 * Build the FFmpeg video filter string for frame extraction.
 */
export function buildVideoFilter(fps: number, preset: ResolvedPreset): string {
  const filters: string[] = [samplingFilter(fps), PRINT_PTS_FILTER];

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
    ...rangeInputArgs(opts.range),
    "-i", opts.videoPath,
    "-vf", buildVideoFilter(opts.fps, opts.preset),
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
    const message = err instanceof Error ? err.message : String(err);
    throw new ProcessingError(`FFmpeg extraction failed: ${message}`);
  }

  const entries = await readdir(opts.outputDir);
  const frameFiles = entries
    .filter((f) => f.startsWith("frame_"))
    .sort(compareNatural)
    .map((f) => join(opts.outputDir, f));

  return {
    frameFiles,
    frameCount: frameFiles.length,
    frameTimes: frameFiles.map(
      (_, i) => printedTimes[i] ?? offset + i / opts.fps,
    ),
  };
}
