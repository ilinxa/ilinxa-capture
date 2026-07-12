import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReadStream } from "node:fs";

vi.mock("node:fs", () => ({
  createReadStream: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn(),
}));

import { createReadStream } from "node:fs";
import { access, stat, readdir, rm } from "node:fs/promises";
import { LocalStorage } from "./storage.js";

const mockCreateReadStream = vi.mocked(createReadStream);
const mockAccess = vi.mocked(access);
const mockStat = vi.mocked(stat);
const mockReaddir = vi.mocked(readdir);
const mockRm = vi.mocked(rm);

const BASE_DIR = "/data/jobs";

describe("LocalStorage", () => {
  let storage: LocalStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new LocalStorage(BASE_DIR);
  });

  describe("getJobDir", () => {
    it("returns correct absolute path", () => {
      const jobDir = storage.getJobDir("cap_abc123");
      expect(jobDir).toMatch(/cap_abc123$/);
      expect(jobDir).toContain("data");
    });
  });

  describe("resolveSecure (via fileExists)", () => {
    it("rejects ../ traversal", async () => {
      await expect(
        storage.fileExists("cap_abc", "../../../etc/passwd"),
      ).rejects.toThrow("Path traversal detected");
    });

    it("rejects ..\\backslash traversal", async () => {
      await expect(
        storage.fileExists("cap_abc", "..\\..\\etc\\passwd"),
      ).rejects.toThrow("Path traversal detected");
    });

    it("allows valid nested paths", async () => {
      mockAccess.mockResolvedValue(undefined);
      const result = await storage.fileExists("cap_abc", "frames/frame_0001.jpg");
      expect(result).toBe(true);
    });

    it("rejects escape into a sibling directory whose name starts with the job dir name", async () => {
      // jobDir = /data/jobs/cap_abc — a naive `startsWith(jobDir)` check would
      // wrongly allow /data/jobs/cap_abc-evil/file.jpg since it shares the prefix.
      await expect(
        storage.fileExists("cap_abc", "../cap_abc-evil/file.jpg"),
      ).rejects.toThrow("Path traversal detected");
    });
  });

  describe("fileExists", () => {
    it("returns true when file is accessible", async () => {
      mockAccess.mockResolvedValue(undefined);
      const result = await storage.fileExists("cap_abc", "frames/frame_0001.jpg");
      expect(result).toBe(true);
    });

    it("returns false when file is not accessible", async () => {
      mockAccess.mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );
      const result = await storage.fileExists("cap_abc", "frames/frame_0001.jpg");
      expect(result).toBe(false);
    });
  });

  describe("getFileStream", () => {
    it("returns ReadStream for valid path", () => {
      const mockStream = {} as ReadStream;
      mockCreateReadStream.mockReturnValue(mockStream);

      const stream = storage.getFileStream("cap_abc", "frames/frame_0001.jpg");
      expect(stream).toBe(mockStream);
      expect(mockCreateReadStream).toHaveBeenCalledTimes(1);

      const calledWith = mockCreateReadStream.mock.calls[0]?.[0] as string;
      expect(calledWith).toContain("cap_abc");
      expect(calledWith).toMatch(/frames[/\\]frame_0001\.jpg$/);
    });

    it("throws on path traversal", () => {
      expect(() =>
        storage.getFileStream("cap_abc", "../../etc/passwd"),
      ).toThrow("Path traversal detected");
    });
  });

  describe("getFileInfo", () => {
    it("returns file info with size and paths", async () => {
      mockStat.mockResolvedValue({ size: 12345 } as Awaited<ReturnType<typeof stat>>);

      const info = await storage.getFileInfo("cap_abc", "frames/frame_0001.jpg");
      expect(info.size).toBe(12345);
      expect(info.relativePath).toBe("frames/frame_0001.jpg");
      expect(info.path).toContain("cap_abc");
      expect(info.path).toMatch(/frames[/\\]frame_0001\.jpg$/);
    });
  });

  describe("listFiles", () => {
    it("lists files from both frames and sheets when no filter", async () => {
      mockReaddir
        .mockResolvedValueOnce(["frame_0001.jpg", "frame_0002.jpg"] as unknown as Awaited<ReturnType<typeof readdir>>)
        .mockResolvedValueOnce(["sheet_001.jpg"] as unknown as Awaited<ReturnType<typeof readdir>>);

      mockStat.mockResolvedValue({
        size: 1000,
        isFile: () => true,
      } as unknown as Awaited<ReturnType<typeof stat>>);

      const files = await storage.listFiles("cap_abc");
      expect(files).toHaveLength(3);
      expect(files[0]?.relativePath).toBe("frames/frame_0001.jpg");
      expect(files[1]?.relativePath).toBe("frames/frame_0002.jpg");
      expect(files[2]?.relativePath).toBe("sheets/sheet_001.jpg");
    });

    it("lists only frames when filter is 'frames'", async () => {
      mockReaddir.mockResolvedValue(
        ["frame_0001.jpg"] as unknown as Awaited<ReturnType<typeof readdir>>,
      );
      mockStat.mockResolvedValue({
        size: 1000,
        isFile: () => true,
      } as unknown as Awaited<ReturnType<typeof stat>>);

      const files = await storage.listFiles("cap_abc", "frames");
      expect(files).toHaveLength(1);
      expect(files[0]?.relativePath).toBe("frames/frame_0001.jpg");
      expect(mockReaddir).toHaveBeenCalledTimes(1);
    });

    it("lists only sheets when filter is 'sheets'", async () => {
      mockReaddir.mockResolvedValue(
        ["sheet_001.jpg"] as unknown as Awaited<ReturnType<typeof readdir>>,
      );
      mockStat.mockResolvedValue({
        size: 2000,
        isFile: () => true,
      } as unknown as Awaited<ReturnType<typeof stat>>);

      const files = await storage.listFiles("cap_abc", "sheets");
      expect(files).toHaveLength(1);
      expect(files[0]?.relativePath).toBe("sheets/sheet_001.jpg");
    });

    it("handles missing subdirectories gracefully", async () => {
      mockReaddir.mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );

      const files = await storage.listFiles("cap_abc");
      expect(files).toHaveLength(0);
    });

    it("rethrows non-ENOENT errors", async () => {
      mockReaddir.mockRejectedValue(new Error("EPERM: permission denied"));

      await expect(storage.listFiles("cap_abc")).rejects.toThrow("EPERM");
    });
  });

  describe("deleteJobDir", () => {
    it("calls rm with recursive and force", async () => {
      mockRm.mockResolvedValue(undefined);

      await storage.deleteJobDir("cap_abc");
      expect(mockRm).toHaveBeenCalledTimes(1);

      const [dirPath, opts] = mockRm.mock.calls[0]!;
      expect(dirPath).toContain("cap_abc");
      expect(opts).toEqual({ recursive: true, force: true });
    });
  });
});
