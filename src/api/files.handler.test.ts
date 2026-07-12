import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { buildApp } from "../app.js";
import type { Env } from "../lib/env.js";
import type { Storage, FileInfo } from "../core/storage.js";
import type { ReadStream } from "node:fs";

// Mock core modules for creating jobs via POST /extract
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

function createFakeStream(data = "fake image data"): ReadStream {
  const stream = new PassThrough();
  stream.end(Buffer.from(data));
  return stream as unknown as ReadStream;
}

function createMockStorage(): Storage {
  return {
    fileExists: vi.fn().mockResolvedValue(true),
    readFile: vi.fn().mockResolvedValue(Buffer.from("fake image data")),
    getFileStream: vi.fn().mockImplementation(() => createFakeStream()),
    getFileInfo: vi.fn().mockResolvedValue({
      path: "/data/jobs/cap_test/frames/frame_0001.jpg",
      relativePath: "frames/frame_0001.jpg",
      size: 12345,
    } satisfies FileInfo),
    listFiles: vi.fn().mockResolvedValue([]),
    deleteJobDir: vi.fn().mockResolvedValue(undefined),
    getJobDir: vi.fn().mockReturnValue("/data/jobs/cap_test"),
  };
}

describe("GET /api/v1/files/:jobId/*", () => {
  let mockStorage: Storage;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage = createMockStorage();

    mockGetVideoMetadata.mockResolvedValue({
      duration: 60,
      width: 1920,
      height: 1080,
      fps: 29.97,
      codec: "h264",
      size_bytes: 15234567,
      format: "mov",
    });
    mockExtractFrames.mockResolvedValue({
      frameFiles: ["/data/jobs/cap_test/frames/frame_0001.jpg"],
      frameCount: 1,
    });
  });

  async function buildAppWithJob() {
    const app = await buildApp({
      env: createTestEnv(),
      logger: false,
      storage: mockStorage,
    });

    // Create a job by posting an extract request
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/extract",
      headers: { "content-type": "application/json" },
      payload: { source: "https://example.com/video.mp4", fps: 5 },
    });

    const body = JSON.parse(response.body) as { job_id: string };
    return { app, jobId: body.job_id };
  }

  it("returns 200 with image/jpeg for .jpg file", async () => {
    const { app, jobId } = await buildAppWithJob();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/files/${jobId}/frames/frame_0001.jpg`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");

    await app.close();
  });

  it("returns 200 with image/png for .png file", async () => {
    const { app, jobId } = await buildAppWithJob();

    vi.mocked(mockStorage.getFileInfo).mockResolvedValue({
      path: "/data/jobs/cap_test/frames/frame_0001.png",
      relativePath: "frames/frame_0001.png",
      size: 54321,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/files/${jobId}/frames/frame_0001.png`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");

    await app.close();
  });

  it("returns 404 JOB_NOT_FOUND for unknown job", async () => {
    const app = await buildApp({
      env: createTestEnv(),
      logger: false,
      storage: mockStorage,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/files/cap_nonexistent/frames/frame_0001.jpg",
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("JOB_NOT_FOUND");

    await app.close();
  });

  it("returns 404 FILE_NOT_FOUND for missing file in valid job", async () => {
    const { app, jobId } = await buildAppWithJob();

    vi.mocked(mockStorage.fileExists).mockResolvedValue(false);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/files/${jobId}/frames/nonexistent.jpg`,
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("FILE_NOT_FOUND");

    await app.close();
  });

  it("sets cache-control header", async () => {
    const { app, jobId } = await buildAppWithJob();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/files/${jobId}/frames/frame_0001.jpg`,
    });

    expect(response.headers["cache-control"]).toBe("public, max-age=3600");

    await app.close();
  });

  it("calls readFile for valid request", async () => {
    const { app, jobId } = await buildAppWithJob();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/files/${jobId}/frames/frame_0001.jpg`,
    });

    expect(response.statusCode).toBe(200);
    expect(vi.mocked(mockStorage.readFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mockStorage.readFile)).toHaveBeenCalledWith(
      jobId,
      "frames/frame_0001.jpg",
    );

    await app.close();
  });

  it("returns 400 VALIDATION_ERROR when job is not completed (matches download handler)", async () => {
    const app = await buildApp({
      env: createTestEnv(),
      logger: false,
      storage: mockStorage,
    });

    // Create an async job — status is "pending"/"processing", not "completed"
    const postResponse = await app.inject({
      method: "POST",
      url: "/api/v1/extract",
      headers: { "content-type": "application/json" },
      payload: {
        source: "https://example.com/video.mp4",
        fps: 5,
        async: true,
      },
    });

    const postBody = JSON.parse(postResponse.body) as { job_id: string };

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/files/${postBody.job_id}/frames/frame_0001.jpg`,
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");

    await app.close();
  });

  it("returns error when storage throws on path traversal", async () => {
    const { app, jobId } = await buildAppWithJob();

    vi.mocked(mockStorage.fileExists).mockRejectedValue(
      Object.assign(new Error("Path traversal detected"), {
        statusCode: 400,
        code: "VALIDATION_ERROR",
      }),
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/files/${jobId}/frames/../../../etc/passwd`,
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);

    await app.close();
  });
});
