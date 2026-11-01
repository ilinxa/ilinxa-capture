import { mkdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { ProcessingError, ValidationError } from "../utils/errors.js";
import {
  EXACT_TIMEBASE_FILTER,
  MEDIA_INPUT_OPTIONS,
  PRINT_PTS_FILTER,
  mediaInputArgs,
  parsePtsLine,
  runFfmpeg,
  type TimeRange,
} from "./ffmpeg.js";
import type { ResolvedPreset } from "./presets.js";
import { qualityToQscale } from "./presets.js";

export type FramePosition = "first" | "middle" | "last";

const MAX_FRAME_WORKERS = 4;

// Small enough for scene scoring to be fast; large enough to keep the cuts.
const DETECT_WIDTH = 320;

// Times are whole microseconds, so seek a hair early to land on the wanted frame
// rather than the one after it. Far less than one frame even at 240 fps.
const SEEK_LEAD_SECONDS = 0.0005;

const SCENE_SCORE_LINE = /^lavfi\.scene_score=([\d.]+)/;

export interface Shot {
  /** 1-based, as a shot list reads. */
  index: number;
  start: number;
  end: number;
  duration: number;
  /** Time of the shot's own final frame. */
  lastFrame: number;
}

/** What the decode saw, in seconds. */
export interface DecodedTimeline {
  /** A shot's end is the time of the cut; this gives the frame before each. */
  frameBeforeCut: Map<number, number>;
  lastFrame: number;
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
  timeline?: DecodedTimeline,
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
    const next = boundaries[i + 1];
    const end = next ?? span.end;
    const lastFrame =
      next === undefined
        ? (timeline?.lastFrame ?? end)
        : (timeline?.frameBeforeCut.get(next) ?? next);
    return { index: i + 1, start, end, duration: end - start, lastFrame };
  });
}

/** Find shot boundaries with FFmpeg's scene score. Decodes the whole span. */
export async function detectShots(opts: DetectShotsOptions): Promise<Shot[]> {
  const offset = opts.range?.start ?? 0;
  const cuts: number[] = [];
  const frameBeforeCut = new Map<number, number>();
  let previous: number | null = null;
  let current: number | null = null;

  // Every frame passes and is scored, rather than selecting only the cuts: the
  // container's duration is not where the video ends (audio can run on), and a
  // variable frame rate leaves no way to compute the frame before a cut.
  const filter = [
    EXACT_TIMEBASE_FILTER,
    `scale=${DETECT_WIDTH}:-2`,
    "select='gte(scene,0)'",
    "metadata=mode=print:key=lavfi.scene_score:file=-",
  ].join(",");

  try {
    await runFfmpeg(
      [
        ...mediaInputArgs(opts.videoPath, opts.range),
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
          if (pts !== null) {
            previous = current;
            current = pts + offset;
            return;
          }

          const score = SCENE_SCORE_LINE.exec(line);
          if (
            score &&
            Number(score[1]) > opts.threshold &&
            current !== null &&
            previous !== null
          ) {
            cuts.push(current);
            frameBeforeCut.set(current, previous);
          }
        },
      },
    );
  } catch (err) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    if (current === null && opts.range) {
      throw new ValidationError("No video frames in the requested range");
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ProcessingError(`Shot detection failed: ${message}`);
  }

  if (current === null) {
    throw new ValidationError(
      opts.range
        ? "No video frames in the requested range"
        : "No video frames found",
    );
  }

  // One frame's length past the last frame is where the video really ends.
  const lastFrame: number = current;
  const frameLength = previous === null ? 0 : lastFrame - previous;
  const videoEnd = lastFrame + frameLength;

  return buildShots(
    cuts,
    { start: opts.span.start, end: Math.min(opts.span.end, videoEnd) },
    opts.minShotSeconds,
    { frameBeforeCut, lastFrame },
  );
}

export interface ShotFrameTarget {
  shot: number;
  position: FramePosition;
  /** Where to seek, in seconds. */
  time: number;
  /** The shot's final frame. A seek must not land past it. */
  latest: number;
}

/**
 * Decide which instants to capture, skipping positions that land together.
 * `last` is the real final frame, known from the decode.
 */
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
      last: Math.max(shot.start, shot.lastFrame),
    };

    let previous: number | null = null;
    for (const position of wanted) {
      const time = times[position];
      if (previous !== null && time - previous < frameInterval) continue;
      targets.push({ shot: shot.index, position, time, latest: shot.lastFrame });
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

/**
 * Grab one frame. Returns its true time, or null if there was none to grab:
 * some encoders fail rather than finish when no frame ever reaches them.
 */
async function grabFrame(
  videoPath: string,
  seek: number,
  outputPath: string,
  preset: ResolvedPreset,
  signal: AbortSignal | undefined,
): Promise<number | null> {
  const start = Math.max(0, seek - SEEK_LEAD_SECONDS);
  let pts: number | null = null;

  try {
    await runFfmpeg(
    [
      "-ss", String(start),
      ...MEDIA_INPUT_OPTIONS,
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
  } catch (err) {
    if (pts !== null || signal?.aborted) throw err;
    return null;
  }

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

  // One failure stops the other workers too: they run on the job's slot, and
  // must all be finished before that slot goes to the next job.
  const failure = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, failure.signal])
    : failure.signal;

  const ext = opts.preset.format === "png" ? "png" : "jpg";
  const results: Array<ShotFrame | null> = opts.targets.map(() => null);
  let nextTarget = 0;
  let finished = 0;

  const worker = async (): Promise<void> => {
    while (nextTarget < opts.targets.length && !signal.aborted) {
      const index = nextTarget++;
      const target = opts.targets[index]!;
      const name = `frame_${String(index + 1).padStart(4, "0")}.${ext}`;
      const file = join(opts.outputDir, name);

      try {
        let time = await grabFrame(
          opts.videoPath,
          target.time,
          file,
          opts.preset,
          signal,
        );

        // A gap in the source can carry a seek past the cut into the next shot.
        if (time === null || time > target.latest + SEEK_LEAD_SECONDS) {
          time = await grabFrame(
            opts.videoPath,
            target.latest,
            file,
            opts.preset,
            signal,
          );
        }

        if (time !== null) {
          results[index] = {
            file,
            time,
            shot: target.shot,
            position: target.position,
          };
        }
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        const message = err instanceof Error ? err.message : String(err);
        const wrapped = new ProcessingError(
          `Shot frame extraction failed: ${message}`,
        );
        failure.abort(wrapped);
        throw wrapped;
      }

      finished += 1;
      opts.onProgress?.((finished / opts.targets.length) * 100);
    }
  };

  const workers = Math.min(MAX_FRAME_WORKERS, availableParallelism());
  const outcomes = await Promise.allSettled(
    Array.from({ length: workers }, worker),
  );
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") throw outcome.reason;
  }

  return results.filter((frame): frame is ShotFrame => frame !== null);
}
