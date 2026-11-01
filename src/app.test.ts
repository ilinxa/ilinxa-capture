import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "./app.js";
import { createTestEnv } from "./test/env.js";

// Mock fs/promises for JobManager recovery on buildApp()
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

  // Regression: it read process.env and fell back to "development", so a server
  // running with production defaults described itself as development.
  it("health reports the environment the server resolved", async () => {
    const app = await buildApp({ env: createTestEnv({ NODE_ENV: "production" }), logger: false });

    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect((JSON.parse(response.body) as { environment: string }).environment).toBe("production");

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
