import { describe, it, expect } from "vitest";
import { formatTimestamp, parseTimecode, resolveRange } from "./timecode.js";

describe("parseTimecode", () => {
  it.each([
    [90.5, 90.5],
    [0, 0],
    ["90.5", 90.5],
    ["01:30", 90],
    ["01:30.5", 90.5],
    ["1:02:03", 3723],
    ["01:02:03.25", 3723.25],
    ["  12  ", 12],
  ])("parses %s", (input, expected) => {
    expect(parseTimecode(input)).toBe(expected);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "", "abc", "1:2:3:4", "00:61", "61:00:99", "-5", "1e3"])(
    "rejects %s",
    (input) => {
      expect(() => parseTimecode(input)).toThrow(/Invalid time/);
    },
  );
});

describe("formatTimestamp", () => {
  it.each([
    [0, "00:00.000"],
    [0.2, "00:00.200"],
    [30, "00:30.000"],
    [60, "01:00.000"],
    [3.5, "00:03.500"],
    [3599.999, "59:59.999"],
    [3600, "01:00:00.000"],
    [3700, "01:01:40.000"],
    [7384.25, "02:03:04.250"],
    [36000, "10:00:00.000"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatTimestamp(input)).toBe(expected);
  });

  it("carries rounding instead of printing an impossible value", () => {
    expect(formatTimestamp(59.9996)).toBe("01:00.000");
    expect(formatTimestamp(0.9996)).toBe("00:01.000");
    expect(formatTimestamp(3599.9996)).toBe("01:00:00.000");
  });
});

describe("resolveRange", () => {
  it("returns undefined for the whole file", () => {
    expect(resolveRange(undefined, undefined, 100)).toBeUndefined();
  });

  it("fills in a missing start or end", () => {
    expect(resolveRange(10, undefined, 100)).toEqual({ start: 10, end: 100 });
    expect(resolveRange(undefined, 20, 100)).toEqual({ start: 0, end: 20 });
  });

  it("accepts clock strings", () => {
    expect(resolveRange("00:10", "00:20", 100)).toEqual({ start: 10, end: 20 });
  });

  it("clamps an end past the video", () => {
    expect(resolveRange(90, 500, 100)).toEqual({ start: 90, end: 100 });
  });

  it("rejects a start past the end of the video", () => {
    expect(() => resolveRange(100, undefined, 100)).toThrow(/past the end/);
  });

  it("rejects an empty or reversed range", () => {
    expect(() => resolveRange(20, 20, 100)).toThrow(/after 'start'/);
    expect(() => resolveRange(20, 10, 100)).toThrow(/after 'start'/);
  });

  it("keeps the given end when the duration is unknown", () => {
    expect(resolveRange(5, 15, 0)).toEqual({ start: 5, end: 15 });
  });
});
