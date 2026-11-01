import sharp, { type Metadata, type OverlayOptions } from "sharp";
import { copyFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { ProcessingError, ValidationError } from "../utils/errors.js";
import { formatTimestamp } from "./timecode.js";

const FRAME_FORMATS = new Set(["jpeg", "png", "webp"]);
const VALIDATE_CONCURRENCY = 8;

export interface FrameLabel {
  /** Source time in seconds. */
  time: number;
  shot?: number | undefined;
}

export interface CompositionOptions {
  frameFiles: string[];
  outputDir: string;
  mode: 1 | 4 | 16;
  overlays: {
    frameNumber: boolean;
    timestamp: boolean;
  };
  /** Used for timestamp labels only where a frame has no entry in `labels`. */
  fps: number;
  /** Parallel to frameFiles. */
  labels?: Array<FrameLabel | undefined> | undefined;
  /** Longest sheet edge in pixels for grid modes. 0 or absent means no limit. */
  maxSheetEdge?: number | undefined;
  /** Frames this service wrote itself, which can be read in parallel. */
  trustedFrames?: boolean | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((percent: number) => void) | undefined;
}

export interface ComposedSheet {
  file: string;
  /** Indexes into frameFiles. */
  frames: number[];
}

export interface CompositionResult {
  sheetFiles: string[];
  sheetCount: number;
  mode: 1 | 4 | 16;
  grid: string;
  sheets: ComposedSheet[];
}

interface FrameInfo {
  path: string;
  width: number;
  height: number;
  format: string;
}

export function modeToGrid(mode: 1 | 4 | 16): { cols: number; rows: number } {
  switch (mode) {
    case 1:
      return { cols: 1, rows: 1 };
    case 4:
      return { cols: 2, rows: 2 };
    case 16:
      return { cols: 4, rows: 4 };
  }
}

/** Frame size in a grid: at most the source size, and fitting the edge limit. */
export function cellSize(
  frameWidth: number,
  frameHeight: number,
  cols: number,
  rows: number,
  maxSheetEdge: number,
): { width: number; height: number } {
  if (maxSheetEdge <= 0) return { width: frameWidth, height: frameHeight };

  const scale = Math.min(
    1,
    maxSheetEdge / (cols * frameWidth),
    maxSheetEdge / (rows * frameHeight),
  );
  return {
    width: Math.max(1, Math.floor(frameWidth * scale)),
    height: Math.max(1, Math.floor(frameHeight * scale)),
  };
}

/** Label size for a frame: follows its height, and always fits its width. */
export function overlayMetrics(
  width: number,
  height: number,
  textLength: number,
): { fontSize: number; barHeight: number } {
  const byHeight = Math.max(12, Math.round(height * 0.035));
  const byWidth = Math.floor((width - 16) / (Math.max(1, textLength) * 0.62));
  const fontSize = Math.max(8, Math.min(byHeight, byWidth, 48));
  return { fontSize, barHeight: Math.round(fontSize * 1.7) };
}

function buildOverlayText(
  index: number,
  fps: number,
  overlays: CompositionOptions["overlays"],
  label: FrameLabel | undefined,
): string {
  const parts: string[] = [];
  if (label?.shot !== undefined) {
    parts.push(`Shot ${label.shot}`);
  }
  if (overlays.frameNumber) {
    parts.push(`Frame ${index + 1}`);
  }
  if (overlays.timestamp) {
    parts.push(formatTimestamp(label?.time ?? index / fps));
  }
  return parts.join(" · ");
}

function buildOverlaySvg(width: number, height: number, text: string): string {
  const { fontSize, barHeight } = overlayMetrics(width, height, text.length);
  const y = height - barHeight;
  const baseline = height - Math.round((barHeight - fontSize) / 2) - 2;

  return [
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`,
    `  <rect x="0" y="${y}" width="${width}" height="${barHeight}" fill="rgba(0,0,0,0.6)"/>`,
    `  <text x="8" y="${baseline}" fill="white" font-size="${fontSize}" font-family="monospace">${text}</text>`,
    `</svg>`,
  ].join("");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Read every frame as an image before anything is written. Frame paths can come
 * from a caller, and a sheet is served back to them, so nothing but a real image
 * may reach the output, in any mode.
 */
async function inspectFrames(
  files: string[],
  trusted: boolean,
  signal: AbortSignal | undefined,
): Promise<FrameInfo[]> {
  const inspect = async (path: string, index: number): Promise<FrameInfo> => {
    let meta: Metadata;
    try {
      meta = await sharp(path).metadata();
    } catch {
      throw new ValidationError(`Frame ${index + 1} is not a readable image`);
    }

    const { width, height, format } = meta;
    if (!width || !height || !format || !FRAME_FORMATS.has(format)) {
      throw new ValidationError(
        `Frame ${index + 1} is not a JPEG, PNG or WebP image`,
      );
    }
    return { path, width, height, format };
  };

  // One at a time for frames from a caller: sharp can abort the whole process
  // on Windows when bad decodes run in parallel.
  const concurrency = trusted ? VALIDATE_CONCURRENCY : 1;
  const frames: FrameInfo[] = [];
  const batches = chunk(files, concurrency);
  for (let b = 0; b < batches.length; b++) {
    signal?.throwIfAborted();
    const offset = b * concurrency;
    frames.push(
      ...(await Promise.all(
        batches[b]!.map((path, i) => inspect(path, offset + i)),
      )),
    );
  }
  return frames;
}

export async function composeGrid(
  opts: CompositionOptions,
): Promise<CompositionResult> {
  await mkdir(opts.outputDir, { recursive: true });

  const { cols, rows } = modeToGrid(opts.mode);
  const framesPerSheet = cols * rows;
  const hasOverlays = opts.overlays.frameNumber || opts.overlays.timestamp;

  const frames = await inspectFrames(
    opts.frameFiles,
    opts.trustedFrames ?? false,
    opts.signal,
  );
  const first = frames[0];
  if (!first) {
    throw new ValidationError("No frames to compose");
  }

  const ext = first.format === "png" ? ".png" : ".jpg";
  const sheetFormat = first.format === "png" ? "png" : "jpeg";
  const cell = cellSize(
    first.width,
    first.height,
    cols,
    rows,
    opts.maxSheetEdge ?? 0,
  );

  const overlayText = (index: number): string =>
    buildOverlayText(index, opts.fps, opts.overlays, opts.labels?.[index]);

  const chunks = chunk(frames, framesPerSheet);
  const sheets: ComposedSheet[] = [];

  for (let sheetIdx = 0; sheetIdx < chunks.length; sheetIdx++) {
    opts.signal?.throwIfAborted();

    const sheetFrames = chunks[sheetIdx]!;
    const sheetNum = String(sheetIdx + 1).padStart(3, "0");
    const sheetPath = join(opts.outputDir, `sheet_${sheetNum}${ext}`);

    // Global frame index offset for this sheet
    const globalOffset = sheetIdx * framesPerSheet;

    try {
      if (opts.mode === 1) {
        const frame = sheetFrames[0]!;

        if (!hasOverlays && frame.format === sheetFormat) {
          // Same format, no overlay: the validated frame is the sheet
          await copyFile(frame.path, sheetPath);
        } else {
          const image = sharp(frame.path);
          const pipeline = hasOverlays
            ? image.composite([
                {
                  input: Buffer.from(
                    buildOverlaySvg(
                      frame.width,
                      frame.height,
                      overlayText(globalOffset),
                    ),
                  ),
                  top: 0,
                  left: 0,
                },
              ])
            : image;

          if (ext === ".png") {
            await pipeline.png().toFile(sheetPath);
          } else {
            await pipeline.jpeg({ quality: 90 }).toFile(sheetPath);
          }
        }
      } else {
        // Mode 4 or 16: compose grid
        const canvasWidth = cols * cell.width;
        const canvasHeight = rows * cell.height;

        const compositeInputs: OverlayOptions[] = [];

        for (let i = 0; i < sheetFrames.length; i++) {
          const frame = sheetFrames[i]!;
          const col = i % cols;
          const row = Math.floor(i / cols);
          const left = col * cell.width;
          const top = row * cell.height;
          const needsResize =
            frame.width !== cell.width || frame.height !== cell.height;

          if (!hasOverlays && !needsResize) {
            compositeInputs.push({ input: frame.path, top, left });
            continue;
          }

          // Resize first, so the label is drawn at the size it will be seen
          const resized = needsResize
            ? await sharp(frame.path)
                .resize(cell.width, cell.height, {
                  fit: "contain",
                  background: { r: 0, g: 0, b: 0 },
                })
                .png()
                .toBuffer()
            : frame.path;

          const rendered = hasOverlays
            ? await sharp(resized)
                .composite([
                  {
                    input: Buffer.from(
                      buildOverlaySvg(
                        cell.width,
                        cell.height,
                        overlayText(globalOffset + i),
                      ),
                    ),
                    top: 0,
                    left: 0,
                  },
                ])
                .png()
                .toBuffer()
            : resized;

          compositeInputs.push({ input: rendered, top, left });
        }

        const canvas = sharp({
          create: {
            width: canvasWidth,
            height: canvasHeight,
            channels: 3,
            background: { r: 0, g: 0, b: 0 },
          },
        }).composite(compositeInputs);

        if (ext === ".png") {
          await canvas.png().toFile(sheetPath);
        } else {
          await canvas.jpeg({ quality: 90 }).toFile(sheetPath);
        }
      }

      sheets.push({
        file: sheetPath,
        frames: sheetFrames.map((_, i) => globalOffset + i),
      });
      opts.onProgress?.(((sheetIdx + 1) / chunks.length) * 100);
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      if (err instanceof ProcessingError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new ProcessingError(`Grid composition failed: ${message}`);
    }
  }

  const gridLabel =
    opts.mode === 1 ? "1x1" : opts.mode === 4 ? "2x2" : "4x4";

  return {
    sheetFiles: sheets.map((sheet) => sheet.file),
    sheetCount: sheets.length,
    mode: opts.mode,
    grid: gridLabel,
    sheets: sheets.map((sheet) => ({
      file: basename(sheet.file),
      frames: sheet.frames,
    })),
  };
}
