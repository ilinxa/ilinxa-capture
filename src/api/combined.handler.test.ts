import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../app.js";
import type { Env } from "../lib/env.js";
import type { ExtractionResult } from "../core/extractor.js";
import type { VideoMetadata } from "../core/metadata.js";
import type { CompositionResult } from "../core/composer.js";

// Mock core modules
vi.mock("../core/metadata.js", () => ({
  getVideoMetadata: vi.fn(),
}));

vi.mock("../core/extractor.js", () => ({
  extractFrames: vi.fn(),
}));

vi.mock("../core/composer.js", () => ({
  composeGrid: vi.fn(),
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
import { composeGrid } from "../core/composer.js";

const mockGetVideoMetadata = vi.mocked(getVideoMetadata);
const mockExtractFrames = vi.mocked(extractFrames);
const mockComposeGrid = vi.mocked(composeGrid);

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
    "/data/jobs/cap_test1234/frames/frame_0004.jpg",
  ],
  frameCount: 4,
};

const sampleCompositionResult: CompositionResult = {
  sheetFiles: [
    "/data/jobs/cap_test1234/sheets/sheet_001.jpg",
  ],
  sheetCount: 1,
  mode: 4,
  grid: "2x2",
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

describe("POST /api/v1/extract-and-compose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVideoMetadata.mockResolvedValue(sampleMetadata);
    mockExtractFrames.mockResolvedValue(sampleExtractionResult);
    mockComposeGrid.mockResolvedValue(sampleCompositionResult);
  });

  it("returns combined result for JSON body", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/extract-and-compose",
      headers: { "content-type": "application/json" },
      payload: {
        source: "https://example.com/video.mp4",
        fps: 5,
        mode: 4,
      },
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body["job_id"]).toMatch(/^cap_/);
    expect(body["status"]).toBe("completed");
    expect(body["frames"]).toBeDefined();
    expect(body["sheets"]).toBeDefined();
    expect(body["source_metadata"]).toBeDefined();
    expect(typeof body["processing_time_ms"]).toBe("number");

    const frames = body["frames"] as { count: number; files: string[]; urls: string[] };
    expect(frames.count).toBe(4);
    expect(frames.files).toHaveLength(4);
    expect(frames.urls).toHaveLength(4);

    const sheets = body["sheets"] as {
      count: number;
      mode: number;
      grid: string;
      files: string[];
      urls: string[];
    };
    expect(sheets.count).toBe(1);
    expect(sheets.mode).toBe(4);
    expect(sheets.grid).toBe("2x2");

    await app.close();
  });

  it("returns combined result for multipart upload", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const boundary = "----FormBoundary" + Date.now();
    const fileContent = Buffer.from("fake video content");
    const multipartBody = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="source"; filename="test.mp4"',
      "Content-Type: video/mp4",
      "",
      fileContent.toString(),
      `--${boundary}`,
      'Content-Disposition: form-data; name="fps"',
      "",
      "5",
      `--${boundary}`,
      'Content-Disposition: form-data; name="mode"',
      "",
      "4",
      `--${boundary}--`,
    ].join("\r\n");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/extract-and-compose",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody,
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body["job_id"]).toMatch(/^cap_/);
    expect(body["status"]).toBe("completed");
    expect(body["frames"]).toBeDefined();
    expect(body["sheets"]).toBeDefined();

    await app.close();
  });

  it("returns 400 for missing mode", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/extract-and-compose",
      headers: { "content-type": "application/json" },
      payload: {
        source: "https://example.com/video.mp4",
        fps: 5,
      },
    });

    expect(response.statusCode).toBe(400);

    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");

    await app.close();
  });

  it("returns 413 when video exceeds max duration", async () => {
    mockGetVideoMetadata.mockResolvedValue({
      ...sampleMetadata,
      duration: 700,
    });

    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/extract-and-compose",
      headers: { "content-type": "application/json" },
      payload: {
        source: "https://example.com/video.mp4",
        fps: 5,
        mode: 4,
      },
    });

    expect(response.statusCode).toBe(413);

    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("VIDEO_TOO_LONG");

    await app.close();
  });

  it("calls extract then compose in order", async () => {
    const callOrder: string[] = [];
    mockExtractFrames.mockImplementation(async () => {
      callOrder.push("extract");
      return sampleExtractionResult;
    });
    mockComposeGrid.mockImplementation(async () => {
      callOrder.push("compose");
      return sampleCompositionResult;
    });

    const app = await buildApp({ env: createTestEnv(), logger: false });

    await app.inject({
      method: "POST",
      url: "/api/v1/extract-and-compose",
      headers: { "content-type": "application/json" },
      payload: {
        source: "https://example.com/video.mp4",
        fps: 5,
        mode: 4,
      },
    });

    expect(callOrder).toEqual(["extract", "compose"]);
    expect(mockExtractFrames).toHaveBeenCalledTimes(1);
    expect(mockComposeGrid).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("returns 202 for async request", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/extract-and-compose",
      headers: { "content-type": "application/json" },
      payload: {
        source: "https://example.com/video.mp4",
        fps: 5,
        mode: 4,
        async: true,
      },
    });

    expect(response.statusCode).toBe(202);

    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body["status"]).toBe("pending");
    expect(body["poll_url"]).toMatch(/\/api\/v1\/jobs\/cap_/);

    // Wait for background task to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Poll for completion
    const pollResponse = await app.inject({
      method: "GET",
      url: body["poll_url"] as string,
    });
    expect(pollResponse.statusCode).toBe(200);

    const pollBody = JSON.parse(pollResponse.body) as Record<string, unknown>;
    expect(pollBody["status"]).toBe("completed");

    await app.close();
  });
});
