import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/exec.js", () => ({
  execFileAsync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { execFileAsync } from "../utils/exec.js";
import { extractShotFrames, type ShotFrameTarget } from "./shots.js";

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

function printFrame(opts: Parameters<typeof execFileAsync>[2]): void {
  opts?.onStdoutLine?.("frame:0    pts:1000    pts_time:0.001");
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
      const seek = Number(args[args.indexOf("-ss") + 1]);
      // First seek jumps a gap to well past the shot's end.
      opts?.onStdoutLine?.(
        `frame:0    pts:${seek < 2.5 ? 2_000_000 : 0}    pts_time:0`,
      );
      return { stdout: "", stderr: "" };
    });

    const [frame] = await extractShotFrames({
      ...options,
      targets: [{ shot: 1, position: "middle", time: 2, latest: 3 }],
    });

    expect(frame?.time).toBeCloseTo(3, 2);
    expect(mockExec).toHaveBeenCalledTimes(2);
  });
});
