import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../app.js";
import { createTestEnv } from "../test/env.js";
import type { VideoMetadata } from "../core/metadata.js";

// Mock the core metadata module to avoid needing real ffprobe
vi.mock("../core/metadata.js", () => ({
  getVideoMetadata: vi.fn(),
}));

vi.mock("../core/downloader.js", () => ({
  isUrl: vi.fn(
    (s: string) => s.startsWith("http://") || s.startsWith("https://"),
  ),
  downloadVideo: vi.fn().mockResolvedValue("/tmp/ilinxa-capture-dl-mock.mp4"),
}));

// Mock fs/promises for JobManager recovery on buildApp()
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

import { getVideoMetadata } from "../core/metadata.js";
import { downloadVideo } from "../core/downloader.js";

const mockGetVideoMetadata = vi.mocked(getVideoMetadata);
const mockDownloadVideo = vi.mocked(downloadVideo);

const sampleMetadata: VideoMetadata = {
  duration: 65.3,
  width: 1920,
  height: 1080,
  fps: 29.97,
  codec: "h264",
  size_bytes: 15234567,
  format: "mov",
};

describe("POST /api/v1/metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns metadata for JSON body with URL source", async () => {
    mockGetVideoMetadata.mockResolvedValue(sampleMetadata);

    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/metadata",
      headers: { "content-type": "application/json" },
      payload: { source: "https://example.com/video.mp4" },
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as VideoMetadata;
    expect(body).toEqual(sampleMetadata);
    expect(mockDownloadVideo).toHaveBeenCalledWith(
      "https://example.com/video.mp4",
      expect.anything(),
    );
    expect(mockGetVideoMetadata).toHaveBeenCalledWith(
      "/tmp/ilinxa-capture-dl-mock.mp4",
      expect.anything(),
    );

    await app.close();
  });

  it("returns 400 for JSON body without source", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/metadata",
      headers: { "content-type": "application/json" },
      payload: {},
    });

    expect(response.statusCode).toBe(400);

    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");

    await app.close();
  });

  it("returns 400 for JSON body with empty source", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/metadata",
      headers: { "content-type": "application/json" },
      payload: { source: "" },
    });

    expect(response.statusCode).toBe(400);

    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");

    await app.close();
  });

  it("returns metadata for multipart file upload", async () => {
    mockGetVideoMetadata.mockResolvedValue(sampleMetadata);

    const app = await buildApp({ env: createTestEnv(), logger: false });

    const boundary = "----FormBoundary" + Date.now();
    const fileContent = Buffer.from("fake video content");
    const multipartBody = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="source"; filename="test.mp4"',
      "Content-Type: video/mp4",
      "",
      fileContent.toString(),
      `--${boundary}--`,
    ].join("\r\n");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/metadata",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody,
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as VideoMetadata;
    expect(body).toEqual(sampleMetadata);
    expect(mockGetVideoMetadata).toHaveBeenCalledTimes(1);

    // Verify it was called with a temp file path
    const calledWith = mockGetVideoMetadata.mock.calls[0]?.[0] ?? "";
    expect(calledWith).toContain("ilinxa-capture-");

    await app.close();
  });

  it("health endpoint still works", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });
});
