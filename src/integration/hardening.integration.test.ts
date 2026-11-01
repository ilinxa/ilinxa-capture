import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import sharp from "sharp";
import { ffmpeg, framePts, makeClip, makeCodedClip, startServer, waitUntil } from "./helpers.js";
import type { TestServer } from "./helpers.js";

/**
 * Every defect from the 0.2.0 hardening, reproduced with real binaries, real
 * files and real HTTP. Mocks could not have caught any of these.
 */
describe("hardening (real ffmpeg, sharp, disk and HTTP)", () => {
  let dir: string;
  let jobs: string;
  let inputs: string;
  let clip: string;
  let secret: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ilinxa-capture-hard-"));
    jobs = join(dir, "jobs");
    inputs = join(dir, "inputs");
    await mkdir(inputs);

    clip = join(inputs, "clip.mp4");
    await makeClip(clip, { seconds: 6, size: "640x360", rate: 30 });

    secret = join(dir, "passwords.txt");
    await writeFile(secret, "MARKER-private-file-contents");
    await writeFile(join(inputs, "notes.txt"), "MARKER-private-file-contents");
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Regression: every URL but the root was a 500, so a link into the UI failed.
  describe("serving the Web UI", () => {
    let server: TestServer;

    beforeAll(async () => {
      const ui = join(dir, "ui");
      await mkdir(ui);
      await writeFile(join(ui, "index.html"), "<title>MARKER-ui</title>");
      server = await startServer({ LOCAL_OUTPUT_DIR: jobs, UI_DIR: ui });
    });
    afterAll(() => server.close());

    it("answers a client route with the page", async () => {
      const res = await fetch(`${server.baseUrl}/some/client/route`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("MARKER-ui");
    });

    it("still answers an unknown API route with JSON", async () => {
      const res = await fetch(`${server.baseUrl}/api/v1/nothing-here`);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("NOT_FOUND");
    });
  });

  describe("default local path policy", () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer({ LOCAL_OUTPUT_DIR: jobs, ALLOWED_INPUT_DIRS: "" });
    });
    afterAll(() => server.close());

    it("refuses a local source path", async () => {
      const res = await server.post("/api/v1/extract", { source: clip, fps: 1 });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("LOCAL_PATH_FORBIDDEN");
    });

    it("refuses a local path on metadata", async () => {
      const res = await server.post("/api/v1/metadata", { source: clip });
      expect(res.status).toBe(403);
    });

    it("refuses local frame paths on compose", async () => {
      const res = await server.post("/api/v1/compose", { frames: [secret], mode: 1 });
      expect(res.status).toBe(403);
    });

    it("refuses other URL schemes", async () => {
      for (const source of [`concat:${clip}|${clip}`, `file:///${clip}`, "tcp://127.0.0.1:1"]) {
        const res = await server.post("/api/v1/extract", { source, fps: 1 });
        expect(res.status).toBe(400);
      }
    });

    it("still takes uploads, whose frames can then be composed by path", async () => {
      const form = new FormData();
      form.append("fps", "1");
      form.append("file", new Blob([await readFile(clip)]), "clip.mp4");
      const upload = await fetch(`${server.baseUrl}/api/v1/extract`, { method: "POST", body: form });
      expect(upload.status).toBe(200);

      const { frames } = (await upload.json()) as { frames: { files: string[] } };
      const res = await server.post("/api/v1/compose", {
        frames: frames.files.slice(0, 2),
        mode: 4,
      });
      expect(res.status).toBe(200);
    });
  });

  // Regression: mode 1 copied every frame after the first with no image check,
  // so any file came back through the file route labeled as a sheet.
  describe("compose only ever outputs images", () => {
    let server: TestServer;
    let frame: string;

    beforeAll(async () => {
      server = await startServer({ LOCAL_OUTPUT_DIR: jobs, ALLOWED_INPUT_DIRS: inputs });
      const res = await server.post("/api/v1/extract", { source: clip, fps: 1 });
      frame = ((await res.json()) as { frames: { files: string[] } }).frames.files[0]!;
    });
    afterAll(() => server.close());

    it.each([1, 4, 16])("refuses a text file after a real frame in mode %i", async (mode) => {
      const res = await server.post("/api/v1/compose", {
        frames: [frame, join(inputs, "notes.txt")],
        mode,
      });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain("MARKER");
    });

    it("refuses a video file passed as a frame", async () => {
      const res = await server.post("/api/v1/compose", { frames: [frame, clip], mode: 1 });
      expect(res.status).toBe(400);
    });
  });

  describe("the file route is confined to job output", () => {
    let server: TestServer;
    let jobId: string;

    beforeAll(async () => {
      server = await startServer({ LOCAL_OUTPUT_DIR: jobs });
      const res = await server.post("/api/v1/extract", { source: clip, fps: 1 });
      jobId = ((await res.json()) as { job_id: string }).job_id;
    });
    afterAll(() => server.close());

    it.each([
      ["job.json", 404],
      ["frames/../job.json", 404],
      ["frames/..%2Fjob.json", 404],
      // fetch collapses this to the job root, which has no file path at all
      ["frames/..", 400],
      ["other/frame_0001.jpg", 404],
    ])("does not serve %s", async (path, status) => {
      const res = await fetch(`${server.baseUrl}/api/v1/files/${jobId}/${path}`);
      expect(res.status).toBe(status);
    });

    it("serves frames and the manifest", async () => {
      const frame = await fetch(`${server.baseUrl}/api/v1/files/${jobId}/frames/frame_0001.jpg`);
      expect(frame.headers.get("content-type")).toBe("image/jpeg");

      const manifest = await fetch(`${server.baseUrl}/api/v1/files/${jobId}/manifest.json`);
      expect(manifest.status).toBe(200);
      expect(await manifest.text()).not.toContain(dir);
    });
  });

  // Regression: a job_id was joined into a path, so ../ reached outside the
  // jobs folder, wrote job.json there, and DELETE then removed the folder.
  describe("job IDs cannot leave the jobs folder", () => {
    let server: TestServer;
    let target: string;

    beforeAll(async () => {
      target = join(dir, "shot_010");
      await mkdir(join(target, "frames"), { recursive: true });
      await ffmpeg("-i", clip, "-frames:v", "1", join(target, "frames", "frame_0001.jpg"));
      await writeFile(join(target, "important.txt"), "keep me");
      server = await startServer({ LOCAL_OUTPUT_DIR: jobs });
    });
    afterAll(() => server.close());

    it.each(["../shot_010", "..\\shot_010"])("refuses compose with %s", async (jobId) => {
      const res = await server.post("/api/v1/compose", { job_id: jobId, mode: 4 });
      expect(res.status).toBe(400);
      expect(await readdir(target)).toEqual(["frames", "important.txt"]);
    });

    it("refuses an absolute path as a job ID", async () => {
      const res = await server.post("/api/v1/compose", { job_id: target, mode: 4 });
      expect(res.status).toBe(400);
      expect(await readdir(target)).toEqual(["frames", "important.txt"]);
    });

    it.each(["..%2Fshot_010", "..%5Cshot_010", "%2e%2e%2fshot_010"])(
      "refuses DELETE and file reads with %s",
      async (id) => {
        const del = await fetch(`${server.baseUrl}/api/v1/jobs/${id}`, { method: "DELETE" });
        expect(del.status).toBe(400);

        const file = await fetch(`${server.baseUrl}/api/v1/files/${id}/important.txt`);
        expect(file.status).toBe(400);

        await access(target);
      },
    );
  });

  // Regression: the half-interval error came from the fps filter, on all video.
  describe("frame times are true source times", () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer({ LOCAL_OUTPUT_DIR: jobs });
    });
    afterAll(() => server.close());

    async function check(
      video: string,
      request: Record<string, unknown>,
    ): Promise<{ timestamps: number[]; sourceFrames: number[]; errors: number[] }> {
      const res = await server.post("/api/v1/extract", {
        source: video,
        preset: "high",
        ...request,
      });
      expect(res.status).toBe(200);
      const { frames } = (await res.json()) as {
        frames: { files: string[]; timestamps: number[] };
      };

      const truth = await framePts(video);
      const sourceFrames: number[] = [];
      const errors: number[] = [];
      for (let i = 0; i < frames.files.length; i++) {
        const { data } = await sharp(frames.files[i]!)
          .extractChannel(0)
          .raw()
          .toBuffer({ resolveWithObject: true });
        const sourceFrame = data[Math.floor(data.length / 2)]!;
        sourceFrames.push(sourceFrame);
        errors.push(Math.abs(truth[sourceFrame]! - frames.timestamps[i]!));
      }
      return { timestamps: frames.timestamps, sourceFrames, errors };
    }

    it("is exact on constant frame rate video", async () => {
      const video = join(dir, "cfr.mkv");
      await makeCodedClip(video, {});

      const { timestamps, sourceFrames, errors } = await check(video, { fps: 1 });

      expect(Math.max(...errors)).toBeLessThan(0.001);
      expect(timestamps.slice(0, 3)).toEqual([0, 1, 2]);
      expect(sourceFrames.slice(0, 3)).toEqual([0, 25, 50]);
    }, 60_000);

    it("is exact on variable frame rate video", async () => {
      const video = join(dir, "vfr.mkv");
      await makeCodedClip(video, { setpts: "if(lt(N,125),N/25,5+(N-125)/5)/TB" });

      const { errors } = await check(video, { fps: 2 });

      expect(Math.max(...errors)).toBeLessThan(0.001);
    }, 60_000);

    it("leaves a gap in the source as a gap, with no burst after it", async () => {
      const video = join(dir, "gap.mkv");
      await makeCodedClip(video, { setpts: "if(lt(N,100),N/25,(N+50)/25)/TB" });

      const { timestamps, errors } = await check(video, { fps: 1 });

      expect(Math.max(...errors)).toBeLessThan(0.001);
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]! - timestamps[i - 1]!).toBeGreaterThanOrEqual(0.5);
      }
      expect(timestamps).toContain(6);
      expect(timestamps).not.toContain(5);
    }, 60_000);

    it("stays true inside a time range", async () => {
      const video = join(dir, "range.mkv");
      await makeCodedClip(video, {});

      const { timestamps, sourceFrames, errors } = await check(video, {
        fps: 1,
        start: 3,
        end: "00:06",
      });

      expect(Math.max(...errors)).toBeLessThan(0.05);
      expect(timestamps[0]).toBeCloseTo(3, 2);
      expect(timestamps.at(-1)!).toBeLessThan(6);
      expect(sourceFrames[0]).toBe(75);
    }, 60_000);

    it("samples below one frame per second", async () => {
      const video = join(dir, "slow.mkv");
      await makeCodedClip(video, {});

      const everyFour = await check(video, { every_seconds: 4 });
      expect(everyFour.timestamps).toEqual([0, 4, 8]);

      const fraction = await check(video, { fps: 0.5 });
      expect(fraction.timestamps).toEqual([0, 2, 4, 6, 8]);
    }, 60_000);

    it("labels a third-of-a-second boundary on the frame that sits there", async () => {
      const video = join(dir, "third.mkv");
      await makeCodedClip(video, { rate: 30, frames: 180 });

      const { sourceFrames } = await check(video, { every_seconds: 3 });
      expect(sourceFrames).toEqual([0, 90]);
    }, 60_000);

    it("refuses fps with every_seconds, and neither", async () => {
      const both = await server.post("/api/v1/extract", {
        source: clip,
        fps: 1,
        every_seconds: 2,
      });
      expect(both.status).toBe(400);

      const neither = await server.post("/api/v1/extract", { source: clip });
      expect(neither.status).toBe(400);
    });
  });

  describe("time range and duration limit", () => {
    it("lets a range of a long video through the limit", async () => {
      const server = await startServer({ LOCAL_OUTPUT_DIR: jobs, MAX_VIDEO_DURATION: 2 });
      try {
        const whole = await server.post("/api/v1/extract", { source: clip, fps: 1 });
        expect(whole.status).toBe(413);

        const part = await server.post("/api/v1/extract", {
          source: clip,
          fps: 1,
          start: 1,
          end: 2.5,
        });
        expect(part.status).toBe(200);

        const tooMuch = await server.post("/api/v1/extract", {
          source: clip,
          fps: 1,
          start: 1,
          end: 5,
        });
        expect(tooMuch.status).toBe(413);
      } finally {
        await server.close();
      }
    });

    it("rejects a range outside the video", async () => {
      const server = await startServer({ LOCAL_OUTPUT_DIR: jobs });
      try {
        const res = await server.post("/api/v1/extract", { source: clip, fps: 1, start: 99 });
        expect(res.status).toBe(400);
      } finally {
        await server.close();
      }
    });
  });

  // Regression: frame_%04d plus a text sort put frame_10000 after frame_1000.
  it("keeps frame order past 9,999 at default limits", async () => {
    const server = await startServer({ LOCAL_OUTPUT_DIR: jobs });
    try {
      const long = join(dir, "long.mp4");
      await makeClip(long, { seconds: 334, size: "64x36", rate: 30 });

      const res = await server.post("/api/v1/extract", {
        source: long,
        fps: 30,
        preset: "custom",
        width: 32,
        format: "jpeg",
      });
      expect(res.status).toBe(200);

      const { frames } = (await res.json()) as {
        frames: { count: number; files: string[]; timestamps: number[] };
      };
      expect(frames.count).toBeGreaterThan(10_000);

      const numbers = frames.files.map((f) => Number.parseInt(basename(f).slice(6), 10));
      expect(numbers).toEqual(numbers.map((_, i) => i + 1));
      for (let i = 1; i < frames.timestamps.length; i++) {
        expect(frames.timestamps[i]!).toBeGreaterThan(frames.timestamps[i - 1]!);
      }
    } finally {
      await server.close();
    }
  }, 120_000);

  describe("composing a job", () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer({ LOCAL_OUTPUT_DIR: jobs });
    });
    afterAll(() => server.close());

    // Regression: compose replaced the job's record and left old sheets behind.
    it("keeps the frames and replaces the sheets", async () => {
      const extract = await server.post("/api/v1/extract", { source: clip, fps: 2 });
      const { job_id: jobId } = (await extract.json()) as { job_id: string };

      await server.post("/api/v1/compose", { job_id: jobId, mode: 1 });
      const second = await server.post("/api/v1/compose", { job_id: jobId, mode: 16 });
      expect(second.status).toBe(200);

      const job = await server.json<{
        frames?: { count: number };
        sheets?: { count: number };
      }>(`/api/v1/jobs/${jobId}`);

      expect(job.frames?.count).toBe(12);
      expect(job.sheets?.count).toBe(1);
      expect(await readdir(join(jobs, jobId, "sheets"))).toHaveLength(1);
    });

    it("draws labels from true times, without being given an fps", async () => {
      const extract = await server.post("/api/v1/extract", { source: clip, fps: 2 });
      const { job_id: jobId } = (await extract.json()) as { job_id: string };

      const res = await server.post("/api/v1/compose", {
        job_id: jobId,
        mode: 4,
        overlay_timestamp: true,
      });
      expect(res.status).toBe(200);

      const manifest = await server.json<{ sheets: Array<{ frames: number[] }> }>(
        `/api/v1/files/${jobId}/manifest.json`,
      );
      expect(manifest.sheets[0]?.frames).toEqual([0, 1, 2, 3]);
    });
  });

  describe("sheet size", () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer({ LOCAL_OUTPUT_DIR: jobs });
    });
    afterAll(() => server.close());

    async function sheetWidth(request: Record<string, unknown>): Promise<number> {
      const res = await server.post("/api/v1/extract-and-compose", {
        source: clip,
        fps: 3,
        mode: 16,
        overlay_timestamp: true,
        ...request,
      });
      expect(res.status).toBe(200);
      const { sheets } = (await res.json()) as { sheets: { files: string[] } };
      return (await sharp(sheets.files[0]!).metadata()).width!;
    }

    it("fits an llm 4x4 sheet in 2000 px by default", async () => {
      expect(await sheetWidth({})).toBe(2000);
    });

    it("follows max_sheet_edge, and 0 turns the limit off", async () => {
      expect(await sheetWidth({ max_sheet_edge: 1000 })).toBe(1000);
      expect(await sheetWidth({ max_sheet_edge: 0 })).toBe(4096);
    });

    it("leaves the high preset at original size", async () => {
      expect(await sheetWidth({ preset: "high" })).toBe(2560);
    });
  });

  // Regression: z.coerce.boolean() read the string "false" as true.
  describe("multipart booleans", () => {
    let server: TestServer;
    let bytes: Buffer;

    beforeAll(async () => {
      server = await startServer({ LOCAL_OUTPUT_DIR: jobs });
      bytes = await readFile(clip);
    });
    afterAll(() => server.close());

    function form(fields: Record<string, string>): FormData {
      const data = new FormData();
      for (const [key, value] of Object.entries(fields)) data.append(key, value);
      data.append("file", new Blob([bytes]), "clip.mp4");
      return data;
    }

    it("treats async=false as false", async () => {
      const res = await fetch(`${server.baseUrl}/api/v1/extract`, {
        method: "POST",
        body: form({ fps: "1", async: "false" }),
      });
      expect(res.status).toBe(200);
    });

    it("treats async=true as true", async () => {
      const res = await fetch(`${server.baseUrl}/api/v1/extract`, {
        method: "POST",
        body: form({ fps: "1", async: "true" }),
      });
      expect(res.status).toBe(202);
    });

    it("draws no overlay for overlay_*=false", async () => {
      const sheet = async (fields: Record<string, string>): Promise<Buffer> => {
        const res = await fetch(`${server.baseUrl}/api/v1/extract-and-compose`, {
          method: "POST",
          body: form({ fps: "1", mode: "1", ...fields }),
        });
        const { sheets } = (await res.json()) as { sheets: { files: string[] } };
        return readFile(sheets.files[0]!);
      };

      const omitted = await sheet({});
      const off = await sheet({ overlay_timestamp: "false", overlay_frame_number: "0" });
      const on = await sheet({ overlay_timestamp: "true" });

      expect(off.equals(omitted)).toBe(true);
      expect(on.equals(omitted)).toBe(false);
    });

    it("rejects a value that is not a boolean", async () => {
      const res = await fetch(`${server.baseUrl}/api/v1/extract`, {
        method: "POST",
        body: form({ fps: "1", async: "maybe" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("job timeout with a real process", () => {
    let busy: string;

    beforeAll(async () => {
      busy = join(dir, "busy.mp4");
      await makeClip(busy, { seconds: 90, size: "1280x720", rate: 30 });
    }, 120_000);

    const slowRequest = (): Record<string, unknown> => ({
      source: busy,
      fps: 30,
      preset: "high",
    });

    async function frameCount(root: string, jobId: string): Promise<number> {
      return (await readdir(join(root, jobId, "frames"))).length;
    }

    async function settled(root: string, jobId: string): Promise<number> {
      const first = await frameCount(root, jobId);
      await new Promise((r) => setTimeout(r, 500));
      const second = await frameCount(root, jobId);
      expect(second).toBe(first);
      return second;
    }

    it("stops ffmpeg, fails the job and answers 504 on a sync call", async () => {
      const root = join(dir, "timeout-sync");
      const server = await startServer({ LOCAL_OUTPUT_DIR: root, JOB_TIMEOUT: 1 });
      try {
        const res = await server.post("/api/v1/extract", slowRequest());
        expect(res.status).toBe(504);
        expect((await res.json()).error.code).toBe("JOB_TIMEOUT");

        const [jobId] = await readdir(root);
        const job = await server.json<{ status: string; error: string }>(`/api/v1/jobs/${jobId}`);
        expect(job.status).toBe("failed");
        expect(job.error).toContain("JOB_TIMEOUT");

        // ffmpeg is gone: the frame count has stopped well short of the 2,700.
        expect(await settled(root, jobId!)).toBeLessThan(2700);
      } finally {
        await server.close();
      }
    }, 60_000);

    // Regression: this exact call used to end the server process.
    it("survives an async job timing out", async () => {
      const root = join(dir, "timeout-async");
      const server = await startServer({ LOCAL_OUTPUT_DIR: root, JOB_TIMEOUT: 1 });
      try {
        const res = await server.post("/api/v1/extract", { ...slowRequest(), async: true });
        expect(res.status).toBe(202);
        const { job_id: jobId } = (await res.json()) as { job_id: string };

        await waitUntil(async () => {
          const job = await server.json<{ status: string }>(`/api/v1/jobs/${jobId}`);
          return job.status === "failed";
        });

        const health = await fetch(`${server.baseUrl}/api/v1/health`);
        expect(health.status).toBe(200);
        expect(await settled(root, jobId)).toBeLessThan(2700);
      } finally {
        await server.close();
      }
    }, 60_000);

    it("stops a running job on DELETE and removes its folder", async () => {
      const root = join(dir, "cancel");
      const server = await startServer({ LOCAL_OUTPUT_DIR: root });
      try {
        const res = await server.post("/api/v1/extract", { ...slowRequest(), async: true });
        const { job_id: jobId } = (await res.json()) as { job_id: string };

        await waitUntil(async () => {
          const framesDir = join(root, jobId, "frames");
          return (await readdir(framesDir).catch(() => [])).length > 5;
        });

        const del = await fetch(`${server.baseUrl}/api/v1/jobs/${jobId}`, { method: "DELETE" });
        expect(del.status).toBe(204);

        await new Promise((r) => setTimeout(r, 500));
        await expect(access(join(root, jobId))).rejects.toThrow();
      } finally {
        await server.close();
      }
    }, 60_000);

    it("reports progress while running", async () => {
      const root = join(dir, "progress");
      const server = await startServer({ LOCAL_OUTPUT_DIR: root });
      try {
        const res = await server.post("/api/v1/extract", { ...slowRequest(), async: true });
        const { job_id: jobId } = (await res.json()) as { job_id: string };

        let seen: { stage: string; percent: number | null } | null = null;
        await waitUntil(async () => {
          const job = await server.json<{ progress?: typeof seen }>(`/api/v1/jobs/${jobId}`);
          seen = job.progress ?? null;
          return seen?.percent !== null && seen?.percent !== undefined;
        });

        expect(seen).toMatchObject({ stage: "extracting" });
        await fetch(`${server.baseUrl}/api/v1/jobs/${jobId}`, { method: "DELETE" });
      } finally {
        await server.close();
      }
    }, 60_000);
  });
});
