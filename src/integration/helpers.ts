import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
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

const BARCODE_FILTER =
  "format=yuv420p,geq=" +
  "lum='if(gt(Y,H/4),if(lt(N,96),40,if(lt(N,192),220,60)),32+6*if(lt(X,W/2),mod(N,32),floor(N/32)))'" +
  ":cb=128:cr=128";

/**
 * Lossy codecs and containers cannot carry `makeCodedClip`'s exact values, so
 * this writes each frame's number in two coarse bands, as base-32 digits that
 * survive compression. They are too small to read as cuts. The rest of the
 * picture changes at frames 96 and 192: those are the scene cuts.
 */
export async function makeBarcodeClip(
  path: string,
  encoding: string[],
  { frames = 240, rate = 24, audio = false }: { frames?: number; rate?: number; audio?: boolean } = {},
): Promise<void> {
  const seconds = frames / rate;
  await ffmpeg(
    "-f", "lavfi",
    "-i", `color=c=black:s=320x180:r=${rate}:d=${seconds}`,
    ...(audio ? ["-f", "lavfi", "-i", `sine=d=${seconds}`] : []),
    "-vf", BARCODE_FILTER,
    ...encoding,
    path,
  );
}

/** Which frame of `makeBarcodeClip` an extracted image is. */
export async function barcodeOf(file: string): Promise<number> {
  const { data, info } = await sharp(file)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const digit = (x: number): number => {
    const value = data[Math.round(info.height / 8) * info.width + x]!;
    // Luma comes back from video range to full range.
    return Math.max(0, Math.round((value / 1.164 + 16 - 32) / 6));
  };

  return digit(Math.round((3 * info.width) / 4)) * 32 + digit(Math.round(info.width / 4));
}

/** Presentation time of every frame in a file. */
export async function framePts(path: string): Promise<number[]> {
  const { stdout } = await run(
    "ffprobe",
    ["-v", "error", "-select_streams", "v", "-show_entries", "frame=pts_time", "-of", "csv=p=0", path],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  // FFmpeg 5.1 adds a blank row after a frame that carries side data.
  return stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => Number.parseFloat(line.replace(/,/g, "")))
    .filter((time) => Number.isFinite(time));
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
