import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isUrl,
  downloadVideo,
  listVideoFormats,
  downloadVideoWithFormat,
  VIDEO_DOWNLOAD_PRESETS,
} from "./downloader.js";

vi.mock("../utils/exec.js", () => ({
  execFileAsync: vi.fn(),
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

import { execFileAsync } from "../utils/exec.js";
import { readdir, stat } from "node:fs/promises";

const mockExec = vi.mocked(execFileAsync);
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
    mockExec.mockResolvedValue({ stdout: "", stderr: "" });

    const result = await downloadVideo("https://youtube.com/watch?v=abc");

    expect(mockExec).toHaveBeenCalledTimes(1);
    const call = mockExec.mock.calls[0]!;
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
    mockExec.mockResolvedValue({ stdout: "", stderr: "" });

    const result = await downloadVideo("https://example.com/video.mp4");
    expect(typeof result).toBe("string");
    expect(result).toContain("ilinxa-capture-dl-");
    expect(result).toMatch(/\.mp4$/);
  });

  it("throws DownloadFailedError on yt-dlp failure", async () => {
    mockExec.mockRejectedValue(new Error("yt-dlp crashed"));

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
    mockExec.mockResolvedValue({ stdout: JSON.stringify({
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
        }), stderr: "" });

    const result = await listVideoFormats("https://youtube.com/watch?v=abc");

    expect(result.title).toBe("Test Video");
    expect(result.duration).toBe(120);
    expect(result.formats).toHaveLength(1);
    expect(result.formats[0]!.format_id).toBe("18");
    expect(result.formats[0]!.height).toBe(360);
  });

  it("filters out storyboard formats", async () => {
    mockExec.mockResolvedValue({ stdout: JSON.stringify({
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
        }), stderr: "" });

    const result = await listVideoFormats("https://example.com/v");
    expect(result.formats).toHaveLength(1);
    expect(result.formats[0]!.format_id).toBe("18");
  });

  it("throws FormatListingFailedError on yt-dlp failure", async () => {
    mockExec.mockRejectedValue(new Error("yt-dlp crashed"));

    await expect(
      listVideoFormats("https://example.com/v"),
    ).rejects.toThrow("Failed to list video formats");
  });

  it("throws on invalid JSON", async () => {
    mockExec.mockResolvedValue({ stdout: "not json", stderr: "" });

    await expect(
      listVideoFormats("https://example.com/v"),
    ).rejects.toThrow("invalid JSON");
  });

  it("calls yt-dlp with --dump-json --no-playlist", async () => {
    mockExec.mockResolvedValue({ stdout: JSON.stringify({ title: "T", duration: 1, formats: [] }), stderr: "" });

    await listVideoFormats("https://example.com/v");

    const call = mockExec.mock.calls[0]!;
    expect(call[0]).toBe("yt-dlp");
    const args = call[1] as string[];
    expect(args).toContain("--dump-json");
    expect(args).toContain("--no-playlist");
    expect(args).toContain("https://example.com/v");
  });
});

describe("listVideoFormats headers", () => {
  it("passes headers to yt-dlp", async () => {
    mockExec.mockClear();
    mockExec.mockResolvedValue({ stdout: "{}", stderr: "" });

    await listVideoFormats("https://example.com/v", { Referer: "https://example.com/" });

    const args = mockExec.mock.calls[0]![1] as string[];
    expect(args.join(" ")).toContain("--add-header Referer:https://example.com/");
  });
});

// ─── downloadVideoWithFormat ────────────────────────────────────────

describe("downloadVideoWithFormat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls yt-dlp with format selector and merge format", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "" });
    mockReaddir.mockResolvedValue(["My Video.mp4"] as unknown as never);
    mockStat.mockResolvedValue({ size: 12345678 } as never);

    const result = await downloadVideoWithFormat({
      url: "https://example.com/v",
      outputDir: "/data/jobs/cap_0000beef/video",
      formatSelector: "bestvideo[height<=720]+bestaudio/best[height<=720]",
      mergeFormat: "mp4",
    });

    const call = mockExec.mock.calls[0]!;
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

  // Regression: headers reached HLS sources only, and yt-dlp went in anonymous.
  it("passes headers to yt-dlp", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "" });
    mockReaddir.mockResolvedValue(["video.mp4"] as unknown as never);
    mockStat.mockResolvedValue({ size: 100 } as never);

    await downloadVideoWithFormat({
      url: "https://example.com/v",
      outputDir: "/data/jobs/cap_0000beef/video",
      headers: { Referer: "https://example.com/", Cookie: "a=b" },
    });

    const args = mockExec.mock.calls[0]![1] as string[];
    expect(args.join(" ")).toContain(
      "--add-header Referer:https://example.com/ --add-header Cookie:a=b",
    );
    expect(args.indexOf("--add-header")).toBeLessThan(args.indexOf("--"));
  });

  it("uses defaults when no formatSelector or mergeFormat provided", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "" });
    mockReaddir.mockResolvedValue(["video.mp4"] as unknown as never);
    mockStat.mockResolvedValue({ size: 100 } as never);

    await downloadVideoWithFormat({
      url: "https://example.com/v",
      outputDir: "/data/jobs/cap_0000beef/video",
    });

    const call = mockExec.mock.calls[0]!;
    const args = call[1] as string[];
    expect(args).toContain("bestvideo+bestaudio/best");
    expect(args).toContain("mp4");
  });

  it("throws DownloadFailedError on yt-dlp failure", async () => {
    mockExec.mockRejectedValue(new Error("download failed"));

    await expect(
      downloadVideoWithFormat({
        url: "https://example.com/v",
        outputDir: "/tmp/test",
      }),
    ).rejects.toThrow("Failed to download video");
  });

  it("uses --extract-audio --audio-format for mp3 mergeFormat", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "" });
    mockReaddir.mockResolvedValue(["song.mp3"] as unknown as never);
    mockStat.mockResolvedValue({ size: 5000 } as never);

    await downloadVideoWithFormat({
      url: "https://example.com/v",
      outputDir: "/tmp/test",
      formatSelector: "bestaudio",
      mergeFormat: "mp3",
    });

    const call = mockExec.mock.calls[0]!;
    const args = call[1] as string[];
    expect(args).toContain("--extract-audio");
    expect(args).toContain("--audio-format");
    expect(args).toContain("mp3");
    expect(args).not.toContain("--merge-output-format");
  });

  it("throws when no output file found", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "" });
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
