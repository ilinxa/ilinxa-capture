import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ProcessingError, ValidationError } from "../utils/errors.js";
import {
  EXACT_ENCODER_TIMEBASE,
  FIRST_DECODED_FILTER,
  PRINT_PTS_FILTER,
  createFrameReader,
  mediaInputArgs,
  runFfmpeg,
  seekMargins,
  seekOvershot,
  seekPoint,
  trimFilter,
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
  /** Container, as ffprobe names it. Decides how to seek. */
  format?: string | undefined;
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
function samplingFilter(fps: number, frameInterval: number): string | null {
  // At or above the source rate every frame is wanted, and a grid finer than
  // the frames would lose some to rounded timestamps.
  if (frameInterval > 0 && fps * frameInterval >= 0.995) return null;

  // Intervals count from the first frame, not from zero: audio priming puts
  // video about 21 ms in, right on a boundary of a 24 fps grid. Timestamps can
  // be rounded, as MKV's are to the millisecond, so just under half a source
  // frame of slack keeps a frame on the interval it belongs to. The epsilon
  // does the same where a rate like 1/3 has no exact binary form.
  const slack = frameInterval * 0.49;
  const interval = (t: string): string =>
    `floor((${t}-start_t+${slack})*${fps}+0.000001)`;
  return `select='isnan(prev_selected_t)+gt(${interval("t")},${interval("prev_selected_t")})'`;
}

/**
 * Build the FFmpeg video filter string for frame extraction.
 */
export function buildVideoFilter(
  fps: number,
  preset: ResolvedPreset,
  frameInterval = 0,
  range?: TimeRange,
): string {
  const sampling = samplingFilter(fps, frameInterval);
  const filters: string[] = [
    ...(range
      ? [FIRST_DECODED_FILTER, trimFilter(range.start, range.end)]
      : []),
    ...(sampling ? [sampling] : []),
    PRINT_PTS_FILTER,
  ];

  if (preset.width !== null) {
    // -2 keeps aspect ratio with even dimensions (required by many codecs)
    filters.push(`scale=${preset.width}:-2`);
  }

  return filters.join(",");
}

/**
 * Build the full FFmpeg argument array for frame extraction.
 */
export function buildFfmpegArgs(opts: ExtractionOptions, seek?: number): string[] {
  const ext = opts.preset.format === "png" ? "png" : "jpg";
  const outputPattern = join(opts.outputDir, `frame_%04d.${ext}`);

  const args: string[] = [
    ...mediaInputArgs(opts.videoPath, seek),
    "-vf", buildVideoFilter(opts.fps, opts.preset, opts.frameInterval, opts.range),
    "-fps_mode", "passthrough",
    ...EXACT_ENCODER_TIMEBASE,
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

  const start = opts.range?.start ?? 0;
  let printedTimes: number[] = [];

  for (const margin of opts.range ? seekMargins(opts.format) : [Infinity]) {
    const seek = opts.range ? seekPoint(start, margin) : undefined;
    const reader = createFrameReader();
    printedTimes = reader.times;

    try {
      await runFfmpeg(buildFfmpegArgs(opts, seek), {
        signal: opts.signal,
        durationSeconds: opts.durationSeconds,
        onProgress: opts.onProgress,
        onStdoutLine: reader.onLine,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      // Some encoders fail rather than finish when no frame ever reaches them.
      if (opts.range && printedTimes.length === 0) {
        if (seek !== undefined && seek > 0) continue;
        throw new ValidationError("No video frames in the requested range");
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new ProcessingError(`FFmpeg extraction failed: ${message}`);
    }

    if (!seekOvershot(seek, reader.firstDecoded(), start, opts.frameInterval ?? 0)) {
      break;
    }
    await rm(opts.outputDir, { recursive: true, force: true });
    await mkdir(opts.outputDir, { recursive: true });
  }

  const entries = await readdir(opts.outputDir);
  const frameFiles = entries
    .filter((f) => f.startsWith("frame_"))
    .sort(compareNatural)
    .map((f) => join(opts.outputDir, f));

  if (opts.range && frameFiles.length === 0) {
    throw new ValidationError("No video frames in the requested range");
  }

  // A frame with no printed time has no true time, and a computed one would pass for it.
  if (printedTimes.length < frameFiles.length) {
    throw new ProcessingError(
      `FFmpeg printed ${printedTimes.length} frame times for ${frameFiles.length} frames`,
    );
  }

  return {
    frameFiles,
    frameCount: frameFiles.length,
    frameTimes: printedTimes.slice(0, frameFiles.length),
  };
}
