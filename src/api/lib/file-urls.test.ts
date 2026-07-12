import { describe, it, expect } from "vitest";
import { buildFileUrls } from "./file-urls.js";

describe("buildFileUrls", () => {
  it("builds URLs from POSIX-style absolute paths (frames)", () => {
    const urls = buildFileUrls("cap_test", [
      "/data/jobs/cap_test/frames/frame_0001.jpg",
      "/data/jobs/cap_test/frames/frame_0002.jpg",
    ]);

    expect(urls).toEqual([
      "/api/v1/files/cap_test/frames/frame_0001.jpg",
      "/api/v1/files/cap_test/frames/frame_0002.jpg",
    ]);
  });

  it("builds URLs from POSIX-style absolute paths (sheets)", () => {
    const urls = buildFileUrls("cap_test", [
      "/data/jobs/cap_test/sheets/sheet_001.jpg",
    ]);

    expect(urls).toEqual(["/api/v1/files/cap_test/sheets/sheet_001.jpg"]);
  });

  it("builds URLs from Windows-style absolute paths (frames)", () => {
    const urls = buildFileUrls("cap_test", [
      "C:\\data\\jobs\\cap_test\\frames\\frame_0001.jpg",
    ]);

    expect(urls).toEqual(["/api/v1/files/cap_test/frames/frame_0001.jpg"]);
  });

  it("builds URLs from Windows-style absolute paths (sheets)", () => {
    const urls = buildFileUrls("cap_test", [
      "C:\\data\\jobs\\cap_test\\sheets\\sheet_001.jpg",
    ]);

    expect(urls).toEqual(["/api/v1/files/cap_test/sheets/sheet_001.jpg"]);
  });

  it("handles nested relative segments beyond one level", () => {
    const urls = buildFileUrls("cap_test", [
      "/data/jobs/cap_test/frames/sub/frame_0001.jpg",
    ]);

    expect(urls).toEqual([
      "/api/v1/files/cap_test/frames/sub/frame_0001.jpg",
    ]);
  });

  it("returns an empty array for an empty input list", () => {
    expect(buildFileUrls("cap_test", [])).toEqual([]);
  });
});
