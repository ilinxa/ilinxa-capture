import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import type { Env } from "../lib/env.js";
import { createTestEnv } from "../test/env.js";

const run = promisify(execFile);

export interface TestServer {
  app: FastifyInstance;
  baseUrl: string;
  post(path: string, body: unknown): Promise<Response>;
  json<T>(path: string): Promise<T>;
  close(): Promise<void>;
}

/** A real server on a random loopback port, with no UI. */
export async function startServer(overrides: Partial<Env>): Promise<TestServer> {
  const env = createTestEnv({
    UI_DIR: "./ui/dist-does-not-exist",
    ...overrides,
  });
  const app = await buildApp({ env, logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });

  const { port } = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    app,
    baseUrl,
    post: (path, body) =>
      fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    json: async <T>(path: string): Promise<T> =>
      (await (await fetch(`${baseUrl}${path}`)).json()) as T,
    close: () => app.close(),
  };
}

export async function ffmpeg(...args: string[]): Promise<void> {
  await run("ffmpeg", ["-v", "error", "-y", ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** An ordinary clip. Encodes with libx264 where the build has it. */
export async function makeClip(
  path: string,
  { seconds, size = "320x240", rate = 10 }: { seconds: number; size?: string; rate?: number },
): Promise<void> {
  const input = ["-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=${size}:rate=${rate}`];
  try {
    await ffmpeg(...input, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path);
  } catch {
    await ffmpeg(...input, "-c:v", "mpeg4", "-pix_fmt", "yuv420p", path);
  }
}

/**
 * A clip whose every frame has luma equal to its frame number, so a frame on
 * disk says exactly which source frame it is. Lossless, so the value survives.
 * `setpts` may remap time to build variable frame rate video.
 */
export async function makeCodedClip(
  path: string,
  { frames = 250, rate = 25, setpts }: { frames?: number; rate?: number; setpts?: string },
): Promise<void> {
  const seconds = frames / rate;
  const timing = setpts ? `,setpts='${setpts}'` : "";
  await ffmpeg(
    "-f", "lavfi",
    "-i", `color=c=black:s=64x64:r=${rate}:d=${seconds}`,
    "-vf", `format=gray,geq=lum='N'${timing}`,
    "-fps_mode", "passthrough",
    "-c:v", "ffv1",
    path,
  );
}

/** Presentation time of every frame in a file. */
export async function framePts(path: string): Promise<number[]> {
  const { stdout } = await run(
    "ffprobe",
    ["-v", "error", "-select_streams", "v", "-show_entries", "frame=pts_time", "-of", "csv=p=0", path],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => Number.parseFloat(line.replace(/,/g, "")));
}

export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  ms = 20_000,
): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}
