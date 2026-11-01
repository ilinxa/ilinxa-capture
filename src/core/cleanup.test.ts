import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
}));

import { readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CleanupScheduler } from "./cleanup.js";

const mockReaddir = vi.mocked(readdir);
const mockReadFile = vi.mocked(readFile);
const mockRename = vi.mocked(rename);
const mockRm = vi.mocked(rm);
const mockStat = vi.mocked(stat);

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
};

function expiredJob(): string {
  return JSON.stringify({
    id: "cap_0000beef",
    status: "completed",
    completed_at: "2020-01-01T00:00:00.000Z",
    failed_at: null,
  });
}

function createScheduler(ttlSeconds = 3600) {
  return new CleanupScheduler({
    outputDir: "/data/jobs",
    ttlSeconds,
    intervalMs: 60_000,
    logger,
  });
}

function makeJobJson(status: string, timestamp: string | null): string {
  return JSON.stringify({
    status,
    completed_at: status === "completed" ? timestamp : null,
    failed_at: status === "failed" ? timestamp : null,
  });
}

describe("CleanupScheduler", () => {
  describe("what a sweep may touch", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockRename.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(expiredJob());
    });

    function jobsThen(entries: string[]): void {
      mockReaddir
        .mockResolvedValueOnce(entries as unknown as Awaited<ReturnType<typeof readdir>>)
        .mockResolvedValueOnce([] as unknown as Awaited<ReturnType<typeof readdir>>);
    }

    it("ignores anything not named like a job, even with a job.json inside", async () => {
      jobsThen(["photos", "cap_short", "CAP_0000BEEF"]);

      const cleaned = await createScheduler().sweep();

      expect(cleaned).toBe(0);
      expect(mockRename).not.toHaveBeenCalled();
      expect(mockRm).not.toHaveBeenCalled();
    });

    it("tells the registry about each job it removes", async () => {
      jobsThen(["cap_0000beef"]);
      const onJobRemoved = vi.fn();
      const scheduler = new CleanupScheduler({
        outputDir: "/data/jobs",
        ttlSeconds: 3600,
        logger,
        onJobRemoved,
      });

      await scheduler.sweep();

      expect(onJobRemoved).toHaveBeenCalledWith("cap_0000beef");
    });

    it("leaves a job alone while work on it is queued or running", async () => {
      jobsThen(["cap_0000beef"]);
      const scheduler = new CleanupScheduler({
        outputDir: "/data/jobs",
        ttlSeconds: 3600,
        logger,
        isBusy: () => true,
      });

      expect(await scheduler.sweep()).toBe(0);
      expect(mockRename).not.toHaveBeenCalled();
    });

    // Regression: a locked file rejected out of sweep() and ended the process,
    // after job.json had already gone, stranding the rest of the folder.
    it("survives a locked job, keeps it whole, and carries on to the next", async () => {
      jobsThen(["cap_0000beef", "cap_0000abc0"]);
      mockRename.mockRejectedValueOnce(
        Object.assign(new Error("busy"), { code: "EBUSY" }),
      );
      const onJobRemoved = vi.fn();
      const scheduler = new CleanupScheduler({
        outputDir: "/data/jobs",
        ttlSeconds: 3600,
        logger,
        onJobRemoved,
      });

      const cleaned = await scheduler.sweep();

      expect(cleaned).toBe(1);
      expect(onJobRemoved).toHaveBeenCalledTimes(1);
      expect(onJobRemoved).toHaveBeenCalledWith("cap_0000abc0");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "cap_0000beef" }),
        "Could not remove expired job",
      );
    });

    it("finishes a delete that stopped partway", async () => {
      jobsThen(["cap_0000beef.deleting", "notes.deleting"]);

      await createScheduler().sweep();

      expect(mockRm).toHaveBeenCalledTimes(1);
      expect(mockRm).toHaveBeenCalledWith(
        join(resolve("/data/jobs"), "cap_0000beef.deleting"),
        { recursive: true, force: true },
      );
    });

    it("never lets a failed sweep reject out of start()", async () => {
      vi.useRealTimers();
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      mockReaddir.mockRejectedValue(
        Object.assign(new Error("denied"), { code: "EACCES" }),
      );

      const scheduler = createScheduler();
      scheduler.start();
      await new Promise((r) => setTimeout(r, 20));
      scheduler.stop();
      process.off("unhandledRejection", unhandled);

      expect(unhandled).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.anything(),
        "Cleanup sweep failed",
      );
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("sweep", () => {
    it("removes expired completed jobs", async () => {
      const expiredTime = new Date(Date.now() - 7200_000).toISOString(); // 2h ago
      mockReaddir.mockResolvedValue(
        ["cap_00000010"] as unknown as Awaited<ReturnType<typeof readdir>>,
      );
      mockReadFile.mockResolvedValue(makeJobJson("completed", expiredTime));
      mockRm.mockResolvedValue(undefined);

      const scheduler = createScheduler(3600); // 1h TTL
      const cleaned = await scheduler.sweep();

      expect(cleaned).toBe(1);
      expect(mockRm).toHaveBeenCalledTimes(1);
    });

    it("removes expired failed jobs", async () => {
      const expiredTime = new Date(Date.now() - 7200_000).toISOString();
      mockReaddir.mockResolvedValue(
        ["cap_00000014"] as unknown as Awaited<ReturnType<typeof readdir>>,
      );
      mockReadFile.mockResolvedValue(makeJobJson("failed", expiredTime));
      mockRm.mockResolvedValue(undefined);

      const scheduler = createScheduler(3600);
      const cleaned = await scheduler.sweep();

      expect(cleaned).toBe(1);
      expect(mockRm).toHaveBeenCalledTimes(1);
    });

    it("skips non-expired jobs", async () => {
      const recentTime = new Date(Date.now() - 1000).toISOString(); // 1s ago
      mockReaddir.mockResolvedValue(
        ["cap_00000011"] as unknown as Awaited<ReturnType<typeof readdir>>,
      );
      mockReadFile.mockResolvedValue(makeJobJson("completed", recentTime));

      const scheduler = createScheduler(3600);
      const cleaned = await scheduler.sweep();

      expect(cleaned).toBe(0);
      expect(mockRm).not.toHaveBeenCalled();
    });

    it("skips pending/processing jobs", async () => {
      mockReaddir.mockResolvedValue(
        ["cap_00000013", "cap_00000012"] as unknown as Awaited<ReturnType<typeof readdir>>,
      );
      mockReadFile
        .mockResolvedValueOnce(makeJobJson("pending", null))
        .mockResolvedValueOnce(makeJobJson("processing", null));

      const scheduler = createScheduler(3600);
      const cleaned = await scheduler.sweep();

      expect(cleaned).toBe(0);
      expect(mockRm).not.toHaveBeenCalled();
    });

    it("handles missing output directory (ENOENT)", async () => {
      mockReaddir.mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );

      const scheduler = createScheduler(3600);
      const cleaned = await scheduler.sweep();

      expect(cleaned).toBe(0);
    });

    it("skips directories without valid job.json", async () => {
      mockReaddir.mockResolvedValue(
        ["random_dir"] as unknown as Awaited<ReturnType<typeof readdir>>,
      );
      mockReadFile.mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );

      const scheduler = createScheduler(3600);
      const cleaned = await scheduler.sweep();

      expect(cleaned).toBe(0);
      expect(mockRm).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("logs a warning and skips a job.json with an invalid shape, without deleting the dir", async () => {
      mockReaddir.mockResolvedValue(
        ["cap_0000bad1"] as unknown as Awaited<ReturnType<typeof readdir>>,
      );
      mockReadFile.mockResolvedValue(JSON.stringify({ id: 42 }));

      const scheduler = createScheduler(3600);
      const cleaned = await scheduler.sweep();

      expect(cleaned).toBe(0);
      expect(mockRm).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          jobJsonPath: expect.stringContaining("cap_0000bad1") as string,
        }),
        "Skipping invalid job.json during cleanup sweep",
      );
    });
  });

  describe("sweep — temp file cleanup", () => {
    beforeEach(() => {
      // Default: empty job dir so we isolate temp-file behavior
      mockReaddir.mockImplementation((path: unknown) => {
        if (path === tmpdir()) {
          return Promise.resolve([] as unknown as Awaited<ReturnType<typeof readdir>>);
        }
        return Promise.resolve([] as unknown as Awaited<ReturnType<typeof readdir>>);
      });
    });

    it("removes an old ilinxa-capture-dl-*.mp4 temp file from tmpdir", async () => {
      const oldTime = Date.now() - 7200_000; // 2h ago
      mockReaddir.mockImplementation((path: unknown) => {
        if (path === tmpdir()) {
          return Promise.resolve([
            "ilinxa-capture-dl-abc123.mp4",
          ] as unknown as Awaited<ReturnType<typeof readdir>>);
        }
        return Promise.resolve([] as unknown as Awaited<ReturnType<typeof readdir>>);
      });
      mockStat.mockResolvedValue({
        mtimeMs: oldTime,
      } as unknown as Awaited<ReturnType<typeof stat>>);
      mockRm.mockResolvedValue(undefined);

      const scheduler = createScheduler(3600); // 1h TTL
      await scheduler.sweep();

      expect(mockRm).toHaveBeenCalledWith(join(tmpdir(), "ilinxa-capture-dl-abc123.mp4"), {
        force: true,
      });
      expect(logger.info).toHaveBeenCalledWith(
        { cleaned: 1 },
        "Temp file cleanup sweep completed",
      );
    });

    it("does not remove a fresh ilinxa-capture- temp file", async () => {
      const freshTime = Date.now() - 1000; // 1s ago
      mockReaddir.mockImplementation((path: unknown) => {
        if (path === tmpdir()) {
          return Promise.resolve([
            "ilinxa-capture-dl-fresh.mp4",
          ] as unknown as Awaited<ReturnType<typeof readdir>>);
        }
        return Promise.resolve([] as unknown as Awaited<ReturnType<typeof readdir>>);
      });
      mockStat.mockResolvedValue({
        mtimeMs: freshTime,
      } as unknown as Awaited<ReturnType<typeof stat>>);

      const scheduler = createScheduler(3600);
      await scheduler.sweep();

      expect(mockRm).not.toHaveBeenCalled();
    });

    it("does not remove a non-ilinxa-capture file found in tmpdir", async () => {
      mockReaddir.mockImplementation((path: unknown) => {
        if (path === tmpdir()) {
          return Promise.resolve([
            "some-other-file.txt",
          ] as unknown as Awaited<ReturnType<typeof readdir>>);
        }
        return Promise.resolve([] as unknown as Awaited<ReturnType<typeof readdir>>);
      });

      const scheduler = createScheduler(3600);
      await scheduler.sweep();

      expect(mockStat).not.toHaveBeenCalled();
      expect(mockRm).not.toHaveBeenCalled();
    });

    it("completes the sweep and still returns the job count when tmpdir readdir fails", async () => {
      const expiredTime = new Date(Date.now() - 7200_000).toISOString();
      mockReaddir.mockImplementation((path: unknown) => {
        if (path === tmpdir()) {
          return Promise.reject(new Error("EPERM: operation not permitted"));
        }
        return Promise.resolve(["cap_00000010"] as unknown as Awaited<ReturnType<typeof readdir>>);
      });
      mockReadFile.mockResolvedValue(makeJobJson("completed", expiredTime));
      mockRm.mockResolvedValue(undefined);

      const scheduler = createScheduler(3600);
      const cleaned = await scheduler.sweep();

      expect(cleaned).toBe(1);
      expect(mockRm).toHaveBeenCalledTimes(1);
    });
  });

  describe("start/stop", () => {
    it("runs sweep immediately on start", async () => {
      mockReaddir.mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );

      const scheduler = createScheduler(3600);
      scheduler.start();

      // Give the async sweep a tick to run
      await vi.advanceTimersByTimeAsync(0);

      expect(mockReaddir).toHaveBeenCalledTimes(1);
      scheduler.stop();
    });

    it("stops interval on stop", async () => {
      mockReaddir.mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );

      const scheduler = createScheduler(3600);
      scheduler.start();

      await vi.advanceTimersByTimeAsync(0);
      expect(mockReaddir).toHaveBeenCalledTimes(1);

      scheduler.stop();

      // Advance past the interval — no additional calls
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mockReaddir).toHaveBeenCalledTimes(1);
    });
  });
});
