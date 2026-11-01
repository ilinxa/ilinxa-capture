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

// For writing images at the source rate: left alone, the encoder ticks at that
// rate, and MKV's millisecond timestamps round onto the same tick and fail it.
export const EXACT_ENCODER_TIMEBASE = ["-enc_time_base", `1:${PTS_PER_SECOND}`];

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

// Frames carry time on the source's own clock on every FFmpeg. Without this, the
// offset after -ss depends on the version, container and which streams are in use.
const SOURCE_CLOCK = ["-copyts", "-start_at_zero"];

/** Input arguments for a local media file, reading from `seek` if given. */
export function mediaInputArgs(path: string, seek?: number): string[] {
  // A whole-file read keeps FFmpeg's own clock: it smooths a timestamp reset, as
  // in joined TS captures, which on the source clock fails the JPEG encoder.
  if (seek === undefined) return [...MEDIA_INPUT_OPTIONS, "-i", path];
  const from = seek > 0 ? ["-noaccurate_seek", "-ss", String(seek)] : [];
  return [...SOURCE_CLOCK, ...from, ...MEDIA_INPUT_OPTIONS, "-i", path];
}

/** No timestamps to seek on: only decoding from the start is right. */
const UNSEEKABLE_FORMATS = new Set(["h264", "hevc", "mpegvideo", "m4v"]);
/** These seek by byte search, not a keyframe index, so they land past the target. */
const BYTE_SEEK_FORMATS = new Set(["mpegts", "mpeg"]);

// FFmpeg backs a seek off by up to 3/23 s for B-frames. Near the start that goes
// before the first keyframe, and the decoder starts blind and invents frames,
// which no check can see. Reading the first second instead costs nothing.
const MIN_SEEK_SECONDS = 1;

/** Where to start reading for a target, given a margin. 0 means no seek. */
export function seekPoint(target: number, margin: number): number {
  const seek = target - margin;
  return seek < MIN_SEEK_SECONDS ? 0 : seek;
}

/** Seconds to back off before a target, on each successive try. */
export function seekMargins(format: string | undefined): number[] {
  if (format !== undefined && UNSEEKABLE_FORMATS.has(format)) return [Infinity];
  const first = format !== undefined && BYTE_SEEK_FORMATS.has(format) ? 3 : 0;
  return [first, 12, 96, Infinity];
}

/**
 * Whether a run started past its target, so frames before the first decoded one
 * were never seen. Judged at the decoder, not on the first frame kept: a gap in
 * a variable frame rate source looks the same there and needs no retry. Within
 * half a frame, the landing is the frame wanted. Past that it may be the next
 * shot, and a needless retry only costs a fraction of a second.
 */
export function seekOvershot(
  seek: number | undefined,
  firstDecoded: number | null,
  target: number,
  frameInterval: number,
): boolean {
  if (seek === undefined || seek <= 0) return false;
  if (firstDecoded === null) return true;
  return firstDecoded - target >= (frameInterval > 0 ? frameInterval : 0.04) / 2;
}

/** Keeps frames in [start, end). Needs microsecond timestamps upstream. */
export function trimFilter(start: number, end?: number): string {
  const us = (t: number): number => Math.round(t * PTS_PER_SECOND);
  const stop = end === undefined ? "" : `:end_pts=${us(end)}`;
  return `trim=start_pts=${us(start)}${stop}`;
}

/**
 * Print the first frame out of the decoder, to show where a seek really landed.
 * Only that one, and unbuffered, so it comes first: each print filter holds its
 * own 32 KB buffer on stdout, so two printing every frame would interleave
 * chunks mid-line, and frame times would attach to the wrong frames.
 */
export const FIRST_DECODED_FILTER = `${EXACT_TIMEBASE_FILTER},metadata=mode=add:key=decoded:value=1,metadata=mode=print:key=decoded:file=-:direct=1:enable=not(n),metadata=mode=delete:key=decoded`;

/** Reads the frame lines of a run that uses both print filters. */
export function createFrameReader(): {
  onLine: (line: string) => void;
  times: number[];
  firstDecoded: () => number | null;
} {
  const times: number[] = [];
  let pending: number | null = null;
  let first: number | null = null;
  return {
    times,
    firstDecoded: () => first,
    onLine(line) {
      const pts = parsePtsLine(line);
      if (pts !== null) {
        pending = pts;
      } else if (line.startsWith("decoded=1")) {
        first ??= pending;
      } else if (line.startsWith("capture=1") && pending !== null) {
        times.push(pending);
      }
    },
  };
}

/** Input options selecting a range of audio. Must precede `-i`. */
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
