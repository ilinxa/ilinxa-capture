import type { Env } from "../lib/env.js";

/** Env for tests. Local paths are open so tests can use fixture paths freely. */
export function createTestEnv(overrides?: Partial<Env>): Env {
  return {
    PORT: 3000,
    HOST: "127.0.0.1",
    ALLOWED_HOSTS: "",
    ALLOWED_ORIGINS: "",
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
    ALLOWED_INPUT_DIRS: "*",
    MAX_VIDEO_DURATION: 600,
    MAX_UPLOAD_SIZE: 524288000,
    MAX_CONCURRENT_JOBS: 3,
    JOB_TIMEOUT: 300,
    MAX_SHEET_EDGE: 2000,
    MCP_SESSION_TTL: 1800,
    UI_DIR: "./ui/dist",
    ...overrides,
  };
}
