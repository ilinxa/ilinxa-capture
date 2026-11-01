import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  barcodeOf,
  ffmpeg,
  framePts,
  makeBarcodeClip,
  startServer,
  type TestServer,
} from "./helpers.js";

const RATE = 24;
const LOSSLESS_ENOUGH = ["-c:v", "mpeg2video", "-q:v", "2"];

// Regression: an input -ss on these landed past the target, and -t then counted
// from wherever it landed, so a range quietly returned later frames, or none.
// AVI stores no timestamps for B-frames, so FFmpeg's clock has frame 0 at 1/24 s.
// `clockLead` says so: a frame's label is that many frames after its number.
const SOURCES: Array<
  [string, string, string[], { audio?: boolean; clockLead?: number }?]
> = [
  ["MPEG-TS", "ts", [...LOSSLESS_ENOUGH, "-g", "24", "-f", "mpegts"]],
  ["MPEG-TS, one keyframe", "ts", [...LOSSLESS_ENOUGH, "-g", "1000", "-f", "mpegts"]],
  [
    "MPEG-TS with audio",
    "ts",
    [...LOSSLESS_ENOUGH, "-g", "24", "-c:a", "mp2", "-f", "mpegts"],
    { audio: true },
  ],
  ["MPEG-PS", "mpg", [...LOSSLESS_ENOUGH, "-g", "12", "-f", "vob"]],
  ["FLV with B-frames", "flv", ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-bf", "2"]],
  ["AVI with B-frames", "avi", ["-c:v", "mpeg4", "-q:v", "2", "-bf", "2"], { clockLead: 1 }],
  ["MKV", "mkv", ["-c:v", "ffv1"]],
];

interface FrameSet {
  files: string[];
  timestamps: number[];
}

describe("frame accuracy (real ffmpeg)", () => {
  let dir: string;
  let server: TestServer;
  const clips = new Map<string, string>();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ilinxa-capture-acc-"));
    server = await startServer({ LOCAL_OUTPUT_DIR: join(dir, "jobs") });

    await Promise.all(
      SOURCES.map(async ([name, ext, encoding, options], index) => {
        const clip = join(dir, `source_${index}.${ext}`);
        await makeBarcodeClip(clip, encoding, options);
        clips.set(name, clip);
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  async function extract(name: string, start: number, end: number): Promise<FrameSet> {
    const res = await server.post("/api/v1/extract", {
      source: clips.get(name),
      fps: RATE,
      preset: "high",
      start,
      end,
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { frames: FrameSet }).frames;
  }

  describe.each(SOURCES)("%s", (name, _ext, _encoding, options) => {
    const lead = options?.clockLead ?? 0;

    it("returns exactly the frames of a range, at their real times", async () => {
      const frames = await extract(name, 7.5, 8.5);

      const numbers = await Promise.all(frames.files.map(barcodeOf));
      expect(numbers).toEqual(Array.from({ length: 24 }, (_, i) => 180 - lead + i));

      frames.timestamps.forEach((time, i) => {
        expect(time).toBeCloseTo((180 + i) / RATE, 1);
      });
    }, 60_000);

    it("does not overshoot a range at the very start of the file", async () => {
      const frames = await extract(name, 0.05, 0.5);

      const numbers = await Promise.all(frames.files.map(barcodeOf));
      expect(numbers).toEqual(Array.from({ length: 10 }, (_, i) => 2 - lead + i));
    }, 60_000);

    it("puts every shot's frames inside that shot", async () => {
      const res = await server.post("/api/v1/shots", {
        source: clips.get(name),
        preset: "high",
        frame_positions: ["first", "middle", "last"],
      });
      expect(res.status).toBe(200);

      const { shots, frames } = (await res.json()) as {
        shots: { items: Array<{ start: number; end: number; frames: number[] }> };
        frames: FrameSet;
      };

      expect(shots.items).toHaveLength(3);
      const bounds = [
        [0, 95],
        [96, 191],
        [192, 239],
      ] as const;

      for (const [index, shot] of shots.items.entries()) {
        const [first, last] = bounds[index]!;
        const numbers = await Promise.all(
          shot.frames.map((frame) => barcodeOf(frames.files[frame]!)),
        );

        expect(numbers).toHaveLength(3);
        expect(numbers[0]).toBe(first);
        expect(numbers[1]).toBeGreaterThan(first);
        expect(numbers[1]).toBeLessThan(last);
        expect(numbers[2]).toBe(last);

        // Regression: a first frame could be timed just before its own shot.
        const firstTime = frames.timestamps[shot.frames[0]!]!;
        expect(firstTime).toBeGreaterThanOrEqual(shot.start);
        expect(firstTime - shot.start).toBeLessThan(2 / RATE);
      }
    }, 60_000);
  });

  describe("sampling", () => {
    const encode = (rate: string, file: string, ...audio: string[]): Promise<void> =>
      ffmpeg(
        "-f", "lavfi",
        "-i", `testsrc=duration=15:size=64x36:rate=${rate}`,
        "-f", "lavfi",
        "-i", "sine=d=15",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        ...audio,
        "-shortest",
        file,
      );

    // Regression: AAC priming puts video about 21 ms in, on a boundary of a 24 fps
    // grid, and millisecond MKV timestamps then lost a third of the frames. Taking
    // every frame then failed the encoder, for the same timestamps.
    it.each([
      ["24", 24, "llm"],
      ["24", 24, "high"],
      ["24000/1001", 23.98, "llm"],
      ["24000/1001", 23.98, "high"],
    ])("keeps every frame of a %s fps MKV with AAC, %s", async (rate, fps, preset) => {
      const file = join(dir, `aac_${fps}_${preset}.mkv`);
      await encode(rate, file, "-c:a", "aac", "-ar", "48000");

      const res = await server.post("/api/v1/extract", { source: file, fps, preset });
      const { frames } = (await res.json()) as { frames: FrameSet };

      expect(res.status).toBe(200);
      expect(frames.timestamps).toHaveLength((await framePts(file)).length);
    });

    it("keeps every frame of a range of one", async () => {
      const file = join(dir, "aac_range.mkv");
      await encode("24", file, "-c:a", "aac", "-ar", "48000");

      const res = await server.post("/api/v1/extract", {
        source: file,
        fps: 24,
        start: 5,
        end: 10,
      });
      const { frames } = (await res.json()) as { frames: FrameSet };

      expect(res.status).toBe(200);
      expect(frames.timestamps).toHaveLength(120);
    });

    // Regression: rounded times made some gaps half the others.
    it("spaces frames evenly below the source rate", async () => {
      const file = join(dir, "half.mkv");
      await encode("24", file, "-c:a", "aac", "-ar", "48000");

      const res = await server.post("/api/v1/extract", { source: file, fps: 12 });
      const { frames } = (await res.json()) as { frames: FrameSet };

      const gaps = frames.timestamps.slice(1).map((time, i) => time - frames.timestamps[i]!);
      expect(frames.timestamps.length).toBeGreaterThan(175);
      expect(frames.timestamps.length).toBeLessThan(185);
      expect(Math.min(...gaps)).toBeGreaterThan(0.06);
      expect(Math.max(...gaps)).toBeLessThan(0.11);
    });
  });

  // Found while landing the seek fix: a second print filter on stdout interleaves
  // its 32 KB buffers with the first, which only shows on a long range.
  it("keeps exact times on a range long enough to fill FFmpeg's buffers", async () => {
    const file = join(dir, "long.mp4");
    await ffmpeg(
      "-f", "lavfi",
      "-i", "testsrc=duration=130:size=64x36:rate=30",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "30",
      file,
    );

    const res = await server.post("/api/v1/extract", {
      source: file,
      fps: 30,
      start: 1,
      end: 121,
    });
    const { frames } = (await res.json()) as { frames: FrameSet };

    expect(frames.timestamps).toHaveLength(3600);
    expect(frames.timestamps[0]).toBeCloseTo(1, 6);
    expect(frames.timestamps.at(-1)).toBeCloseTo(121 - 1 / 30, 3);

    const gaps = frames.timestamps.slice(1).map((time, i) => time - frames.timestamps[i]!);
    expect(Math.max(...gaps)).toBeLessThan(0.034);
    expect(Math.min(...gaps)).toBeGreaterThan(0.033);
  }, 90_000);
});
