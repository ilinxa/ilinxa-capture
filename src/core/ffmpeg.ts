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
const METADATA_FRAME_LINE = /^frame:\d+\s+pts:(-?\d+)\s/;

// Filter timestamps in microseconds, so `pts:` is an exact integer. `pts_time`
// cannot be used: FFmpeg 5.1 prints it to 6 significant digits, which is 50 ms
// out by 2h46m and moves shot boundaries from 1,000 s on.
const PTS_PER_SECOND = 1_000_000;
export const EXACT_TIMEBASE_FILTER = `settb=1/${PTS_PER_SECOND}`;

// Containers a film can arrive in. An allowlist rather than a list of what to
// refuse: FFmpeg also reads playlists, manifests and scripts that pull in other
// files, and the set of those grows with each release. Both options apply
// before the file is opened, and nested opens inherit them.
const MEDIA_FORMATS = [
  "mov",
  "matroska",
  "avi",
  "mpegts",
  "mpeg",
  "flv",
  "asf",
  "ogg",
  "mxf",
  "dv",
  "m4v",
  "h264",
  "hevc",
  "mpegvideo",
  "ivf",
].join(",");

export const MEDIA_INPUT_OPTIONS = [
  "-format_whitelist",
  MEDIA_FORMATS,
  "-protocol_whitelist",
  "file",
];

/** Input arguments for a local media file, with an optional range. */
export function mediaInputArgs(path: string, range?: TimeRange): string[] {
  return [...rangeInputArgs(range), ...MEDIA_INPUT_OPTIONS, "-i", path];
}

/** Input options selecting a range. Must precede `-i`, for fast accurate seek. */
export function rangeInputArgs(range?: TimeRange): string[] {
  if (!range) return [];
  return ["-ss", String(range.start), "-t", String(range.end - range.start)];
}

/**
 * Filter chain that prints the presentation time of every frame reaching it.
 * `metadata=print` stays silent for frames with no metadata, so one is added.
 */
export const PRINT_PTS_FILTER = `${EXACT_TIMEBASE_FILTER},metadata=mode=add:key=capture:value=1,metadata=mode=print:file=-`;

/** Parse one `metadata=print` frame line; null for any other line. */
export function parsePtsLine(line: string): number | null {
  const match = METADATA_FRAME_LINE.exec(line);
  if (!match) return null;
  return Number(match[1]) / PTS_PER_SECOND;
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
