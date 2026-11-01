import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../app.js";
import { createTestEnv } from "../test/env.js";
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
    rename: vi.fn().mockResolvedValue(undefined),
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
    "/data/jobs/cap_0000abcd/sheets/sheet_001.jpg",
    "/data/jobs/cap_0000abcd/sheets/sheet_002.jpg",
  ],
  sheetCount: 2,
  sheets: [],
  mode: 4,
  grid: "2x2",
};

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
          "/data/jobs/cap_0000abc0/frames/frame_0001.jpg",
          "/data/jobs/cap_0000abc0/frames/frame_0002.jpg",
          "/data/jobs/cap_0000abc0/frames/frame_0003.jpg",
          "/data/jobs/cap_0000abc0/frames/frame_0004.jpg",
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
    const job = await app.jobManager.createJob("cap_0000e815", { type: "extract" });
    job.status = "completed";

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/compose",
      headers: { "content-type": "application/json" },
      payload: {
        job_id: "cap_0000e815",
        mode: 4,
      },
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body["job_id"]).toBe("cap_0000e815");
    expect(body["status"]).toBe("completed");

    await app.close();
  });

  it("returns 404 for a job_id that is not a real job", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/compose",
      headers: { "content-type": "application/json" },
      payload: { job_id: "cap_0000dea0", mode: 4 },
    });

    expect(response.statusCode).toBe(404);
    expect(mockComposeGrid).not.toHaveBeenCalled();

    await app.close();
  });

  it.each(["../target", "..\\target", "cap_abc/../../x", "/etc", "C:\\Windows", "cap_ABCDEF12"])(
    "returns 400 for job_id %s and touches nothing",
    async (jobId) => {
      const app = await buildApp({ env: createTestEnv(), logger: false });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/compose",
        headers: { "content-type": "application/json" },
        payload: { job_id: jobId, mode: 4 },
      });

      expect(response.statusCode).toBe(400);
      expect(mockReaddir).not.toHaveBeenCalledWith(
        expect.stringContaining("target"),
      );
      expect(mockComposeGrid).not.toHaveBeenCalled();

      await app.close();
    },
  );

  it("returns 409 while the job is still running", async () => {
    const app = await buildApp({ env: createTestEnv(), logger: false });
    const job = await app.jobManager.createJob("cap_0000e815", { type: "extract" });
    job.status = "processing";

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/compose",
      headers: { "content-type": "application/json" },
      payload: { job_id: "cap_0000e815", mode: 4 },
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error.code).toBe("JOB_BUSY");

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
        job_id: "cap_0000abc0",
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
