import { basename } from "node:path";
import { ProcessingError, UnsupportedFormatError } from "../utils/errors.js";
import { execFileAsync } from "../utils/exec.js";
import {
  MEDIA_INPUT_OPTIONS,
  PRINT_PTS_FILTER,
  mediaInputArgs,
  parsePtsLine,
  runFfmpeg,
} from "./ffmpeg.js";

export interface AudioStream {
  /** Among audio streams only: 0 is the first audio stream. */
  index: number;
  codec: string;
  channels: number;
  sample_rate: number;
  language: string | null;
  title: string | null;
}

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  size_bytes: number;
  format: string;
  audio_streams: AudioStream[];
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  duration?: string;
  channels?: number;
  sample_rate?: string;
  tags?: { language?: string; title?: string };
}

interface FfprobeFormat {
  duration?: string;
  size?: string;
  format_name?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

/**
 * Parse an ffprobe frame rate fraction string (e.g. "30000/1001") to a decimal number.
 */
export function parseFps(rFrameRate: string | undefined): number {
  if (!rFrameRate) return 0;

  const parts = rFrameRate.split("/");
  if (parts.length !== 2) return parseFloat(rFrameRate) || 0;

  const numerator = parseFloat(parts[0] ?? "0");
  const denominator = parseFloat(parts[1] ?? "1");

  if (denominator === 0) return 0;

  return Math.round((numerator / denominator) * 100) / 100;
}

/**
 * Duration of a file whose container does not state one, such as a piped MKV.
 * Reads packets rather than decoding, so it takes seconds even on a film.
 */
async function measureDuration(
  source: string,
  signal: AbortSignal | undefined,
): Promise<number> {
  let last = 0;
  await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      ...MEDIA_INPUT_OPTIONS,
      "-select_streams", "v:0",
      "-show_entries", "packet=pts_time",
      "-of", "csv=p=0",
      source,
    ],
    {
      signal,
      onStdoutLine: (line) => {
        const pts = parseFloat(line);
        if (pts > last) last = pts;
      },
    },
  );
  return last;
}

/**
 * Duration and rate of a raw stream. Its packets have no timestamps, and ffprobe
 * reports 25 or double the real rate depending on the version, but the decoder
 * paces frames from the stream's own headers.
 */
async function measureByDecoding(
  source: string,
  signal: AbortSignal | undefined,
): Promise<{ duration: number; fps: number }> {
  let frames = 0;
  let first = 0;
  let last = 0;

  await runFfmpeg(
    [
      ...mediaInputArgs(source),
      "-vf", PRINT_PTS_FILTER,
      "-fps_mode", "passthrough",
      "-an",
      "-sn",
      "-f", "null",
      "-",
    ],
    {
      ...(signal ? { signal } : {}),
      onStdoutLine: (line) => {
        const pts = parsePtsLine(line);
        if (pts === null) return;
        if (frames === 0) first = pts;
        last = pts;
        frames += 1;
      },
    },
  );

  if (last <= first) return { duration: 0, fps: 0 };
  const fps = (frames - 1) / (last - first);
  return { duration: frames / fps, fps: Math.round(fps * 100) / 100 };
}

/** The reason a file could not be read, for a caller to act on. */
function readFailure(
  err: unknown,
  source: string,
  signal: AbortSignal | undefined,
): unknown {
  if (signal?.aborted) return signal.reason;

  const message = err instanceof Error ? err.message : String(err);
  // The tool itself is missing, which is no fault of the file.
  if ((err as { code?: unknown }).code === "ENOENT") {
    return new ProcessingError(`ffprobe failed: ${message}`);
  }

  // An upload's name is a temp file's, so the file's own errors drop it.
  const reason = message
    .split(`${source}: `)
    .join("")
    .split(source)
    .join(basename(source))
    .split("\n")
    .pop()
    ?.replace(/^\S+ exited with [^:]+: /, "");
  return new UnsupportedFormatError(
    `Not a readable video: ${reason}. Containers read: MP4, MOV, MKV, WebM, AVI, ` +
      "MPEG-TS, MPEG-PS, FLV, WMV, Ogg, MXF, DV, IVF, and raw H.264, HEVC or MPEG video",
  );
}

/**
 * Extract video metadata using ffprobe.
 * Accepts a local file path or a direct HTTP/HTTPS URL.
 */
export async function getVideoMetadata(
  source: string,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<VideoMetadata> {
  let stdout: string;

  try {
    const result = await execFileAsync(
      "ffprobe",
      [
        "-v", "error",
        ...MEDIA_INPUT_OPTIONS,
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        source,
      ],
      { signal: opts.signal },
    );
    stdout = result.stdout;
  } catch (err) {
    throw readFailure(err, source, opts.signal);
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new ProcessingError("ffprobe returned invalid JSON");
  }

  const videoStream = parsed.streams?.find((s) => s.codec_type === "video");
  if (!videoStream) {
    throw new UnsupportedFormatError("No video stream found in file");
  }

  const format = parsed.format;
  if (!format) {
    throw new ProcessingError("No format information found in file");
  }

  let duration = parseFloat(format.duration ?? videoStream.duration ?? "0");
  let fps = parseFps(videoStream.r_frame_rate);

  try {
    if (!(duration > 0)) duration = await measureDuration(source, opts.signal);
    if (!(duration > 0)) {
      const decoded = await measureByDecoding(source, opts.signal);
      duration = decoded.duration;
      if (decoded.fps > 0) fps = decoded.fps;
    }
  } catch (err) {
    throw readFailure(err, source, opts.signal);
  }

  const sizeBytes = parseInt(format.size ?? "0", 10);

  // format_name can be comma-separated (e.g. "mov,mp4,m4a,3gp,3g2,mj2") — take the first
  const formatName = format.format_name?.split(",")[0] ?? "unknown";

  return {
    duration,
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    fps,
    codec: videoStream.codec_name ?? "unknown",
    size_bytes: sizeBytes,
    format: formatName,
    audio_streams: (parsed.streams ?? [])
      .filter((s) => s.codec_type === "audio")
      .map((s, index) => ({
        index,
        codec: s.codec_name ?? "unknown",
        channels: s.channels ?? 0,
        sample_rate: parseInt(s.sample_rate ?? "0", 10),
        language: s.tags?.language ?? null,
        title: s.tags?.title ?? null,
      })),
  };
}
