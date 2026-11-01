import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../app.js";
import { createTestEnv } from "../test/env.js";

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
  listVideoFormats: vi.fn(),
  downloadVideoWithFormat: vi.fn(),
  VIDEO_DOWNLOAD_PRESETS: {
    best: { formatSelector: "bestvideo+bestaudio/best", label: "Best Quality" },
  },
}));

vi.mock("../core/hls.js", () => ({
  discoverHlsUrls: vi.fn().mockResolvedValue({
    page_url: "https://example.com/watch",
    page_title: "Test Video Page",
    streams: [{ url: "https://cdn.example.com/master.m3u8", source: "script_tag" }],
  }),
}));

// Mock fs/promises for JobManager persistence + recovery
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    ),
    rm: vi.fn().mockResolvedValue(undefined),
  };
});

import { discoverHlsUrls } from "../core/hls.js";

const mockDiscoverHlsUrls = vi.mocked(discoverHlsUrls);

describe("POST /api/v1/hls/discover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDiscoverHlsUrls.mockResolvedValue({
      page_url: "https://example.com/watch",
      page_title: "Test Video Page",
      streams: [{ url: "https://cdn.example.com/master.m3u8", source: "script_tag" }],
    });
  });

  it("returns 400 VALIDATION_ERROR for an invalid url (not a raw Zod error)", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hls/discover",
      headers: { "content-type": "application/json" },
      payload: { url: "not-a-url" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(mockDiscoverHlsUrls).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 200 with discovered streams for a valid url", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hls/discover",
      headers: { "content-type": "application/json" },
      payload: { url: "https://example.com/watch" },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { page_url: string };
    expect(body.page_url).toBe("https://example.com/watch");

    await app.close();
  });
});
