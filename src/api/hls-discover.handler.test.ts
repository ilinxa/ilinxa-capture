import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../app.js";
import type { Env } from "../lib/env.js";

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

function createTestEnv(overrides?: Partial<Env>): Env {
  return {
    PORT: 3000,
    HOST: "0.0.0.0",
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    STORAGE_MODE: "local",
    LOCAL_OUTPUT_DIR: "./data/jobs",
    LOCAL_TTL_SECONDS: 3600,
    S3_BUCKET: undefined,
    S3_REGION: undefined,
    S3_ACCESS_KEY_ID: undefined,
    S3_SECRET_ACCESS_KEY: undefined,
    S3_ENDPOINT: undefined,
    S3_URL_EXPIRY: undefined,
    MAX_VIDEO_DURATION: 600,
    MAX_UPLOAD_SIZE: 524288000,
    MAX_CONCURRENT_JOBS: 3,
    JOB_TIMEOUT: 300,
    MCP_SESSION_TTL: 1800,
    UI_DIR: "./ui/dist",
    ...overrides,
  };
}

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
