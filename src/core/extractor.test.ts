import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildVideoFilter,
  buildFfmpegArgs,
  extractFrames,
} from "./extractor.js";
import type { ResolvedPreset } from "./presets.js";
import { qualityToQscale } from "./presets.js";

// Mock child_process and fs
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn(),
}));

import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";

const mockExecFile = vi.mocked(execFile);
const mockReaddir = vi.mocked(readdir);

describe("qualityToQscale", () => {
  it("maps 100 to 2 (best quality)", () => {
    expect(qualityToQscale(100)).toBe(2);
  });

  it("maps 80 to ~8", () => {
    expect(qualityToQscale(80)).toBe(8);
  });

  it("maps 1 to 31 (worst quality)", () => {
    expect(qualityToQscale(1)).toBe(31);
  });

  it("maps 50 to ~17", () => {
    const result = qualityToQscale(50);
    expect(result).toBeGreaterThanOrEqual(16);
    expect(result).toBeLessThanOrEqual(17);
  });
});

describe("buildVideoFilter", () => {
  it("builds fps-only filter when no width", () => {
    const preset: ResolvedPreset = { width: null, format: "png", quality: null };
    expect(buildVideoFilter(5, preset)).toBe("fps=5");
  });

  it("adds scale when width is set", () => {
    const preset: ResolvedPreset = { width: 1024, format: "jpeg", quality: 80 };
    expect(buildVideoFilter(10, preset)).toBe("fps=10,scale=1024:-2");
  });
});

describe("buildFfmpegArgs", () => {
  it("builds correct args for LLM preset", () => {
    const args = buildFfmpegArgs({
      videoPath: "/tmp/video.mp4",
      outputDir: "/output/frames",
      fps: 5,
      preset: { width: 1024, format: "jpeg", quality: 80 },
    });

    expect(args).toContain("-i");
    expect(args).toContain("/tmp/video.mp4");
    expect(args).toContain("-vf");
    expect(args).toContain("fps=5,scale=1024:-2");
    expect(args).toContain("-q:v");
    expect(args).toContain(String(qualityToQscale(80)));
    // Output pattern should be jpg
    const outputArg = args[args.length - 1];
    expect(outputArg).toMatch(/frame_%04d\.jpg$/);
  });

  it("builds correct args for HIGH preset", () => {
    const args = buildFfmpegArgs({
      videoPath: "/tmp/video.mp4",
      outputDir: "/output/frames",
      fps: 10,
      preset: { width: null, format: "png", quality: null },
    });

    expect(args).toContain("fps=10");
    expect(args).not.toContain("-q:v");
    const outputArg = args[args.length - 1];
    expect(outputArg).toMatch(/frame_%04d\.png$/);
  });

  it("builds correct args for CUSTOM preset with width", () => {
    const args = buildFfmpegArgs({
      videoPath: "/tmp/video.mp4",
      outputDir: "/output/frames",
      fps: 2,
      preset: { width: 720, format: "jpeg", quality: 60 },
    });

    expect(args).toContain("fps=2,scale=720:-2");
    expect(args).toContain("-q:v");
    expect(args).toContain(String(qualityToQscale(60)));
  });
});

describe("extractFrames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates output dir and returns frame list", async () => {
    mockExecFile.mockImplementation((_cmd, _args, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(
        null, "", "",
      );
      return undefined as never;
    });

    mockReaddir.mockResolvedValue([
      "frame_0001.jpg",
      "frame_0002.jpg",
      "frame_0003.jpg",
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    const result = await extractFrames({
      videoPath: "/tmp/video.mp4",
      outputDir: "/output/frames",
      fps: 5,
      preset: { width: 1024, format: "jpeg", quality: 80 },
    });

    expect(mkdir).toHaveBeenCalledWith("/output/frames", { recursive: true });
    expect(result.frameCount).toBe(3);
    expect(result.frameFiles).toHaveLength(3);
    expect(result.frameFiles[0]).toContain("frame_0001.jpg");
  });

  it("throws ProcessingError on FFmpeg failure", async () => {
    mockExecFile.mockImplementation((_cmd, _args, callback) => {
      (callback as (err: Error, stdout: string, stderr: string) => void)(
        new Error("FFmpeg crashed"),
        "",
        "",
      );
      return undefined as never;
    });

    await expect(
      extractFrames({
        videoPath: "/tmp/video.mp4",
        outputDir: "/output/frames",
        fps: 5,
        preset: { width: 1024, format: "jpeg", quality: 80 },
      }),
    ).rejects.toThrow("FFmpeg extraction failed");
  });

  it("filters and sorts frame files", async () => {
    mockExecFile.mockImplementation((_cmd, _args, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(
        null, "", "",
      );
      return undefined as never;
    });

    mockReaddir.mockResolvedValue([
      "frame_0003.jpg",
      "frame_0001.jpg",
      ".DS_Store",
      "frame_0002.jpg",
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    const result = await extractFrames({
      videoPath: "/tmp/video.mp4",
      outputDir: "/output/frames",
      fps: 5,
      preset: { width: 1024, format: "jpeg", quality: 80 },
    });

    expect(result.frameCount).toBe(3);
    expect(result.frameFiles[0]).toContain("frame_0001.jpg");
    expect(result.frameFiles[1]).toContain("frame_0002.jpg");
    expect(result.frameFiles[2]).toContain("frame_0003.jpg");
  });
});
