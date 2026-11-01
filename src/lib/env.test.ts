import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv, loadEnv, resetEnvCache } from "./env.js";

describe("loadDotEnv", () => {
  // loadEnvFile writes to the real environment, whatever object is assigned to
  // process.env, so these restore what they touch.
  const KEY = "ILINXA_CAPTURE_ENV_TEST";
  const nodeEnv = process.env["NODE_ENV"];
  let dir: string;
  let file: string;

  beforeEach(() => {
    delete process.env[KEY];
    dir = mkdtempSync(join(tmpdir(), "ilinxa-env-"));
    file = join(dir, ".env");
  });

  afterEach(() => {
    delete process.env[KEY];
    process.env["NODE_ENV"] = nodeEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads settings from the file", () => {
    writeFileSync(file, `${KEY}=42\n`);

    loadDotEnv(file);

    expect(process.env[KEY]).toBe("42");
  });

  it("lets the real environment win", () => {
    process.env[KEY] = "7";
    writeFileSync(file, `${KEY}=42\n`);

    loadDotEnv(file);

    expect(process.env[KEY]).toBe("7");
  });

  // Regression: a checkout's development .env trusted the Vite origins on a
  // plain `npm start`.
  it("never takes NODE_ENV from the file", () => {
    delete process.env["NODE_ENV"];
    writeFileSync(file, "NODE_ENV=development\n");

    loadDotEnv(file);

    expect(process.env["NODE_ENV"]).toBeUndefined();
  });

  it("is fine with no file", () => {
    expect(() => loadDotEnv(join(dir, "missing"))).not.toThrow();
  });
});

describe("loadEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    resetEnvCache();
    // Start with a clean env for each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    resetEnvCache();
  });

  it("returns defaults when no env vars are set", () => {
    const env = loadEnv();

    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe("127.0.0.1");
    // Vitest sets NODE_ENV=test automatically
    expect(env.NODE_ENV).toBe("test");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.STORAGE_MODE).toBe("local");
    expect(env.LOCAL_OUTPUT_DIR).toBe("./data/jobs");
    expect(env.LOCAL_TTL_SECONDS).toBe(86400);
    expect(env.MAX_VIDEO_DURATION).toBe(600);
    expect(env.MAX_UPLOAD_SIZE).toBe(524288000);
    expect(env.MAX_CONCURRENT_JOBS).toBe(3);
    expect(env.JOB_TIMEOUT).toBe(300);
    expect(env.MCP_SESSION_TTL).toBe(1800);
  });

  it("coerces numeric string values", () => {
    process.env["PORT"] = "4000";
    process.env["MAX_VIDEO_DURATION"] = "1200";

    const env = loadEnv();

    expect(env.PORT).toBe(4000);
    expect(env.MAX_VIDEO_DURATION).toBe(1200);
  });

  it("defaults to production, so only npm run dev gets development behavior", () => {
    delete process.env["NODE_ENV"];
    expect(loadEnv().NODE_ENV).toBe("production");
  });

  it("refuses a JOB_TIMEOUT too long for a Node timer", () => {
    process.env["JOB_TIMEOUT"] = "2147484";
    expect(() => loadEnv()).toThrow("JOB_TIMEOUT");
    delete process.env["JOB_TIMEOUT"];
  });

  it("validates NODE_ENV enum", () => {
    process.env["NODE_ENV"] = "invalid";

    expect(() => loadEnv()).toThrow("Invalid environment variables");
  });

  it("validates LOG_LEVEL enum", () => {
    process.env["LOG_LEVEL"] = "verbose";

    expect(() => loadEnv()).toThrow("Invalid environment variables");
  });

  it("passes when STORAGE_MODE=local without S3 vars", () => {
    process.env["STORAGE_MODE"] = "local";

    const env = loadEnv();
    expect(env.STORAGE_MODE).toBe("local");
  });

  it("throws when STORAGE_MODE=s3 without required S3 vars", () => {
    process.env["STORAGE_MODE"] = "s3";

    expect(() => loadEnv()).toThrow(
      "S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY are required when STORAGE_MODE=s3",
    );
  });

  it("passes when STORAGE_MODE=s3 with all required S3 vars", () => {
    process.env["STORAGE_MODE"] = "s3";
    process.env["S3_BUCKET"] = "test-bucket";
    process.env["S3_REGION"] = "us-east-1";
    process.env["S3_ACCESS_KEY_ID"] = "test-key";
    process.env["S3_SECRET_ACCESS_KEY"] = "test-secret";

    const env = loadEnv();
    expect(env.STORAGE_MODE).toBe("s3");
    expect(env.S3_BUCKET).toBe("test-bucket");
  });

  it("caches the result on subsequent calls", () => {
    const env1 = loadEnv();
    const env2 = loadEnv();

    expect(env1).toBe(env2); // Same reference
  });

  it("returns fresh result after resetEnvCache", () => {
    const env1 = loadEnv();
    resetEnvCache();
    process.env["PORT"] = "5000";
    const env2 = loadEnv();

    expect(env1.PORT).toBe(3000);
    expect(env2.PORT).toBe(5000);
  });
});
