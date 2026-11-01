import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildVideoFilter,
  buildFfmpegArgs,
  extractFrames,
} from "./extractor.js";
import type { ResolvedPreset } from "./presets.js";
import { qualityToQscale } from "./presets.js";

// Mock child_process and fs
vi.mock("../utils/exec.js", () => ({
  execFileAsync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn(),
}));

import { execFileAsync } from "../utils/exec.js";
import { mkdir, readdir } from "node:fs/promises";

const mockExec = vi.mocked(execFileAsync);
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
  it("selects by interval and prints each frame's time, without the fps filter", () => {
    const preset: ResolvedPreset = { width: null, format: "png", quality: null };
    const filter = buildVideoFilter(5, preset);
    expect(filter).toContain("select='isnan(prev_selected_t)");
    expect(filter).toContain("floor(t*5+");
    expect(filter).toContain("metadata=mode=print:file=-");
    expect(filter).not.toMatch(/(^|,)fps=/);
    expect(filter).not.toContain("scale=");
  });

  it("adds scale when width is set", () => {
    const preset: ResolvedPreset = { width: 1024, format: "jpeg", quality: 80 };
    expect(buildVideoFilter(10, preset)).toMatch(/,scale=1024:-2$/);
  });

  it("allows for rounded timestamps when the source rate is known", () => {
    const preset: ResolvedPreset = { width: null, format: "png", quality: null };
    expect(buildVideoFilter(30, preset, 1 / 30)).toContain("floor((t+0.016333");
  });

  it("accepts a fractional rate", () => {
    const preset: ResolvedPreset = { width: null, format: "png", quality: null };
    expect(buildVideoFilter(0.2, preset)).toContain("floor(t*0.2+");
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
    expect(args.join(" ")).toContain("scale=1024:-2");
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

    expect(args.join(" ")).toContain("floor(t*10+");
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

    expect(args.join(" ")).toContain("scale=720:-2");
    expect(args).toContain("-q:v");
    expect(args).toContain(String(qualityToQscale(60)));
  });
});

describe("extractFrames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates output dir and returns frame list", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "" });

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
    mockExec.mockRejectedValue(new Error("FFmpeg crashed"));

    await expect(
      extractFrames({
        videoPath: "/tmp/video.mp4",
        outputDir: "/output/frames",
        fps: 5,
        preset: { width: 1024, format: "jpeg", quality: 80 },
      }),
    ).rejects.toThrow("FFmpeg extraction failed");
  });

  it("orders frames numerically past 9,999", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "" });

    mockReaddir.mockResolvedValue([
      "frame_10000.jpg",
      "frame_9999.jpg",
      "frame_1000.jpg",
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    const result = await extractFrames({
      videoPath: "/tmp/video.mp4",
      outputDir: "/output/frames",
      fps: 30,
      preset: { width: 1024, format: "jpeg", quality: 80 },
    });

    expect(result.frameFiles.map((f) => f.split(/[\\/]/).pop())).toEqual([
      "frame_1000.jpg",
      "frame_9999.jpg",
      "frame_10000.jpg",
    ]);
  });

  it("reports each frame's printed time, offset by the range start", async () => {
    mockExec.mockImplementation(async (_cmd, _args, opts) => {
      opts?.onStdoutLine?.("frame:0    pts:40000   pts_time:0.04");
      opts?.onStdoutLine?.("capture=1");
      // pts_time as FFmpeg 5.1 rounds it. The exact integer must win.
      opts?.onStdoutLine?.("frame:1    pts:1041667 pts_time:1.04");
      return { stdout: "", stderr: "" };
    });

    mockReaddir.mockResolvedValue([
      "frame_0001.jpg",
      "frame_0002.jpg",
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    const result = await extractFrames({
      videoPath: "/tmp/video.mp4",
      outputDir: "/output/frames",
      fps: 1,
      preset: { width: 1024, format: "jpeg", quality: 80 },
      range: { start: 100, end: 110 },
    });

    expect(result.frameTimes).toEqual([100.04, 101.041667]);
  });

  it("reads only allowlisted containers, from local files only", () => {
    const args = buildFfmpegArgs({
      videoPath: "/tmp/video.mp4",
      outputDir: "/output/frames",
      fps: 1,
      preset: { width: null, format: "png", quality: null },
    });

    const formats = args[args.indexOf("-format_whitelist") + 1]!.split(",");
    expect(formats).toContain("mov");
    expect(formats).toContain("matroska");
    for (const refused of ["hls", "dash", "concat", "image2", "avisynth", "sdp"]) {
      expect(formats).not.toContain(refused);
    }
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file");
    expect(args.indexOf("-format_whitelist")).toBeLessThan(args.indexOf("-i"));
  });

  it("reports no frames in a range as the caller's mistake", async () => {
    mockExec.mockRejectedValue(new Error("encoder failed: no frames"));

    await expect(
      extractFrames({
        videoPath: "/tmp/video.mp4",
        outputDir: "/output/frames",
        fps: 1,
        preset: { width: 1024, format: "jpeg", quality: 80 },
        range: { start: 100, end: 110 },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("seeks before the input for a range", () => {
    const args = buildFfmpegArgs({
      videoPath: "/tmp/video.mp4",
      outputDir: "/output/frames",
      fps: 1,
      preset: { width: null, format: "png", quality: null },
      range: { start: 10, end: 25 },
    });

    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-ss") + 1]).toBe("10");
    expect(args[args.indexOf("-t") + 1]).toBe("15");
  });

  it("surfaces the abort reason rather than a wrapped FFmpeg error", async () => {
    const reason = new Error("job timed out");
    mockExec.mockRejectedValue(new Error("killed"));

    await expect(
      extractFrames({
        videoPath: "/tmp/video.mp4",
        outputDir: "/output/frames",
        fps: 1,
        preset: { width: 1024, format: "jpeg", quality: 80 },
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
  });

  it("filters and sorts frame files", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "" });

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
