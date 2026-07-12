import { describe, it, expect, vi, beforeEach } from "vitest";
import { getVideoMetadata, parseFps } from "./metadata.js";

// Mock child_process.execFile
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";

const mockExecFile = vi.mocked(execFile);

function createFfprobeOutput(overrides?: {
  streams?: Record<string, unknown>[];
  format?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    streams: overrides?.streams ?? [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1920,
        height: 1080,
        r_frame_rate: "30000/1001",
        duration: "65.300000",
      },
    ],
    format: overrides?.format ?? {
      duration: "65.300000",
      size: "15234567",
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    },
  });
}

describe("parseFps", () => {
  it("converts fraction to decimal", () => {
    expect(parseFps("30000/1001")).toBeCloseTo(29.97, 1);
  });

  it("handles simple fraction", () => {
    expect(parseFps("25/1")).toBe(25);
  });

  it("returns 0 for 0/0", () => {
    expect(parseFps("0/0")).toBe(0);
  });

  it("returns 0 for undefined", () => {
    expect(parseFps(undefined)).toBe(0);
  });

  it("handles plain number string", () => {
    expect(parseFps("30")).toBe(30);
  });
});

describe("getVideoMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses valid ffprobe output", async () => {
    const stdout = createFfprobeOutput();

    mockExecFile.mockImplementation((_cmd, _args, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(null, stdout, "");
      return undefined as never;
    });

    const metadata = await getVideoMetadata("/path/to/video.mp4");

    expect(metadata).toEqual({
      duration: 65.3,
      width: 1920,
      height: 1080,
      fps: 29.97,
      codec: "h264",
      size_bytes: 15234567,
      format: "mov",
    });
  });

  it("uses first value of comma-separated format_name", async () => {
    const stdout = createFfprobeOutput({
      format: {
        duration: "10.0",
        size: "1000",
        format_name: "matroska,webm",
      },
    });

    mockExecFile.mockImplementation((_cmd, _args, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(null, stdout, "");
      return undefined as never;
    });

    const metadata = await getVideoMetadata("/path/to/video.mkv");
    expect(metadata.format).toBe("matroska");
  });

  it("throws ProcessingError when no video stream found", async () => {
    const stdout = createFfprobeOutput({
      streams: [{ codec_type: "audio", codec_name: "aac" }],
    });

    mockExecFile.mockImplementation((_cmd, _args, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(null, stdout, "");
      return undefined as never;
    });

    await expect(getVideoMetadata("/path/to/audio.mp3")).rejects.toThrow(
      "No video stream found",
    );
  });

  it("throws ProcessingError when ffprobe fails", async () => {
    mockExecFile.mockImplementation((_cmd, _args, callback) => {
      (callback as (err: Error, stdout: string, stderr: string) => void)(
        new Error("ffprobe: No such file"),
        "",
        "",
      );
      return undefined as never;
    });

    await expect(getVideoMetadata("/nonexistent/file.mp4")).rejects.toThrow(
      "ffprobe failed",
    );
  });

  it("throws ProcessingError for invalid JSON output", async () => {
    mockExecFile.mockImplementation((_cmd, _args, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(null, "not json", "");
      return undefined as never;
    });

    await expect(getVideoMetadata("/path/to/video.mp4")).rejects.toThrow(
      "ffprobe returned invalid JSON",
    );
  });

  it("calls ffprobe with correct arguments", async () => {
    const stdout = createFfprobeOutput();

    mockExecFile.mockImplementation((_cmd, _args, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(null, stdout, "");
      return undefined as never;
    });

    await getVideoMetadata("/test/file.mp4");

    expect(mockExecFile).toHaveBeenCalledWith(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "/test/file.mp4"],
      expect.any(Function),
    );
  });
});
