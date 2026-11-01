import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  cellSize,
  modeToGrid,
  overlayMetrics,
  composeGrid,
} from "./composer.js";
import type { CompositionOptions } from "./composer.js";

// Mock sharp
vi.mock("sharp", () => {
  const mockSharpInstance = {
    metadata: vi.fn().mockResolvedValue({ width: 1024, height: 768, format: "jpeg" }),
    composite: vi.fn().mockReturnThis(),
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    toFile: vi.fn().mockResolvedValue(undefined),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from("fake")),
  };

  const sharpFn = vi.fn().mockReturnValue(mockSharpInstance);
  return { default: sharpFn };
});

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
}));

import sharp from "sharp";
import { mkdir, copyFile } from "node:fs/promises";

const mockSharp = vi.mocked(sharp);
const mockMkdir = vi.mocked(mkdir);
const mockCopyFile = vi.mocked(copyFile);

/** Make sharp report these formats for frames, in order; the last one repeats. */
function framesReadAs(metas: Array<Record<string, unknown>>): void {
  const metadata = vi.fn().mockResolvedValue(metas[metas.length - 1]);
  for (const meta of metas) metadata.mockResolvedValueOnce(meta);

  const instance = {
    metadata,
    composite: vi.fn().mockReturnThis(),
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    toFile: vi.fn().mockResolvedValue(undefined),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from("fake")),
  };
  mockSharp.mockImplementation(
    () => instance as unknown as ReturnType<typeof sharp>,
  );
}

describe("modeToGrid", () => {
  it("returns 1x1 for mode 1", () => {
    expect(modeToGrid(1)).toEqual({ cols: 1, rows: 1 });
  });

  it("returns 2x2 for mode 4", () => {
    expect(modeToGrid(4)).toEqual({ cols: 2, rows: 2 });
  });

  it("returns 4x4 for mode 16", () => {
    expect(modeToGrid(16)).toEqual({ cols: 4, rows: 4 });
  });
});

describe("cellSize", () => {
  it("keeps frames as they are with no limit", () => {
    expect(cellSize(1024, 576, 4, 4, 0)).toEqual({ width: 1024, height: 576 });
  });

  it("fits a 4x4 llm sheet inside the limit", () => {
    const cell = cellSize(1024, 576, 4, 4, 2000);
    expect(cell.width * 4).toBeLessThanOrEqual(2000);
    expect(cell.height * 4).toBeLessThanOrEqual(2000);
    expect(cell.width).toBe(500);
  });

  it("is bound by height for portrait video", () => {
    const cell = cellSize(576, 1024, 4, 4, 2000);
    expect(cell.height * 4).toBeLessThanOrEqual(2000);
  });

  it("never enlarges a frame", () => {
    expect(cellSize(320, 240, 2, 2, 2000)).toEqual({ width: 320, height: 240 });
  });
});

describe("overlayMetrics", () => {
  it("grows with the frame", () => {
    const small = overlayMetrics(500, 281, 20);
    const large = overlayMetrics(1920, 1080, 20);
    expect(large.fontSize).toBeGreaterThan(small.fontSize);
    expect(large.barHeight).toBeGreaterThan(small.barHeight);
  });

  it("stays legible on a shrunken 4x4 cell", () => {
    expect(overlayMetrics(500, 281, 22).fontSize).toBeGreaterThanOrEqual(12);
  });

  it("keeps a long label inside a narrow frame", () => {
    const text = "Shot 123 · Frame 12345 · 01:02:03.456";
    const { fontSize } = overlayMetrics(240, 135, text.length);
    expect(fontSize * 0.62 * text.length).toBeLessThanOrEqual(240 - 16);
  });

  it("keeps the bar a small share of the frame", () => {
    const { barHeight } = overlayMetrics(1024, 576, 20);
    expect(barHeight / 576).toBeLessThan(0.1);
  });
});

describe("composeGrid", () => {
  const baseOpts: CompositionOptions = {
    frameFiles: [
      "/data/jobs/cap_0000beef/frames/frame_0001.jpg",
      "/data/jobs/cap_0000beef/frames/frame_0002.jpg",
      "/data/jobs/cap_0000beef/frames/frame_0003.jpg",
      "/data/jobs/cap_0000beef/frames/frame_0004.jpg",
    ],
    outputDir: "/data/jobs/cap_0000beef/sheets",
    mode: 4,
    overlays: { frameNumber: false, timestamp: false },
    fps: 5,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset sharp mock to return chainable instance
    const mockInstance = {
      metadata: vi.fn().mockResolvedValue({ width: 1024, height: 768, format: "jpeg" }),
      composite: vi.fn().mockReturnThis(),
      resize: vi.fn().mockReturnThis(),
      jpeg: vi.fn().mockReturnThis(),
      png: vi.fn().mockReturnThis(),
      toFile: vi.fn().mockResolvedValue(undefined),
      toBuffer: vi.fn().mockResolvedValue(Buffer.from("fake")),
    };
    mockSharp.mockReturnValue(mockInstance as unknown as sharp.Sharp);
  });

  it("creates output directory", async () => {
    await composeGrid(baseOpts);
    expect(mockMkdir).toHaveBeenCalledWith(baseOpts.outputDir, {
      recursive: true,
    });
  });

  it("produces 1 sheet for 4 frames in mode 4", async () => {
    const result = await composeGrid(baseOpts);
    expect(result.sheetCount).toBe(1);
    expect(result.sheetFiles).toHaveLength(1);
    expect(result.sheetFiles[0]).toContain("sheet_001.jpg");
  });

  it("produces correct number of sheets for 10 frames in mode 4", async () => {
    const tenFrames = Array.from(
      { length: 10 },
      (_, i) =>
        `/data/jobs/cap_0000beef/frames/frame_${String(i + 1).padStart(4, "0")}.jpg`,
    );

    const result = await composeGrid({ ...baseOpts, frameFiles: tenFrames });
    // 10 frames / 4 per sheet = 3 sheets (4+4+2)
    expect(result.sheetCount).toBe(3);
    expect(result.sheetFiles).toHaveLength(3);
  });

  it("returns correct grid label", async () => {
    const result4 = await composeGrid({ ...baseOpts, mode: 4 });
    expect(result4.grid).toBe("2x2");

    const result16 = await composeGrid({ ...baseOpts, mode: 16 });
    expect(result16.grid).toBe("4x4");

    const result1 = await composeGrid({ ...baseOpts, mode: 1 });
    expect(result1.grid).toBe("1x1");
  });

  it("uses copyFile for mode 1 without overlays", async () => {
    await composeGrid({
      ...baseOpts,
      mode: 1,
      overlays: { frameNumber: false, timestamp: false },
    });

    expect(mockCopyFile).toHaveBeenCalledTimes(4);
  });

  it("does not use copyFile for mode 1 with overlays", async () => {
    await composeGrid({
      ...baseOpts,
      mode: 1,
      overlays: { frameNumber: true, timestamp: false },
    });

    // Should use Sharp composite, not copyFile
    expect(mockCopyFile).not.toHaveBeenCalled();
  });

  it("creates canvas for grid mode (mode 4)", async () => {
    await composeGrid(baseOpts);

    // sharp() should be called with create options for the canvas
    const createCall = mockSharp.mock.calls.find(
      (call) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        "create" in (call[0] as Record<string, unknown>),
    );
    expect(createCall).toBeDefined();
  });

  it("names the sheet from the image format, not the file name", async () => {
    framesReadAs([{ width: 1024, height: 768, format: "png" }]);

    const result = await composeGrid({
      ...baseOpts,
      frameFiles: ["/frames/looks-like.jpg"],
    });
    expect(result.sheetFiles[0]).toContain(".png");
  });

  it("refuses an unreadable file as the first frame", async () => {
    mockSharp.mockImplementation(() => {
      throw new Error("Input file contains unsupported image format");
    });

    await expect(composeGrid(baseOpts)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  // Regression: mode 1 used to check only frames[0], then copyFile the rest, so
  // any file could be read back through the file route as a "sheet".
  it.each([1, 4, 16] as const)(
    "refuses an unreadable file in any later position, in mode %i",
    async (mode) => {
      const metadata = vi
        .fn()
        .mockResolvedValueOnce({ width: 1024, height: 768, format: "jpeg" })
        .mockRejectedValueOnce(new Error("unsupported image format"));
      mockSharp.mockImplementation(
        () => ({ metadata }) as unknown as ReturnType<typeof sharp>,
      );

      await expect(
        composeGrid({
          ...baseOpts,
          mode,
          overlays: { frameNumber: false, timestamp: false },
          frameFiles: ["/frames/real.jpg", "/private/notes.txt"],
        }),
      ).rejects.toThrow("Frame 2 is not a readable image");

      expect(mockCopyFile).not.toHaveBeenCalled();
    },
  );

  it("refuses formats that are not frames, like SVG", async () => {
    framesReadAs([{ width: 100, height: 100, format: "svg" }]);

    await expect(
      composeGrid({ ...baseOpts, frameFiles: ["/x.svg"] }),
    ).rejects.toThrow("Frame 1 is not a JPEG, PNG or WebP image");
  });

  it("re-encodes in mode 1 when a frame's format differs from the sheet's", async () => {
    framesReadAs([
      { width: 100, height: 100, format: "jpeg" },
      { width: 100, height: 100, format: "png" },
    ]);

    await composeGrid({
      ...baseOpts,
      mode: 1,
      overlays: { frameNumber: false, timestamp: false },
      frameFiles: ["/a.jpg", "/b.png"],
    });

    expect(mockCopyFile).toHaveBeenCalledTimes(1);
  });

  it("reports which frames each sheet holds", async () => {
    const result = await composeGrid({
      ...baseOpts,
      frameFiles: Array.from({ length: 6 }, (_, i) => `/f/frame_${i}.jpg`),
    });

    expect(result.sheets).toEqual([
      { file: "sheet_001.jpg", frames: [0, 1, 2, 3] },
      { file: "sheet_002.jpg", frames: [4, 5] },
    ]);
  });

  it("stops between sheets when aborted", async () => {
    const reason = new Error("timed out");
    await expect(
      composeGrid({ ...baseOpts, signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
  });
});
