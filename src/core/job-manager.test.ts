import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    readdir: vi.fn(),
    rm: vi.fn().mockResolvedValue(undefined),
  };
});

import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { JobManager } from "./job-manager.js";
import { createTestEnv } from "../test/env.js";


const mockMkdir = vi.mocked(mkdir);
const mockWriteFile = vi.mocked(writeFile);
const mockReadFile = vi.mocked(readFile);
const mockReaddir = vi.mocked(readdir);
const mockRm = vi.mocked(rm);

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as ConstructorParameters<typeof JobManager>[1];

describe("JobManager", () => {
  let jobManager: JobManager;

  beforeEach(() => {
    vi.clearAllMocks();
    jobManager = new JobManager(createTestEnv(), mockLogger);
  });

  afterEach(async () => {
    await jobManager.shutdown();
  });

  describe("generateJobId", () => {
    it("returns a string starting with cap_", () => {
      const id = jobManager.generateJobId();
      expect(id).toMatch(/^cap_[a-f0-9]{8}$/);
    });
  });

  describe("createJob", () => {
    it("creates a pending job and persists job.json", async () => {
      const jobId = jobManager.generateJobId();
      const job = await jobManager.createJob(jobId, { type: "extract" });

      expect(job.id).toBe(jobId);
      expect(job.status).toBe("pending");
      expect(job.type).toBe("extract");
      expect(job.created_at).toBeTruthy();
      expect(job.started_at).toBeNull();
      expect(job.result).toBeNull();
      expect(job.error).toBeNull();
      expect(job.webhook_url).toBeNull();

      expect(mockMkdir).toHaveBeenCalledTimes(1);
      expect(mockWriteFile).toHaveBeenCalledTimes(1);

      const writtenContent = mockWriteFile.mock.calls[0]?.[1] as string;
      const parsed = JSON.parse(writtenContent) as Record<string, unknown>;
      expect(parsed["status"]).toBe("pending");
    });

    it("stores webhook_url when provided", async () => {
      const jobId = jobManager.generateJobId();
      const job = await jobManager.createJob(jobId, {
        type: "compose",
        webhookUrl: "https://example.com/hook",
      });

      expect(job.webhook_url).toBe("https://example.com/hook");
    });
  });

  describe("getJob", () => {
    it("returns the job state", async () => {
      const jobId = jobManager.generateJobId();
      await jobManager.createJob(jobId, { type: "extract" });

      const job = jobManager.getJob(jobId);
      expect(job.id).toBe(jobId);
    });

    it("throws JobNotFoundError for unknown job", () => {
      expect(() => jobManager.getJob("cap_0000dead")).toThrow("not found");
    });
  });

  describe("deleteJob", () => {
    it("removes the job and deletes the directory", async () => {
      const jobId = jobManager.generateJobId();
      await jobManager.createJob(jobId, { type: "extract" });

      await jobManager.deleteJob(jobId);

      expect(() => jobManager.getJob(jobId)).toThrow("not found");
      expect(mockRm).toHaveBeenCalledWith(
        expect.stringContaining(jobId),
        { recursive: true, force: true },
      );
    });

    it("throws JobNotFoundError for unknown job", async () => {
      await expect(jobManager.deleteJob("cap_0000dead")).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("runSync", () => {
    it("transitions pending → processing → completed", async () => {
      const jobId = jobManager.generateJobId();
      await jobManager.createJob(jobId, { type: "extract" });

      vi.clearAllMocks();

      const taskResult = { job_id: jobId, status: "completed", data: "test" };
      const result = await jobManager.runSync(jobId, async () => taskResult);

      expect(result).toEqual(taskResult);

      const job = jobManager.getJob(jobId);
      expect(job.status).toBe("completed");
      expect(job.started_at).toBeTruthy();
      expect(job.completed_at).toBeTruthy();
      expect(job.result).toEqual(taskResult);
      expect(job.processing_time_ms).toBeGreaterThanOrEqual(0);

      // Persists at processing + completed = 2 calls
      expect(mockWriteFile).toHaveBeenCalledTimes(2);
    });

    it("transitions to failed on error and re-throws", async () => {
      const jobId = jobManager.generateJobId();
      await jobManager.createJob(jobId, { type: "extract" });

      await expect(
        jobManager.runSync(jobId, async () => {
          throw new Error("extraction failed");
        }),
      ).rejects.toThrow("extraction failed");

      const job = jobManager.getJob(jobId);
      expect(job.status).toBe("failed");
      expect(job.failed_at).toBeTruthy();
      expect(job.error).toBe("extraction failed");
    });
  });

  describe("runAsync", () => {
    it("returns immediately and job eventually completes", async () => {
      const jobId = jobManager.generateJobId();
      await jobManager.createJob(jobId, { type: "extract" });

      const taskResult = { job_id: jobId, status: "completed" };
      jobManager.runAsync(jobId, async () => taskResult);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const job = jobManager.getJob(jobId);
      expect(job.status).toBe("completed");
      expect(job.result).toEqual(taskResult);
    });

    it("marks job as failed on task error", async () => {
      const jobId = jobManager.generateJobId();
      await jobManager.createJob(jobId, { type: "extract" });

      jobManager.runAsync(jobId, async () => {
        throw new Error("async task failed");
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const job = jobManager.getJob(jobId);
      expect(job.status).toBe("failed");
      expect(job.error).toBe("async task failed");
    });

    it("exits silently when job was deleted while queued", async () => {
      const env = createTestEnv({ MAX_CONCURRENT_JOBS: 1 });
      const mgr = new JobManager(env, mockLogger);

      const blockJobId = mgr.generateJobId();
      await mgr.createJob(blockJobId, { type: "extract" });
      let resolveBlocker: () => void;
      const blocker = new Promise<void>((resolve) => {
        resolveBlocker = resolve;
      });
      mgr.runAsync(blockJobId, async () => {
        await blocker;
        return { done: true };
      });

      const deleteJobId = mgr.generateJobId();
      await mgr.createJob(deleteJobId, { type: "extract" });
      mgr.runAsync(deleteJobId, async () => ({ should: "not run" }));
      await mgr.deleteJob(deleteJobId);

      resolveBlocker!();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(() => mgr.getJob(deleteJobId)).toThrow("not found");

      await mgr.shutdown();
    });
  });

  describe("webhook", () => {
    it("fires webhook on completed async job", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("ok"));

      const jobId = jobManager.generateJobId();
      await jobManager.createJob(jobId, {
        type: "extract",
        webhookUrl: "https://example.com/hook",
      });

      const taskResult = { job_id: jobId, status: "completed" };
      jobManager.runAsync(jobId, async () => taskResult);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://example.com/hook");

      const body = JSON.parse(
        (opts as { body: string }).body,
      ) as Record<string, unknown>;
      expect(body["event"]).toBe("job.completed");
      expect(body["job_id"]).toBe(jobId);
      expect(body["result"]).toEqual(taskResult);

      fetchSpy.mockRestore();
    });

    it("fires webhook on failed async job", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("ok"));

      const jobId = jobManager.generateJobId();
      await jobManager.createJob(jobId, {
        type: "extract",
        webhookUrl: "https://example.com/hook",
      });

      jobManager.runAsync(jobId, async () => {
        throw new Error("webhook fail test");
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        (fetchSpy.mock.calls[0]![1] as { body: string }).body,
      ) as Record<string, unknown>;
      expect(body["event"]).toBe("job.failed");
      expect(body["error"]).toBe("webhook fail test");

      fetchSpy.mockRestore();
    });

    it("does not fire webhook when webhook_url is not set", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("ok"));

      const jobId = jobManager.generateJobId();
      await jobManager.createJob(jobId, { type: "extract" });

      jobManager.runAsync(jobId, async () => ({ done: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  describe("recover", () => {
    it("loads jobs from disk and marks stuck ones as failed", async () => {
      mockReaddir.mockResolvedValue([
        "cap_00000001",
        "cap_00000002",
        "cap_00000003",
      ] as unknown as Awaited<ReturnType<typeof readdir>>);

      mockReadFile.mockImplementation(async (filePath) => {
        const path = String(filePath);
        if (path.includes("cap_00000001")) {
          return JSON.stringify({
            id: "cap_00000001",
            type: "extract",
            status: "completed",
            created_at: "2026-01-01T00:00:00Z",
            started_at: "2026-01-01T00:00:01Z",
            completed_at: "2026-01-01T00:00:05Z",
            failed_at: null,
            error: null,
            webhook_url: null,
            result: { data: "test" },
            processing_time_ms: 4000,
          });
        }
        if (path.includes("cap_00000002")) {
          return JSON.stringify({
            id: "cap_00000002",
            type: "extract",
            status: "processing",
            created_at: "2026-01-01T00:00:00Z",
            started_at: "2026-01-01T00:00:01Z",
            completed_at: null,
            failed_at: null,
            error: null,
            webhook_url: null,
            result: null,
            processing_time_ms: null,
          });
        }
        if (path.includes("cap_00000003")) {
          return JSON.stringify({
            id: "cap_00000003",
            type: "compose",
            status: "pending",
            created_at: "2026-01-01T00:00:00Z",
            started_at: null,
            completed_at: null,
            failed_at: null,
            error: null,
            webhook_url: null,
            result: null,
            processing_time_ms: null,
          });
        }
        throw new Error("Unknown file");
      });

      await jobManager.recover();

      const job1 = jobManager.getJob("cap_00000001");
      expect(job1.status).toBe("completed");

      const job2 = jobManager.getJob("cap_00000002");
      expect(job2.status).toBe("failed");
      expect(job2.error).toBe("Server restarted during processing");

      const job3 = jobManager.getJob("cap_00000003");
      expect(job3.status).toBe("failed");
      expect(job3.error).toBe("Server restarted during processing");
    });

    it("handles missing directory gracefully", async () => {
      const enoentError = new Error("ENOENT") as NodeJS.ErrnoException;
      enoentError.code = "ENOENT";
      mockReaddir.mockRejectedValue(enoentError);

      await jobManager.recover();
    });

    it("skips directories without valid job.json", async () => {
      mockReaddir.mockResolvedValue([
        "cap_0000a11d",
        "some_other_dir",
      ] as unknown as Awaited<ReturnType<typeof readdir>>);

      mockReadFile.mockImplementation(async (filePath) => {
        const path = String(filePath);
        if (path.includes("cap_0000a11d")) {
          return JSON.stringify({
            id: "cap_0000a11d",
            type: "extract",
            status: "completed",
            created_at: "2026-01-01T00:00:00Z",
            started_at: null,
            completed_at: null,
            failed_at: null,
            error: null,
            webhook_url: null,
            result: null,
            processing_time_ms: null,
          });
        }
        throw new Error("ENOENT");
      });

      await jobManager.recover();

      expect(jobManager.getJob("cap_0000a11d")).toBeDefined();
      expect(() => jobManager.getJob("some_other_dir")).toThrow("not found");
    });

    it("skips a malformed job.json (wrong shape) with a warn log and does not add it to the jobs map", async () => {
      mockReaddir.mockResolvedValue([
        "cap_0000bad0",
        "cap_0000a11d",
      ] as unknown as Awaited<ReturnType<typeof readdir>>);

      mockReadFile.mockImplementation(async (filePath) => {
        const path = String(filePath);
        if (path.includes("cap_0000bad0")) {
          // Valid JSON, but does not conform to jobStateSchema.
          return JSON.stringify({ id: 42 });
        }
        if (path.includes("cap_0000a11d")) {
          return JSON.stringify({
            id: "cap_0000a11d",
            type: "extract",
            status: "completed",
            created_at: "2026-01-01T00:00:00Z",
            started_at: null,
            completed_at: null,
            failed_at: null,
            error: null,
            webhook_url: null,
            result: null,
            processing_time_ms: null,
          });
        }
        throw new Error("Unknown file");
      });

      await jobManager.recover();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { jobJsonPath: expect.stringContaining("cap_0000bad0") as string },
        "Skipping invalid job.json during recovery",
      );
      expect(() => jobManager.getJob("cap_0000bad0")).toThrow("not found");
      expect(jobManager.getJob("cap_0000a11d")).toBeDefined();
    });

    it("recovers a job.json from an older build that lacks newer optional fields", async () => {
      mockReaddir.mockResolvedValue([
        "cap_0000a9ed",
      ] as unknown as Awaited<ReturnType<typeof readdir>>);

      mockReadFile.mockImplementation(async () =>
        // Simulates a job.json persisted before webhook_url and
        // processing_time_ms existed — keys entirely absent, not null.
        JSON.stringify({
          id: "cap_0000a9ed",
          type: "extract",
          status: "completed",
          created_at: "2026-01-01T00:00:00Z",
          started_at: null,
          completed_at: "2026-01-01T00:01:00Z",
          failed_at: null,
          error: null,
          result: { frameCount: 3 },
        }),
      );

      await jobManager.recover();

      const job = jobManager.getJob("cap_0000a9ed");
      expect(job.status).toBe("completed");
      expect(job.webhook_url).toBeNull();
      expect(job.processing_time_ms).toBeNull();
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        "Skipping invalid job.json during recovery",
      );
    });
  });

  describe("shutdown", () => {
    it("clears the queue and waits for idle", async () => {
      await jobManager.shutdown();
      expect(mockLogger.info).toHaveBeenCalledWith("Job manager shut down");
    });
  });
});
