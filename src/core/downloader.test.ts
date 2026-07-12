import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isUrl,
  downloadVideo,
  listVideoFormats,
  downloadVideoWithFormat,
  VIDEO_DOWNLOAD_PRESETS,
} from "./downloader.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readdir: vi.fn(),
    stat: vi.fn(),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
});

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";

const mockExecFile = vi.mocked(execFile);
const mockReaddir = vi.mocked(readdir);
const mockStat = vi.mocked(stat);

// ─── isUrl ──────────────────────────────────────────────────────────

describe("isUrl", () => {
  it("returns true for http URLs", () => {
    expect(isUrl("http://example.com/video.mp4")).toBe(true);
  });

  it("returns true for https URLs", () => {
    expect(isUrl("https://youtube.com/watch?v=abc")).toBe(true);
  });

  it("returns false for absolute file paths", () => {
    expect(isUrl("/tmp/video.mp4")).toBe(false);
  });

  it("returns false for relative file paths", () => {
    expect(isUrl("./data/video.mp4")).toBe(false);
  });

  it("returns false for Windows file paths", () => {
    expect(isUrl("C:\\Users\\video.mp4")).toBe(false);
  });
});

// ─── downloadVideo ──────────────────────────────────────────────────

describe("downloadVideo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls yt-dlp with correct arguments", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(
        null,
        "",
        "",
      );
      return undefined as never;
    });

    const result = await downloadVideo("https://youtube.com/watch?v=abc");

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const call = mockExecFile.mock.calls[0]!;
    expect(call[0]).toBe("yt-dlp");

    const args = call[1] as string[];
    expect(args).toContain("-o");
    expect(args).toContain("--no-playlist");
    expect(args).toContain("--merge-output-format");
    expect(args).toContain("mp4");
    expect(args).toContain("https://youtube.com/watch?v=abc");

    expect(result).toMatch(/ilinxa-capture-dl-.*\.mp4$/);
  });

  it("returns a temp file path", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(
        null,
        "",
        "",
      );
      return undefined as never;
    });

    const result = await downloadVideo("https://example.com/video.mp4");
    expect(typeof result).toBe("string");
    expect(result).toContain("ilinxa-capture-dl-");
    expect(result).toMatch(/\.mp4$/);
  });

  it("throws DownloadFailedError on yt-dlp failure", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: Error, stdout: string, stderr: string) => void)(
        new Error("yt-dlp crashed"),
        "",
        "",
      );
      return undefined as never;
    });

    await expect(
      downloadVideo("https://example.com/video.mp4"),
    ).rejects.toThrow("Failed to download video");
  });
});

// ─── listVideoFormats ───────────────────────────────────────────────

describe("listVideoFormats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses yt-dlp --dump-json output", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(
        null,
        JSON.stringify({
          title: "Test Video",
          duration: 120,
          formats: [
            {
              format_id: "18",
              ext: "mp4",
              width: 640,
              height: 360,
              fps: 30,
              vcodec: "avc1",
              acodec: "mp4a",
              filesize: 5000000,
              filesize_approx: null,
              format_note: "360p",
              resolution: "640x360",
            },
          ],
        }),
        "",
      );
      return undefined as never;
    });

    const result = await listVideoFormats("https://youtube.com/watch?v=abc");

    expect(result.title).toBe("Test Video");
    expect(result.duration).toBe(120);
    expect(result.formats).toHaveLength(1);
    expect(result.formats[0]!.format_id).toBe("18");
    expect(result.formats[0]!.height).toBe(360);
  });

  it("filters out storyboard formats", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(
        null,
        JSON.stringify({
          title: "Test",
          duration: 60,
          formats: [
            {
              format_id: "18",
              ext: "mp4",
              vcodec: "avc1",
              acodec: "mp4a",
              format_note: "360p",
              resolution: "640x360",
            },
            {
              format_id: "sb0",
              ext: "mhtml",
              vcodec: "none",
              acodec: "none",
              format_note: "storyboard",
              resolution: "160x90",
            },
          ],
        }),
        "",
      );
      return undefined as never;
    });

    const result = await listVideoFormats("https://example.com/v");
    expect(result.formats).toHaveLength(1);
    expect(result.formats[0]!.format_id).toBe("18");
  });

  it("throws FormatListingFailedError on yt-dlp failure", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: Error, stdout: string, stderr: string) => void)(
        new Error("yt-dlp crashed"),
        "",
        "",
      );
      return undefined as never;
    });

    await expect(
      listVideoFormats("https://example.com/v"),
    ).rejects.toThrow("Failed to list video formats");
  });

  it("throws on invalid JSON", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(
        null,
        "not json",
        "",
      );
      return undefined as never;
    });

    await expect(
      listVideoFormats("https://example.com/v"),
    ).rejects.toThrow("invalid JSON");
  });

  it("calls yt-dlp with --dump-json --no-playlist", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(
        null,
        JSON.stringify({ title: "T", duration: 1, formats: [] }),
        "",
      );
      return undefined as never;
    });

    await listVideoFormats("https://example.com/v");

    const call = mockExecFile.mock.calls[0]!;
    expect(call[0]).toBe("yt-dlp");
    const args = call[1] as string[];
    expect(args).toContain("--dump-json");
    expect(args).toContain("--no-playlist");
    expect(args).toContain("https://example.com/v");
  });
});

// ─── downloadVideoWithFormat ────────────────────────────────────────

describe("downloadVideoWithFormat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls yt-dlp with format selector and merge format", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(
        null,
        "",
        "",
      );
      return undefined as never;
    });
    mockReaddir.mockResolvedValue(["My Video.mp4"] as unknown as never);
    mockStat.mockResolvedValue({ size: 12345678 } as never);

    const result = await downloadVideoWithFormat({
      url: "https://example.com/v",
      outputDir: "/data/jobs/cap_test/video",
      formatSelector: "bestvideo[height<=720]+bestaudio/best[height<=720]",
      mergeFormat: "mp4",
    });

    const call = mockExecFile.mock.calls[0]!;
    const args = call[1] as string[];
    expect(args).toContain("-f");
    expect(args).toContain("bestvideo[height<=720]+bestaudio/best[height<=720]");
    expect(args).toContain("--merge-output-format");
    expect(args).toContain("mp4");
    expect(args).toContain("--no-playlist");

    expect(result.filename).toBe("My Video.mp4");
    expect(result.filesize).toBe(12345678);
    expect(result.ext).toBe("mp4");
  });

  it("uses defaults when no formatSelector or mergeFormat provided", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(
        null,
        "",
        "",
      );
      return undefined as never;
    });
    mockReaddir.mockResolvedValue(["video.mp4"] as unknown as never);
    mockStat.mockResolvedValue({ size: 100 } as never);

    await downloadVideoWithFormat({
      url: "https://example.com/v",
      outputDir: "/data/jobs/cap_test/video",
    });

    const call = mockExecFile.mock.calls[0]!;
    const args = call[1] as string[];
    expect(args).toContain("bestvideo+bestaudio/best");
    expect(args).toContain("mp4");
  });

  it("throws DownloadFailedError on yt-dlp failure", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: Error, stdout: string, stderr: string) => void)(
        new Error("download failed"),
        "",
        "",
      );
      return undefined as never;
    });

    await expect(
      downloadVideoWithFormat({
        url: "https://example.com/v",
        outputDir: "/tmp/test",
      }),
    ).rejects.toThrow("Failed to download video");
  });

  it("uses --extract-audio --audio-format for mp3 mergeFormat", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(
        null,
        "",
        "",
      );
      return undefined as never;
    });
    mockReaddir.mockResolvedValue(["song.mp3"] as unknown as never);
    mockStat.mockResolvedValue({ size: 5000 } as never);

    await downloadVideoWithFormat({
      url: "https://example.com/v",
      outputDir: "/tmp/test",
      formatSelector: "bestaudio",
      mergeFormat: "mp3",
    });

    const call = mockExecFile.mock.calls[0]!;
    const args = call[1] as string[];
    expect(args).toContain("--extract-audio");
    expect(args).toContain("--audio-format");
    expect(args).toContain("mp3");
    expect(args).not.toContain("--merge-output-format");
  });

  it("throws when no output file found", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(
        null,
        "",
        "",
      );
      return undefined as never;
    });
    mockReaddir.mockResolvedValue([] as unknown as never);

    await expect(
      downloadVideoWithFormat({
        url: "https://example.com/v",
        outputDir: "/tmp/test",
      }),
    ).rejects.toThrow("No output file found");
  });
});

// ─── VIDEO_DOWNLOAD_PRESETS ─────────────────────────────────────────

describe("VIDEO_DOWNLOAD_PRESETS", () => {
  it("has all expected preset keys", () => {
    const keys = Object.keys(VIDEO_DOWNLOAD_PRESETS);
    expect(keys).toContain("best");
    expect(keys).toContain("1080p");
    expect(keys).toContain("720p");
    expect(keys).toContain("480p");
    expect(keys).toContain("360p");
    expect(keys).toContain("audio_only");
  });

  it("each preset has formatSelector and label", () => {
    for (const preset of Object.values(VIDEO_DOWNLOAD_PRESETS)) {
      expect(preset.formatSelector).toBeTruthy();
      expect(preset.label).toBeTruthy();
    }
  });
});
