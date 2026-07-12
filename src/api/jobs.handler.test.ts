import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../app.js";
import type { Env } from "../lib/env.js";
import type { ExtractionResult } from "../core/extractor.js";
import type { VideoMetadata } from "../core/metadata.js";

// Mock core modules (needed for building the app and creating async jobs)
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

import { getVideoMetadata } from "../core/metadata.js";
import { extractFrames } from "../core/extractor.js";

const mockGetVideoMetadata = vi.mocked(getVideoMetadata);
const mockExtractFrames = vi.mocked(extractFrames);

const sampleMetadata: VideoMetadata = {
  duration: 60,
  width: 1920,
  height: 1080,
  fps: 29.97,
  codec: "h264",
  size_bytes: 15234567,
  format: "mov",
};

const sampleExtractionResult: ExtractionResult = {
  frameFiles: [
    "/data/jobs/cap_test1234/frames/frame_0001.jpg",
    "/data/jobs/cap_test1234/frames/frame_0002.jpg",
    "/data/jobs/cap_test1234/frames/frame_0003.jpg",
  ],
  frameCount: 3,
};

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

describe("Job endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVideoMetadata.mockResolvedValue(sampleMetadata);
    mockExtractFrames.mockResolvedValue(sampleExtractionResult);
  });

  describe("GET /api/v1/jobs/:id", () => {
    it("returns pending status for queued job", async () => {
      const app = await buildApp({ env: createTestEnv(), logger: false });

      // Create an async job
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/v1/extract",
        headers: { "content-type": "application/json" },
        payload: {
          source: "https://example.com/video.mp4",
          fps: 5,
          async: true,
        },
      });

      expect(createResponse.statusCode).toBe(202);
      const createBody = JSON.parse(createResponse.body) as Record<string, unknown>;
      const pollUrl = createBody["poll_url"] as string;

      // Wait for background task to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should now be completed
      const pollResponse = await app.inject({ method: "GET", url: pollUrl });
      expect(pollResponse.statusCode).toBe(200);

      const pollBody = JSON.parse(pollResponse.body) as Record<string, unknown>;
      expect(pollBody["status"]).toBe("completed");
      expect(pollBody["job_id"]).toBeDefined();

      await app.close();
    });

    it("returns failed status for errored job", async () => {
      mockExtractFrames.mockRejectedValue(new Error("ffmpeg crashed"));

      const app = await buildApp({ env: createTestEnv(), logger: false });

      // Create an async job that will fail
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/v1/extract",
        headers: { "content-type": "application/json" },
        payload: {
          source: "https://example.com/video.mp4",
          fps: 5,
          async: true,
        },
      });

      expect(createResponse.statusCode).toBe(202);
      const createBody = JSON.parse(createResponse.body) as Record<string, unknown>;
      const pollUrl = createBody["poll_url"] as string;

      // Wait for background task to fail
      await new Promise((resolve) => setTimeout(resolve, 50));

      const pollResponse = await app.inject({ method: "GET", url: pollUrl });
      expect(pollResponse.statusCode).toBe(200);

      const pollBody = JSON.parse(pollResponse.body) as Record<string, unknown>;
      expect(pollBody["status"]).toBe("failed");
      expect(pollBody["error"]).toBe("ffmpeg crashed");

      await app.close();
    });

    it("returns 404 for unknown job", async () => {
      const app = await buildApp({ env: createTestEnv(), logger: false });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/jobs/cap_unknown",
      });

      expect(response.statusCode).toBe(404);

      const body = JSON.parse(response.body) as { error: { code: string } };
      expect(body.error.code).toBe("JOB_NOT_FOUND");

      await app.close();
    });
  });

  describe("DELETE /api/v1/jobs/:id", () => {
    it("returns 204 for existing job", async () => {
      const app = await buildApp({ env: createTestEnv(), logger: false });

      // Create an async job first
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/v1/extract",
        headers: { "content-type": "application/json" },
        payload: {
          source: "https://example.com/video.mp4",
          fps: 5,
          async: true,
        },
      });

      const createBody = JSON.parse(createResponse.body) as Record<string, unknown>;
      const jobId = createBody["job_id"] as string;

      // Wait for completion
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Delete the job
      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/v1/jobs/${jobId}`,
      });

      expect(deleteResponse.statusCode).toBe(204);

      // Verify it's gone
      const getResponse = await app.inject({
        method: "GET",
        url: `/api/v1/jobs/${jobId}`,
      });

      expect(getResponse.statusCode).toBe(404);

      await app.close();
    });

    it("returns 404 for unknown job", async () => {
      const app = await buildApp({ env: createTestEnv(), logger: false });

      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/jobs/cap_unknown",
      });

      expect(response.statusCode).toBe(404);

      const body = JSON.parse(response.body) as { error: { code: string } };
      expect(body.error.code).toBe("JOB_NOT_FOUND");

      await app.close();
    });
  });
});
