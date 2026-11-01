import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeClip, startServer, waitUntil } from "./helpers.js";
import type { TestServer } from "./helpers.js";

function hasYtDlp(): boolean {
  try {
    execFileSync("yt-dlp", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** URL sources with real yt-dlp, against a local server so no network is used. */
describe.skipIf(!hasYtDlp())("URL sources (real yt-dlp)", () => {
  let dir: string;
  let origin: Server;
  let url: string;
  let slowUrl: string;
  let server: TestServer;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ilinxa-capture-dl-test-"));
    const clip = join(dir, "clip.mp4");
    await makeClip(clip, { seconds: 4, size: "320x180", rate: 10 });

    origin = createServer((request, response) => {
      if (request.url === "/slow.mp4") {
        // Headers, then nothing: a stuck download.
        response.writeHead(200, { "content-type": "video/mp4", "content-length": "100000000" });
        response.write("x");
        return;
      }
      response.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": statSync(clip).size,
      });
      createReadStream(clip).pipe(response);
    });
    await new Promise<void>((done) => origin.listen(0, "127.0.0.1", done));

    const { port } = origin.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/clip.mp4`;
    slowUrl = `http://127.0.0.1:${port}/slow.mp4`;

    server = await startServer({ LOCAL_OUTPUT_DIR: join(dir, "jobs") });
  }, 60_000);

  afterAll(async () => {
    await server.close();
    origin.closeAllConnections();
    origin.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("extracts frames from a URL", async () => {
    const res = await server.post("/api/v1/extract", { source: url, fps: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { frames: { count: number } };
    expect(body.frames.count).toBe(4);
  });

  it("reads metadata from a URL", async () => {
    const res = await server.post("/api/v1/metadata", { source: url });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { duration: number };
    expect(body.duration).toBeCloseTo(4, 0);
  });

  it("downloads into a job", async () => {
    const res = await server.post("/api/v1/video/download", { url, preset: "best" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      job_id: string;
      video: { download_url: string; filesize: number; file_path: string };
    };
    expect(body.video.filesize).toBeGreaterThan(1000);
    expect(body.video.file_path).toContain(body.job_id);

    const file = await fetch(`${server.baseUrl}${body.video.download_url}`);
    expect(file.status).toBe(200);
    expect((await file.arrayBuffer()).byteLength).toBe(body.video.filesize);
  });

  it("feeds a downloaded job's file back in as a source", async () => {
    const res = await server.post("/api/v1/video/download", { url, preset: "best" });
    const { job_id: jobId } = (await res.json()) as { job_id: string };

    const videoDir = join(dir, "jobs", jobId, "video");
    const [name] = await readdir(videoDir);

    const restricted = await startServer({
      LOCAL_OUTPUT_DIR: join(dir, "jobs"),
      ALLOWED_INPUT_DIRS: "",
    });
    try {
      const extract = await restricted.post("/api/v1/extract", {
        source: join(videoDir, name!),
        fps: 1,
      });
      expect(extract.status).toBe(200);
    } finally {
      await restricted.close();
    }
  });

  it("refuses a non-http URL before it reaches yt-dlp", async () => {
    const res = await server.post("/api/v1/video/download", {
      url: "file:///etc/passwd",
    });
    expect(res.status).toBe(400);
  });

  // Regression: a URL probe is a full download, but ran outside every limit.
  it("holds URL probes to the job limits", async () => {
    const limited = await startServer({
      LOCAL_OUTPUT_DIR: join(dir, "probe"),
      JOB_TIMEOUT: 1,
      MAX_CONCURRENT_JOBS: 1,
    });
    try {
      const started = Date.now();
      const responses = await Promise.all(
        [1, 2].map(() => limited.post("/api/v1/metadata", { source: slowUrl })),
      );

      expect(responses.map((r) => r.status)).toEqual([504, 504]);
      // One at a time, each for its full second.
      expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    } finally {
      await limited.close();
    }
  }, 30_000);

  // Regression: this kept the only slot for the whole timeout, with no job ID
  // for anyone to stop it by.
  it("gives the slot back when the client gives up on a URL probe", async () => {
    const limited = await startServer({
      LOCAL_OUTPUT_DIR: join(dir, "gave-up"),
      JOB_TIMEOUT: 60,
      MAX_CONCURRENT_JOBS: 1,
    });
    try {
      const controller = new AbortController();
      const probe = fetch(`${limited.baseUrl}/api/v1/metadata`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: slowUrl }),
        signal: controller.signal,
      }).catch(() => null);

      await new Promise((r) => setTimeout(r, 1000));
      controller.abort();
      await probe;

      const next = await limited.post("/api/v1/extract", {
        source: join(dir, "clip.mp4"),
        fps: 1,
      });
      expect(next.status).toBe(200);
    } finally {
      await limited.close();
    }
  }, 30_000);

  // Regression: downloads ran outside the job, so nothing could stop them.
  it("stops a stuck download at the job timeout", async () => {
    const root = join(dir, "stuck");
    const limited = await startServer({ LOCAL_OUTPUT_DIR: root, JOB_TIMEOUT: 2 });
    try {
      const res = await limited.post("/api/v1/extract", {
        source: slowUrl,
        fps: 1,
        async: true,
      });
      expect(res.status).toBe(202);
      const { job_id: jobId } = (await res.json()) as { job_id: string };

      await waitUntil(async () => {
        const job = await limited.json<{ status: string }>(`/api/v1/jobs/${jobId}`);
        return job.status === "failed";
      });

      const job = await limited.json<{ error_code: string }>(`/api/v1/jobs/${jobId}`);
      expect(job.error_code).toBe("JOB_TIMEOUT");
    } finally {
      await limited.close();
    }
  }, 30_000);
});
