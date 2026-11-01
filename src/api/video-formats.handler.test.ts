import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../app.js";
import { createTestEnv } from "../test/env.js";

// Mock core modules — this test only exercises validation, not the real
// yt-dlp integration.
vi.mock("../core/metadata.js", () => ({
  getVideoMetadata: vi.fn(),
}));

vi.mock("../core/extractor.js", () => ({
  extractFrames: vi.fn(),
}));

vi.mock("../core/downloader.js", () => ({
  isUrl: vi.fn(
    (s: string) => s.startsWith("http://") || s.startsWith("https://"),
  ),
  downloadVideo: vi.fn().mockResolvedValue("/tmp/ilinxa-capture-dl-mock.mp4"),
  listVideoFormats: vi.fn().mockResolvedValue({
    title: "Test Video",
    duration: 120,
    formats: [],
  }),
  downloadVideoWithFormat: vi.fn(),
  VIDEO_DOWNLOAD_PRESETS: {
    best: { formatSelector: "bestvideo+bestaudio/best", label: "Best Quality" },
  },
}));

// Mock fs/promises for JobManager persistence + recovery
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    ),
    rm: vi.fn().mockResolvedValue(undefined),
  };
});

import { listVideoFormats } from "../core/downloader.js";

const mockListVideoFormats = vi.mocked(listVideoFormats);

describe("POST /api/v1/video/formats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListVideoFormats.mockResolvedValue({
      title: "Test Video",
      duration: 120,
      formats: [],
    });
  });

  it("returns 400 VALIDATION_ERROR for an invalid url (not a raw Zod error)", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/video/formats",
      headers: { "content-type": "application/json" },
      payload: { url: "not-a-url" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(mockListVideoFormats).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 200 with formats for a valid url", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/video/formats",
      headers: { "content-type": "application/json" },
      payload: { url: "https://example.com/video.mp4" },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { title: string };
    expect(body.title).toBe("Test Video");

    await app.close();
  });
});
