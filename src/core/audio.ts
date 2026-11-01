import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ProcessingError } from "../utils/errors.js";
import { rangeInputArgs, runFfmpeg, type TimeRange } from "./ffmpeg.js";

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

export interface AudioExtractionResult {
  file: string;
  sizeBytes: number;
}

export function buildAudioArgs(
  opts: AudioExtractionOptions,
  outputPath: string,
): string[] {
  return [
    ...rangeInputArgs(opts.range),
    "-i", opts.videoPath,
    "-map", `0:a:${opts.stream}`,
    "-vn",
    "-sn",
    "-dn",
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

  return { file, sizeBytes: (await stat(file)).size };
}
