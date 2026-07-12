import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "./app.js";
import type { Env } from "./lib/env.js";

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

describe("buildApp", () => {
  let env: Env;

  beforeEach(() => {
    env = createTestEnv();
  });

  it("creates a Fastify instance", async () => {
    const app = await buildApp({ env, logger: false });
    expect(app).toBeDefined();
    await app.close();
  });

  it("GET /api/v1/health returns 200 with correct shape", async () => {
    const app = await buildApp({ env, logger: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "ok",
      version: expect.any(String),
      environment: "test",
    });
    expect(typeof body["uptime"]).toBe("number");

    await app.close();
  });

  it("unknown route returns 404 with error shape", async () => {
    const app = await buildApp({ env, logger: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/does-not-exist",
    });

    expect(response.statusCode).toBe(404);

    const body = JSON.parse(response.body) as { error: { code: string; message: string } };
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Route not found");

    await app.close();
  });
});
