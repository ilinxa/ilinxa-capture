import { describe, it, expect } from "vitest";
import { buildShots, planShotFrames, type Shot } from "./shots.js";

const span = { start: 0, end: 10 };

describe("buildShots", () => {
  it("returns one shot when there are no cuts", () => {
    expect(buildShots([], span, 0.25)).toEqual([
      { index: 1, start: 0, end: 10, duration: 10, lastFrame: 10 },
    ]);
  });

  it("splits at each cut, leaving no gaps and no overlaps", () => {
    const shots = buildShots([2, 5.5], span, 0.25);
    expect(shots.map((s) => [s.start, s.end])).toEqual([
      [0, 2],
      [2, 5.5],
      [5.5, 10],
    ]);
    expect(shots.reduce((sum, s) => sum + s.duration, 0)).toBeCloseTo(10);
  });

  it("numbers shots from 1", () => {
    expect(buildShots([2, 4], span, 0.25).map((s) => s.index)).toEqual([1, 2, 3]);
  });

  it("ignores a cut closer than the minimum to the previous one", () => {
    const shots = buildShots([2, 2.1, 5], span, 0.25);
    expect(shots.map((s) => s.start)).toEqual([0, 2, 5]);
  });

  it("merges a too-short tail into the shot before it", () => {
    const shots = buildShots([2, 9.9], span, 0.25);
    expect(shots.map((s) => [s.start, s.end])).toEqual([
      [0, 2],
      [2, 10],
    ]);
  });

  it("accepts every cut when the minimum is 0", () => {
    expect(buildShots([2, 2.01, 2.02], span, 0)).toHaveLength(4);
  });

  it("works on a range that does not start at zero", () => {
    const shots = buildShots([105], { start: 100, end: 110 }, 0.25);
    expect(shots.map((s) => [s.start, s.end])).toEqual([
      [100, 105],
      [105, 110],
    ]);
  });

  it("ignores cuts outside the span", () => {
    const shots = buildShots([50, 150], { start: 100, end: 110 }, 0.25);
    expect(shots).toHaveLength(1);
  });

  it("records each shot's real final frame from the decode", () => {
    const shots = buildShots([4], span, 0.25, {
      frameBeforeCut: new Map([[4, 2.958]]),
      lastFrame: 9.96,
    });
    expect(shots.map((s) => s.lastFrame)).toEqual([2.958, 9.96]);
  });

  it("keeps the frame before a cut that survived, not one that was ignored", () => {
    const shots = buildShots([2, 2.1, 5], span, 0.25, {
      frameBeforeCut: new Map([
        [2, 1.96],
        [2.1, 2.06],
        [5, 4.96],
      ]),
      lastFrame: 9.96,
    });
    expect(shots[1]?.lastFrame).toBe(4.96);
  });

  it("sorts cuts that arrive out of order", () => {
    expect(buildShots([5, 2], span, 0.25).map((s) => s.start)).toEqual([0, 2, 5]);
  });
});

describe("planShotFrames", () => {
  const shot: Shot = { index: 3, start: 10, end: 14, duration: 4, lastFrame: 13.96 };

  it("places first, middle and last inside the shot", () => {
    const targets = planShotFrames([shot], ["first", "middle", "last"], 0.04);
    expect(targets).toEqual([
      { shot: 3, position: "first", time: 10, latest: 13.96 },
      { shot: 3, position: "middle", time: 12, latest: 13.96 },
      { shot: 3, position: "last", time: 13.96, latest: 13.96 },
    ]);
  });

  it("keeps time order whatever order positions are given in", () => {
    const targets = planShotFrames([shot], ["last", "first"], 0.04);
    expect(targets.map((t) => t.position)).toEqual(["first", "last"]);
  });

  it("does not capture the same frame twice in a very short shot", () => {
    const tiny: Shot = { index: 1, start: 5, end: 5.04, duration: 0.04, lastFrame: 5 };
    const targets = planShotFrames([tiny], ["first", "middle", "last"], 0.04);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.position).toBe("first");
  });

  it("covers every shot", () => {
    const shots: Shot[] = [
      { index: 1, start: 0, end: 2, duration: 2, lastFrame: 1.96 },
      { index: 2, start: 2, end: 4, duration: 2, lastFrame: 3.96 },
    ];
    expect(planShotFrames(shots, ["middle"], 0.04).map((t) => t.time)).toEqual([1, 3]);
  });

  it("takes the real last frame on variable rate video, not end minus a frame", () => {
    const vfr: Shot = { index: 1, start: 0, end: 4, duration: 4, lastFrame: 2.958 };
    const [target] = planShotFrames([vfr], ["last"], 0.04);
    expect(target?.time).toBe(2.958);
  });

  it("plans nothing with no positions", () => {
    expect(planShotFrames([shot], [], 0.04)).toEqual([]);
  });
});
