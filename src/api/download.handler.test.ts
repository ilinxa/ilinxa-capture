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

function createFakeStream(data = "fake file data"): ReadStream {
  const stream = new PassThrough();
  stream.end(Buffer.from(data));
  return stream as unknown as ReadStream;
}

const sampleFrameFiles: FileInfo[] = [
  { path: "/data/jobs/cap_test/frames/frame_0001.jpg", relativePath: "frames/frame_0001.jpg", size: 1000 },
  { path: "/data/jobs/cap_test/frames/frame_0002.jpg", relativePath: "frames/frame_0002.jpg", size: 1000 },
];

const sampleSheetFiles: FileInfo[] = [
  { path: "/data/jobs/cap_test/sheets/sheet_001.jpg", relativePath: "sheets/sheet_001.jpg", size: 2000 },
];

function createMockStorage(): Storage {
  return {
    fileExists: vi.fn().mockResolvedValue(true),
    readFile: vi.fn().mockResolvedValue(Buffer.from("fake file data")),
    getFileStream: vi.fn().mockImplementation(() => createFakeStream()),
    getFileInfo: vi.fn().mockResolvedValue({
      path: "/data/jobs/cap_test/frames/frame_0001.jpg",
      relativePath: "frames/frame_0001.jpg",
      size: 1000,
    } satisfies FileInfo),
    listFiles: vi.fn().mockResolvedValue([...sampleFrameFiles, ...sampleSheetFiles]),
    deleteJobDir: vi.fn().mockResolvedValue(undefined),
    getJobDir: vi.fn().mockReturnValue("/data/jobs/cap_test"),
  };
}

describe("GET /api/v1/jobs/:id/download", () => {
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

  async function buildAppWithCompletedJob() {
    const app = await buildApp({
      env: createTestEnv(),
      logger: false,
      storage: mockStorage,
    });

    // Create a completed job by posting an extract request
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/extract",
      headers: { "content-type": "application/json" },
      payload: { source: "https://example.com/video.mp4", fps: 5 },
    });

    const body = JSON.parse(response.body) as { job_id: string };
    return { app, jobId: body.job_id };
  }

  it("returns 200 with application/zip content-type", async () => {
    const { app, jobId } = await buildAppWithCompletedJob();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/jobs/${jobId}/download`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");

    await app.close();
  });

  it("returns correct content-disposition filename", async () => {
    const { app, jobId } = await buildAppWithCompletedJob();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/jobs/${jobId}/download`,
    });

    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename="${jobId}-all.zip"`,
    );

    await app.close();
  });

  it("returns 404 for unknown job", async () => {
    const app = await buildApp({
      env: createTestEnv(),
      logger: false,
      storage: mockStorage,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/jobs/cap_nonexistent/download",
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("JOB_NOT_FOUND");

    await app.close();
  });

  it("returns 400 when job is not completed", async () => {
    const app = await buildApp({
      env: createTestEnv(),
      logger: false,
      storage: mockStorage,
    });

    // Create an async job (status: pending)
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
      url: `/api/v1/jobs/${postBody.job_id}/download`,
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");

    await app.close();
  });

  it("returns 400 for empty file list", async () => {
    vi.mocked(mockStorage.listFiles).mockResolvedValue([]);

    const { app, jobId } = await buildAppWithCompletedJob();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/jobs/${jobId}/download`,
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");

    await app.close();
  });

  it("default include is 'all'", async () => {
    const { app, jobId } = await buildAppWithCompletedJob();

    await app.inject({
      method: "GET",
      url: `/api/v1/jobs/${jobId}/download`,
    });

    expect(vi.mocked(mockStorage.listFiles)).toHaveBeenCalledWith(
      jobId,
      undefined,
    );

    await app.close();
  });

  it("include=frames filters correctly", async () => {
    vi.mocked(mockStorage.listFiles).mockResolvedValue(sampleFrameFiles);

    const { app, jobId } = await buildAppWithCompletedJob();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/jobs/${jobId}/download?include=frames`,
    });

    expect(response.statusCode).toBe(200);
    expect(vi.mocked(mockStorage.listFiles)).toHaveBeenCalledWith(
      jobId,
      "frames",
    );
    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename="${jobId}-frames.zip"`,
    );

    await app.close();
  });

  it("include=sheets filters correctly", async () => {
    vi.mocked(mockStorage.listFiles).mockResolvedValue(sampleSheetFiles);

    const { app, jobId } = await buildAppWithCompletedJob();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/jobs/${jobId}/download?include=sheets`,
    });

    expect(response.statusCode).toBe(200);
    expect(vi.mocked(mockStorage.listFiles)).toHaveBeenCalledWith(
      jobId,
      "sheets",
    );
    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename="${jobId}-sheets.zip"`,
    );

    await app.close();
  });
});
