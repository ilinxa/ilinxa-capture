import { mkdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { ProcessingError } from "../utils/errors.js";
import {
  PRINT_PTS_FILTER,
  parsePtsLine,
  rangeInputArgs,
  runFfmpeg,
  type TimeRange,
} from "./ffmpeg.js";
import type { ResolvedPreset } from "./presets.js";
import { qualityToQscale } from "./presets.js";

export type FramePosition = "first" | "middle" | "last";

const MAX_FRAME_WORKERS = 4;

// Small enough for scene scoring to be fast; large enough to keep the cuts.
const DETECT_WIDTH = 320;

// Times from metadata=print are rounded, so seek a hair early to land on the
// wanted frame rather than the one after it. Far less than one frame even at 240 fps.
const SEEK_LEAD_SECONDS = 0.0005;

export interface Shot {
  /** 1-based, as a shot list reads. */
  index: number;
  start: number;
  end: number;
  duration: number;
}

export interface DetectShotsOptions {
  videoPath: string;
  threshold: number;
  minShotSeconds: number;
  /** Timeline to cover: the given range, or the whole file. */
  span: TimeRange;
  range?: TimeRange | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((percent: number) => void) | undefined;
}

/**
 * Turn cut times into contiguous shots covering the span. A cut too close to
 * the previous one is ignored, so a flash or a single stray frame does not
 * count as a shot; a too-short tail joins the shot before it.
 */
export function buildShots(
  cuts: number[],
  span: TimeRange,
  minShotSeconds: number,
): Shot[] {
  const boundaries = [span.start];

  for (const cut of [...cuts].sort((a, b) => a - b)) {
    const previous = boundaries[boundaries.length - 1] ?? span.start;
    if (cut > previous && cut < span.end && cut - previous >= minShotSeconds) {
      boundaries.push(cut);
    }
  }

  const last = boundaries[boundaries.length - 1] ?? span.start;
  if (boundaries.length > 1 && span.end - last < minShotSeconds) {
    boundaries.pop();
  }

  return boundaries.map((start, i) => {
    const end = boundaries[i + 1] ?? span.end;
    return { index: i + 1, start, end, duration: end - start };
  });
}

/** Find shot boundaries with FFmpeg's scene score. Decodes the whole span. */
export async function detectShots(opts: DetectShotsOptions): Promise<Shot[]> {
  const offset = opts.range?.start ?? 0;
  const cuts: number[] = [];

  const filter = [
    `scale=${DETECT_WIDTH}:-2`,
    `select='gt(scene,${opts.threshold})'`,
    "metadata=mode=print:file=-",
  ].join(",");

  try {
    await runFfmpeg(
      [
        ...rangeInputArgs(opts.range),
        "-i", opts.videoPath,
        "-vf", filter,
        "-fps_mode", "passthrough",
        "-an",
        "-sn",
        "-f", "null",
        "-",
      ],
      {
        signal: opts.signal,
        durationSeconds: opts.span.end - opts.span.start,
        onProgress: opts.onProgress,
        onStdoutLine: (line) => {
          const pts = parsePtsLine(line);
          if (pts !== null) cuts.push(pts + offset);
        },
      },
    );
  } catch (err) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    const message = err instanceof Error ? err.message : String(err);
    throw new ProcessingError(`Shot detection failed: ${message}`);
  }

  return buildShots(cuts, opts.span, opts.minShotSeconds);
}

export interface ShotFrameTarget {
  shot: number;
  position: FramePosition;
  /** Where to seek, in seconds. */
  time: number;
}

/** Decide which instants to capture, skipping positions that land together. */
export function planShotFrames(
  shots: Shot[],
  positions: FramePosition[],
  frameInterval: number,
): ShotFrameTarget[] {
  const order: FramePosition[] = ["first", "middle", "last"];
  const wanted = order.filter((position) => positions.includes(position));
  const targets: ShotFrameTarget[] = [];

  for (const shot of shots) {
    const times: Record<FramePosition, number> = {
      first: shot.start,
      middle: shot.start + shot.duration / 2,
      last: Math.max(shot.start, shot.end - frameInterval),
    };

    let previous: number | null = null;
    for (const position of wanted) {
      const time = times[position];
      if (previous !== null && time - previous < frameInterval) continue;
      targets.push({ shot: shot.index, position, time });
      previous = time;
    }
  }

  return targets;
}

export interface ShotFrame {
  file: string;
  time: number;
  shot: number;
  position: FramePosition;
}

export interface ShotFramesOptions {
  videoPath: string;
  outputDir: string;
  targets: ShotFrameTarget[];
  preset: ResolvedPreset;
  signal?: AbortSignal | undefined;
  onProgress?: ((percent: number) => void) | undefined;
}

function frameFilter(preset: ResolvedPreset): string {
  return [
    PRINT_PTS_FILTER,
    ...(preset.width !== null ? [`scale=${preset.width}:-2`] : []),
  ].join(",");
}

/** Grab one frame at a time. Returns its true time, or null if none was there. */
async function grabFrame(
  videoPath: string,
  seek: number,
  outputPath: string,
  preset: ResolvedPreset,
  signal: AbortSignal | undefined,
): Promise<number | null> {
  const start = Math.max(0, seek - SEEK_LEAD_SECONDS);
  let pts: number | null = null;

  await runFfmpeg(
    [
      "-ss", String(start),
      "-i", videoPath,
      "-vf", frameFilter(preset),
      "-frames:v", "1",
      "-fps_mode", "passthrough",
      "-an",
      "-y",
      ...(preset.format === "jpeg" && preset.quality !== null
        ? ["-q:v", String(qualityToQscale(preset.quality))]
        : []),
      outputPath,
    ],
    {
      signal,
      onStdoutLine: (line) => {
        pts ??= parsePtsLine(line);
      },
    },
  );

  return pts === null ? null : start + pts;
}

/**
 * Seek to each target. A single pass over the film would need a filter
 * expression as long as the shot list, evaluated for every decoded frame.
 */
export async function extractShotFrames(
  opts: ShotFramesOptions,
): Promise<ShotFrame[]> {
  await mkdir(opts.outputDir, { recursive: true });

  const ext = opts.preset.format === "png" ? "png" : "jpg";
  const results: Array<ShotFrame | null> = opts.targets.map(() => null);
  let nextTarget = 0;
  let finished = 0;

  const worker = async (): Promise<void> => {
    while (nextTarget < opts.targets.length) {
      const index = nextTarget++;
      const target = opts.targets[index]!;
      const name = `frame_${String(index + 1).padStart(4, "0")}.${ext}`;
      const file = join(opts.outputDir, name);

      try {
        // The container's duration can run past the last frame, so the end of
        // the final shot may have nothing to land on. Step back once if so.
        const time =
          (await grabFrame(opts.videoPath, target.time, file, opts.preset, opts.signal)) ??
          (await grabFrame(
            opts.videoPath,
            Math.max(0, target.time - 1),
            file,
            opts.preset,
            opts.signal,
          ));

        if (time !== null) {
          results[index] = {
            file,
            time,
            shot: target.shot,
            position: target.position,
          };
        }
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        const message = err instanceof Error ? err.message : String(err);
        throw new ProcessingError(`Shot frame extraction failed: ${message}`);
      }

      finished += 1;
      opts.onProgress?.((finished / opts.targets.length) * 100);
    }
  };

  const workers = Math.min(MAX_FRAME_WORKERS, availableParallelism());
  await Promise.all(Array.from({ length: workers }, worker));

  return results.filter((frame): frame is ShotFrame => frame !== null);
}
