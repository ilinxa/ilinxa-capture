import { describe, it, expect, vi, beforeEach } from "vitest";
import { getVideoMetadata, parseFps } from "./metadata.js";

// Mock the process runner
vi.mock("../utils/exec.js", () => ({
  execFileAsync: vi.fn(),
}));

import { execFileAsync } from "../utils/exec.js";

const mockExec = vi.mocked(execFileAsync);

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

    mockExec.mockResolvedValue({ stdout: stdout, stderr: "" });

    const metadata = await getVideoMetadata("/path/to/video.mp4");

    expect(metadata).toEqual({
      duration: 65.3,
      width: 1920,
      height: 1080,
      fps: 29.97,
      codec: "h264",
      size_bytes: 15234567,
      format: "mov",
      audio_streams: [],
    });
  });

  it("lists audio streams, numbered among audio streams only", async () => {
    const stdout = JSON.stringify({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 640, height: 360, r_frame_rate: "25/1" },
        {
          codec_type: "audio",
          codec_name: "aac",
          channels: 6,
          sample_rate: "48000",
          tags: { language: "eng", title: "Surround" },
        },
        { codec_type: "subtitle", codec_name: "subrip" },
        { codec_type: "audio", codec_name: "ac3", channels: 2, sample_rate: "44100" },
      ],
      format: { duration: "10", size: "100", format_name: "matroska,webm" },
    });
    mockExec.mockResolvedValue({ stdout, stderr: "" });

    const { audio_streams: streams } = await getVideoMetadata("/path/to/video.mkv");

    expect(streams).toEqual([
      { index: 0, codec: "aac", channels: 6, sample_rate: 48000, language: "eng", title: "Surround" },
      { index: 1, codec: "ac3", channels: 2, sample_rate: 44100, language: null, title: null },
    ]);
  });

  it("refuses anything outside the container allowlist before opening it", async () => {
    mockExec.mockResolvedValue({ stdout: createFfprobeOutput(), stderr: "" });

    await getVideoMetadata("/test/file.mp4");

    const args = mockExec.mock.calls[0]![1];
    expect(args.indexOf("-format_whitelist")).toBeLessThan(args.indexOf("/test/file.mp4"));
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file");
  });

  it("measures the duration when the container does not state it", async () => {
    const stdout = JSON.stringify({
      streams: [{ codec_type: "video", codec_name: "h264", r_frame_rate: "25/1" }],
      format: { size: "100", format_name: "matroska,webm" },
    });
    mockExec.mockResolvedValueOnce({ stdout, stderr: "" });
    mockExec.mockImplementationOnce(async (_cmd, _args, opts) => {
      opts?.onStdoutLine?.("0.000000");
      opts?.onStdoutLine?.("29.960000");
      opts?.onStdoutLine?.("12.000000");
      return { stdout: "", stderr: "" };
    });

    const metadata = await getVideoMetadata("/piped.mkv");

    expect(metadata.duration).toBeCloseTo(29.96);
  });

  it("uses first value of comma-separated format_name", async () => {
    const stdout = createFfprobeOutput({
      format: {
        duration: "10.0",
        size: "1000",
        format_name: "matroska,webm",
      },
    });

    mockExec.mockResolvedValue({ stdout: stdout, stderr: "" });

    const metadata = await getVideoMetadata("/path/to/video.mkv");
    expect(metadata.format).toBe("matroska");
  });

  it("throws ProcessingError when no video stream found", async () => {
    const stdout = createFfprobeOutput({
      streams: [{ codec_type: "audio", codec_name: "aac" }],
    });

    mockExec.mockResolvedValue({ stdout: stdout, stderr: "" });

    await expect(getVideoMetadata("/path/to/audio.mp3")).rejects.toThrow(
      "No video stream found",
    );
  });

  it("throws ProcessingError when ffprobe fails", async () => {
    mockExec.mockRejectedValue(new Error("ffprobe: No such file"));

    await expect(getVideoMetadata("/nonexistent/file.mp4")).rejects.toThrow(
      "ffprobe failed",
    );
  });

  it("throws ProcessingError for invalid JSON output", async () => {
    mockExec.mockResolvedValue({ stdout: "not json", stderr: "" });

    await expect(getVideoMetadata("/path/to/video.mp4")).rejects.toThrow(
      "ffprobe returned invalid JSON",
    );
  });

  it("calls ffprobe with correct arguments", async () => {
    const stdout = createFfprobeOutput();

    mockExec.mockResolvedValue({ stdout: stdout, stderr: "" });

    await getVideoMetadata("/test/file.mp4");

    expect(mockExec).toHaveBeenCalledWith(
      "ffprobe",
      expect.arrayContaining(["-show_format", "-show_streams", "/test/file.mp4"]),
      expect.anything(),
    );
  });
});
