import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { ffmpeg, makeClip, makeCodedClip, startServer, waitUntil, type TestServer } from "./helpers.js";

const run = promisify(execFile);

/**
 * Defects found by adversarial review of 0.2.0 before release. Each test is the
 * reviewer's own scenario, and fails if its fix is reverted.
 */
describe("review findings (real ffmpeg)", () => {
  let dir: string;
  let jobs: string;
  let clip: string;
  let server: TestServer;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ilinxa-capture-rev-"));
    jobs = join(dir, "jobs");
    clip = join(dir, "clip.mp4");
    await makeClip(clip, { seconds: 4, size: "320x180", rate: 10 });
    server = await startServer({ LOCAL_OUTPUT_DIR: jobs });
  }, 60_000);

  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  function upload(fields: Array<[string, string]>, after = false): FormData {
    return buildForm(fields, after);
  }

  let clipBytes: Buffer | null = null;
  function buildForm(fields: Array<[string, string]>, fileFirst: boolean): FormData {
    const form = new FormData();
    if (fileFirst) form.append("file", new Blob([clipBytes!]), "clip.mp4");
    for (const [key, value] of fields) form.append(key, value);
    if (!fileFirst) form.append("file", new Blob([clipBytes!]), "clip.mp4");
    return form;
  }

  beforeAll(async () => {
    clipBytes = await readFile(clip);
  });

  async function colorOf(file: string): Promise<"red" | "green" | "blue" | "white" | "black"> {
    const { channels } = await sharp(file).stats();
    const [r, g, b] = channels.map((c) => c.mean) as [number, number, number];
    if (r > 200 && g > 200 && b > 200) return "white";
    if (r < 50 && g < 50 && b < 50) return "black";
    if (r > g && r > b) return "red";
    return b > g ? "blue" : "green";
  }

  beforeAll(async () => {
    await ffmpeg(
      "-f", "lavfi", "-i", "color=c=black:s=160x90:r=25:d=1",
      "-f", "lavfi", "-i", "sine=d=1",
      "-map", "0:v", "-map", "1:a", "-c:v", "ffv1", "-c:a", "flac",
      join(dir, "voice.mkv"),
    );
  });

  describe("what ffmpeg may be given", () => {
    it.each([
      ["a local path", "C:\\secret\\list.m3u8"],
      ["a POSIX path", "/etc/list.m3u8"],
      ["a file URL", "file:///etc/list.m3u8"],
      ["a concat string", "concat:/a.m3u8"],
      ["a tcp URL", "tcp://127.0.0.1:9/x.m3u8"],
    ])("refuses %s as a format_selector", async (_name, selector) => {
      // Async, so the answer is the check itself: a selector that got through
      // would be accepted, and only fail later on the dead port.
      const res = await server.post("/api/v1/video/download", {
        url: "http://127.0.0.1:9/video.mp4",
        format_selector: selector,
        async: true,
      });
      expect(res.status).toBe(400);
    });

    it("still accepts a real format selector", async () => {
      const res = await server.post("/api/v1/video/download", {
        url: "http://127.0.0.1:9/video.mp4",
        format_selector: "bestvideo+bestaudio",
        async: true,
      });
      expect(res.status).toBe(202);
    });

    it.each([
      ["an HLS playlist", "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4,\nclip.mp4\n#EXT-X-ENDLIST\n"],
      ["a concat list", "ffconcat version 1.0\nfile clip.mp4\n"],
      [
        "a DASH manifest",
        '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"></MPD>',
      ],
    ])("refuses %s dressed as a video", async (_name, text) => {
      const form = new FormData();
      form.append("fps", "1");
      form.append("file", new Blob([text]), "video.bin");

      const res = await fetch(`${server.baseUrl}/api/v1/extract`, { method: "POST", body: form });
      expect(res.status).toBe(400);
    });

    // The list is valid and its target exists beside it, so FFmpeg would read
    // the other file if the container allowlist did not refuse the list itself.
    it("refuses a list that names a real file beside it", async () => {
      const list = join(dir, "list.bin");
      await writeFile(list, "ffconcat version 1.0\nfile clip.mp4\n");

      const res = await server.post("/api/v1/extract", { source: list, fps: 1 });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "UNSUPPORTED_FORMAT",
      );
    });
  });

  describe("input that cannot be read", () => {
    it.each([
      ["a corrupt file", () => randomBytes(4096)],
      ["a text file", () => Buffer.from("not a video")],
    ])("explains %s, without saying where it is", async (_name, bytes) => {
      const folder = join(dir, "private-folder");
      await mkdir(folder, { recursive: true });
      const bad = join(folder, "bad.mp4");
      await writeFile(bad, bytes());

      for (const route of ["/api/v1/metadata", "/api/v1/extract"]) {
        const res = await server.post(route, { source: bad, fps: 1 });
        const { error } = (await res.json()) as { error: { code: string; message: string } };

        expect(res.status).toBe(400);
        expect(error.code).toBe("UNSUPPORTED_FORMAT");
        expect(error.message).toContain("Not a readable video");
        expect(error.message).not.toContain("private-folder");
      }
    });

    it("says when a file has sound but no picture", async () => {
      const sound = join(dir, "sound.mp3");
      await ffmpeg("-f", "lavfi", "-i", "sine=d=1", sound);
      const res = await server.post("/api/v1/metadata", { source: sound });

      // mp3 is outside the allowlist, so this is refused rather than probed.
      expect(res.status).toBe(400);
    });

    it("says when a container has audio only", async () => {
      const sound = join(dir, "sound.mkv");
      await ffmpeg("-f", "lavfi", "-i", "sine=d=1", "-c:a", "flac", sound);

      const res = await server.post("/api/v1/metadata", { source: sound });
      const { error } = (await res.json()) as { error: { message: string } };

      expect(res.status).toBe(400);
      expect(error.message).toContain("No video stream");
    });
  });

  // ffprobe gives these no duration, and a rate that depends on its version.
  describe("raw video streams", () => {
    it.each([
      ["h264", ["-c:v", "libx264", "-preset", "ultrafast", "-bf", "2"]],
      ["hevc", ["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error"]],
      ["m2v", ["-c:v", "mpeg2video"]],
    ])("measures a .%s stream", async (ext, encoding) => {
      const raw = join(dir, `stream.${ext}`);
      await ffmpeg(
        "-f", "lavfi",
        "-i", "testsrc=duration=6:size=160x90:rate=24",
        "-pix_fmt", "yuv420p",
        ...encoding,
        raw,
      );

      const res = await server.post("/api/v1/metadata", { source: raw });
      const metadata = (await res.json()) as { duration: number; fps: number };

      expect(res.status).toBe(200);
      expect(metadata.duration).toBeCloseTo(6, 0);
      expect(metadata.fps).toBeCloseTo(24, 0);

      const ranged = await server.post("/api/v1/extract", { source: raw, fps: 1, start: 2 });
      const { frames } = (await ranged.json()) as { frames: { timestamps: number[] } };

      expect(ranged.status).toBe(200);
      expect(frames.timestamps[0]).toBeCloseTo(2, 1);
    });

    it("holds a raw stream to the length limit", async () => {
      const raw = join(dir, "long.h264");
      await ffmpeg(
        "-f", "lavfi",
        "-i", "testsrc=duration=6:size=160x90:rate=24",
        "-c:v", "libx264", "-preset", "ultrafast",
        raw,
      );
      const limited = await startServer({
        LOCAL_OUTPUT_DIR: join(dir, "raw-limit"),
        MAX_VIDEO_DURATION: 5,
      });

      try {
        const res = await limited.post("/api/v1/extract", { source: raw, fps: 1 });
        expect(res.status).toBe(413);
      } finally {
        await limited.close();
      }
    });
  });

  describe("a client that hangs up", () => {
    async function openFiles(): Promise<number> {
      // Windows has no equivalent, but shows the leak as a job it cannot delete.
      return process.platform === "linux" ? (await readdir("/proc/self/fd")).length : 0;
    }

    /** A finished job holding one file too big to fit in the socket buffers. */
    async function bigJob(id: string, subDir: string, name: string): Promise<void> {
      await server.app.jobManager.createJob(id, { type: "extract" });
      await server.app.jobManager.runSync(id, async () => ({}));
      const folder = join(jobs, id, subDir);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, name), randomBytes(32 * 1024 * 1024));
    }

    async function abandon(path: string): Promise<void> {
      const controller = new AbortController();
      const res = await fetch(`${server.baseUrl}${path}`, { signal: controller.signal });
      await res.body!.getReader().read();
      controller.abort();
    }

    // Regression: each one leaked a file handle, for good.
    it.each([
      ["a ZIP", "cap_0000a001", "frames", "frame_0001.png", "download?include=frames"],
      ["a video", "cap_0000a002", "video", "clip.mp4", "video"],
    ])("leaves nothing open after abandoning %s", async (_name, id, subDir, name, route) => {
      await bigJob(id, subDir, name);
      const before = await openFiles();

      for (let i = 0; i < 5; i++) await abandon(`/api/v1/jobs/${id}/${route}`);

      await waitUntil(async () => (await openFiles()) <= before + 2, 5000);

      await waitUntil(async () => {
        const res = await fetch(`${server.baseUrl}/api/v1/jobs/${id}`, { method: "DELETE" });
        return res.status === 204;
      }, 5000);
    });

    // Regression: the job ran on for nobody, holding its slot.
    it("stops the sync job it was waiting for", async () => {
      const root = join(dir, "hangup");
      const limited = await startServer({ LOCAL_OUTPUT_DIR: root, MAX_CONCURRENT_JOBS: 1 });
      const slow = join(dir, "hangup.mp4");
      await makeClip(slow, { seconds: 60, size: "1280x720", rate: 30 });

      const readJob = async (id: string): Promise<{ status: string; error_code: string | null }> =>
        JSON.parse(await readFile(join(root, id, "job.json"), "utf-8")) as {
          status: string;
          error_code: string | null;
        };

      try {
        const controller = new AbortController();
        const request = fetch(`${limited.baseUrl}/api/v1/extract`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: slow, fps: 30, preset: "high" }),
          signal: controller.signal,
        }).catch(() => null);

        let id = "";
        await waitUntil(async () => {
          [id = ""] = await readdir(root).catch(() => []);
          return id !== "" && (await readJob(id).catch(() => null))?.status === "processing";
        });

        controller.abort();
        await request;

        await waitUntil(async () => (await readJob(id)).status === "failed");
        expect((await readJob(id)).error_code).toBe("JOB_CANCELLED");

        const next = await limited.post("/api/v1/extract", { source: clip, fps: 1 });
        expect(next.status).toBe(200);
      } finally {
        await limited.close();
      }
    }, 60_000);
  });

  describe("audio that outlasts the video", () => {
    let film: string;

    beforeAll(async () => {
      film = join(dir, "tail.mp4");
      await ffmpeg(
        "-f", "lavfi", "-i", "color=c=red:s=320x180:r=25:d=2",
        "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=25:d=2",
        "-f", "lavfi", "-i", "sine=d=10",
        "-filter_complex", "[0][1]concat=n=2:v=1:a=0[v]",
        "-map", "[v]", "-map", "2:a",
        "-c:a", "aac",
        film,
      );
    });

    it("ends the last shot where the video ends, not the audio", async () => {
      const res = await server.post("/api/v1/shots", { source: film, frame_positions: [] });
      expect(res.status).toBe(200);
      const { shots } = (await res.json()) as { shots: { items: Array<{ end: number }> } };
      expect(shots.items.at(-1)!.end).toBeCloseTo(4, 1);
    });

    it.each([
      ["default JPEG", {}],
      ["PNG", { preset: "high" }],
    ])("captures a real last and middle frame with %s", async (_name, preset) => {
      const res = await server.post("/api/v1/shots", {
        source: film,
        frame_positions: ["middle", "last"],
        ...preset,
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        frames: { count: number; timestamps: number[]; files: string[] };
      };
      expect(body.frames.count).toBe(4);
      expect(body.frames.timestamps.at(-1)).toBeCloseTo(3.96, 1);
      expect(await colorOf(body.frames.files.at(-1)!)).toBe("blue");
    });

    it("answers a range past the video with a clear 400", async () => {
      for (const path of ["/api/v1/extract", "/api/v1/shots"]) {
        const res = await server.post(path, { source: film, fps: 1, start: 6, end: 8 });
        expect(res.status).toBe(400);
        expect((await res.json()).error.message).toContain("No video frames");
      }
    });
  });

  it("takes the true last frame before a cut across a gap in the source", async () => {
    const vfr = join(dir, "vfrcut.mkv");
    // White to 2.96 s, a gap, then black from 4.0 s.
    await makeCodedClip(vfr, {
      frames: 150,
      setpts: "if(lt(N,75),N/25,(N+25)/25)/TB",
    });
    // Luma counts up, so force a hard cut with a clear step at the gap.
    const cut = join(dir, "cut.mkv");
    await ffmpeg(
      "-f", "lavfi", "-i", "color=c=white:s=160x90:r=25:d=3",
      "-f", "lavfi", "-i", "color=c=black:s=160x90:r=25:d=3",
      "-filter_complex", "[0]setpts=PTS-STARTPTS[a];[1]setpts=PTS-STARTPTS+4/TB[b];[a][b]concat=n=2:v=1:a=0,setpts='if(lt(N,75),N/25,(N+25)/25)/TB'[v]",
      "-map", "[v]",
      "-fps_mode", "passthrough",
      "-c:v", "ffv1",
      cut,
    );

    const res = await server.post("/api/v1/shots", {
      source: cut,
      frame_positions: ["last"],
      preset: "high",
    });
    const body = (await res.json()) as {
      shots: { items: Array<{ start: number; frames: number[] }> };
      frames: { files: string[]; timestamps: number[] };
    };

    expect(body.shots.items).toHaveLength(2);
    const first = body.shots.items[0]!.frames[0]!;
    expect(await colorOf(body.frames.files[first]!)).toBe("white");
    expect(body.frames.timestamps[first]).toBeCloseTo(2.96, 2);
  }, 60_000);

  it("samples every frame of a millisecond-timebase MKV at its own rate", async () => {
    const mkv = join(dir, "ms.mkv");
    await ffmpeg("-f", "lavfi", "-i", "testsrc=d=4:s=160x90:r=30", "-c:v", "ffv1", mkv);

    const res = await server.post("/api/v1/extract", { source: mkv, fps: 30 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { frames: { count: number } }).frames.count).toBe(120);
  });

  describe("a video with no stated duration", () => {
    let piped: string;

    beforeAll(async () => {
      piped = join(dir, "piped.mkv");
      const child = spawn("ffmpeg", [
        "-v", "error", "-f", "lavfi", "-i", "testsrc=d=12:s=160x90:r=10",
        "-c:v", "ffv1", "-f", "matroska", "pipe:1",
      ]);
      const done = new Promise((resolve) => child.on("close", resolve));
      child.stdout.pipe(createWriteStream(piped));
      await done;
    });

    it("still gets its real length", async () => {
      const res = await server.post("/api/v1/metadata", { source: piped });
      const { duration } = (await res.json()) as { duration: number };
      expect(duration).toBeGreaterThan(11);
    });

    it("cannot slip past the duration limit", async () => {
      const limited = await startServer({ LOCAL_OUTPUT_DIR: jobs, MAX_VIDEO_DURATION: 5 });
      try {
        const res = await limited.post("/api/v1/extract", { source: piped, fps: 1 });
        expect(res.status).toBe(413);
      } finally {
        await limited.close();
      }
    });

    it("honors a start with no end", async () => {
      const res = await server.post("/api/v1/extract", { source: piped, fps: 1, start: 10 });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { frames: { count: number } }).frames.count).toBe(2);
    });
  });

  describe("delayed audio", () => {
    let delayed: string;

    beforeAll(async () => {
      delayed = join(dir, "delayed.mkv");
      await ffmpeg(
        "-f", "lavfi", "-i", "color=c=black:s=160x90:r=25:d=6",
        // A track that starts 2 s in, with a tone 1 s after that: film time 3 s.
        "-itsoffset", "2",
        "-f", "lavfi", "-i", "aevalsrc='if(gte(t,1)*lt(t,1.5),0.5*sin(2*PI*440*t),0)':s=16000:d=4",
        "-map", "0:v", "-map", "1:a",
        "-c:v", "ffv1", "-c:a", "flac",
        delayed,
      );
    });

    async function firstSound(path: string, rate: number): Promise<number> {
      const wav = await readFile(path);
      const data = wav.indexOf("data") + 8;
      for (let i = data; i + 1 < wav.length; i += 2) {
        if (Math.abs(wav.readInt16LE(i)) > 1000) return (i - data) / 2 / rate;
      }
      return Number.NaN;
    }

    it("keeps the track's delay, so audio lines up with frames", async () => {
      const res = await server.post("/api/v1/audio", { source: delayed, channels: 1 });
      const { audio, timeline_offset: offset } = (await res.json()) as {
        audio: { file: string; sample_rate: number };
        timeline_offset: number;
      };
      expect(offset + (await firstSound(audio.file, audio.sample_rate))).toBeCloseTo(3, 1);
    });

    it("stays right inside a range", async () => {
      const res = await server.post("/api/v1/audio", {
        source: delayed,
        channels: 1,
        start: 1,
        end: 5,
      });
      const { audio, timeline_offset: offset } = (await res.json()) as {
        audio: { file: string; sample_rate: number };
        timeline_offset: number;
      };
      expect(offset + (await firstSound(audio.file, audio.sample_rate))).toBeCloseTo(3, 1);
    });
  });

  describe("what audio reports", () => {
    it("reports what was written, not what was asked for", async () => {
      const multi = join(dir, "surround.mkv");
      await ffmpeg(
        "-f", "lavfi", "-i", "color=c=black:s=160x90:r=25:d=2",
        "-f", "lavfi", "-i", "sine=f=440:d=2:r=96000",
        "-map", "0:v", "-map", "1:a",
        "-c:v", "ffv1", "-c:a", "flac",
        multi,
      );

      const res = await server.post("/api/v1/audio", { source: multi, format: "mp3" });
      const { audio } = (await res.json()) as {
        audio: { sample_rate: number; channels: number; duration: number };
      };

      // The source is 96 kHz, which mp3 cannot hold.
      expect(audio.sample_rate).toBeLessThanOrEqual(48000);
      expect(audio.duration).toBeCloseTo(2, 0);
    });

    // Regression: only the maximum was checked, and the encoder refused the
    // rest when it opened, as a 500 with no reason.
    it.each(["mp3", "m4a"])("refuses a rate %s does not have, up front", async (format) => {
      const res = await server.post("/api/v1/audio", {
        source: join(dir, "voice.mkv"),
        format,
        sample_rate: 12345,
        async: true,
      });
      const { error } = (await res.json()) as { error: { message: string } };

      expect(res.status).toBe(400);
      expect(error.message).toContain("44100");
    });

    it.each([
      ["mp3", 22050],
      ["m4a", 12000],
      ["flac", 12345],
    ])("takes %s at %i Hz", async (format, rate) => {
      const res = await server.post("/api/v1/audio", {
        source: join(dir, "voice.mkv"),
        format,
        sample_rate: rate,
      });
      const { audio } = (await res.json()) as { audio: { sample_rate: number } };

      expect(res.status).toBe(200);
      expect(audio.sample_rate).toBe(rate);
    });

    it("reports requested stereo from a mono source", async () => {
      const mono = join(dir, "mono.mkv");
      await ffmpeg(
        "-f", "lavfi", "-i", "color=c=black:s=160x90:r=25:d=1",
        "-f", "lavfi", "-i", "sine=d=1",
        "-map", "0:v", "-map", "1:a", "-ac", "1", "-c:v", "ffv1", "-c:a", "flac",
        mono,
      );
      const res = await server.post("/api/v1/audio", { source: mono, channels: 2 });
      const { audio } = (await res.json()) as { audio: { channels: number } };
      expect(audio.channels).toBe(2);
    });

    it.each([
      ["mp3", 96000],
      ["m4a", 192000],
    ])("refuses %s at %i Hz up front", async (format, rate) => {
      const res = await server.post("/api/v1/audio", {
        source: clip,
        format,
        sample_rate: rate,
      });
      expect(res.status).toBe(400);
    });
  });

  describe("scene threshold", () => {
    it("decides what counts as a cut", async () => {
      const soft = join(dir, "soft.mkv");
      await ffmpeg(
        "-f", "lavfi", "-i", "color=c=0x808080:s=160x90:r=25:d=2",
        "-f", "lavfi", "-i", "color=c=0xb0b0b0:s=160x90:r=25:d=2",
        "-filter_complex", "[0][1]concat=n=2:v=1:a=0[v]",
        "-map", "[v]", "-c:v", "ffv1",
        soft,
      );

      const count = async (threshold: number): Promise<number> => {
        const res = await server.post("/api/v1/shots", {
          source: soft,
          frame_positions: [],
          scene_threshold: threshold,
        });
        return ((await res.json()) as { shots: { count: number } }).shots.count;
      };

      expect(await count(0.05)).toBe(2);
      expect(await count(0.9)).toBe(1);
    });
  });

  describe("a compose that fails", () => {
    async function preparedJob(): Promise<{
      jobId: string;
      frame: string;
    }> {
      const res = await server.post("/api/v1/extract-and-compose", {
        source: clip,
        fps: 2,
        mode: 4,
      });
      const body = (await res.json()) as { job_id: string; frames: { files: string[] } };
      return { jobId: body.job_id, frame: body.frames.files[1]! };
    }

    it("leaves the earlier sheets, frames, manifest and ZIP working", async () => {
      const { jobId, frame } = await preparedJob();
      const before = await readdir(join(jobs, jobId, "sheets"));

      await writeFile(frame, "not an image any more");
      const failed = await server.post("/api/v1/compose", { job_id: jobId, mode: 16 });
      expect(failed.ok).toBe(false);

      expect(await readdir(join(jobs, jobId, "sheets"))).toEqual(before);
      expect(await readdir(join(jobs, jobId))).not.toContain("sheets.tmp");

      const job = await server.json<{
        sheets: { count: number };
        last_error: { message: string };
      }>(`/api/v1/jobs/${jobId}`);
      expect(job.sheets.count).toBe(before.length);
      expect(job.last_error.message).toContain("not a readable image");

      const sheet = await fetch(`${server.baseUrl}/api/v1/files/${jobId}/sheets/${before[0]}`);
      expect(sheet.status).toBe(200);
      const manifest = await fetch(`${server.baseUrl}/api/v1/files/${jobId}/manifest.json`);
      expect(manifest.status).toBe(200);
      const zip = await fetch(`${server.baseUrl}/api/v1/jobs/${jobId}/download`);
      expect(zip.status).toBe(200);
    });

    it("clears the error once a later compose succeeds", async () => {
      const { jobId, frame } = await preparedJob();
      const good = await readFile(frame);

      await writeFile(frame, "broken");
      await server.post("/api/v1/compose", { job_id: jobId, mode: 16 });
      await writeFile(frame, good);

      const retry = await server.post("/api/v1/compose", { job_id: jobId, mode: 16 });
      expect(retry.status).toBe(200);

      const job = await server.json<{ last_error?: unknown }>(`/api/v1/jobs/${jobId}`);
      expect(job.last_error).toBeUndefined();
    });
  });

  it("records sheets for a compose of frames by path", async () => {
    const extract = await server.post("/api/v1/extract", { source: clip, fps: 2 });
    const { frames } = (await extract.json()) as { frames: { files: string[] } };

    const res = await server.post("/api/v1/compose", { frames: frames.files, mode: 4 });
    const { job_id: jobId } = (await res.json()) as { job_id: string };

    const manifest = await server.json<{ sheets: unknown[] }>(
      `/api/v1/files/${jobId}/manifest.json`,
    );
    expect(manifest.sheets).toHaveLength(2);
  });

  describe("multipart forms", () => {
    async function positions(fields: Array<[string, string]>): Promise<Response> {
      return fetch(`${server.baseUrl}/api/v1/shots`, {
        method: "POST",
        body: upload(fields),
      });
    }

    it.each<[string, Array<[string, string]>, number]>([
      ["a comma list", [["frame_positions", "first,last"]], 2],
      ["a single value", [["frame_positions", "first"]], 1],
      ["repeated fields", [["frame_positions", "first"], ["frame_positions", "last"]], 2],
      ["bracket names", [["frame_positions[]", "first"], ["frame_positions[]", "last"]], 2],
      ["none", [["frame_positions", "none"]], 0],
    ])("accepts frame_positions as %s", async (_name, fields, count) => {
      const res = await positions(fields);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { frames: { count: number } }).frames.count).toBe(count);
    });

    it("refuses an unknown frame position", async () => {
      const res = await positions([["frame_positions", "sideways"]]);
      expect(res.status).toBe(400);
    });

    it("reads fields sent after the file", async () => {
      const res = await fetch(`${server.baseUrl}/api/v1/extract`, {
        method: "POST",
        body: buildForm([["fps", "2"], ["async", "true"]], true),
      });
      expect(res.status).toBe(202);
    });

    it("does not read an empty field as zero", async () => {
      const res = await fetch(`${server.baseUrl}/api/v1/extract-and-compose`, {
        method: "POST",
        body: upload([["fps", "4"], ["mode", "16"], ["max_sheet_edge", ""]]),
      });
      expect(res.status).toBe(200);
      const { sheets } = (await res.json()) as { sheets: { files: string[] } };
      expect((await sharp(sheets.files[0]!).metadata()).width).toBeLessThanOrEqual(2000);
    });
  });

  it("does not read a null option as zero in JSON", async () => {
    const res = await server.post("/api/v1/extract-and-compose", {
      source: clip,
      fps: 4,
      mode: 16,
      max_sheet_edge: null,
    });
    expect(res.status).toBe(200);
    const { sheets } = (await res.json()) as { sheets: { files: string[] } };
    expect((await sharp(sheets.files[0]!).metadata()).width).toBeLessThanOrEqual(2000);
  });

  it.each(["/api/v1/extract", "/api/v1/shots", "/api/v1/audio"])(
    "refuses a bad time at once on %s, even async",
    async (path) => {
      const res = await server.post(path, {
        source: clip,
        fps: 1,
        start: "soon",
        async: true,
      });
      expect(res.status).toBe(400);
    },
  );

  it("refuses max_sheet_edge in mode 1, where it would do nothing", async () => {
    const res = await server.post("/api/v1/extract-and-compose", {
      source: clip,
      fps: 1,
      mode: 1,
      max_sheet_edge: 100,
    });
    expect(res.status).toBe(400);
  });

  it("includes the manifest in the ZIP, and zips an audio job", async () => {
    const extract = await server.post("/api/v1/extract", { source: clip, fps: 1 });
    const { job_id: jobId } = (await extract.json()) as { job_id: string };
    const zip = Buffer.from(
      await (await fetch(`${server.baseUrl}/api/v1/jobs/${jobId}/download`)).arrayBuffer(),
    );
    expect(zip.includes("manifest.json")).toBe(true);

    const audio = join(dir, "withsound.mp4");
    await ffmpeg(
      "-f", "lavfi", "-i", "color=c=black:s=160x90:r=25:d=1",
      "-f", "lavfi", "-i", "sine=d=1",
      audio,
    );
    const job = await server.post("/api/v1/audio", { source: audio });
    const { job_id: audioJob } = (await job.json()) as { job_id: string };
    const res = await fetch(`${server.baseUrl}/api/v1/jobs/${audioJob}/download`);
    expect(res.status).toBe(200);
  });

  it("does not let caches keep sheets or the manifest", async () => {
    const res = await server.post("/api/v1/extract-and-compose", { source: clip, fps: 1, mode: 4 });
    const { job_id: jobId } = (await res.json()) as { job_id: string };

    const header = async (path: string): Promise<string | null> =>
      (await fetch(`${server.baseUrl}/api/v1/files/${jobId}/${path}`)).headers.get("cache-control");

    expect(await header("sheets/sheet_001.jpg")).toBe("no-cache");
    expect(await header("manifest.json")).toBe("no-cache");
    expect(await header("frames/frame_0001.jpg")).toContain("max-age");
  });

  it("takes a frame list far beyond 1 MiB", async () => {
    const frames = Array.from({ length: 15_000 }, (_, i) =>
      join(dir, "x".repeat(60), `frame_${i}.jpg`),
    );
    const res = await server.post("/api/v1/compose", { frames, mode: 4 });
    expect(res.status).not.toBe(413);
  });

  // Regression: every frame held a file open from the start, and the uncaught
  // stream error at the OS limit ended the whole server.
  it("zips more frames than the open-file limit, and the server survives", async () => {
    const extract = await server.post("/api/v1/extract", { source: clip, fps: 1 });
    const { job_id: jobId, frames } = (await extract.json()) as {
      job_id: string;
      frames: { files: string[] };
    };

    const framesDir = join(jobs, jobId, "frames");
    const source = frames.files[0]!;
    for (let i = 100; i < 8500; i++) {
      await link(source, join(framesDir, `frame_${i}.jpg`)).catch(() =>
        copyFile(source, join(framesDir, `frame_${i}.jpg`)),
      );
    }

    const res = await fetch(`${server.baseUrl}/api/v1/jobs/${jobId}/download?include=frames`);
    expect(res.status).toBe(200);
    const zip = await res.arrayBuffer();
    expect(zip.byteLength).toBeGreaterThan(1_000_000);

    const health = await fetch(`${server.baseUrl}/api/v1/health`);
    expect(health.status).toBe(200);
  }, 120_000);

  it("removes an upload when its queued job is deleted before it runs", async () => {
    const before = (await readdir(tmpdir())).filter((f) => f.startsWith("ilinxa-capture-")).length;

    const busy = await startServer({
      LOCAL_OUTPUT_DIR: join(dir, "queued"),
      MAX_CONCURRENT_JOBS: 1,
    });
    try {
      const slow = join(dir, "slow.mp4");
      await makeClip(slow, { seconds: 40, size: "1280x720", rate: 30 });

      const first = await busy.post("/api/v1/extract", {
        source: slow,
        fps: 30,
        preset: "high",
        async: true,
      });
      const { job_id: running } = (await first.json()) as { job_id: string };

      const second = await fetch(`${busy.baseUrl}/api/v1/extract`, {
        method: "POST",
        body: upload([["fps", "1"], ["async", "true"]]),
      });
      const { job_id: queued } = (await second.json()) as { job_id: string };

      await fetch(`${busy.baseUrl}/api/v1/jobs/${queued}`, { method: "DELETE" });
      await fetch(`${busy.baseUrl}/api/v1/jobs/${running}`, { method: "DELETE" });
      await new Promise((r) => setTimeout(r, 500));

      const after = (await readdir(tmpdir())).filter((f) => f.startsWith("ilinxa-capture-")).length;
      expect(after).toBeLessThanOrEqual(before);
    } finally {
      await busy.close();
    }
  }, 60_000);

  it("can still probe a file with an ordinary container", async () => {
    await unlink(join(dir, "does-not-exist")).catch(() => {});
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_format", clip]);
    expect(stdout).toContain("format_name");
    const res = await server.post("/api/v1/metadata", { source: clip });
    expect(res.status).toBe(200);
  });
});
