import { mkdir, stat } from "node:fs/promises";
import { execFileAsync } from "../utils/exec.js";
import { join } from "node:path";
import { ProcessingError } from "../utils/errors.js";
import { mediaInputArgs, runFfmpeg, type TimeRange } from "./ffmpeg.js";

export type AudioFormat = "wav" | "flac" | "mp3" | "m4a";

const CODECS: Record<AudioFormat, string> = {
  wav: "pcm_s16le",
  flac: "flac",
  mp3: "libmp3lame",
  m4a: "aac",
};

export interface AudioExtractionOptions {
  videoPath: string;
  outputDir: string;
  format: AudioFormat;
  /** Among audio streams only: 0 is the first audio stream. */
  stream: number;
  sampleRate?: number | undefined;
  channels?: number | undefined;
  range?: TimeRange | undefined;
  durationSeconds?: number | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((percent: number) => void) | undefined;
}

/** Highest sample rate each lossy encoder accepts. */
export const MAX_SAMPLE_RATE: Partial<Record<AudioFormat, number>> = {
  mp3: 48000,
  m4a: 96000,
};

export interface AudioExtractionResult {
  file: string;
  sizeBytes: number;
  /** As written, which encoders may change from what was asked. */
  sampleRate: number;
  channels: number;
  duration: number;
}

export function buildAudioArgs(
  opts: AudioExtractionOptions,
  outputPath: string,
): string[] {
  return [
    ...mediaInputArgs(opts.videoPath, opts.range),
    "-map", `0:a:${opts.stream}`,
    "-vn",
    "-sn",
    "-dn",
    // A track can start after the video does. Without this, formats that have
    // no start time drop the delay, and speech lands early against the frames.
    "-af", "aresample=async=1:first_pts=0",
    "-c:a", CODECS[opts.format],
    ...(opts.sampleRate !== undefined ? ["-ar", String(opts.sampleRate)] : []),
    ...(opts.channels !== undefined ? ["-ac", String(opts.channels)] : []),
    "-y",
    outputPath,
  ];
}

/** Export one audio track of a local file for separate speech or music models. */
export async function extractAudio(
  opts: AudioExtractionOptions,
): Promise<AudioExtractionResult> {
  await mkdir(opts.outputDir, { recursive: true });
  const file = join(opts.outputDir, `audio.${opts.format}`);

  try {
    await runFfmpeg(buildAudioArgs(opts, file), {
      signal: opts.signal,
      durationSeconds: opts.durationSeconds,
      onProgress: opts.onProgress,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    const message = err instanceof Error ? err.message : String(err);
    throw new ProcessingError(`Audio extraction failed: ${message}`);
  }

  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "stream=sample_rate,channels:format=duration",
      "-of", "json",
      file,
    ],
    { signal: opts.signal },
  );
  const written = JSON.parse(stdout) as {
    streams?: Array<{ sample_rate?: string; channels?: number }>;
    format?: { duration?: string };
  };
  const stream = written.streams?.[0];

  return {
    file,
    sizeBytes: (await stat(file)).size,
    sampleRate: parseInt(stream?.sample_rate ?? "0", 10),
    channels: stream?.channels ?? 0,
    duration: parseFloat(written.format?.duration ?? "0"),
  };
}
