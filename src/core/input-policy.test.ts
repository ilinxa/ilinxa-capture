import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { InputPolicy } from "./input-policy.js";

describe("InputPolicy", () => {
  let root: string;
  let allowed: string;
  let outside: string;
  let output: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ilinxa-policy-"));
    allowed = join(root, "allowed");
    outside = join(root, "outside");
    output = join(root, "jobs");
    await mkdir(allowed);
    await mkdir(outside);
    await mkdir(output);
    await writeFile(join(allowed, "film.mp4"), "x");
    await writeFile(join(outside, "secret.txt"), "x");
    await writeFile(join(output, "frame.jpg"), "x");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const http = (dirs = ""): InputPolicy =>
    InputPolicy.fromEnv({ ALLOWED_INPUT_DIRS: dirs, LOCAL_OUTPUT_DIR: output }, "http");
  const stdio = (dirs = ""): InputPolicy =>
    InputPolicy.fromEnv({ ALLOWED_INPUT_DIRS: dirs, LOCAL_OUTPUT_DIR: output }, "stdio");

  describe("defaults", () => {
    it("over HTTP, refuses a path outside the output folder", async () => {
      await expect(http().resolve(join(outside, "secret.txt"))).rejects.toMatchObject({
        code: "LOCAL_PATH_FORBIDDEN",
      });
    });

    it("over HTTP, allows a path inside the output folder", async () => {
      await expect(http().resolve(join(output, "frame.jpg"))).resolves.toContain("frame.jpg");
    });

    it("over stdio, allows any path", async () => {
      const target = join(outside, "secret.txt");
      await expect(stdio().resolve(target)).resolves.toBe(target);
    });
  });

  describe("ALLOWED_INPUT_DIRS", () => {
    it("opens a listed folder over HTTP", async () => {
      await expect(http(allowed).resolve(join(allowed, "film.mp4"))).resolves.toContain(
        "film.mp4",
      );
    });

    it("accepts several folders", async () => {
      const policy = http(`${allowed}${delimiter}${outside}`);
      await expect(policy.resolve(join(outside, "secret.txt"))).resolves.toContain("secret.txt");
    });

    it("also restricts stdio when set", async () => {
      await expect(stdio(allowed).resolve(join(outside, "secret.txt"))).rejects.toMatchObject({
        code: "LOCAL_PATH_FORBIDDEN",
      });
    });

    it("treats * as any path, even over HTTP", async () => {
      const target = join(outside, "secret.txt");
      await expect(http("*").resolve(target)).resolves.toBe(target);
    });
  });

  describe("escapes", () => {
    it("refuses ../ out of an allowed folder", async () => {
      await expect(
        http(allowed).resolve(join(allowed, "..", "outside", "secret.txt")),
      ).rejects.toMatchObject({ code: "LOCAL_PATH_FORBIDDEN" });
    });

    it("refuses a sibling folder sharing the allowed prefix", async () => {
      const sibling = `${allowed}-evil`;
      await mkdir(sibling, { recursive: true });
      await writeFile(join(sibling, "x.mp4"), "x");
      await expect(http(allowed).resolve(join(sibling, "x.mp4"))).rejects.toMatchObject({
        code: "LOCAL_PATH_FORBIDDEN",
      });
    });

    it("refuses a symlink inside an allowed folder pointing outside", async () => {
      const link = join(allowed, "link.txt");
      try {
        await symlink(join(outside, "secret.txt"), link);
      } catch {
        return; // Creating symlinks needs a privilege on Windows
      }
      await expect(http(allowed).resolve(link)).rejects.toMatchObject({
        code: "LOCAL_PATH_FORBIDDEN",
      });
    });

    it("says nothing about whether a refused path exists", async () => {
      const exists = http().resolve(join(outside, "secret.txt"));
      const missing = http().resolve(join(outside, "nope.txt"));
      await expect(exists).rejects.toMatchObject({ code: "LOCAL_PATH_FORBIDDEN" });
      await expect(missing).rejects.toMatchObject({ code: "LOCAL_PATH_FORBIDDEN" });
    });

    it("reports a missing file inside an allowed folder", async () => {
      await expect(http(allowed).resolve(join(allowed, "nope.mp4"))).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    });
  });

  describe("values that are not paths", () => {
    it.each([
      "concat:/a.mp4|/b.mp4",
      "file:///etc/passwd",
      "ftp://host/film.mp4",
      "rtsp://host/stream",
      "tcp://127.0.0.1:9000",
      "data:video/mp4;base64,AAAA",
      "subfile:,start,0,end,0,,:/etc/passwd",
    ])("refuses %s even when any path is allowed", async (input) => {
      await expect(stdio().resolve(input)).rejects.toMatchObject({
        code: "UNSUPPORTED_FORMAT",
      });
    });

    it("refuses a null byte", async () => {
      await expect(stdio().resolve("a\0b.mp4")).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    });

    it("turns an option-like value into a plain path", async () => {
      await expect(stdio().resolve("-version")).resolves.toBe(resolve("-version"));
    });

    it("does not mistake a Windows drive for a scheme", async () => {
      await expect(stdio().resolve("C:\\Films\\reel.mp4")).resolves.toContain("reel.mp4");
    });
  });
});
