import { describe, it, expect } from "vitest";
import {
  FIRST_DECODED_FILTER,
  createFrameReader,
  mediaInputArgs,
  parsePtsLine,
  seekMargins,
  seekOvershot,
  seekPoint,
  trimFilter,
} from "./ffmpeg.js";

describe("seekMargins", () => {
  it("starts at the target where the container has an index", () => {
    expect(seekMargins("mov")).toEqual([0, 12, 96, Infinity]);
    expect(seekMargins(undefined)).toEqual([0, 12, 96, Infinity]);
  });

  // PS timestamps are wrong for a while after landing, which no check can see,
  // so these always decode into the range from a margin before it.
  it.each(["mpegts", "mpeg"])("backs off from the start in %s", (format) => {
    expect(seekMargins(format)).toEqual([3, 12, 96, Infinity]);
  });

  it.each(["h264", "hevc", "mpegvideo", "m4v"])("never seeks in raw %s", (format) => {
    expect(seekMargins(format)).toEqual([Infinity]);
  });
});

describe("seekPoint", () => {
  it("backs off by the margin", () => {
    expect(seekPoint(100, 12)).toBe(88);
  });

  // Regression: a seek this early went before the first keyframe on B-frame
  // sources, and the decoder returned grey frames that look like real ones.
  it.each([
    [0.05, 0],
    [0.9, 0],
    [5, 12],
    [100, Infinity],
  ])("reads from the start for a target of %d with a margin of %d", (target, margin) => {
    expect(seekPoint(target, margin)).toBe(0);
  });
});

describe("seekOvershot", () => {
  it("accepts a landing at or before the target", () => {
    expect(seekOvershot(8, 7.9, 10, 0.04)).toBe(false);
    expect(seekOvershot(8, 10, 10, 0.04)).toBe(false);
  });

  it("allows rounding past the target", () => {
    expect(seekOvershot(8, 10.01, 10, 0.04)).toBe(false);
  });

  // Regression: at a tolerance of 1.5 frames, a landing on the keyframe of the
  // next shot passed as the last frame of this one.
  it("calls even one frame past the target an overshoot", () => {
    expect(seekOvershot(8, 10.04, 10, 0.04)).toBe(true);
  });

  it("calls no frame at all an overshoot, since the seek may have passed them", () => {
    expect(seekOvershot(8, null, 10, 0.04)).toBe(true);
  });

  it("has nothing to retry when the run started from the beginning", () => {
    expect(seekOvershot(undefined, null, 10, 0.04)).toBe(false);
    expect(seekOvershot(0, 11, 10, 0.04)).toBe(false);
    expect(seekOvershot(-Infinity, null, 10, 0.04)).toBe(false);
  });
});

describe("mediaInputArgs", () => {
  it("has the input options before the input", () => {
    const args = mediaInputArgs("/film.ts", 10);

    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args.indexOf("-format_whitelist")).toBeLessThan(args.indexOf("-i"));
    expect(args.indexOf("-protocol_whitelist")).toBeLessThan(args.indexOf("-i"));
  });
});

describe("trimFilter", () => {
  it("cuts in microseconds, to match the timebase upstream", () => {
    expect(trimFilter(7.5, 8.5)).toBe("trim=start_pts=7500000:end_pts=8500000");
  });

  it("is open-ended without an end", () => {
    expect(trimFilter(2.003)).toBe("trim=start_pts=2003000");
  });
});

describe("FIRST_DECODED_FILTER", () => {
  // Regression: printing every frame from two filters interleaved their buffers
  // on stdout. On a 2-minute range the first time came back 22 s out.
  it("prints one frame only, unbuffered", () => {
    expect(FIRST_DECODED_FILTER).toContain("direct=1");
    expect(FIRST_DECODED_FILTER).toContain("enable=not(n)");
  });

  it("does not leak its marker into what later filters print", () => {
    expect(FIRST_DECODED_FILTER).toMatch(/metadata=mode=delete:key=decoded$/);
  });
});

describe("createFrameReader", () => {
  const frame = (index: number, pts: number): string =>
    `frame:${index}    pts:${pts}    pts_time:0`;

  it("separates the first decoded frame from the frames kept", () => {
    const reader = createFrameReader();

    for (const line of [
      frame(0, 7_000_000),
      "decoded=1",
      frame(0, 7_500_000),
      "capture=1",
      frame(1, 7_541_667),
      "capture=1",
    ]) {
      reader.onLine(line);
    }

    expect(reader.firstDecoded()).toBe(7);
    expect(reader.times).toEqual([7.5, 7.541667]);
  });

  it("ignores frames that were printed for neither reason", () => {
    const reader = createFrameReader();

    reader.onLine(frame(0, 1_000_000));
    reader.onLine("lavfi.scene_score=0.1");

    expect(reader.times).toEqual([]);
    expect(reader.firstDecoded()).toBeNull();
  });

  it("reports nothing for a run that decoded nothing", () => {
    expect(createFrameReader().firstDecoded()).toBeNull();
  });
});

describe("parsePtsLine", () => {
  it("reads the exact integer, not the rounded time", () => {
    expect(parsePtsLine("frame:1    pts:9960041667 pts_time:9960.04")).toBe(9960.041667);
  });

  it("is null for anything else", () => {
    expect(parsePtsLine("capture=1")).toBeNull();
  });
});
