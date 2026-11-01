import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/exec.js", () => ({
  execFileAsync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

import { rm } from "node:fs/promises";
import { execFileAsync } from "../utils/exec.js";
import { detectShots, extractShotFrames, type ShotFrameTarget } from "./shots.js";

const mockExec = vi.mocked(execFileAsync);

const targets: ShotFrameTarget[] = Array.from({ length: 40 }, (_, i) => ({
  shot: i + 1,
  position: "middle",
  time: i,
  latest: i + 0.5,
}));

const options = {
  videoPath: "/film.mp4",
  outputDir: "/frames",
  targets,
  preset: { width: null, format: "png" as const, quality: null },
};

type ExecOptions = Parameters<typeof execFileAsync>[2];

function printAt(opts: ExecOptions, decoded: number, kept: number): void {
  opts?.onStdoutLine?.(`frame:0    pts:${decoded}    pts_time:0`);
  opts?.onStdoutLine?.("decoded=1");
  opts?.onStdoutLine?.(`frame:0    pts:${kept}    pts_time:0`);
  opts?.onStdoutLine?.("capture=1");
}

function printFrame(opts: ExecOptions): void {
  printAt(opts, 1000, 1000);
}

/** The time a grab asked for, in microseconds. */
function trimTarget(args: string[]): number {
  return Number(/trim=start_pts=(\d+)/.exec(args[args.indexOf("-vf") + 1]!)![1]);
}

describe("extractShotFrames workers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Regression: Promise.all rejected on the first failure and freed the job's
  // slot while the other workers went on starting ffmpeg.
  it("stops every worker on a failure, and settles only once they have", async () => {
    let running = 0;
    let finishedAfterFailure = false;
    let failed = false;

    mockExec.mockImplementation(async (_cmd, _args, opts) => {
      running += 1;
      const call = mockExec.mock.calls.length;
      await new Promise((r) => setTimeout(r, 15));
      running -= 1;
      if (failed) finishedAfterFailure = true;

      printFrame(opts);
      if (call === 3) {
        failed = true;
        // A frame was printed, so this is a real failure, not "no frame here".
        throw new Error("disk full");
      }
      return { stdout: "", stderr: "" };
    });

    await expect(extractShotFrames(options)).rejects.toThrow(
      "Shot frame extraction failed",
    );

    expect(running).toBe(0);
    expect(mockExec.mock.calls.length).toBeLessThan(targets.length);
    expect(finishedAfterFailure || running === 0).toBe(true);
  });

  it("treats a failure with no frame as no frame, not a failed job", async () => {
    mockExec.mockRejectedValue(new Error("encoder failed: no frames"));

    const frames = await extractShotFrames({ ...options, targets: targets.slice(0, 2) });

    expect(frames).toEqual([]);
  });

  it("seeks again for the shot's last frame if a seek lands past it", async () => {
    mockExec.mockImplementation(async (_cmd, args, opts) => {
      const target = trimTarget(args);
      // The first grab jumps a gap to well past the shot's end.
      printAt(opts, target, target === 2_000_000 ? 4_000_000 : target);
      return { stdout: "", stderr: "" };
    });

    const [frame] = await extractShotFrames({
      ...options,
      targets: [{ shot: 1, position: "middle", time: 2, latest: 3 }],
    });

    expect(frame?.time).toBe(3);
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  // Regression: the retry was trusted, and a frame of the next shot went out
  // labelled as this one.
  it("drops a frame that still lands past the shot", async () => {
    mockExec.mockImplementation(async (_cmd, args, opts) => {
      printAt(opts, trimTarget(args), 9_000_000);
      return { stdout: "", stderr: "" };
    });

    const frames = await extractShotFrames({
      ...options,
      frameInterval: 0.04,
      targets: [{ shot: 1, position: "middle", time: 2, latest: 3 }],
    });

    expect(frames).toEqual([]);
    expect(rm).toHaveBeenCalledTimes(1);
  });

  it("keeps a frame that differs from the shot's end only by rounding", async () => {
    mockExec.mockImplementation(async (_cmd, _args, opts) => {
      printAt(opts, 3_000_001, 3_000_001);
      return { stdout: "", stderr: "" };
    });

    const frames = await extractShotFrames({
      ...options,
      frameInterval: 0.04,
      targets: [{ shot: 1, position: "last", time: 3, latest: 3 }],
    });

    expect(frames).toHaveLength(1);
  });

  // Regression: a sparse source paid for every failed margin on every grab.
  it("remembers a margin that worked, for the grabs after it", async () => {
    const many = targets.slice(20).map((t) => ({ ...t, time: t.time, latest: t.time }));

    mockExec.mockImplementation(async (_cmd, args, opts) => {
      const at = args.indexOf("-ss");
      const seek = at === -1 ? 0 : Number(args[at + 1]);
      const target = trimTarget(args);
      // The demuxer lands 5 s past wherever it was sent.
      printAt(opts, (seek + 5) * 1_000_000, target);
      return { stdout: "", stderr: "" };
    });

    const frames = await extractShotFrames({
      ...options,
      format: "mpegts",
      frameInterval: 0.04,
      targets: many,
    });

    expect(frames).toHaveLength(many.length);
    // Once per grab, plus the few that were already running when one learned it.
    expect(mockExec.mock.calls.length).toBeLessThan(many.length + 5);
  });

  it("gives a shot of a single frame one frame's length", async () => {
    mockExec.mockImplementation(async (_cmd, _args, opts) => {
      opts?.onStdoutLine?.("frame:0    pts:0    pts_time:0");
      opts?.onStdoutLine?.("lavfi.scene_score=0.000000");
      return { stdout: "", stderr: "" };
    });

    const shots = await detectShots({
      videoPath: "/film.mp4",
      threshold: 0.3,
      minShotSeconds: 0,
      span: { start: 0, end: 10 },
      frameInterval: 0.04,
    });

    expect(shots).toHaveLength(1);
    expect(shots[0]?.duration).toBeCloseTo(0.04, 6);
  });
});
