import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: vi.fn(original.rename), rm: vi.fn(original.rm) };
});

import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOMBSTONE_SUFFIX,
  buildPath,
  isFileInUse,
  removeTree,
  replaceDir,
  settleSwap,
  writeFileAtomic,
} from "./safe-fs.js";

const inUse = (): Error => Object.assign(new Error("held open"), { code: "EBUSY" });

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

  describe("replaceDir", () => {
    let target: string;

    async function fill(folder: string, name: string): Promise<void> {
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, name), name);
    }

    beforeEach(() => {
      target = join(dir, "sheets");
    });

    it("swaps the build in and leaves nothing else behind", async () => {
      await fill(target, "old.jpg");
      await fill(buildPath(target), "new.jpg");

      await replaceDir(target);

      expect(await readdir(dir)).toEqual(["sheets"]);
      expect(await readdir(target)).toEqual(["new.jpg"]);
    });

    it("works the first time, with nothing to replace", async () => {
      await fill(buildPath(target), "new.jpg");

      await replaceDir(target);

      expect(await readdir(target)).toEqual(["new.jpg"]);
    });

    // Regression: the old sheets were deleted first, so a held file left the job
    // reporting sheets that were gone.
    it("leaves the old directory whole if a file in it is held open", async () => {
      await fill(target, "old.jpg");
      await fill(buildPath(target), "new.jpg");
      for (let attempt = 0; attempt < 5; attempt++) {
        vi.mocked(rename).mockRejectedValueOnce(inUse());
      }

      await expect(replaceDir(target)).rejects.toMatchObject({ code: "EBUSY" });

      expect(await readdir(target)).toEqual(["old.jpg"]);
    });

    it("puts the old directory back if the build cannot move in", async () => {
      await fill(target, "old.jpg");

      await expect(replaceDir(target)).rejects.toMatchObject({ code: "ENOENT" });

      expect(await readdir(dir)).toEqual(["sheets"]);
      expect(await readdir(target)).toEqual(["old.jpg"]);
    });

    it("rides out a file held for a moment", async () => {
      await fill(target, "old.jpg");
      await fill(buildPath(target), "new.jpg");
      vi.mocked(rename).mockRejectedValueOnce(inUse());

      await replaceDir(target);

      expect(await readdir(target)).toEqual(["new.jpg"]);
    });

    it("does not fail on a retired folder it cannot clear yet", async () => {
      await fill(target, "old.jpg");
      await fill(buildPath(target), "new.jpg");
      const original = await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
      vi.mocked(rm)
        .mockImplementationOnce(original.rm)
        .mockRejectedValueOnce(inUse());

      await replaceDir(target);

      expect(await readdir(target)).toEqual(["new.jpg"]);
    });
  });

  describe("settleSwap", () => {
    it("restores what a crash left moved aside, and drops the build", async () => {
      const target = join(dir, "sheets");
      await mkdir(`${target}.old`);
      await writeFile(join(`${target}.old`, "old.jpg"), "x");
      await mkdir(buildPath(target));

      await settleSwap(target);

      expect(await readdir(dir)).toEqual(["sheets"]);
      expect(await readdir(target)).toEqual(["old.jpg"]);
    });

    it("keeps a finished swap, and drops the retired folder", async () => {
      const target = join(dir, "sheets");
      await mkdir(target);
      await writeFile(join(target, "new.jpg"), "x");
      await mkdir(`${target}.old`);

      await settleSwap(target);

      expect(await readdir(dir)).toEqual(["sheets"]);
      expect(await readdir(target)).toEqual(["new.jpg"]);
    });

    it("has nothing to do on a job that never composed", async () => {
      await expect(settleSwap(join(dir, "sheets"))).resolves.toBeUndefined();
    });
  });

  describe("isFileInUse", () => {
    it.each([
      ["EBUSY", true],
      ["EPERM", true],
      ["ENOENT", false],
    ])("says %s is %s", (code, expected) => {
      expect(isFileInUse(Object.assign(new Error("x"), { code }))).toBe(expected);
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

    // Regression: this threw after the job had already gone, so cleanup kept
    // a registry entry for a job with no files.
    it("leaves a stuck tombstone for the sweep, and counts the job as gone", async () => {
      const target = join(dir, "cap_00000001");
      await mkdir(target);
      vi.mocked(rm).mockRejectedValueOnce(inUse());

      await expect(removeTree(target)).resolves.toBeUndefined();

      expect(await readdir(dir)).toEqual([`cap_00000001${TOMBSTONE_SUFFIX}`]);
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
