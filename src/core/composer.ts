import sharp from "sharp";
import { copyFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { ProcessingError } from "../utils/errors.js";

export interface CompositionOptions {
  frameFiles: string[];
  outputDir: string;
  mode: 1 | 4 | 16;
  overlays: {
    frameNumber: boolean;
    timestamp: boolean;
  };
  fps: number;
}

export interface CompositionResult {
  sheetFiles: string[];
  sheetCount: number;
  mode: 1 | 4 | 16;
  grid: string;
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

export function formatTimestamp(frameIndex: number, fps: number): string {
  const totalSeconds = frameIndex / fps;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  const wholeSec = Math.floor(seconds);
  const millis = Math.round((seconds - wholeSec) * 1000);

  const mm = String(minutes).padStart(2, "0");
  const ss = String(wholeSec).padStart(2, "0");
  const ms = String(millis).padStart(3, "0");

  return `${mm}:${ss}.${ms}`;
}

function buildOverlaySvg(
  width: number,
  height: number,
  frameIndex: number,
  fps: number,
  overlays: { frameNumber: boolean; timestamp: boolean },
): string {
  const parts: string[] = [];
  if (overlays.frameNumber) {
    parts.push(`Frame ${frameIndex + 1}`);
  }
  if (overlays.timestamp) {
    parts.push(formatTimestamp(frameIndex, fps));
  }

  const text = parts.join(" \u00b7 ");
  const barHeight = 30;
  const fontSize = 16;
  const y = height - barHeight;

  return [
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`,
    `  <rect x="0" y="${y}" width="${width}" height="${barHeight}" fill="rgba(0,0,0,0.6)"/>`,
    `  <text x="8" y="${height - 8}" fill="white" font-size="${fontSize}" font-family="monospace">${text}</text>`,
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

export async function composeGrid(
  opts: CompositionOptions,
): Promise<CompositionResult> {
  await mkdir(opts.outputDir, { recursive: true });

  const { cols, rows } = modeToGrid(opts.mode);
  const framesPerSheet = cols * rows;
  const hasOverlays = opts.overlays.frameNumber || opts.overlays.timestamp;

  // Detect output extension from first frame
  const ext = extname(opts.frameFiles[0] ?? ".jpg");

  // Get frame dimensions from first frame
  let frameWidth: number;
  let frameHeight: number;
  try {
    const meta = await sharp(opts.frameFiles[0]).metadata();
    frameWidth = meta.width ?? 0;
    frameHeight = meta.height ?? 0;
    if (frameWidth === 0 || frameHeight === 0) {
      throw new Error("Could not determine frame dimensions");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ProcessingError(`Failed to read frame metadata: ${message}`);
  }

  const chunks = chunk(opts.frameFiles, framesPerSheet);
  const sheetFiles: string[] = [];

  for (let sheetIdx = 0; sheetIdx < chunks.length; sheetIdx++) {
    const sheetFrames = chunks[sheetIdx]!;
    const sheetNum = String(sheetIdx + 1).padStart(3, "0");
    const sheetPath = join(opts.outputDir, `sheet_${sheetNum}${ext}`);

    // Global frame index offset for this sheet
    const globalOffset = sheetIdx * framesPerSheet;

    try {
      if (opts.mode === 1 && !hasOverlays) {
        // Mode 1, no overlays: simple copy
        await copyFile(sheetFrames[0]!, sheetPath);
      } else if (opts.mode === 1 && hasOverlays) {
        // Mode 1 with overlays: render overlay onto individual frame
        const overlayBuf = Buffer.from(
          buildOverlaySvg(
            frameWidth,
            frameHeight,
            globalOffset,
            opts.fps,
            opts.overlays,
          ),
        );

        const pipeline = sharp(sheetFrames[0]!).composite([
          { input: overlayBuf, top: 0, left: 0 },
        ]);

        if (ext === ".png") {
          await pipeline.png().toFile(sheetPath);
        } else {
          await pipeline.jpeg({ quality: 90 }).toFile(sheetPath);
        }
      } else {
        // Mode 4 or 16: compose grid
        const canvasWidth = cols * frameWidth;
        const canvasHeight = rows * frameHeight;

        const compositeInputs: sharp.OverlayOptions[] = [];

        for (let i = 0; i < sheetFrames.length; i++) {
          const col = i % cols;
          const row = Math.floor(i / cols);
          const left = col * frameWidth;
          const top = row * frameHeight;
          const globalIdx = globalOffset + i;

          if (hasOverlays) {
            // Render frame with overlay first
            const overlayBuf = Buffer.from(
              buildOverlaySvg(
                frameWidth,
                frameHeight,
                globalIdx,
                opts.fps,
                opts.overlays,
              ),
            );

            const frameBuf = await sharp(sheetFrames[i]!)
              .composite([{ input: overlayBuf, top: 0, left: 0 }])
              .toBuffer();

            compositeInputs.push({ input: frameBuf, top, left });
          } else {
            compositeInputs.push({ input: sheetFrames[i]!, top, left });
          }
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

      sheetFiles.push(sheetPath);
    } catch (err) {
      if (err instanceof ProcessingError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new ProcessingError(`Grid composition failed: ${message}`);
    }
  }

  const gridLabel =
    opts.mode === 1 ? "1x1" : opts.mode === 4 ? "2x2" : "4x4";

  return {
    sheetFiles,
    sheetCount: sheetFiles.length,
    mode: opts.mode,
    grid: gridLabel,
  };
}
