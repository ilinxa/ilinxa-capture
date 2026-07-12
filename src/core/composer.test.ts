import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  modeToGrid,
  formatTimestamp,
  composeGrid,
} from "./composer.js";
import type { CompositionOptions } from "./composer.js";

// Mock sharp
vi.mock("sharp", () => {
  const mockSharpInstance = {
    metadata: vi.fn().mockResolvedValue({ width: 1024, height: 768 }),
    composite: vi.fn().mockReturnThis(),
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

describe("formatTimestamp", () => {
  it("formats frame 0 at 5fps as 00:00.000", () => {
    expect(formatTimestamp(0, 5)).toBe("00:00.000");
  });

  it("formats frame 1 at 5fps as 00:00.200", () => {
    expect(formatTimestamp(1, 5)).toBe("00:00.200");
  });

  it("formats frame 150 at 5fps as 00:30.000", () => {
    expect(formatTimestamp(150, 5)).toBe("00:30.000");
  });

  it("formats frame 300 at 5fps as 01:00.000", () => {
    expect(formatTimestamp(300, 5)).toBe("01:00.000");
  });

  it("formats frame 7 at 2fps as 00:03.500", () => {
    expect(formatTimestamp(7, 2)).toBe("00:03.500");
  });
});

describe("composeGrid", () => {
  const baseOpts: CompositionOptions = {
    frameFiles: [
      "/data/jobs/cap_test/frames/frame_0001.jpg",
      "/data/jobs/cap_test/frames/frame_0002.jpg",
      "/data/jobs/cap_test/frames/frame_0003.jpg",
      "/data/jobs/cap_test/frames/frame_0004.jpg",
    ],
    outputDir: "/data/jobs/cap_test/sheets",
    mode: 4,
    overlays: { frameNumber: false, timestamp: false },
    fps: 5,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset sharp mock to return chainable instance
    const mockInstance = {
      metadata: vi.fn().mockResolvedValue({ width: 1024, height: 768 }),
      composite: vi.fn().mockReturnThis(),
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
        `/data/jobs/cap_test/frames/frame_${String(i + 1).padStart(4, "0")}.jpg`,
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

  it("handles PNG frame format", async () => {
    const pngFrames = baseOpts.frameFiles.map((f) =>
      f.replace(".jpg", ".png"),
    );

    const result = await composeGrid({ ...baseOpts, frameFiles: pngFrames });
    expect(result.sheetFiles[0]).toContain(".png");
  });

  it("throws ProcessingError on Sharp failure", async () => {
    mockSharp.mockImplementation(() => {
      throw new Error("Sharp crashed");
    });

    await expect(composeGrid(baseOpts)).rejects.toThrow(
      "Failed to read frame metadata",
    );
  });
});
