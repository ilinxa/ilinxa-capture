import { ProcessingError } from "../utils/errors.js";
import { execFileAsync } from "../utils/exec.js";
import { MEDIA_INPUT_OPTIONS } from "./ffmpeg.js";

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
    if (opts.signal?.aborted) throw opts.signal.reason;
    const message = err instanceof Error ? err.message : String(err);
    throw new ProcessingError(`ffprobe failed: ${message}`);
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new ProcessingError("ffprobe returned invalid JSON");
  }

  const videoStream = parsed.streams?.find((s) => s.codec_type === "video");
  if (!videoStream) {
    throw new ProcessingError("No video stream found in file");
  }

  const format = parsed.format;
  if (!format) {
    throw new ProcessingError("No format information found in file");
  }

  const stated = parseFloat(format.duration ?? videoStream.duration ?? "0");
  const duration =
    stated > 0 ? stated : await measureDuration(source, opts.signal);
  const sizeBytes = parseInt(format.size ?? "0", 10);

  // format_name can be comma-separated (e.g. "mov,mp4,m4a,3gp,3g2,mj2") — take the first
  const formatName = format.format_name?.split(",")[0] ?? "unknown";

  return {
    duration,
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    fps: parseFps(videoStream.r_frame_rate),
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
