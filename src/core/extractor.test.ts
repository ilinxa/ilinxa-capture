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
  rm: vi.fn().mockResolvedValue(undefined),
}));

import { execFileAsync } from "../utils/exec.js";
import { mkdir, readdir, rm } from "node:fs/promises";

const mockExec = vi.mocked(execFileAsync);
const mockReaddir = vi.mocked(readdir);

type ExecOptions = Parameters<typeof execFileAsync>[2];

function printDecoded(opts: ExecOptions, seconds: number): void {
  opts?.onStdoutLine?.(`frame:0    pts:${Math.round(seconds * 1e6)} pts_time:${seconds}`);
  opts?.onStdoutLine?.("decoded=1");
}

function printKept(opts: ExecOptions, index: number, seconds: number): void {
  opts?.onStdoutLine?.(`frame:${index}    pts:${Math.round(seconds * 1e6)} pts_time:${seconds}`);
  opts?.onStdoutLine?.("capture=1");
}

function printFrames(opts: ExecOptions, count: number): void {
  for (let i = 0; i < count; i++) printKept(opts, i, i);
}

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
    expect(filter).toContain("floor((t-start_t+0)*5+");
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
    expect(buildVideoFilter(12, preset, 1 / 24)).toContain("floor((t-start_t+0.0204");
  });

  it("accepts a fractional rate", () => {
    const preset: ResolvedPreset = { width: null, format: "png", quality: null };
    expect(buildVideoFilter(0.2, preset)).toContain("floor((t-start_t+0)*0.2+");
  });

  // Regression: a grid as fine as the frames lost some to rounded timestamps.
  it.each([
    [24, 1 / 24],
    [23.98, 1001 / 24000],
    [60, 1001 / 60000],
    [30, 1 / 24],
  ])("keeps every frame when %d fps is the source rate or above", (fps, interval) => {
    const preset: ResolvedPreset = { width: null, format: "png", quality: null };
    expect(buildVideoFilter(fps, preset, interval)).not.toContain("select=");
  });

  it("still samples when the source rate is unknown", () => {
    const preset: ResolvedPreset = { width: null, format: "png", quality: null };
    expect(buildVideoFilter(24, preset, 0)).toContain("select=");
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

    expect(args.join(" ")).toContain("floor((t-start_t+0)*10+");
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
    mockExec.mockImplementation(async (_cmd, _args, opts) => {
      printFrames(opts, 3);
      return { stdout: "", stderr: "" };
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
    mockExec.mockImplementation(async (_cmd, _args, opts) => {
      printFrames(opts, 3);
      return { stdout: "", stderr: "" };
    });

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

  it("fails rather than invent a time for a frame FFmpeg did not print", async () => {
    mockExec.mockImplementation(async (_cmd, _args, opts) => {
      printFrames(opts, 1);
      return { stdout: "", stderr: "" };
    });
    mockReaddir.mockResolvedValue([
      "frame_0001.jpg",
      "frame_0002.jpg",
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    await expect(
      extractFrames({
        videoPath: "/tmp/video.mp4",
        outputDir: "/output/frames",
        fps: 5,
        preset: { width: 1024, format: "jpeg", quality: 80 },
      }),
    ).rejects.toThrow("printed 1 frame times for 2 frames");
  });

  it("reports each frame's printed time, on the source's own clock", async () => {
    mockExec.mockImplementation(async (_cmd, _args, opts) => {
      printDecoded(opts, 99.5);
      printKept(opts, 0, 100.04);
      // pts_time as FFmpeg 5.1 rounds it. The exact integer must win.
      opts?.onStdoutLine?.("frame:1    pts:101041667 pts_time:101.042");
      opts?.onStdoutLine?.("capture=1");
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

  describe("a range", () => {
    const range = { start: 100, end: 110 };
    const base = {
      videoPath: "/tmp/video.mp4",
      outputDir: "/output/frames",
      fps: 1,
      preset: { width: null, format: "png" as const, quality: null },
    };

    const seeks = (): Array<number | null> =>
      mockExec.mock.calls.map(([, args]) => {
        const at = args.indexOf("-ss");
        return at === -1 ? null : Number(args[at + 1]);
      });

    // -t counts from the first frame after a seek, wherever that landed, so
    // the window slid. The range is cut by time instead.
    it("seeks early, keeps the source clock, and cuts by trim", () => {
      const args = buildFfmpegArgs({ ...base, range: { start: 10, end: 25 } }, 8);

      expect(args.slice(0, 5)).toEqual([
        "-copyts",
        "-start_at_zero",
        "-noaccurate_seek",
        "-ss",
        "8",
      ]);
      expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
      expect(args).not.toContain("-t");
      expect(args.join(" ")).toContain("trim=start_pts=10000000:end_pts=25000000");
    });

    // Without it, MKV's millisecond timestamps land on the same tick of an
    // encoder running at the source rate, and the run fails.
    it("gives the encoder a clock finer than any timestamp", () => {
      const args = buildFfmpegArgs(base);

      expect(args[args.indexOf("-enc_time_base") + 1]).toBe("1:1000000");
    });

    it("does not seek at all at or before the start of the file", () => {
      const args = buildFfmpegArgs({ ...base, range: { start: 0, end: 5 } }, 0);

      expect(args).not.toContain("-ss");
      expect(args).toContain("-copyts");
    });

    // The source clock fails on joined TS captures, so a whole read stays off it.
    it("leaves a whole-file read on FFmpeg's own clock", () => {
      expect(buildFfmpegArgs(base)).not.toContain("-copyts");
    });

    it("trims before sampling, so sampling starts at the range", () => {
      const filter = buildVideoFilter(1, base.preset, 0, range);

      expect(filter.indexOf("trim=")).toBeGreaterThan(-1);
      expect(filter.indexOf("trim=")).toBeLessThan(filter.indexOf("select="));
    });

    it("runs once when the seek landed at or before the start", async () => {
      mockExec.mockImplementation(async (_cmd, _args, opts) => {
        printDecoded(opts, 99.9);
        printKept(opts, 0, 100);
        return { stdout: "", stderr: "" };
      });
      mockReaddir.mockResolvedValue(["frame_0001.jpg"] as unknown as Awaited<
        ReturnType<typeof readdir>
      >);

      await extractFrames({ ...base, range, frameInterval: 0.04 });

      expect(seeks()).toEqual([100]);
    });

    it("backs off further and starts clean when a seek overshot", async () => {
      mockExec.mockImplementation(async (_cmd, args, opts) => {
        const seek = Number(args[args.indexOf("-ss") + 1]);
        printDecoded(opts, seek === 100 ? 101 : 87);
        if (seek !== 100) printKept(opts, 0, 100);
        return { stdout: "", stderr: "" };
      });
      mockReaddir.mockResolvedValue(["frame_0001.jpg"] as unknown as Awaited<
        ReturnType<typeof readdir>
      >);

      const result = await extractFrames({ ...base, range, frameInterval: 0.04 });

      expect(seeks()).toEqual([100, 88]);
      expect(rm).toHaveBeenCalledWith("/output/frames", { recursive: true, force: true });
      expect(result.frameTimes).toEqual([100]);
    });

    // A gap in a variable frame rate source looks like an overshoot if judged
    // by the first frame kept, and would force a needless full decode.
    it("is not fooled by a gap after the start", async () => {
      mockExec.mockImplementation(async (_cmd, _args, opts) => {
        printDecoded(opts, 99.9);
        printKept(opts, 0, 104);
        return { stdout: "", stderr: "" };
      });
      mockReaddir.mockResolvedValue(["frame_0001.jpg"] as unknown as Awaited<
        ReturnType<typeof readdir>
      >);

      await extractFrames({ ...base, range, frameInterval: 0.04 });

      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    it("reads a byte-seeking container from a margin before the start", async () => {
      mockExec.mockImplementation(async (_cmd, _args, opts) => {
        printDecoded(opts, 97);
        printKept(opts, 0, 100);
        return { stdout: "", stderr: "" };
      });
      mockReaddir.mockResolvedValue(["frame_0001.jpg"] as unknown as Awaited<
        ReturnType<typeof readdir>
      >);

      await extractFrames({ ...base, range, format: "mpegts", frameInterval: 0.04 });

      expect(seeks()).toEqual([97]);
    });

    it("never seeks in a raw stream, which has no timestamps to seek on", async () => {
      mockExec.mockImplementation(async (_cmd, _args, opts) => {
        printFrames(opts, 1);
        return { stdout: "", stderr: "" };
      });
      mockReaddir.mockResolvedValue(["frame_0001.jpg"] as unknown as Awaited<
        ReturnType<typeof readdir>
      >);

      await extractFrames({ ...base, range, format: "h264", frameInterval: 0.04 });

      expect(seeks()).toEqual([null]);
    });

    it("falls back to reading from the start after the last margin", async () => {
      mockExec.mockImplementation(async (_cmd, args, opts) => {
        if (!args.includes("-ss")) printFrames(opts, 1);
        return { stdout: "", stderr: "" };
      });
      mockReaddir.mockResolvedValue(["frame_0001.jpg"] as unknown as Awaited<
        ReturnType<typeof readdir>
      >);

      await extractFrames({ ...base, range, frameInterval: 0.04 });

      expect(seeks()).toEqual([100, 88, 4, null]);
    });
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
    mockExec.mockImplementation(async (_cmd, _args, opts) => {
      printFrames(opts, 3);
      return { stdout: "", stderr: "" };
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
