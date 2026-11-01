import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { ffmpeg, startServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";

const run = promisify(execFile);

interface ShotsBody {
  job_id: string;
  shots: {
    count: number;
    items: Array<{
      index: number;
      start: number;
      end: number;
      duration: number;
      frames: number[];
    }>;
  };
  frames: { count: number; files: string[]; timestamps: number[] };
}

async function dominantChannel(file: string): Promise<"red" | "green" | "blue"> {
  const { channels } = await sharp(file).stats();
  const [r, g, b] = channels.map((c) => c.mean) as [number, number, number];
  if (r > g && r > b) return "red";
  return b > g ? "blue" : "green";
}

async function probeAudio(path: string): Promise<{
  sampleRate: number;
  channels: number;
  duration: number;
  codec: string;
}> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=sample_rate,channels,codec_name:format=duration",
    "-of", "json",
    path,
  ]);
  const info = JSON.parse(stdout) as {
    streams: Array<{ sample_rate: string; channels: number; codec_name: string }>;
    format: { duration: string };
  };
  return {
    sampleRate: Number(info.streams[0]?.sample_rate),
    channels: info.streams[0]?.channels ?? 0,
    duration: Number(info.format.duration),
    codec: info.streams[0]?.codec_name ?? "",
  };
}

/** Seconds into a 16-bit mono WAV where sound first appears. */
async function firstSoundAt(path: string, sampleRate: number): Promise<number> {
  const wav = await readFile(path);
  const data = wav.indexOf("data") + 8;
  for (let offset = data; offset + 1 < wav.length; offset += 2) {
    if (Math.abs(wav.readInt16LE(offset)) > 1000) {
      return (offset - data) / 2 / sampleRate;
    }
  }
  return Number.NaN;
}

describe("film features (real ffmpeg)", () => {
  let dir: string;
  let film: string;
  let server: TestServer;

  // Red to 2.0 s, blue to 5.0 s, green to 8.0 s, at 25 fps.
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ilinxa-capture-film-"));
    film = join(dir, "film.mkv");

    await ffmpeg(
      "-f", "lavfi", "-i", "color=c=red:s=320x180:r=25:d=2",
      "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=25:d=3",
      "-f", "lavfi", "-i", "color=c=lime:s=320x180:r=25:d=3",
      // Silent except for a tone from 3.0 s to 3.5 s, on a second track too.
      "-f", "lavfi", "-i", "aevalsrc='if(gte(t,3)*lt(t,3.5),0.5*sin(2*PI*440*t),0)':s=48000:d=8",
      "-f", "lavfi", "-i", "aevalsrc='0.3*sin(2*PI*880*t)':s=44100:d=5",
      "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0[v]",
      "-map", "[v]",
      "-map", "3:a",
      "-map", "4:a",
      "-metadata:s:a:1", "language=tur",
      "-c:v", "ffv1",
      "-c:a", "flac",
      film,
    );

    server = await startServer({ LOCAL_OUTPUT_DIR: join(dir, "jobs") });
  }, 60_000);

  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function shots(request: Record<string, unknown>): Promise<ShotsBody> {
    const res = await server.post("/api/v1/shots", { source: film, ...request });
    expect(res.status).toBe(200);
    return (await res.json()) as ShotsBody;
  }

  describe("shot detection", () => {
    it("finds each hard cut within one frame", async () => {
      const { shots: list } = await shots({ frame_positions: [] });

      expect(list.count).toBe(3);
      expect(list.items[1]!.start).toBeCloseTo(2, 1);
      expect(Math.abs(list.items[1]!.start - 2)).toBeLessThanOrEqual(0.04);
      expect(Math.abs(list.items[2]!.start - 5)).toBeLessThanOrEqual(0.04);
    });

    it("returns contiguous shots that cover the whole film", async () => {
      const { shots: list } = await shots({ frame_positions: [] });

      expect(list.items[0]!.start).toBe(0);
      expect(list.items.at(-1)!.end).toBeCloseTo(8, 1);
      for (let i = 1; i < list.items.length; i++) {
        expect(list.items[i]!.start).toBe(list.items[i - 1]!.end);
      }
    });

    it("respects the minimum shot length", async () => {
      const { shots: list } = await shots({
        frame_positions: [],
        min_shot_seconds: 2.5,
      });
      // The cut at 2 s comes too soon; the cut at 5 s leaves 3 s after it.
      expect(list.items.map((s) => Math.round(s.start))).toEqual([0, 5]);

      // With 4 s, the 3 s tail is too short too, and rejoins the shot before it.
      const merged = await shots({ frame_positions: [], min_shot_seconds: 4 });
      expect(merged.shots.count).toBe(1);
    });

    it("works inside a time range, with times on the film's timeline", async () => {
      const { shots: list } = await shots({
        frame_positions: [],
        start: 3,
        end: 7,
      });

      expect(list.count).toBe(2);
      expect(list.items[0]!.start).toBe(3);
      expect(Math.abs(list.items[1]!.start - 5)).toBeLessThanOrEqual(0.04);
      expect(list.items[1]!.end).toBe(7);
    });

    it("returns one shot for a video with no cuts", async () => {
      const single = join(dir, "single.mp4");
      await ffmpeg("-f", "lavfi", "-i", "color=c=red:s=160x90:r=25:d=2", single);

      const res = await server.post("/api/v1/shots", {
        source: single,
        frame_positions: ["middle"],
      });
      const body = (await res.json()) as ShotsBody;
      expect(body.shots.count).toBe(1);
      expect(body.frames.count).toBe(1);
    });
  });

  describe("frames per shot", () => {
    it("takes first, middle and last from the right shot, at true times", async () => {
      const body = await shots({
        frame_positions: ["first", "middle", "last"],
        preset: "high",
      });

      expect(body.frames.count).toBe(9);

      const colors = ["red", "blue", "green"] as const;
      for (const [i, shot] of body.shots.items.entries()) {
        expect(shot.frames).toHaveLength(3);
        for (const frame of shot.frames) {
          expect(await dominantChannel(body.frames.files[frame]!)).toBe(colors[i]);
          const time = body.frames.timestamps[frame]!;
          expect(time).toBeGreaterThanOrEqual(shot.start - 0.001);
          expect(time).toBeLessThan(shot.end);
        }
      }

      // The first frame of a shot is its first frame, not the one after it.
      const second = body.shots.items[1]!;
      expect(
        Math.abs(body.frames.timestamps[second.frames[0]!]! - second.start),
      ).toBeLessThanOrEqual(0.04);
    });

    it("composes into sheets labeled with shot numbers", async () => {
      const body = await shots({ frame_positions: ["middle"] });

      const res = await server.post("/api/v1/compose", {
        job_id: body.job_id,
        mode: 4,
        overlay_timestamp: true,
      });
      expect(res.status).toBe(200);

      const manifest = await server.json<{
        frames: Array<{ shot: number; position: string; pts_time: number }>;
        shots: unknown[];
        sheets: unknown[];
      }>(`/api/v1/files/${body.job_id}/manifest.json`);

      expect(manifest.frames.map((f) => f.shot)).toEqual([1, 2, 3]);
      expect(manifest.frames[1]?.position).toBe("middle");
      expect(manifest.shots).toHaveLength(3);
      expect(manifest.sheets).toHaveLength(1);

      // Composing must not lose the shot list.
      const job = await server.json<{ shots?: { count: number } }>(
        `/api/v1/jobs/${body.job_id}`,
      );
      expect(job.shots?.count).toBe(3);
    });
  });

  describe("audio extraction from local files", () => {
    interface AudioBody {
      audio: { file: string; url: string; sample_rate: number; channels: number };
      timeline_offset: number;
    }

    async function audio(request: Record<string, unknown>): Promise<AudioBody> {
      const res = await server.post("/api/v1/audio", { source: film, ...request });
      expect(res.status).toBe(200);
      return (await res.json()) as AudioBody;
    }

    it("lists audio streams in metadata", async () => {
      const res = await server.post("/api/v1/metadata", { source: film });
      const { audio_streams: streams } = (await res.json()) as {
        audio_streams: Array<{ index: number; language: string | null; sample_rate: number }>;
      };

      expect(streams).toHaveLength(2);
      expect(streams[0]?.sample_rate).toBe(48000);
      expect(streams[1]).toMatchObject({ index: 1, language: "tur", sample_rate: 44100 });
    });

    it("honors stream, sample rate and channels", async () => {
      const { audio: out } = await audio({ stream: 1, sample_rate: 16000, channels: 1 });
      const info = await probeAudio(out.file);

      expect(info).toMatchObject({ sampleRate: 16000, channels: 1, codec: "pcm_s16le" });
      // Track 2 runs 5 s; track 1 runs 8 s. This proves which one came out.
      expect(info.duration).toBeCloseTo(5, 0);
      expect(out.sample_rate).toBe(16000);
    });

    it("keeps the source rate by default", async () => {
      const { audio: out } = await audio({});
      expect((await probeAudio(out.file)).sampleRate).toBe(48000);
      expect(out.sample_rate).toBe(48000);
    });

    it.each([
      ["flac", "flac"],
      ["mp3", "mp3"],
      ["m4a", "aac"],
    ])("exports %s", async (format, codec) => {
      const { audio: out } = await audio({ format });
      expect((await probeAudio(out.file)).codec).toBe(codec);
    });

    it("lines up with the video timeline", async () => {
      const { audio: out } = await audio({ channels: 1 });
      expect(await firstSoundAt(out.file, out.sample_rate)).toBeCloseTo(3, 2);
    });

    it("gives an offset that maps range audio back to film time", async () => {
      const { audio: out, timeline_offset: offset } = await audio({
        channels: 1,
        start: 2,
        end: 6,
      });

      const info = await probeAudio(out.file);
      expect(info.duration).toBeCloseTo(4, 1);
      expect(offset).toBe(2);
      expect(offset + (await firstSoundAt(out.file, out.sample_rate))).toBeCloseTo(3, 2);
    });

    it("serves the file through the file route", async () => {
      const { audio: out } = await audio({});
      const res = await fetch(`${server.baseUrl}${out.url}`);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("audio/wav");
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    });

    it("rejects a stream that does not exist", async () => {
      const res = await server.post("/api/v1/audio", { source: film, stream: 5 });
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toContain("this video has 2");
    });

    it("rejects a video with no audio", async () => {
      const silent = join(dir, "silent.mp4");
      await ffmpeg("-f", "lavfi", "-i", "color=c=red:s=160x90:r=25:d=1", silent);

      const res = await server.post("/api/v1/audio", { source: silent });
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toContain("no audio");
    });

    it("works from an upload", async () => {
      const form = new FormData();
      form.append("sample_rate", "16000");
      form.append("file", new Blob([await readFile(film)]), "film.mkv");

      const res = await fetch(`${server.baseUrl}/api/v1/audio`, {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(200);
    });
  });
});
