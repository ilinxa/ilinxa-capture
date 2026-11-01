import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOMBSTONE_SUFFIX, removeTree, writeFileAtomic } from "./safe-fs.js";

describe("safe-fs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ilinxa-safe-fs-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("writeFileAtomic", () => {
    it("writes the file and leaves no temp file", async () => {
      const path = join(dir, "job.json");
      await writeFileAtomic(path, "first");
      await writeFileAtomic(path, "second");

      expect(await readFile(path, "utf-8")).toBe("second");
      expect(await readdir(dir)).toEqual(["job.json"]);
    });

    // A crash mid-write once left a truncated job.json that nothing could read.
    it("leaves the old file whole when the write cannot finish", async () => {
      const path = join(dir, "job.json");
      await writeFileAtomic(path, "good");

      await expect(
        writeFileAtomic(join(dir, "missing-folder", "job.json"), "x"),
      ).rejects.toThrow();

      expect(await readFile(path, "utf-8")).toBe("good");
    });
  });

  describe("removeTree", () => {
    it("removes a folder and its tombstone", async () => {
      const target = join(dir, "cap_00000001");
      await mkdir(join(target, "frames"), { recursive: true });
      await writeFile(join(target, "job.json"), "{}");

      await removeTree(target);

      expect(await readdir(dir)).toEqual([]);
    });

    it("is happy if the folder is already gone", async () => {
      await expect(removeTree(join(dir, "gone"))).resolves.toBeUndefined();
    });

    it("uses a suffix that can never pass for a job ID", () => {
      expect(`cap_00000001${TOMBSTONE_SUFFIX}`).not.toMatch(/^cap_[0-9a-f]{8}$/);
    });

    it("can still be reached by name before the delete", async () => {
      const target = join(dir, "kept");
      await mkdir(target);
      await access(target);
    });
  });
});
