import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isHlsUrl,
  parseHlsMasterPlaylist,
  discoverHlsUrls,
  downloadHlsStream,
} from "./hls.js";

// ─── Mock child_process for downloadHlsStream ──────────────────────

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
const mockExecFile = vi.mocked(execFile);

// ─── Mock global fetch ─────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockFetchResponse(body: string, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Not Found",
    text: () => Promise.resolve(body),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isHlsUrl", () => {
  it("returns true for .m3u8 URL", () => {
    expect(isHlsUrl("https://cdn.example.com/video/master.m3u8")).toBe(true);
  });

  it("returns true for .m3u8 URL with query params", () => {
    expect(
      isHlsUrl("https://cdn.example.com/video/master.m3u8?token=abc&t=123"),
    ).toBe(true);
  });

  it("returns true for uppercase .M3U8", () => {
    expect(isHlsUrl("https://cdn.example.com/video/MASTER.M3U8")).toBe(true);
  });

  it("returns false for .m3u8.bak", () => {
    expect(isHlsUrl("https://cdn.example.com/video/master.m3u8.bak")).toBe(
      false,
    );
  });

  it("returns false for regular video URL", () => {
    expect(isHlsUrl("https://example.com/video.mp4")).toBe(false);
  });

  it("returns false for URL containing m3u8 in path segment", () => {
    expect(isHlsUrl("https://example.com/m3u8-info/details")).toBe(false);
  });
});

describe("parseHlsMasterPlaylist", () => {
  const masterPlaylist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2760704,RESOLUTION=1920x1080,NAME="1080p",CODECS="avc1.640028,mp4a.40.2"
hls-1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1327104,RESOLUTION=1280x720,NAME="720p",CODECS="avc1.64001f,mp4a.40.2"
hls-720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=763904,RESOLUTION=854x480,NAME="480p"
hls-480p.m3u8`;

  it("parses master playlist with multiple variants", async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(masterPlaylist));

    const result = await parseHlsMasterPlaylist(
      "https://cdn.example.com/video/master.m3u8",
    );

    expect(result.is_master).toBe(true);
    expect(result.original_url).toBe(
      "https://cdn.example.com/video/master.m3u8",
    );
    expect(result.variants).toHaveLength(3);
  });

  it("sorts variants by bandwidth descending", async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(masterPlaylist));

    const result = await parseHlsMasterPlaylist(
      "https://cdn.example.com/video/master.m3u8",
    );

    expect(result.variants[0]!.bandwidth).toBe(2760704);
    expect(result.variants[1]!.bandwidth).toBe(1327104);
    expect(result.variants[2]!.bandwidth).toBe(763904);
  });

  it("resolves relative variant URLs against master URL", async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(masterPlaylist));

    const result = await parseHlsMasterPlaylist(
      "https://cdn.example.com/video/master.m3u8",
    );

    expect(result.variants[0]!.url).toBe(
      "https://cdn.example.com/video/hls-1080p.m3u8",
    );
    expect(result.variants[1]!.url).toBe(
      "https://cdn.example.com/video/hls-720p.m3u8",
    );
  });

  it("parses resolution into width and height", async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(masterPlaylist));

    const result = await parseHlsMasterPlaylist(
      "https://cdn.example.com/video/master.m3u8",
    );

    expect(result.variants[0]!.width).toBe(1920);
    expect(result.variants[0]!.height).toBe(1080);
    expect(result.variants[0]!.resolution).toBe("1920x1080");
  });

  it("parses NAME and CODECS attributes", async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(masterPlaylist));

    const result = await parseHlsMasterPlaylist(
      "https://cdn.example.com/video/master.m3u8",
    );

    expect(result.variants[0]!.name).toBe("1080p");
    expect(result.variants[0]!.codecs).toBe("avc1.640028,mp4a.40.2");
    // The 480p variant has no CODECS
    expect(result.variants[2]!.codecs).toBeNull();
  });

  it("handles absolute variant URLs", async () => {
    const playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720
https://other-cdn.example.com/hls-720p.m3u8`;

    mockFetch.mockResolvedValue(mockFetchResponse(playlist));

    const result = await parseHlsMasterPlaylist(
      "https://cdn.example.com/video/master.m3u8",
    );

    expect(result.variants[0]!.url).toBe(
      "https://other-cdn.example.com/hls-720p.m3u8",
    );
  });

  it("returns single variant for media playlist (not master)", async () => {
    const mediaPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:9.009,
segment0.ts
#EXTINF:9.009,
segment1.ts
#EXT-X-ENDLIST`;

    mockFetch.mockResolvedValue(mockFetchResponse(mediaPlaylist));

    const result = await parseHlsMasterPlaylist(
      "https://cdn.example.com/video/stream.m3u8",
    );

    expect(result.is_master).toBe(false);
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]!.url).toBe(
      "https://cdn.example.com/video/stream.m3u8",
    );
    expect(result.variants[0]!.bandwidth).toBeNull();
  });

  it("throws HlsParseError for non-M3U8 content", async () => {
    mockFetch.mockResolvedValue(mockFetchResponse("<html>Not a playlist</html>"));

    await expect(
      parseHlsMasterPlaylist("https://cdn.example.com/video/bad.m3u8"),
    ).rejects.toThrow("Not a valid M3U8 playlist");
  });

  it("throws HlsParseError on fetch failure", async () => {
    mockFetch.mockResolvedValue(mockFetchResponse("", false, 404));

    await expect(
      parseHlsMasterPlaylist("https://cdn.example.com/video/missing.m3u8"),
    ).rejects.toThrow("Failed to fetch playlist");
  });

  it("passes custom headers to fetch", async () => {
    mockFetch.mockResolvedValue(
      mockFetchResponse(masterPlaylist),
    );

    await parseHlsMasterPlaylist(
      "https://cdn.example.com/video/master.m3u8",
      { Referer: "https://example.com/" },
    );

    const callHeaders = mockFetch.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(callHeaders["Referer"]).toBe("https://example.com/");
    expect(callHeaders["User-Agent"]).toBeTruthy();
  });
});

describe("discoverHlsUrls", () => {
  it("discovers m3u8 URLs from src attributes", async () => {
    const html = `<html><head><title>Video Page</title></head><body>
      <video src="https://cdn.example.com/stream/master.m3u8"></video>
    </body></html>`;

    mockFetch.mockResolvedValue(mockFetchResponse(html));

    const result = await discoverHlsUrls("https://example.com/watch");

    expect(result.page_url).toBe("https://example.com/watch");
    expect(result.page_title).toBe("Video Page");
    expect(result.streams).toHaveLength(1);
    expect(result.streams[0]!.url).toBe(
      "https://cdn.example.com/stream/master.m3u8",
    );
    expect(result.streams[0]!.source).toBe("html_attribute");
  });

  it("discovers m3u8 URLs from script tags", async () => {
    const html = `<html><head><title>Test</title></head><body>
      <script>var videoUrl = "https://cdn.example.com/hls/stream.m3u8?token=abc";</script>
    </body></html>`;

    mockFetch.mockResolvedValue(mockFetchResponse(html));

    const result = await discoverHlsUrls("https://example.com/watch");

    expect(result.streams.length).toBeGreaterThanOrEqual(1);
    const urls = result.streams.map((s) => s.url);
    expect(urls).toContain(
      "https://cdn.example.com/hls/stream.m3u8?token=abc",
    );
  });

  it("deduplicates found URLs", async () => {
    const html = `<html><head><title>Test</title></head><body>
      <video src="https://cdn.example.com/stream.m3u8"></video>
      <source src="https://cdn.example.com/stream.m3u8">
      <script>var url = "https://cdn.example.com/stream.m3u8";</script>
    </body></html>`;

    mockFetch.mockResolvedValue(mockFetchResponse(html));

    const result = await discoverHlsUrls("https://example.com/watch");

    // Should deduplicate to 1
    const uniqueUrls = new Set(result.streams.map((s) => s.url));
    expect(uniqueUrls.size).toBe(1);
  });

  it("returns empty streams when no m3u8 found", async () => {
    const html = `<html><head><title>No Video</title></head><body>
      <p>Just text</p>
    </body></html>`;

    mockFetch.mockResolvedValue(mockFetchResponse(html));

    const result = await discoverHlsUrls("https://example.com/text-page");

    expect(result.streams).toHaveLength(0);
    expect(result.page_title).toBe("No Video");
  });

  it("extracts page title from HTML", async () => {
    const html = `<html><head><title>  My Video Title  </title></head><body></body></html>`;

    mockFetch.mockResolvedValue(mockFetchResponse(html));

    const result = await discoverHlsUrls("https://example.com/watch");

    expect(result.page_title).toBe("My Video Title");
  });

  it("returns null page_title when title tag missing", async () => {
    const html = `<html><head></head><body></body></html>`;

    mockFetch.mockResolvedValue(mockFetchResponse(html));

    const result = await discoverHlsUrls("https://example.com/watch");

    expect(result.page_title).toBeNull();
  });

  it("throws HlsParseError on fetch failure", async () => {
    mockFetch.mockResolvedValue(mockFetchResponse("", false, 500));

    await expect(
      discoverHlsUrls("https://example.com/watch"),
    ).rejects.toThrow("Failed to fetch page");
  });
});

describe("downloadHlsStream", () => {
  it("calls FFmpeg with correct arguments", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(
        null,
        "",
        "",
      );
      return undefined as never;
    });

    await downloadHlsStream(
      "https://cdn.example.com/stream.m3u8",
      "/output/stream.mp4",
    );

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const call = mockExecFile.mock.calls[0]!;
    expect(call[0]).toBe("ffmpeg");

    const args = call[1] as string[];
    expect(args).toContain("-i");
    expect(args).toContain("https://cdn.example.com/stream.m3u8");
    expect(args).toContain("-c");
    expect(args).toContain("copy");
    expect(args).toContain("-bsf:a");
    expect(args).toContain("aac_adtstoasc");
    expect(args).toContain("-movflags");
    expect(args).toContain("+faststart");
    expect(args).toContain("-y");
    expect(args).toContain("/output/stream.mp4");
  });

  it("passes custom headers via -headers flag", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(
        null,
        "",
        "",
      );
      return undefined as never;
    });

    await downloadHlsStream(
      "https://cdn.example.com/stream.m3u8",
      "/output/stream.mp4",
      { Referer: "https://example.com/", Cookie: "session=abc" },
    );

    const args = mockExecFile.mock.calls[0]![1] as string[];
    expect(args).toContain("-headers");
    const headersIndex = args.indexOf("-headers");
    const headerValue = args[headersIndex + 1]!;
    expect(headerValue).toContain("Referer: https://example.com/");
    expect(headerValue).toContain("Cookie: session=abc");
  });

  it("does not include -headers when no headers provided", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(
        null,
        "",
        "",
      );
      return undefined as never;
    });

    await downloadHlsStream(
      "https://cdn.example.com/stream.m3u8",
      "/output/stream.mp4",
    );

    const args = mockExecFile.mock.calls[0]![1] as string[];
    expect(args).not.toContain("-headers");
  });

  it("throws HlsParseError on FFmpeg failure", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: Error, stdout: string, stderr: string) => void)(
        new Error("ffmpeg crashed"),
        "",
        "",
      );
      return undefined as never;
    });

    await expect(
      downloadHlsStream(
        "https://cdn.example.com/stream.m3u8",
        "/output/stream.mp4",
      ),
    ).rejects.toThrow("FFmpeg HLS download failed");
  });
});
