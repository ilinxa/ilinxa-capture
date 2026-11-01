import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./safe-fs.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./safe-fs.js")>();
  return { ...original, replaceDir: vi.fn(original.replaceDir) };
});

import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createTestEnv } from "../test/env.js";
import { InputPolicy } from "./input-policy.js";
import { JobManager } from "./job-manager.js";
import type { ComposeOptions, VideoDownloadOptions } from "./options.js";
import { replaceDir } from "./safe-fs.js";
import { CaptureService } from "./service.js";

const logger = { info: vi.fn(), warn: vi.fn() };

describe("CaptureService", () => {
  let dir: string;
  let jobs: JobManager;
  let service: CaptureService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ilinxa-service-"));
    const env = createTestEnv({ LOCAL_OUTPUT_DIR: dir });
    jobs = new JobManager(env, logger);
    service = new CaptureService(env, jobs, InputPolicy.fromEnv(env, "http"));
  });

  afterEach(async () => {
    await jobs.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  /** A finished job with two frames on disk. */
  async function frameJob(): Promise<string> {
    const { id } = await jobs.createJob("cap_00000001", { type: "extract" });
    await jobs.runSync(id, async () => ({ frames: 2 }));

    const frames = join(dir, id, "frames");
    await mkdir(frames);
    for (const n of [1, 2]) {
      await sharp({
        create: { width: 16, height: 16, channels: 3, background: "#808080" },
      })
        .png()
        .toFile(join(frames, `frame_000${n}.png`));
    }
    return id;
  }

  const compose = (jobId: string): ComposeOptions =>
    ({
      job_id: jobId,
      mode: 4,
      overlay_frame_number: false,
      overlay_timestamp: false,
    }) as ComposeOptions;

  describe("swapping new sheets in", () => {
    // Regression: the job said completed and listed sheets that were gone.
    it("keeps the old sheets if one is held open, and says so", async () => {
      const jobId = await frameJob();
      await service.compose(compose(jobId));
      const before = await readdir(join(dir, jobId, "sheets"));

      vi.mocked(replaceDir).mockRejectedValueOnce(
        Object.assign(new Error("held open"), { code: "EBUSY" }),
      );

      await expect(service.compose(compose(jobId))).rejects.toMatchObject({
        code: "FILES_IN_USE",
        statusCode: 409,
      });

      const job = jobs.getJob(jobId);
      expect(job.status).toBe("completed");
      expect(job.type).toBe("combined");
      expect(job.error_code).toBe("FILES_IN_USE");
      expect(await readdir(join(dir, jobId, "sheets"))).toEqual(before);
      await expect(access(join(dir, jobId, "sheets.tmp"))).rejects.toThrow();
    });

    it("composes again once the file is free", async () => {
      const jobId = await frameJob();
      await service.compose(compose(jobId));

      vi.mocked(replaceDir).mockRejectedValueOnce(
        Object.assign(new Error("held open"), { code: "EPERM" }),
      );
      await service.compose(compose(jobId)).catch(() => {});

      const again = await service.compose(compose(jobId));

      expect(again.status).toBe("completed");
      expect(await readdir(join(dir, jobId))).not.toContain("sheets.tmp");
    });
  });

  // Regression: the listener went on after the abort, so it never fired.
  it("stops a job whose caller left before it was created", async () => {
    const options = { url: "http://127.0.0.1:9/video.mp4" } as VideoDownloadOptions;

    await expect(
      service.downloadVideo(options, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "JOB_CANCELLED" });
  });
});
