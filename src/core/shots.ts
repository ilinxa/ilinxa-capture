import { mkdir, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { ProcessingError, ValidationError } from "../utils/errors.js";
import {
  EXACT_TIMEBASE_FILTER,
  FIRST_DECODED_FILTER,
  PRINT_PTS_FILTER,
  createFrameReader,
  mediaInputArgs,
  parsePtsLine,
  runFfmpeg,
  seekMargins,
  seekOvershot,
  seekPoint,
  trimFilter,
  type TimeRange,
} from "./ffmpeg.js";
import type { ResolvedPreset } from "./presets.js";
import { qualityToQscale } from "./presets.js";

export type FramePosition = "first" | "middle" | "last";

const MAX_FRAME_WORKERS = 4;

// Small enough for scene scoring to be fast; large enough to keep the cuts.
const DETECT_WIDTH = 320;

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
  format?: string | undefined;
  frameInterval?: number | undefined;
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
  let cuts: number[] = [];
  let frameBeforeCut = new Map<number, number>();
  let previous: number | null = null;
  let current: number | null = null;

  // Every frame passes and is scored, rather than selecting only the cuts: the
  // container's duration is not where the video ends (audio can run on), and a
  // variable frame rate leaves no way to compute the frame before a cut.
  const filter = [
    ...(opts.range
      ? [FIRST_DECODED_FILTER, trimFilter(opts.range.start, opts.range.end)]
      : [EXACT_TIMEBASE_FILTER]),
    `scale=${DETECT_WIDTH}:-2`,
    "select='gte(scene,0)'",
    "metadata=mode=print:key=lavfi.scene_score:file=-",
  ].join(",");

  const target = opts.range?.start ?? 0;
  for (const margin of opts.range ? seekMargins(opts.format) : [Infinity]) {
    const seek = opts.range ? seekPoint(target, margin) : undefined;
    cuts = [];
    frameBeforeCut = new Map();
    previous = null;
    current = null;
    let linePts: number | null = null;
    let firstDecoded: number | null = null;

    try {
      await runFfmpeg(
        [
          ...mediaInputArgs(opts.videoPath, seek),
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
              linePts = pts;
              return;
            }
            if (line.startsWith("decoded=1")) {
              firstDecoded ??= linePts;
              return;
            }

            const score = SCENE_SCORE_LINE.exec(line);
            if (score) {
              previous = current;
              current = linePts;
              if (
                Number(score[1]) > opts.threshold &&
                current !== null &&
                previous !== null
              ) {
                cuts.push(current);
                frameBeforeCut.set(current, previous);
              }
            }
          },
        },
      );
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      if (current === null && opts.range) {
        if (seek !== undefined && seek > 0) continue;
        throw new ValidationError("No video frames in the requested range");
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new ProcessingError(`Shot detection failed: ${message}`);
    }

    if (!seekOvershot(seek, firstDecoded, target, opts.frameInterval ?? 0)) break;
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
  const frameLength =
    previous === null ? (opts.frameInterval ?? 0) : lastFrame - previous;
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
  format?: string | undefined;
  frameInterval?: number | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((percent: number) => void) | undefined;
}

function frameFilter(preset: ResolvedPreset, target: number): string {
  return [
    FIRST_DECODED_FILTER,
    trimFilter(target),
    PRINT_PTS_FILTER,
    ...(preset.width !== null ? [`scale=${preset.width}:-2`] : []),
  ].join(",");
}

/** Which seek margin to try first. Shared, because a source needing a wide one needs it for every grab. */
interface SeekMemory {
  from: number;
}

/**
 * Grab one frame. Returns its true time, or null if there was none to grab:
 * some encoders fail rather than finish when no frame ever reaches them.
 */
async function grabFrame(
  target: number,
  outputPath: string,
  opts: ShotFramesOptions,
  memory: SeekMemory,
  signal: AbortSignal | undefined,
): Promise<number | null> {
  const { preset } = opts;
  const margins = seekMargins(opts.format);

  for (let attempt = memory.from; attempt < margins.length; attempt++) {
    const seek = seekPoint(target, margins[attempt]!);
    const reader = createFrameReader();

    try {
      await runFfmpeg(
        [
          ...mediaInputArgs(opts.videoPath, seek),
          "-vf", frameFilter(preset, target),
          "-frames:v", "1",
          "-fps_mode", "passthrough",
          "-an",
          "-y",
          ...(preset.format === "jpeg" && preset.quality !== null
            ? ["-q:v", String(qualityToQscale(preset.quality))]
            : []),
          outputPath,
        ],
        { signal, onStdoutLine: reader.onLine },
      );
    } catch (err) {
      if (reader.times.length > 0 || signal?.aborted) throw err;
      if (seek > 0) continue;
      return null;
    }

    if (!seekOvershot(seek, reader.firstDecoded(), target, opts.frameInterval ?? 0)) {
      const time = reader.times[0] ?? null;
      if (time !== null) memory.from = Math.max(memory.from, attempt);
      return time;
    }
  }

  return null;
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
  const memory: SeekMemory = { from: 0 };
  const tolerance = (opts.frameInterval ?? 0) / 2;
  let nextTarget = 0;
  let finished = 0;

  const worker = async (): Promise<void> => {
    while (nextTarget < opts.targets.length && !signal.aborted) {
      const index = nextTarget++;
      const target = opts.targets[index]!;
      const name = `frame_${String(index + 1).padStart(4, "0")}.${ext}`;
      const file = join(opts.outputDir, name);

      try {
        let time = await grabFrame(target.time, file, opts, memory, signal);

        // A gap in the source can carry a seek past the cut into the next shot.
        if (time === null || time > target.latest) {
          time = await grabFrame(target.latest, file, opts, memory, signal);
        }

        // No frame beats a frame of the next shot labelled as this one.
        if (time !== null && time > target.latest + tolerance) {
          await rm(file, { force: true });
          time = null;
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

  const captured = results.filter((frame): frame is ShotFrame => frame !== null);

  // Detection just decoded these shots, so nothing at all means a failure, not a gap.
  if (opts.targets.length > 0 && captured.length === 0) {
    throw new ProcessingError("Shot frame extraction failed: no frame could be read");
  }

  return captured;
}
