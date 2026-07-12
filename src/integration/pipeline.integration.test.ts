import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { buildApp } from "../app.js";
import type { Env } from "../lib/env.js";
import type { FastifyInstance } from "fastify";

const execFileAsync = promisify(execFile);

/**
 * REAL-BINARY integration tier — no mocks. Exercises the full pipeline
 * (ffmpeg extraction, sharp composition, real filesystem, real HTTP) against
 * a running Fastify instance. Run via `npm run test:integration`.
 *
 * Uses real fetch() against a listening server rather than app.inject(),
 * because app.inject() does not reliably deliver streamed response bodies
 * (ZIP download, file serving) — see MEMORY.md "Stream Testing" note.
 */
function createIntegrationEnv(overrides: Partial<Env>): Env {
  return {
    PORT: 3000,
    HOST: "127.0.0.1",
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
    UI_DIR: "./ui/dist-does-not-exist", // force API-only mode
    ...overrides,
  };
}

describe("pipeline integration (real ffmpeg/ffprobe/sharp)", () => {
  let scratchDir: string;
  let jobsDir: string;
  let videoPath: string;
  let app: FastifyInstance;
  let baseUrl: string;

  // Shared state threaded through the sequential tests below.
  let extractJobId: string;
  let extractFrameCount: number;
  let firstFrameFilename: string;
  let firstFrameWidth: number;

  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "ilinxa-capture-itest-"));
    jobsDir = join(scratchDir, "jobs");
    videoPath = join(scratchDir, "test.mp4");

    const commonArgs = [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=4:size=320x240:rate=10",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
    ];

    try {
      await execFileAsync("ffmpeg", [
        ...commonArgs,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        videoPath,
      ]);
    } catch {
      // Fall back to mpeg4 if this ffmpeg build lacks libx264.
      await execFileAsync("ffmpeg", [
        ...commonArgs,
        "-c:v",
        "mpeg4",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        videoPath,
      ]);
    }

    const env = createIntegrationEnv({ LOCAL_OUTPUT_DIR: jobsDir });
    app = await buildApp({ env, logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (scratchDir) {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it("1. metadata — POST /api/v1/metadata returns real ffprobe metadata", async () => {
    const videoBuffer = await readFile(videoPath);
    const form = new FormData();
    form.append(
      "source",
      new Blob([videoBuffer], { type: "video/mp4" }),
      "test.mp4",
    );

    const res = await fetch(`${baseUrl}/api/v1/metadata`, {
      method: "POST",
      body: form,
    });

    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      duration: number;
      width: number;
      height: number;
    };

    expect(body.duration).toBeGreaterThanOrEqual(3.5);
    expect(body.duration).toBeLessThanOrEqual(4.5);
    expect(body.width).toBe(320);
    expect(body.height).toBe(240);
  });

  it("2. extract — POST /api/v1/extract writes real frame files to disk", async () => {
    const videoBuffer = await readFile(videoPath);
    const form = new FormData();
    form.append(
      "source",
      new Blob([videoBuffer], { type: "video/mp4" }),
      "test.mp4",
    );
    form.append("fps", "2");
    form.append("preset", "llm");

    const res = await fetch(`${baseUrl}/api/v1/extract`, {
      method: "POST",
      body: form,
    });

    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      job_id: string;
      frames: { count: number; files: string[] };
    };

    expect(body.job_id).toMatch(/^cap_/);
    extractJobId = body.job_id;
    extractFrameCount = body.frames.count;

    // ~4s video @ 2fps ≈ 8 frames; tolerate ffmpeg rounding at boundaries.
    expect(extractFrameCount).toBeGreaterThanOrEqual(7);
    expect(extractFrameCount).toBeLessThanOrEqual(9);

    // The actual frame files must exist on the real filesystem.
    const framesDir = join(jobsDir, extractJobId, "frames");
    const filesOnDisk = (await readdir(framesDir)).sort();
    expect(filesOnDisk.length).toBe(extractFrameCount);

    firstFrameFilename = filesOnDisk[0]!;
    await access(join(framesDir, firstFrameFilename));

    // llm preset: width scaled to 1024, JPEG output.
    const meta = await sharp(join(framesDir, firstFrameFilename)).metadata();
    expect(meta.width).toBeLessThanOrEqual(1024);
    expect(meta.format).toBe("jpeg");
    firstFrameWidth = meta.width!;
  });

  it("3. compose — POST /api/v1/compose renders a real 2x2 grid sheet", async () => {
    const res = await fetch(`${baseUrl}/api/v1/compose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job_id: extractJobId,
        mode: 4,
        overlay_frame_number: true,
      }),
    });

    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      sheets: { count: number; files: string[] };
    };

    expect(body.sheets.count).toBe(Math.ceil(extractFrameCount / 4));

    const sheetsDir = join(jobsDir, extractJobId, "sheets");
    const sheetFiles = (await readdir(sheetsDir)).sort();
    expect(sheetFiles.length).toBe(body.sheets.count);

    const sheetMeta = await sharp(join(sheetsDir, sheetFiles[0]!)).metadata();
    // 2x2 grid: canvas width == 2 * single frame width.
    expect(sheetMeta.width).toBe(2 * firstFrameWidth);
    expect(sheetMeta.format).toBe("jpeg");
  });

  it("4. files — GET /api/v1/files/:jobId/frames/:file serves a real JPEG", async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/files/${extractJobId}/frames/${firstFrameFilename}`,
    );

    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toBe("image/jpeg");

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.byteLength).toBeGreaterThan(1000);
  });

  it("5. download — GET /api/v1/jobs/:id/download?include=all streams a real ZIP", async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/jobs/${extractJobId}/download?include=all`,
    );

    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toBe("application/zip");

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.byteLength).toBeGreaterThan(5000);
    // ZIP local file header magic: PK\x03\x04
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it("6. one-shot — POST /api/v1/extract-and-compose produces frames + sheets on disk", async () => {
    const videoBuffer = await readFile(videoPath);
    const form = new FormData();
    form.append(
      "source",
      new Blob([videoBuffer], { type: "video/mp4" }),
      "test.mp4",
    );
    form.append("fps", "1");
    form.append("mode", "4");

    const res = await fetch(`${baseUrl}/api/v1/extract-and-compose`, {
      method: "POST",
      body: form,
    });

    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      job_id: string;
      frames: { count: number; files: string[] };
      sheets: { count: number; files: string[] };
    };

    expect(body.job_id).toMatch(/^cap_/);
    expect(body.frames.count).toBeGreaterThan(0);
    expect(body.sheets.count).toBeGreaterThan(0);

    const firstSheetPath = body.sheets.files[0]!;
    await access(firstSheetPath);
  });

  it("7. negative — corrupt input returns an error body (observed: PROCESSING_ERROR / 500)", async () => {
    // Not real video data — ffprobe will fail to parse the container.
    const garbage = randomBytes(64);
    const form = new FormData();
    form.append("source", new Blob([garbage]), "garbage.mp4");

    const res = await fetch(`${baseUrl}/api/v1/metadata`, {
      method: "POST",
      body: form,
    });

    // Observed: ffprobe exits non-zero on the malformed container, which
    // getVideoMetadata() wraps as ProcessingError -> 500 PROCESSING_ERROR
    // (see src/core/metadata.ts + src/utils/errors.ts). Asserted loosely
    // (4xx or 500) since the exact ffprobe failure mode is binary-version
    // dependent.
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);

    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error).toBeDefined();
    expect(typeof body.error?.code).toBe("string");
  });

  it("8. negative — path traversal via encoded slashes is rejected", async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/files/${extractJobId}/..%2f..%2fetc%2fpasswd`,
    );

    expect(res.ok).toBe(false);
  });

  it("9. job lifecycle — GET completed, DELETE, dir removed, GET 404s", async () => {
    const getRes = await fetch(`${baseUrl}/api/v1/jobs/${extractJobId}`);
    expect(getRes.ok).toBe(true);
    const getBody = (await getRes.json()) as { status: string };
    expect(getBody.status).toBe("completed");

    const delRes = await fetch(`${baseUrl}/api/v1/jobs/${extractJobId}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(204);

    const jobDir = join(jobsDir, extractJobId);
    await expect(access(jobDir)).rejects.toThrow();

    const getRes2 = await fetch(`${baseUrl}/api/v1/jobs/${extractJobId}`);
    expect(getRes2.status).toBe(404);
  });
});
