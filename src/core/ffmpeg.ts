import { execFileAsync } from "../utils/exec.js";

/** A span of the source timeline, in seconds. */
export interface TimeRange {
  start: number;
  end: number;
}

export interface FfmpegRunOptions {
  signal?: AbortSignal;
  /** Seconds of media this run covers; enables percent progress. */
  durationSeconds?: number;
  onProgress?: (percent: number) => void;
  onStdoutLine?: (line: string) => void;
}

// `-progress pipe:2` is machine-readable and bounded, unlike the stats line.
const BASE_ARGS = [
  "-hide_banner",
  "-nostdin",
  "-nostats",
  "-loglevel",
  "error",
  "-progress",
  "pipe:2",
];

const PROGRESS_LINE = /^[a-z0-9_]+=/;
const OUT_TIME_LINE = /^out_time_us=(\d+)$/;
const METADATA_FRAME_LINE = /^frame:\d+\s+pts:\S+\s+pts_time:(\S+)/;

/** Input options selecting a range. Must precede `-i`, for fast accurate seek. */
export function rangeInputArgs(range?: TimeRange): string[] {
  if (!range) return [];
  return ["-ss", String(range.start), "-t", String(range.end - range.start)];
}

/**
 * Filter chain that prints the presentation time of every frame reaching it.
 * `metadata=print` stays silent for frames with no metadata, so one is added.
 */
export const PRINT_PTS_FILTER =
  "metadata=mode=add:key=capture:value=1,metadata=mode=print:file=-";

/** Parse one `metadata=print` frame line; null for any other line. */
export function parsePtsLine(line: string): number | null {
  const match = METADATA_FRAME_LINE.exec(line);
  if (!match) return null;
  const pts = Number(match[1]);
  return Number.isFinite(pts) ? pts : null;
}

/** Run ffmpeg quietly, reporting progress and keeping only an error tail. */
export async function runFfmpeg(
  args: string[],
  opts: FfmpegRunOptions = {},
): Promise<void> {
  const { durationSeconds, onProgress } = opts;

  await execFileAsync("ffmpeg", [...BASE_ARGS, ...args], {
    signal: opts.signal,
    onStdoutLine: opts.onStdoutLine ?? (() => {}),
    onStderrLine: (line) => {
      if (!PROGRESS_LINE.test(line)) return false;

      const match = OUT_TIME_LINE.exec(line);
      if (match && onProgress && durationSeconds && durationSeconds > 0) {
        const seconds = Number(match[1]) / 1_000_000;
        onProgress(Math.min(100, (seconds / durationSeconds) * 100));
      }
      return true;
    },
  });
}
