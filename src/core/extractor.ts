import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ProcessingError } from "../utils/errors.js";
import { execFileAsync } from "../utils/exec.js";
import type { ResolvedPreset } from "./presets.js";
import { qualityToQscale } from "./presets.js";

export interface ExtractionOptions {
  videoPath: string;
  outputDir: string;
  fps: number;
  preset: ResolvedPreset;
}

export interface ExtractionResult {
  frameFiles: string[];
  frameCount: number;
}

/**
 * Build the FFmpeg video filter string for frame extraction.
 */
export function buildVideoFilter(fps: number, preset: ResolvedPreset): string {
  const filters: string[] = [`fps=${fps}`];

  if (preset.width !== null) {
    // -2 keeps aspect ratio with even dimensions (required by many codecs)
    filters.push(`scale=${preset.width}:-2`);
  }

  return filters.join(",");
}

/**
 * Build the full FFmpeg argument array for frame extraction.
 */
export function buildFfmpegArgs(opts: ExtractionOptions): string[] {
  const ext = opts.preset.format === "png" ? "png" : "jpg";
  const outputPattern = join(opts.outputDir, `frame_%04d.${ext}`);

  const args: string[] = [
    "-i", opts.videoPath,
    "-vf", buildVideoFilter(opts.fps, opts.preset),
  ];

  // JPEG quality
  if (opts.preset.format === "jpeg" && opts.preset.quality !== null) {
    args.push("-q:v", String(qualityToQscale(opts.preset.quality)));
  }

  args.push(outputPattern);

  return args;
}

/**
 * Extract frames from a video using FFmpeg.
 */
export async function extractFrames(
  opts: ExtractionOptions,
): Promise<ExtractionResult> {
  await mkdir(opts.outputDir, { recursive: true });

  const args = buildFfmpegArgs(opts);

  try {
    await execFileAsync("ffmpeg", args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ProcessingError(`FFmpeg extraction failed: ${message}`);
  }

  const entries = await readdir(opts.outputDir);
  const frameFiles = entries
    .filter((f) => f.startsWith("frame_"))
    .sort()
    .map((f) => join(opts.outputDir, f));

  return {
    frameFiles,
    frameCount: frameFiles.length,
  };
}
