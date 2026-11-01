import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./safe-fs.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./safe-fs.js")>();
  return { ...original, removeTree: vi.fn(original.removeTree) };
});

import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager, type JobContext } from "./job-manager.js";
import { removeTree } from "./safe-fs.js";
import { createTestEnv } from "../test/env.js";
import type { Env } from "../lib/env.js";

const logger = { info: vi.fn(), warn: vi.fn() };

/** A task that runs until it is aborted, as a stuck FFmpeg would. */
function hang(ctx: JobContext): Promise<never> {
  return new Promise((_resolve, reject) => {
    ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
  });
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("JobManager lifecycle", () => {
  let dir: string;
  let managers: JobManager[];

  function createManager(overrides: Partial<Env> = {}): JobManager {
    const manager = new JobManager(
      createTestEnv({ LOCAL_OUTPUT_DIR: dir, ...overrides }),
      logger,
    );
    managers.push(manager);
    return manager;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ilinxa-jobs-"));
    managers = [];
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(managers.map((m) => m.shutdown()));
    await rm(dir, { recursive: true, force: true });
  });

  describe("timeout", () => {
    it("fails a sync job with JOB_TIMEOUT and aborts its task", async () => {
      const manager = createManager({ JOB_TIMEOUT: 1 });
      const job = await manager.createJob("cap_00000001", { type: "extract" });

      await expect(manager.runSync(job.id, hang)).rejects.toMatchObject({
        code: "JOB_TIMEOUT",
        statusCode: 504,
      });

      expect(job.status).toBe("failed");
      expect(job.error_code).toBe("JOB_TIMEOUT");
    });

    // Regression: the queue's timeout rejected a promise nobody held, and the
    // unhandled rejection ended the whole server process.
    it("fails an async job without an unhandled rejection", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);

      const manager = createManager({ JOB_TIMEOUT: 1 });
      const job = await manager.createJob("cap_00000002", { type: "extract" });
      manager.runAsync(job.id, hang);

      await waitFor(() => job.status === "failed");
      await new Promise((r) => setTimeout(r, 20));
      process.off("unhandledRejection", unhandled);

      expect(unhandled).not.toHaveBeenCalled();
      expect(job.error_code).toBe("JOB_TIMEOUT");
    });

    // Regression: the queue freed the slot at the timeout while work continued.
    it("holds the concurrency slot until the task has really stopped", async () => {
      const manager = createManager({ JOB_TIMEOUT: 1, MAX_CONCURRENT_JOBS: 1 });
      const first = await manager.createJob("cap_00000003", { type: "extract" });
      const second = await manager.createJob("cap_00000004", { type: "extract" });

      let finishCleanup: () => void = () => {};
      const slowStop = async (ctx: JobContext): Promise<void> => {
        await hang(ctx).catch(async (reason: unknown) => {
          await new Promise<void>((done) => {
            finishCleanup = done;
          });
          throw reason;
        });
      };

      const running = manager.runSync(first.id, slowStop).catch(() => {});
      let secondStarted = false;
      const queued = manager.runSync(second.id, async () => {
        secondStarted = true;
      });

      await waitFor(() => first.status === "processing");
      await new Promise((r) => setTimeout(r, 1200)); // past the timeout
      expect(secondStarted).toBe(false);

      finishCleanup();
      await Promise.all([running, queued]);
      expect(secondStarted).toBe(true);
    });

    it("reports the abort reason even when core code wrapped the error", async () => {
      const manager = createManager({ JOB_TIMEOUT: 1 });
      const job = await manager.createJob("cap_00000005", { type: "extract" });

      await expect(
        manager.runSync(job.id, async (ctx) => {
          await hang(ctx).catch(() => {
            throw new Error("FFmpeg extraction failed: killed");
          });
        }),
      ).rejects.toMatchObject({ code: "JOB_TIMEOUT" });
    });

    it("never times out when JOB_TIMEOUT is 0", async () => {
      const manager = createManager({ JOB_TIMEOUT: 0 });
      const job = await manager.createJob("cap_00000006", { type: "extract" });

      await expect(
        manager.runSync(job.id, async (ctx) => {
          await new Promise((r) => setTimeout(r, 30));
          return ctx.signal.aborted;
        }),
      ).resolves.toBe(false);
    });
  });

  describe("delete", () => {
    it("stops a running job and leaves no directory behind", async () => {
      const manager = createManager();
      const job = await manager.createJob("cap_00000007", { type: "extract" });
      const run = manager.runSync(job.id, hang).catch((err: unknown) => err);
      await waitFor(() => job.status === "processing");

      await manager.deleteJob(job.id);

      expect(await run).toMatchObject({ code: "JOB_CANCELLED" });
      expect(() => manager.getJob(job.id)).toThrow();
      await expect(access(join(dir, job.id))).rejects.toThrow();
    });

    // Regression: the job stayed in the registry during the delete, so the queue
    // started it, and it wrote into the folder being removed.
    it("does not start a queued job while its delete is under way", async () => {
      const manager = createManager({ MAX_CONCURRENT_JOBS: 1 });
      const blocker = await manager.createJob("cap_00000001", { type: "extract" });
      const queued = await manager.createJob("cap_00000002", { type: "extract" });
      const started = vi.fn();

      manager.runAsync(blocker.id, hang);
      await waitFor(() => blocker.status === "processing");
      manager.runAsync(queued.id, async () => {
        started();
      });

      let finishDelete: () => void = () => {};
      vi.mocked(removeTree).mockImplementationOnce(async (path) => {
        await new Promise<void>((done) => {
          finishDelete = done;
        });
        await rm(path, { recursive: true, force: true });
      });
      const deleting = manager.deleteJob(queued.id);
      await waitFor(() => vi.mocked(removeTree).mock.calls.length > 0);

      // The slot comes free in the middle of the delete.
      manager.cancelJob(blocker.id);
      await waitFor(() => blocker.status === "failed");
      await new Promise((r) => setTimeout(r, 50));

      finishDelete();
      await deleting;

      expect(started).not.toHaveBeenCalled();
      await expect(access(join(dir, queued.id))).rejects.toThrow();
      expect(() => manager.getJob(queued.id)).toThrow();
    });

    // Removing it from the registry first would strand the folder, with nothing
    // left to say it exists.
    it("keeps a job it could not remove, and says what to do", async () => {
      const manager = createManager();
      const job = await manager.createJob("cap_00000001", { type: "extract" });
      await manager.runSync(job.id, async () => "done");

      vi.mocked(removeTree).mockRejectedValueOnce(
        Object.assign(new Error("held open"), { code: "EPERM" }),
      );

      await expect(manager.deleteJob(job.id)).rejects.toMatchObject({
        code: "FILES_IN_USE",
        statusCode: 409,
      });

      expect(manager.getJob(job.id).status).toBe("completed");
      await access(join(dir, job.id, "job.json"));
    });

    it("refuses to reopen a job being deleted", async () => {
      const manager = createManager();
      const job = await manager.createJob("cap_00000001", { type: "extract" });
      await manager.runSync(job.id, async () => "done");

      let finishDelete: () => void = () => {};
      vi.mocked(removeTree).mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            finishDelete = done;
          }),
      );
      const deleting = manager.deleteJob(job.id);
      await waitFor(() => vi.mocked(removeTree).mock.calls.length > 0);

      await expect(
        manager.reopenJob(job.id, { type: "combined" }),
      ).rejects.toMatchObject({ code: "JOB_BUSY" });

      finishDelete();
      await deleting;
    });

    it("does not start a job deleted while it was queued", async () => {
      const manager = createManager({ MAX_CONCURRENT_JOBS: 1 });
      const first = await manager.createJob("cap_00000008", { type: "extract" });
      const queued = await manager.createJob("cap_00000009", { type: "extract" });

      const running = manager.runSync(first.id, hang).catch(() => {});
      await waitFor(() => first.status === "processing");

      let started = false;
      const pending = manager
        .runSync(queued.id, async () => {
          started = true;
        })
        .catch((err: unknown) => err);
      await manager.deleteJob(queued.id);
      await manager.deleteJob(first.id);

      expect(await pending).toMatchObject({ code: "JOB_CANCELLED" });
      await running;
      expect(started).toBe(false);
    });
  });

  it("does not start a task aborted before it began", async () => {
    const manager = createManager();
    const job = await manager.createJob("cap_00000015", { type: "extract" });

    let started = false;
    const run = manager
      .runSync(job.id, async () => {
        started = true;
      })
      .catch((err: unknown) => err);

    // Status flips before the first write, so this lands in the gap.
    await waitFor(() => job.status === "processing");
    await manager.deleteJob(job.id);

    expect(await run).toMatchObject({ code: "JOB_CANCELLED" });
    expect(started).toBe(false);
  });

  it("frees a skipped job's upload, whether deleted or shut down in the queue", async () => {
    const manager = createManager({ MAX_CONCURRENT_JOBS: 1 });
    const first = await manager.createJob("cap_00000018", { type: "extract" });
    const queued = await manager.createJob("cap_00000019", { type: "extract" });

    const running = manager.runSync(first.id, hang).catch(() => {});
    await waitFor(() => first.status === "processing");

    const onSkipped = vi.fn().mockResolvedValue(undefined);
    manager.runAsync(queued.id, async () => "never", onSkipped);

    await manager.deleteJob(queued.id);
    await manager.deleteJob(first.id);
    await running;

    await waitFor(() => onSkipped.mock.calls.length > 0);
  });

  it("cancels a queued job so it never starts", async () => {
    const manager = createManager({ MAX_CONCURRENT_JOBS: 1 });
    const first = await manager.createJob("cap_0000001a", { type: "extract" });
    const queued = await manager.createJob("cap_0000001b", { type: "extract" });

    const running = manager.runSync(first.id, hang).catch(() => {});
    await waitFor(() => first.status === "processing");

    let started = false;
    const waiting = manager
      .runSync(queued.id, async () => {
        started = true;
      })
      .catch((err: unknown) => err);

    manager.cancelJob(queued.id);
    manager.cancelJob(first.id);
    await running;

    expect(await waiting).toMatchObject({ code: "JOB_CANCELLED" });
    expect(started).toBe(false);
    expect(queued.status).toBe("failed");
  });

  // Regression: this marked a finished job failed, and its output refused to
  // download until a later compose succeeded.
  it("cancelling queued work on a finished job leaves the job as it was", async () => {
    const manager = createManager({ MAX_CONCURRENT_JOBS: 1 });
    const done = await manager.createJob("cap_00000001", { type: "extract" });
    await manager.runSync(done.id, async () => "frames");
    const { completed_at: completedAt } = done;

    const blocker = await manager.createJob("cap_00000002", { type: "extract" });
    manager.runAsync(blocker.id, hang);
    await waitFor(() => blocker.status === "processing");

    await manager.reopenJob(done.id, { type: "combined" });
    const queued = manager.runSync(done.id, async () => "sheets");
    manager.cancelJob(done.id);
    manager.cancelJob(blocker.id);

    await expect(queued).rejects.toMatchObject({ code: "JOB_CANCELLED" });

    expect(done).toMatchObject({
      status: "completed",
      type: "extract",
      completed_at: completedAt,
      error_code: "JOB_CANCELLED",
      result: "frames",
      reopened_from: null,
    });

    const onDisk = JSON.parse(
      await readFile(join(dir, done.id, "job.json"), "utf-8"),
    ) as { status: string };
    expect(onDisk.status).toBe("completed");
  });

  it("cancels a running job but keeps its record", async () => {
    const manager = createManager();
    const job = await manager.createJob("cap_0000001c", { type: "extract" });
    const run = manager.runSync(job.id, hang).catch((err: unknown) => err);
    await waitFor(() => job.status === "processing");
    await new Promise((r) => setTimeout(r, 30));

    manager.cancelJob(job.id);

    expect(await run).toMatchObject({ code: "JOB_CANCELLED" });
    expect(manager.getJob(job.id).status).toBe("failed");
  });

  it("runs transient work under the same limits as a job", async () => {
    const manager = createManager({ JOB_TIMEOUT: 1, MAX_CONCURRENT_JOBS: 1 });

    let concurrent = 0;
    let peak = 0;
    const work = (signal: AbortSignal): Promise<never> =>
      new Promise((_resolve, reject) => {
        peak = Math.max(peak, ++concurrent);
        signal.addEventListener("abort", () => {
          concurrent--;
          reject(signal.reason);
        });
      });

    const results = await Promise.allSettled([
      manager.runTransient(work),
      manager.runTransient(work),
    ]);

    expect(peak).toBe(1);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(results[0]).toMatchObject({ reason: { code: "JOB_TIMEOUT" } });
  }, 10_000);

  // Regression: a reopen landing as the previous run finished had its active
  // entry deleted by the old run, so nothing could stop it any more.
  describe("transient work a caller gave up on", () => {
    it("stops it if running", async () => {
      const manager = createManager();
      const controller = new AbortController();

      const run = manager.runTransient(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
            controller.abort();
          }),
        controller.signal,
      );

      await expect(run).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    });

    it("never starts it if still queued", async () => {
      const manager = createManager({ MAX_CONCURRENT_JOBS: 1 });
      const blocker = await manager.createJob("cap_00000001", { type: "extract" });
      manager.runAsync(blocker.id, hang);
      await waitFor(() => blocker.status === "processing");

      const controller = new AbortController();
      const started = vi.fn();
      const run = manager.runTransient(async () => {
        started();
      }, controller.signal);

      controller.abort();
      manager.cancelJob(blocker.id);

      await expect(run).rejects.toMatchObject({ code: "JOB_CANCELLED" });
      expect(started).not.toHaveBeenCalled();
    });

    it("drops its listener once finished", async () => {
      const manager = createManager();
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");

      await manager.runTransient(async () => "ok", controller.signal);

      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    });
  });

  it("still stops a job reopened just as its previous run finished", async () => {
    for (let round = 0; round < 8; round++) {
      const manager = createManager();
      const id = `cap_000002${round.toString(16).padStart(2, "0")}`;
      const job = await manager.createJob(id, { type: "extract" });

      const big = { frames: "x".repeat(2_000_000) };
      const first = manager.runSync(job.id, async () => big);
      await waitFor(() => job.status === "completed");

      await manager.reopenJob(job.id, { type: "combined" });
      const second = manager.runSync(job.id, hang).catch((err: unknown) => err);
      await first;
      await waitFor(() => job.status === "processing");

      await manager.deleteJob(job.id);
      expect(await second).toMatchObject({ code: "JOB_CANCELLED" });
    }
  });

  describe("reopen", () => {
    it("returns to its earlier standing when the new work fails", async () => {
      const manager = createManager();
      const job = await manager.createJob("cap_0000001d", { type: "extract" });
      await manager.runSync(job.id, async () => ({ frames: 3 }));
      const completedAt = job.completed_at;

      await manager.reopenJob(job.id, { type: "combined" });
      await manager
        .runSync(job.id, async () => {
          throw new Error("compose failed");
        })
        .catch(() => {});

      expect(job.status).toBe("completed");
      expect(job.type).toBe("extract");
      expect(job.completed_at).toBe(completedAt);
      expect(job.result).toEqual({ frames: 3 });
      expect(job.error).toBe("compose failed");
    });

    it("keeps the earlier result for the task to build on", async () => {
      const manager = createManager();
      const job = await manager.createJob("cap_0000000a", { type: "extract" });
      await manager.runSync(job.id, async () => ({ frames: 3 }));

      await manager.reopenJob(job.id, { type: "combined" });

      expect(job.status).toBe("pending");
      expect(job.type).toBe("combined");
      expect(job.result).toEqual({ frames: 3 });
      expect(job.completed_at).toBeNull();
    });

    it("refuses a job that is still running", async () => {
      const manager = createManager();
      const job = await manager.createJob("cap_0000000b", { type: "extract" });
      const run = manager.runSync(job.id, hang).catch(() => {});
      await waitFor(() => job.status === "processing");

      await expect(
        manager.reopenJob(job.id, { type: "combined" }),
      ).rejects.toMatchObject({ code: "JOB_BUSY", statusCode: 409 });

      await manager.deleteJob(job.id);
      await run;
    });

    it("lets exactly one of two simultaneous callers through", async () => {
      const manager = createManager();
      const job = await manager.createJob("cap_0000000c", { type: "extract" });
      await manager.runSync(job.id, async () => ({}));

      const outcomes = await Promise.allSettled([
        manager.reopenJob(job.id, { type: "combined" }),
        manager.reopenJob(job.id, { type: "combined" }),
      ]);

      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    });
  });

  describe("forget", () => {
    it("drops a finished job from the registry", async () => {
      const manager = createManager();
      const job = await manager.createJob("cap_0000000d", { type: "extract" });
      await manager.runSync(job.id, async () => ({}));

      manager.forgetJob(job.id);

      expect(() => manager.getJob(job.id)).toThrow();
    });

    it("leaves a running job alone", async () => {
      const manager = createManager();
      const job = await manager.createJob("cap_0000000e", { type: "extract" });
      const run = manager.runSync(job.id, hang).catch(() => {});
      await waitFor(() => job.status === "processing");

      manager.forgetJob(job.id);

      expect(manager.getJob(job.id)).toBe(job);
      await manager.deleteJob(job.id);
      await run;
    });
  });

  describe("job IDs", () => {
    it.each(["../escape", "..\\escape", "/etc", "cap_123", "cap_ZZZZZZZZ", "cap_12345678/.."])(
      "refuses to create %s",
      async (id) => {
        const manager = createManager();
        await expect(manager.createJob(id, { type: "extract" })).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
        });
      },
    );

    it("refuses to resolve a directory for a bad ID", () => {
      const manager = createManager();
      expect(() => manager.getJobDir("../escape")).toThrow();
    });
  });

  describe("recovery", () => {
    async function writeJobFile(id: string, job: Record<string, unknown>): Promise<void> {
      await mkdir(join(dir, id), { recursive: true });
      await writeFile(join(dir, id, "job.json"), JSON.stringify(job));
    }

    async function plant(entry: string, id: string): Promise<void> {
      await mkdir(join(dir, entry), { recursive: true });
      await writeFile(
        join(dir, entry, "job.json"),
        JSON.stringify({
          id,
          type: "extract",
          status: "completed",
          created_at: "2026-01-01T00:00:00.000Z",
        }),
      );
    }

    it("skips a job.json whose ID is not a real job ID", async () => {
      await plant("cap_0000000f", "../../outside");
      const manager = createManager();
      await manager.recover();
      expect(() => manager.getJob("../../outside")).toThrow();
    });

    it("skips a job.json whose ID does not match its folder", async () => {
      await plant("cap_00000010", "cap_00000011");
      const manager = createManager();
      await manager.recover();
      expect(() => manager.getJob("cap_00000011")).toThrow();
    });

    it("recovers a job written by an older build", async () => {
      await plant("cap_00000012", "cap_00000012");
      const manager = createManager();
      await manager.recover();
      expect(manager.getJob("cap_00000012").error_code).toBeNull();
    });

    it("keeps a job's earlier output when a reopen was interrupted", async () => {
      await mkdir(join(dir, "cap_0000001e"));
      await writeFile(
        join(dir, "cap_0000001e", "job.json"),
        JSON.stringify({
          id: "cap_0000001e",
          type: "combined",
          status: "processing",
          created_at: "2026-01-01T00:00:00.000Z",
          result: { frames: { count: 3 } },
        }),
      );

      const manager = createManager();
      await manager.recover();

      const job = manager.getJob("cap_0000001e");
      expect(job.status).toBe("completed");
      expect(job.error).toContain("restarted");
    });

    // Regression: only `status` came back, so an extract job stayed `combined`.
    it("undoes a reopen a crash interrupted", async () => {
      const completedAt = "2026-01-01T00:00:00.000Z";
      await writeJobFile("cap_00000005", {
        id: "cap_00000005",
        type: "combined",
        status: "processing",
        created_at: completedAt,
        result: { frames: 3 },
        reopened_from: {
          type: "extract",
          status: "completed",
          completed_at: completedAt,
          failed_at: null,
        },
      });

      const manager = createManager();
      await manager.recover();

      const job = manager.getJob("cap_00000005");
      expect(job).toMatchObject({
        type: "extract",
        status: "completed",
        completed_at: completedAt,
        reopened_from: null,
      });
    });

    it("returns a failed job to failed, not completed", async () => {
      const failedAt = "2026-01-01T00:00:00.000Z";
      await writeJobFile("cap_00000006", {
        id: "cap_00000006",
        type: "combined",
        status: "pending",
        created_at: failedAt,
        result: { frames: 3 },
        reopened_from: {
          type: "extract",
          status: "failed",
          completed_at: null,
          failed_at: failedAt,
        },
      });

      const manager = createManager();
      await manager.recover();

      expect(manager.getJob("cap_00000006")).toMatchObject({
        status: "failed",
        failed_at: failedAt,
      });
    });

    it("puts sheets back if a crash came in the middle of swapping them", async () => {
      await writeJobFile("cap_00000007", {
        id: "cap_00000007",
        type: "combined",
        status: "processing",
        created_at: "2026-01-01T00:00:00.000Z",
        result: {},
      });
      const jobDir = join(dir, "cap_00000007");
      await mkdir(join(jobDir, "sheets.old"));
      await writeFile(join(jobDir, "sheets.old", "sheet_001.jpg"), "x");
      await mkdir(join(jobDir, "sheets.tmp"));

      await createManager().recover();

      expect(await readdir(join(jobDir, "sheets"))).toEqual(["sheet_001.jpg"]);
      await expect(access(join(jobDir, "sheets.tmp"))).rejects.toThrow();
    });

    it("marks an interrupted job failed", async () => {
      await mkdir(join(dir, "cap_00000013"));
      await writeFile(
        join(dir, "cap_00000013", "job.json"),
        JSON.stringify({
          id: "cap_00000013",
          type: "extract",
          status: "processing",
          created_at: "2026-01-01T00:00:00.000Z",
        }),
      );

      const manager = createManager();
      await manager.recover();

      const onDisk = JSON.parse(
        await readFile(join(dir, "cap_00000013", "job.json"), "utf-8"),
      ) as { status: string };
      expect(onDisk.status).toBe("failed");
    });
  });

  describe("shutdown", () => {
    it("rejects queued sync callers instead of leaving them waiting", async () => {
      const manager = createManager({ MAX_CONCURRENT_JOBS: 1, JOB_TIMEOUT: 0 });
      const running = await manager.createJob("cap_00000016", { type: "extract" });
      const queued = await manager.createJob("cap_00000017", { type: "extract" });

      const first = manager.runSync(running.id, hang).catch((err: unknown) => err);
      await waitFor(() => running.status === "processing");
      await new Promise((r) => setTimeout(r, 20));
      const second = manager
        .runSync(queued.id, async () => "never")
        .catch((err: unknown) => err);

      await manager.shutdown();

      expect(await first).toMatchObject({ code: "JOB_CANCELLED" });
      expect(await second).toMatchObject({ code: "JOB_CANCELLED" });
    });

    it("stops running jobs rather than waiting for them", async () => {
      const manager = createManager({ JOB_TIMEOUT: 0 });
      const job = await manager.createJob("cap_00000014", { type: "extract" });
      const run = manager.runSync(job.id, hang).catch((err: unknown) => err);
      await waitFor(() => job.status === "processing");

      await manager.shutdown();

      expect(await run).toMatchObject({ code: "JOB_CANCELLED" });
      expect(job.status).toBe("failed");
    });
  });
});
