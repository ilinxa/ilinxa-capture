import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../app.js";
import type { Env } from "../lib/env.js";
import type { CompositionResult } from "../core/composer.js";

// Mock core modules
vi.mock("../core/composer.js", () => ({
  composeGrid: vi.fn(),
}));

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

import { composeGrid } from "../core/composer.js";
import { readdir } from "node:fs/promises";

const mockComposeGrid = vi.mocked(composeGrid);
const mockReaddir = vi.mocked(readdir);

const sampleCompositionResult: CompositionResult = {
  sheetFiles: [
    "/data/jobs/cap_test1234/sheets/sheet_001.jpg",
    "/data/jobs/cap_test1234/sheets/sheet_002.jpg",
  ],
  sheetCount: 2,
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

describe("POST /api/v1/compose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComposeGrid.mockResolvedValue(sampleCompositionResult);
    // Default readdir to ENOENT for JobManager recovery
    mockReaddir.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
  });

  it("returns composition result for frames array input", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/compose",
      headers: { "content-type": "application/json" },
      payload: {
        frames: [
          "/data/jobs/cap_abc/frames/frame_0001.jpg",
          "/data/jobs/cap_abc/frames/frame_0002.jpg",
          "/data/jobs/cap_abc/frames/frame_0003.jpg",
          "/data/jobs/cap_abc/frames/frame_0004.jpg",
        ],
        mode: 4,
      },
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body["job_id"]).toMatch(/^cap_/);
    expect(body["status"]).toBe("completed");
    expect(body["sheets"]).toBeDefined();
    expect(typeof body["processing_time_ms"]).toBe("number");

    const sheets = body["sheets"] as {
      count: number;
      mode: number;
      grid: string;
      files: string[];
      urls: string[];
    };
    expect(sheets.count).toBe(2);
    expect(sheets.mode).toBe(4);
    expect(sheets.grid).toBe("2x2");
    expect(sheets.files).toHaveLength(2);
    expect(sheets.urls).toHaveLength(2);

    expect(mockComposeGrid).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("returns composition result for job_id input", async () => {
    mockReaddir.mockResolvedValue([
      "frame_0001.jpg",
      "frame_0002.jpg",
      "frame_0003.jpg",
      "frame_0004.jpg",
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/compose",
      headers: { "content-type": "application/json" },
      payload: {
        job_id: "cap_existing",
        mode: 4,
      },
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body["job_id"]).toBe("cap_existing");
    expect(body["status"]).toBe("completed");

    await app.close();
  });

  it("returns 400 for missing mode", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/compose",
      headers: { "content-type": "application/json" },
      payload: {
        frames: ["/data/frames/frame_0001.jpg"],
      },
    });

    expect(response.statusCode).toBe(400);

    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");

    await app.close();
  });

  it("returns 400 for invalid mode", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/compose",
      headers: { "content-type": "application/json" },
      payload: {
        frames: ["/data/frames/frame_0001.jpg"],
        mode: 3,
      },
    });

    expect(response.statusCode).toBe(400);

    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");

    await app.close();
  });

  it("returns 400 when both job_id and frames provided", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/compose",
      headers: { "content-type": "application/json" },
      payload: {
        job_id: "cap_abc",
        frames: ["/data/frames/frame_0001.jpg"],
        mode: 4,
      },
    });

    expect(response.statusCode).toBe(400);

    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");

    await app.close();
  });

  it("returns 400 when neither job_id nor frames provided", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/compose",
      headers: { "content-type": "application/json" },
      payload: {
        mode: 4,
      },
    });

    expect(response.statusCode).toBe(400);

    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");

    await app.close();
  });

  it("returns 400 when overlay_timestamp enabled without fps", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/compose",
      headers: { "content-type": "application/json" },
      payload: {
        frames: ["/data/frames/frame_0001.jpg"],
        mode: 4,
        overlay_timestamp: true,
      },
    });

    expect(response.statusCode).toBe(400);

    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");

    await app.close();
  });

  it("existing endpoints still work", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const healthRes = await app.inject({
      method: "GET",
      url: "/api/v1/health",
    });
    expect(healthRes.statusCode).toBe(200);

    await app.close();
  });
});
