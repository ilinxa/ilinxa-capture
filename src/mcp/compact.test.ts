import { describe, it, expect } from "vitest";
import { compactResult } from "./tools.js";

const paths = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `/jobs/cap_00000001/frames/frame_${i}.jpg`);

describe("compactResult", () => {
  it("cuts frames, sheets and shots at the same limit, and says so", () => {
    const result = compactResult(
      {
        job_id: "cap_00000001",
        frames: { count: 7200, files: paths(7200), timestamps: paths(7200).map((_, i) => i) },
        sheets: { count: 450, mode: 16, files: paths(450), urls: paths(450) },
        shots: {
          count: 1500,
          items: Array.from({ length: 1500 }, (_, i) => ({ index: i + 1 })),
        },
      },
      "/jobs/cap_00000001",
    ) as {
      frames: { files: string[]; timestamps: number[]; truncated: boolean };
      sheets: { files: string[]; urls?: string[]; truncated: boolean };
      shots: { items: unknown[]; count: number; truncated: boolean };
    };

    expect(result.frames.files).toHaveLength(200);
    expect(result.frames.timestamps).toHaveLength(200);
    expect(result.frames.truncated).toBe(true);
    expect(result.sheets.files).toHaveLength(200);
    expect(result.sheets.truncated).toBe(true);
    expect(result.sheets.urls).toBeUndefined();
    expect(result.shots.items).toHaveLength(200);
    expect(result.shots.count).toBe(1500);
    expect(result.shots.truncated).toBe(true);
  });

  it("stays small at film scale", () => {
    const result = compactResult(
      { frames: { count: 100_000, files: paths(100_000), timestamps: [] } },
      "/jobs/cap_00000001",
    );
    expect(JSON.stringify(result).length).toBeLessThan(20_000);
  });

  it("leaves short lists whole and unmarked", () => {
    const result = compactResult(
      { frames: { count: 3, files: paths(3), timestamps: [0, 1, 2] } },
      "/jobs/cap_00000001",
    ) as { frames: { files: string[]; truncated: boolean } };

    expect(result.frames.files).toHaveLength(3);
    expect(result.frames.truncated).toBe(false);
  });
});
