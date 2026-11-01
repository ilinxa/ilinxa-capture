import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Readable } from "node:stream";

// A read failing partway is what a dying disk does, and nothing else makes one.
const brokenFile = vi.hoisted(() => ({ active: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: vi.fn(async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      if (!brokenFile.active || !String(args[0]).endsWith(".jpg")) return handle;

      await handle.close();
      return {
        createReadStream: () =>
          new Readable({
            read() {
              this.destroy(Object.assign(new Error("read failed"), { code: "EIO" }));
            },
          }),
      };
    }),
  };
});

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type TestServer } from "./helpers.js";

describe("ZIP downloads that go wrong", () => {
  let dir: string;
  let server: TestServer;
  const id = "cap_0000b001";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ilinxa-capture-zip-"));
    server = await startServer({ LOCAL_OUTPUT_DIR: dir });

    await server.app.jobManager.createJob(id, { type: "extract" });
    await server.app.jobManager.runSync(id, async () => ({}));
    await mkdir(join(dir, id, "frames"));
    await writeFile(join(dir, id, "frames", "frame_0001.jpg"), randomBytes(1024));
  });

  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  // An unhandled stream error would end the whole server.
  it("cuts the download off, and the server carries on", async () => {
    brokenFile.active = true;

    const outcome = await fetch(`${server.baseUrl}/api/v1/jobs/${id}/download?include=frames`)
      .then((res) => res.arrayBuffer())
      .then(
        () => "finished",
        () => "cut off",
      );

    brokenFile.active = false;
    expect(outcome).toBe("cut off");

    const health = await fetch(`${server.baseUrl}/api/v1/health`);
    expect(health.status).toBe(200);
  });

  it("serves the same job once the file reads again", async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/jobs/${id}/download?include=frames`);

    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1024);
  });
});
